/**
 * dsh-wei-sitecontrol — detect: what is actually on the target server.
 *
 * One compound probe gathers everything the deploy plan needs: OS and package
 * manager, which web server (if any) is installed, where its config and
 * document root live, whether Tomcat exists and where CATALINA_HOME is, whether
 * Docker is available and what it is running, and what is already listening.
 *
 * `SERVICE_PLAYBOOK` then turns that into the per-kind stop/start/install
 * commands, and `buildSteps` renders the ordered plan the deployer executes.
 */

/** Sections are labelled so one round trip can answer every question. */
export const PROBE_SCRIPT = [
  'echo "## os"; (cat /etc/os-release 2>/dev/null | grep -E "^(ID|VERSION_ID|PRETTY_NAME)=") || uname -srm',
  'echo "## kernel"; uname -srm',
  'echo "## init"; (command -v systemctl >/dev/null && echo systemd) || echo none',
  'echo "## pkg"; for c in dnf yum apt-get zypper apk; do if command -v $c >/dev/null; then echo $c; break; fi; done',
  'echo "## httpd"; (command -v httpd || command -v apache2) 2>/dev/null; httpd -v 2>/dev/null | head -1; ls -d /etc/httpd /etc/apache2 2>/dev/null',
  'echo "## nginx"; command -v nginx 2>/dev/null; nginx -v 2>&1 | head -1; ls -d /etc/nginx 2>/dev/null',
  'echo "## tomcat"; ls -d /opt/tomcat* /usr/local/tomcat* /usr/share/tomcat* 2>/dev/null; ls /opt/tomcat*/conf/server.xml /usr/local/tomcat*/conf/server.xml 2>/dev/null',
  // Real deployments name the directory after the product ("/opt/tomcat9"),
  // so discovery also asks systemd, the running JVM and a wider glob.
  'echo "## tomcat_find"; ls -d /opt/*tomcat* /opt/*/tomcat* /usr/local/*tomcat* /usr/share/tomcat* /usr/share/*tomcat* 2>/dev/null | head -10',
  'echo "## tomcat_unit"; systemctl cat tomcat9.service tomcat.service 2>/dev/null | grep -E "^(ExecStart|Environment|WorkingDirectory|User)=" | head -8',
  'echo "## tomcat_proc"; ps -ef 2>/dev/null | grep -oE "catalina\\.(base|home)=[^ ]*" | sort -u | head -4',
  'echo "## tomcat_appbase"; for f in $(ls -d /opt/*tomcat*/conf/server.xml /opt/*/tomcat*/conf/server.xml /usr/local/*tomcat*/conf/server.xml 2>/dev/null | head -3); do echo "FILE=$f"; grep -oE "appBase=\\"[^\\"]*\\"" "$f" 2>/dev/null | head -2; done',
  'echo "## tomcat_webapps"; for d in $(ls -d /opt/*tomcat*/webapps /opt/*/tomcat*/webapps /usr/local/*tomcat*/webapps 2>/dev/null | head -3); do echo "DIR=$d"; ls -1 "$d" 2>/dev/null | head -8; done',
  'echo "## docker"; command -v docker 2>/dev/null; docker --version 2>/dev/null; docker ps --format "{{.Names}} {{.Image}} {{.Ports}}" 2>/dev/null | head -20',
  'echo "## compose"; docker compose version 2>/dev/null | head -1',
  'echo "## units"; (systemctl list-unit-files 2>/dev/null | grep -Ei "httpd|apache2?|nginx|tomcat" | head -20) || true',
  'echo "## listen"; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | head -25',
  'echo "## webroots"; ls -d /var/www/html /var/www /usr/share/nginx/html /opt/tomcat*/webapps /usr/local/tomcat*/webapps 2>/dev/null',
  // The publish target is usually spelled out in the web server's own config:
  // reading the <Context docBase> is what turns a guess into a fact.
  'echo "## contexts"; for f in /opt/*tomcat*/conf/server.xml /opt/*/tomcat*/conf/server.xml /usr/local/*tomcat*/conf/server.xml /etc/nginx/conf.d/*.conf /etc/httpd/conf/httpd.conf; do [ -f "$f" ] && { echo "FILE=$f"; grep -nE "<Context|root +[^;]*;|DocumentRoot" "$f" 2>/dev/null | head -5; }; done',
  'echo "## configs"; for f in /opt/*tomcat*/conf/server.xml /opt/*/tomcat*/conf/server.xml /usr/local/*tomcat*/conf/server.xml; do [ -f "$f" ] && echo "$f"; done | head -3',
  'echo "## end"',
].join('\n')

function sections(text) {
  const out = {}
  let current = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^##\s+(\w+)\s*$/)
    if (match) {
      current = match[1]
      out[current] = []
      continue
    }
    if (current) out[current].push(line.trim())
  }
  return out
}

const firstLine = (lines) => (lines ?? []).map((l) => l.trim()).find((l) => l !== '') ?? null
const allLines = (lines) => (lines ?? []).map((l) => l.trim()).filter((l) => l !== '')

/**
 * Lines that merely report a missing binary ("bash: nginx: command not found")
 * must never be read as evidence that the service is installed — that exact
 * text made an early version report nginx as present on a server without it.
 */
const NOT_FOUND_RE = /command not found|not found|no such file|unrecognized|cannot (?:access|execute)|未找到|不存在/i
const realLines = (lines) => allLines(lines).filter((l) => !NOT_FOUND_RE.test(l))

/** Absolute paths offered by a probe section. */
const pathsIn = (lines) => realLines(lines).filter((l) => l.startsWith('/'))

/**
 * Parse the `## contexts` section: `FILE=<path>` headers followed by matching
 * config lines. Only Context/docBase pairs are extracted — that value is what a
 * release deploy has to switch, so it must come from the file, not a guess.
 */
function parseContexts(lines) {
  const contexts = []
  const files = []
  let file = null
  for (const line of allLines(lines)) {
    if (line.startsWith('FILE=')) {
      file = line.slice(5)
      files.push(file)
      continue
    }
    const docBase = line.match(/docBase\s*=\s*["']([^"']+)["']/)?.[1] ?? null
    const path = line.match(/\bpath\s*=\s*["']([^"']*)["']/)?.[1] ?? null
    // nginx: `root /usr/share/nginx/html;`  ·  httpd: `DocumentRoot "/var/www/html"`
    const nginxRoot = line.match(/^\s*\d+:\s*root\s+([^;\s]+)/) ?? line.match(/\broot\s+([^;\s]+);/)
    const documentRoot = line.match(/DocumentRoot\s+"?([^"\s]+)"?/)
    if (docBase !== null || nginxRoot || documentRoot) {
      contexts.push({
        file,
        line,
        path: path ?? '',
        docBase: docBase ?? nginxRoot?.[1] ?? documentRoot?.[1] ?? null,
        kind: docBase !== null ? 'tomcat-context' : nginxRoot ? 'nginx-root' : 'httpd-documentroot',
      })
    }
  }
  return { contexts, files }
}

/** Turn raw probe output into a compact finding set. Pure, so it is unit-testable. */
export function parseProbeOutput(text) {
  const s = sections(text)
  const os = {}
  for (const line of s.os ?? []) {
    const [key, value] = line.split('=')
    if (key && value) os[key] = value.replace(/^"|"$/g, '')
  }
  const httpdLines = realLines(s.httpd)
  const nginxLines = realLines(s.nginx)
  const tomcatLines = realLines(s.tomcat)
  const dockerLines = realLines(s.docker)
  const unitLines = realLines(s.units)
  const listenLines = realLines(s.listen).filter((l) => /LISTEN|:80|:443|:8080/.test(l))

  // ── Tomcat: a real deployment may live anywhere and may be started by
  // systemd or by a bare startup.sh, so every source is cross-checked.
  const found = [...pathsIn(s.tomcat_find), ...pathsIn(s.tomcat)]
  const procHomes = realLines(s.tomcat_proc)
    .map((l) => l.match(/catalina\.home=([^ ]+)/)?.[1])
    .filter(Boolean)
  const unitLines2 = realLines(s.tomcat_unit)
  const unitHome = unitLines2.map((l) => l.match(/catalina\.home=([^ ]+)/)?.[1]).filter(Boolean)[0] ?? null
  const unitExec = unitLines2.find((l) => l.startsWith('ExecStart=')) ?? null
  const catalinaHome = procHomes[0] ?? unitHome ?? found.find((p) => /tomcat|Tomcat/.test(p)) ?? null
  const tomcatServerXml = found.find((l) => l.endsWith('server.xml')) ?? (catalinaHome ? `${catalinaHome}/conf/server.xml` : null)
  const appBase = (() => {
    const lines = allLines(s.tomcat_appbase)
    return lines.map((l) => l.match(/appBase="([^"]*)"/)?.[1]).find(Boolean) ?? null
  })()
  const webappsListing = (() => {
    const lines = allLines(s.tomcat_webapps)
    const dir = lines.find((l) => l.startsWith('DIR='))?.replace('DIR=', '') ?? null
    const entries = lines.filter((l) => !l.startsWith('DIR=') && !l.startsWith('FILE=') && l !== '')
    return { dir, entries }
  })()
  // `systemctl` wants the bare unit name, so the .service suffix is dropped.
  const tomcatUnit = (unitLines.find((l) => /tomcat/i.test(l))?.split(/\s+/)[0] ?? '').replace(/\.service$/, '') || null
  const contextInfo = parseContexts(s.contexts)
  const configFiles = realLines(s.configs)
  const rootContext = contextInfo.contexts.find((c) => c.path === '/') ?? contextInfo.contexts[0] ?? null

  return {
    os: { id: os.ID ?? null, version: os.VERSION_ID ?? null, pretty: os.PRETTY_NAME ?? null, kernel: firstLine(s.kernel) },
    init: firstLine(s.init),
    packageManager: firstLine(s.pkg),
    httpd: {
      present: httpdLines.length > 0,
      binary: httpdLines.find((l) => /^\//.test(l) && /httpd|apache2/.test(l)) ?? null,
      version: httpdLines.find((l) => /version/i.test(l)) ?? null,
      configDir: httpdLines.find((l) => /^\/etc\/(httpd|apache2)$/.test(l)) ?? null,
    },
    nginx: {
      present: nginxLines.length > 0,
      binary: nginxLines.find((l) => /^\//.test(l) && /nginx/.test(l)) ?? null,
      version: nginxLines.find((l) => /version/i.test(l)) ?? null,
      configDir: nginxLines.find((l) => /^\/etc\/nginx$/.test(l)) ?? null,
    },
    tomcat: {
      present: catalinaHome !== null,
      catalinaHome,
      serverXml: tomcatServerXml,
      appBase,
      unit: tomcatUnit,
      unitExec,
      webapps: webappsListing.dir ?? (catalinaHome ? `${catalinaHome}/webapps` : null),
      webappsEntries: webappsListing.entries,
      candidates: found,
      // The publish target as the server's own config declares it.
      configFile: rootContext?.file ?? configFiles[0] ?? null,
      contexts: contextInfo.contexts,
      configFiles,
    },
    /** Where a release deploy should publish, when the config says so. */
    publish: {
      docBase: rootContext?.docBase ?? null,
      contextPath: rootContext?.path ?? null,
      configFile: rootContext?.file ?? configFiles[0] ?? null,
    },
    docker: {
      present: dockerLines.some((l) => /^\//.test(l) || /Docker version/i.test(l)),
      version: dockerLines.find((l) => /Docker version/i.test(l)) ?? null,
      containers: dockerLines.filter((l) => !/^\//.test(l) && !/Docker version/i.test(l)),
      compose: firstLine(s.compose),
    },
    units: unitLines,
    listen: listenLines,
    webroots: realLines(s.webroots),
  }
}

/** Per-kind service management defaults; explicit target commands always win. */
export const SERVICE_PLAYBOOK = {
  static: {
    label: '静态站点',
    install: null,
    stop: null,
    start: null,
    restart: null,
    docRootCandidates: ['/var/www/html', '/usr/share/nginx/html', '/var/www'],
  },
  httpd: {
    label: 'Apache httpd',
    install: 'PKG=$(command -v dnf || command -v yum || command -v apt-get); case "$PKG" in *dnf|*yum) $PKG install -y httpd ;; *apt-get) $PKG update && $PKG install -y apache2 ;; esac',
    stop: 'systemctl stop httpd 2>/dev/null || systemctl stop apache2 2>/dev/null || httpd -k stop 2>/dev/null || true',
    start: 'systemctl start httpd 2>/dev/null || systemctl start apache2 2>/dev/null || httpd -k start 2>/dev/null || true',
    restart: 'systemctl restart httpd 2>/dev/null || systemctl restart apache2 2>/dev/null || apachectl graceful 2>/dev/null || true',
    configCandidates: ['/etc/httpd/conf/httpd.conf', '/etc/apache2/apache2.conf'],
    docRootCandidates: ['/var/www/html', '/var/www'],
  },
  nginx: {
    label: 'Nginx',
    install: 'PKG=$(command -v dnf || command -v yum || command -v apt-get); case "$PKG" in *dnf|*yum) $PKG install -y nginx ;; *apt-get) $PKG update && $PKG install -y nginx ;; esac',
    stop: 'systemctl stop nginx 2>/dev/null || nginx -s stop 2>/dev/null || true',
    start: 'systemctl start nginx 2>/dev/null || nginx 2>/dev/null || true',
    restart: 'systemctl restart nginx 2>/dev/null || (nginx -s reload 2>/dev/null) || true',
    configCandidates: ['/etc/nginx/nginx.conf', '/etc/nginx/conf.d/default.conf'],
    docRootCandidates: ['/usr/share/nginx/html', '/var/www/html'],
  },
  tomcat: {
    label: 'Tomcat',
    install: null,
    stop: 'systemctl stop tomcat 2>/dev/null || systemctl stop tomcat9 2>/dev/null || { [ -n "$CATALINA_HOME" ] && "$CATALINA_HOME/bin/shutdown.sh" 2>/dev/null; } || true',
    start: 'systemctl start tomcat 2>/dev/null || systemctl start tomcat9 2>/dev/null || { [ -n "$CATALINA_HOME" ] && "$CATALINA_HOME/bin/startup.sh" 2>/dev/null; } || true',
    restart: 'systemctl restart tomcat 2>/dev/null || systemctl restart tomcat9 2>/dev/null || { [ -n "$CATALINA_HOME" ] && "$CATALINA_HOME/bin/shutdown.sh" 2>/dev/null && sleep 3 && "$CATALINA_HOME/bin/startup.sh" 2>/dev/null; } || true',
    configCandidates: ['conf/server.xml', 'conf/web.xml'],
    docRootCandidates: ['webapps', 'webapps/ROOT'],
  },
  docker: {
    label: 'Docker 容器',
    install: null,
    stop: 'docker compose stop 2>/dev/null || docker stop $(docker ps -q --filter "name=$SERVICE_NAME") 2>/dev/null || true',
    start: 'docker compose up -d 2>/dev/null || docker start $(docker ps -aq --filter "name=$SERVICE_NAME") 2>/dev/null || true',
    restart: 'docker compose up -d --build 2>/dev/null || docker restart $(docker ps -aq --filter "name=$SERVICE_NAME") 2>/dev/null || true',
    configCandidates: ['docker-compose.yml', 'compose.yml', 'Dockerfile'],
    docRootCandidates: [],
  },
  custom: {
    label: '自定义(全部命令由目标配置提供)',
    install: null,
    stop: null,
    start: null,
    restart: null,
    configCandidates: [],
    docRootCandidates: [],
  },
}

/** Effective command for one action, honouring explicit target overrides. */
export function commandFor(kind, action, target = {}) {
  const explicit = { install: target.installCommand, stop: target.stopCommand, start: target.startCommand, restart: target.restartCommand }[action]
  if (explicit) return explicit

  // Tomcat units are named after the install (tomcat, tomcat9, tomcat10), so the
  // unit list is built from the target rather than hard-coded in a template.
  if (kind === 'tomcat') {
    const home = target.appHome || '$CATALINA_HOME'
    const units = [...new Set([target.serviceName, 'tomcat', 'tomcat9'].filter(Boolean))]
    const sys = (verb) => units.map((unit) => `systemctl ${verb} ${unit} 2>/dev/null`).join(' || ')
    const catalinaStop = `{ [ -n "${home}" ] && "${home}/bin/shutdown.sh" 2>/dev/null; }`
    const catalinaStart = `{ [ -n "${home}" ] && "${home}/bin/startup.sh" 2>/dev/null; }`
    if (action === 'stop') return `${sys('stop')} || ${catalinaStop} || true`
    if (action === 'start') return `${sys('start')} || ${catalinaStart} || true`
    if (action === 'restart') return `${sys('restart')} || { ${catalinaStop}; sleep 3; ${catalinaStart}; } || true`
    return null
  }

  const playbook = SERVICE_PLAYBOOK[kind] ?? SERVICE_PLAYBOOK.custom
  let base = playbook[action] ?? null
  if (!base) return null
  if (base.includes('$SERVICE_NAME')) {
    base = target.serviceName
      ? base.replace(/\$SERVICE_NAME/g, target.serviceName)
      : // Without a container name the name-filtered clause is meaningless.
        base
          .split('||')
          .filter((clause) => !clause.includes('--filter "name="'))
          .join('||')
  }
  return base
}

/** Human-readable facts, for the panel and for the agent's report. */
export function summarize(findings, target = {}) {
  const lines = []
  lines.push(`系统:${findings.os.pretty ?? findings.os.id ?? '未知'}${findings.os.version ? ` ${findings.os.version}` : ''}(${findings.os.kernel ?? '?'})`)
  lines.push(`init:${findings.init ?? '未知'} · 包管理器:${findings.packageManager ?? '未知'}`)
  if (findings.httpd.present) lines.push(`Apache:${findings.httpd.version ?? findings.httpd.binary ?? '已安装'} · 配置:${findings.httpd.configDir ?? '?'}`)
  if (findings.nginx.present) lines.push(`Nginx:${findings.nginx.version ?? findings.nginx.binary ?? '已安装'} · 配置:${findings.nginx.configDir ?? '?'}`)
  if (findings.tomcat.present) {
    lines.push(
      `Tomcat:CATALINA_HOME=${findings.tomcat.catalinaHome ?? '?'} · server.xml=${findings.tomcat.serverXml ?? '?'}` +
        `${findings.tomcat.appBase ? ` · appBase=${findings.tomcat.appBase}` : ''}${findings.tomcat.unit ? ` · unit=${findings.tomcat.unit}` : ''}`,
    )
    if (findings.tomcat.webappsEntries?.length) lines.push(`webapps 内容:${findings.tomcat.webappsEntries.slice(0, 8).join(', ')}`)
  }
  if (findings.publish?.docBase) {
    lines.push(`发布目标(来自服务器配置):docBase=${findings.publish.docBase} · context=${findings.publish.contextPath === '' ? '(ROOT)' : findings.publish.contextPath} · 配置文件=${findings.publish.configFile ?? '?'}`)
  }
  if (findings.docker.present) lines.push(`Docker:${findings.docker.version ?? '已安装'}${findings.docker.containers.length ? ` · 容器:${findings.docker.containers.join(' | ')}` : ''}${findings.docker.compose ? ` · compose:${findings.docker.compose}` : ''}`)
  if (findings.units.length) lines.push(`相关服务单元:${findings.units.join(', ')}`)
  if (findings.webroots.length) lines.push(`候选站点目录:${findings.webroots.join(', ')}`)
  if (findings.listen.length) lines.push(`监听端口:${findings.listen.slice(0, 8).join(' | ')}`)
  const missing = []
  if (['httpd', 'nginx', 'tomcat', 'docker'].includes(target.serviceKind)) {
    if (target.serviceKind === 'docker' && !findings.docker.present) missing.push('docker 未安装')
    if (target.serviceKind === 'httpd' && !findings.httpd.present) missing.push('httpd/apache2 未安装(需要先安装)')
    if (target.serviceKind === 'nginx' && !findings.nginx.present) missing.push('nginx 未安装(需要先安装)')
    if (target.serviceKind === 'tomcat' && !findings.tomcat.present) missing.push('tomcat 未找到(需要指定 CATALINA_HOME 或先安装)')
  }
  if (!target.uploadDir) missing.push('未配置上传目录(uploadDir)')
  if (missing.length) lines.push(`⚠ 待解决:${missing.join(';')}`)
  return lines.join('\n')
}

/**
 * The ordered deploy plan. `dryRun` reports the same steps without running them,
 * so the panel and the agent can show exactly what a publish will do.
 */
export function buildSteps({ site = {}, target = {}, findings = null }) {
  const kind = target.serviceKind ?? 'custom'
  const uploadDir = target.uploadDir ?? target.remotePath ?? null
  const steps = []
  const push = (name, detail, command = null) => steps.push({ name, detail, command })

  push('detect', findings ? `已探测:${findings.os.pretty ?? findings.os.id ?? '未知系统'}` : '连接后探测系统与已有服务')

  const docRoot = target.uploadDir ?? (kind === 'tomcat' ? findings?.tomcat?.webapps : null) ?? null
  if ((target.deployMode ?? 'inplace') === 'inplace') {
    if (!uploadDir) push('uploadDir', '尚未配置 uploadDir —— 发布前必须指定上传目录')
    else push('uploadDir', `上传目录:${uploadDir}${docRoot && docRoot !== uploadDir ? `(探测建议:${docRoot})` : ''}`)
  }

  // Only an in-place publish overwrites what is being served, so only that mode
  // needs a pre-publish backup: in release mode the previous release and the
  // current docBase are both left untouched on disk.
  const releaseMode = (target.deployMode ?? 'inplace') === 'release'
  if (!releaseMode) {
    if (target.backup !== false && uploadDir) {
      push('backup', `发布前备份 ${uploadDir} → ${target.backupDir ?? `${uploadDir}.bak-<时间戳>`}(保留 ${target.keepReleases ?? 3} 份)`)
    } else if (target.backup === false) {
      push('backup', '备份已按目标配置关闭(backup: false)')
    }
  }

  // ── release mode: a new directory per publish plus a config switch ───────
  if (releaseMode) {
    const keep = target.keepReleases ?? 3
    if (target.releasesDir) push('release-dir', `新建发布目录 ${target.releasesDir}/<时间戳>`)
    else push('release-dir', '未配置 releasesDir —— release 模式无法继续')
    push('upload', 'SFTP 上传站点文件到新发布目录(排除 node_modules/.git 等)')
    if (target.configFile) {
      push('config-rewrite', `改写 ${target.configFile} 中 path="${target.contextPath ?? '/'}" 的 <Context> docBase → 新发布目录(先备份原文件)`)
      push('config-swap', '上传改写后的配置到临时文件,再 mv 覆盖(原来的配置留在 .bak-<时间戳>)')
    } else {
      push('config-rewrite', '未配置 configFile —— 无法切换到新发布目录')
    }
    if (target.restartOnDeploy === false) {
      push('restart', '按目标配置跳过重启(restartOnDeploy: false)')
    } else {
      const restartCommand = commandFor(kind, 'restart', target) ?? commandFor(kind, 'start', target)
      push('restart', '重启服务以加载新 docBase', restartCommand)
    }
    push('verify', 'curl 校验站点响应(含页面标题)')
    if (keep > 0) push('prune', `清理旧发布,只保留最近 ${keep} 个(旧的仍在磁盘,可回滚)`)
    return steps
  }

  const install = commandFor(kind, 'install', target)
  if (install && findings && !isServicePresent(kind, findings)) {
    push('install', `${(SERVICE_PLAYBOOK[kind] ?? {}).label ?? kind} 未安装,需要执行安装命令`, install)
  } else if (install) {
    push('install', '运行时已存在,跳过安装', install)
  }

  const stop = commandFor(kind, 'stop', target)
  const restart = commandFor(kind, 'restart', target) ?? commandFor(kind, 'start', target)
  if (target.restartOnDeploy === false) {
    push('restart', '按目标配置跳过停止/重启(restartOnDeploy: false,适用于直接从磁盘提供服务的静态内容)')
  } else {
    if (stop) push('stop', '停止服务', stop)
  }
  push('upload', 'SFTP 上传站点文件(排除 node_modules/.git 等)')
  if (target.restartOnDeploy !== false && restart) push('restart', '启动/重启服务', restart)
  if (target.scriptName) push('script', `随后执行插件存储中的脚本 ${target.scriptName}`)
  push('verify', '远程校验:列出上传目录、探测监听端口')
  return steps
}

export function isServicePresent(kind, findings) {
  if (!findings) return true
  switch (kind) {
    case 'httpd':
      return findings.httpd.present
    case 'nginx':
      return findings.nginx.present
    case 'tomcat':
      return findings.tomcat.present
    case 'docker':
      return findings.docker.present
    case 'static':
      return true
    default:
      return true
  }
}
