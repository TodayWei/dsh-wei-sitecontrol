/**
 * dsh-wei-sitecontrol — deploy: the SSH publisher.
 *
 * A publish is a sequence of reported steps:
 *
 *   collect → connect → detect → resolve uploadDir → (install) → script →
 *   upload (SFTP) → run remote script (backup / stop / start / verify) → health
 *
 * The transfer is Node's job (SFTP); the *remote* side belongs to the stored
 * shell script, which keeps that half readable and editable by the user.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { WORKSPACE_EXCLUDES, close, connect, exec, execStdin, fastPut, mkdirp, shellQuote, sftp } from './ssh.js'
import { PROBE_SCRIPT, buildSteps, commandFor, isServicePresent, parseProbeOutput, summarize } from './detect.js'
import { parseReleaseListing, previousRelease, releasePath, releaseStamp, rewriteDocBase } from './release.js'

/**
 * Defaults exclude dependency/cache/VCS noise only. Build output (`dist`,
 * `build`, `.next`, `out`) is deliberately NOT excluded: plenty of sites are
 * published exactly as built artifacts. A site can add them back through its
 * own `exclude` list when the remote builds for itself.
 */
export const DEFAULT_EXCLUDES = WORKSPACE_EXCLUDES
const MAX_FILES = 20000

function toPosix(p) {
  return p.split(sep).join('/')
}

function shouldSkip(relPath, excludes) {
  return toPosix(relPath).split('/').some((part) => excludes.includes(part))
}

/** Recursively list files to upload, honouring excludes and symlink safety. */
export function collectFiles(root, excludes) {
  const files = []
  const skipped = []
  const walk = (dir) => {
    if (files.length > MAX_FILES) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = toPosix(relative(root, abs))
      if (shouldSkip(rel, excludes)) {
        skipped.push(rel)
        continue
      }
      if (entry.isSymbolicLink()) {
        skipped.push(`${rel} (symlink)`)
        continue
      }
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) files.push({ abs, rel })
    }
  }
  walk(root)
  return { files, skipped }
}

/** Where to publish: the target's own setting first, the probe's suggestion second. */
export function suggestUploadDir(target, findings) {
  if (target.uploadDir) return { dir: target.uploadDir, source: 'target' }
  const kind = target.serviceKind ?? 'custom'
  if (kind === 'tomcat' && findings?.tomcat?.webapps) return { dir: findings.tomcat.webapps, source: 'detected' }
  if (kind === 'httpd' && findings?.webroots?.includes('/var/www/html')) return { dir: '/var/www/html', source: 'detected' }
  if (kind === 'nginx' && findings?.webroots?.includes('/usr/share/nginx/html')) return { dir: '/usr/share/nginx/html', source: 'detected' }
  const first = findings?.webroots?.[0]
  return first ? { dir: first, source: 'detected' } : { dir: null, source: null }
}

export class Deployer {
  constructor({ logger, vault = null, scripts = null } = {}) {
    this.logger = logger
    this.vault = vault
    this.scripts = scripts
  }

  /** Read-only reconnaissance: connect, probe, disconnect. */
  async detect(target) {
    let conn
    try {
      conn = await connect(target, { vault: this.vault, logger: this.logger })
      const result = await exec(conn, PROBE_SCRIPT, { timeoutMs: 60000 })
      const findings = parseProbeOutput(result.stdout)
      return {
        ok: true,
        findings,
        summary: summarize(findings, target),
        raw: result.stdout.trim().split('\n').slice(-40).join('\n'),
      }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    } finally {
      close(conn)
    }
  }

  /** Preview a publish. `detect: true` connects read-only to fill in real facts. */
  async plan(site, target, { detect = false, overrides = {} } = {}) {
    const effective = { ...target, ...overrides }
    let findings = null
    let summary = null
    if (detect) {
      const probe = await this.detect(effective)
      findings = probe.findings ?? null
      summary = probe.summary ?? probe.error ?? null
    }
    const suggested = suggestUploadDir(effective, findings)
    return {
      ok: true,
      steps: buildSteps({ site, target: effective, findings }),
      findings,
      summary,
      uploadDir: suggested.dir,
      uploadDirSource: suggested.source,
    }
  }

  /** Cheap connectivity check used by the panel's "test" action. */
  async ping(target) {
    let conn
    try {
      conn = await connect(target, { vault: this.vault, logger: this.logger })
      const result = await exec(conn, 'echo ok; (cat /etc/os-release 2>/dev/null | grep PRETTY_NAME) || uname -srm', { timeoutMs: 30000 })
      return { ok: result.code === 0, detail: result.stdout.trim() || result.stderr.trim() }
    } catch (err) {
      return { ok: false, detail: String(err?.message ?? err) }
    } finally {
      close(conn)
    }
  }

  /**
   * Publish one site to one target.
   *
   * @param {object}  options
   * @param {boolean} options.dryRun        report the plan locally and connect to nothing
   * @param {boolean} options.allowInstall  run the install command when the runtime is missing
   * @param {object}  options.overrides     one-off target field overrides (uploadDir, serviceKind…)
   */
  async deploy(site, target, { dryRun = false, allowInstall = false, overrides = {} } = {}) {
    const steps = []
    const effective = { ...target, ...overrides }
    const step = (name, ok, detail, extra = {}) => {
      steps.push({ name, ok, detail, ...extra })
      return ok
    }
    const root = site.workspace
    if (!existsSync(root)) {
      step('validate', false, `站点工作目录不存在:${root}`)
      return { ok: false, steps }
    }

    const configuredUploadDir = effective.uploadDir ?? effective.remotePath ?? null
    const releaseMode = (effective.deployMode ?? 'inplace') === 'release'
    // Release mode publishes into <releasesDir>/<stamp>, so uploadDir is not
    // required there; every other mode still must name its destination.
    if (!releaseMode && !configuredUploadDir && !dryRun) {
      step('validate', false, `目标 "${effective.name}" 未配置上传目录(uploadDir)—— 可先跑 site_server_detect 查看探测建议`)
      return { ok: false, steps }
    }

    const excludes = [...new Set([...DEFAULT_EXCLUDES, ...(site.exclude ?? [])])]
    const { files, skipped } = collectFiles(root, excludes)
    const totalBytes = files.reduce((sum, f) => sum + (statSync(f.abs).size || 0), 0)
    const truncated = files.length > MAX_FILES
    step(
      'collect',
      !truncated,
      `${Math.min(files.length, MAX_FILES)} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB, skipped ${skipped.length} paths${truncated ? ` — STOPPED at the ${MAX_FILES}-file cap` : ''}`,
    )
    if (truncated) return { ok: false, steps }

    // ── dry run: report the plan, connect to nothing ─────────────────────────
    if (dryRun) {
      const suggested = suggestUploadDir(effective, null)
      const planned = configuredUploadDir ?? suggested.dir
      step('connect', true, `dry-run: would connect to ${effective.user}@${effective.host}:${effective.port ?? 22}`)
      step('detect', true, 'dry-run: would probe OS, web servers, Tomcat and Docker')
      step('uploadDir', Boolean(planned), planned ?? '未配置(请在目标里设定 uploadDir)')
      step('upload', true, `dry-run: would upload ${files.length} files to ${planned ?? '?'}`)
      const install = commandFor(effective.serviceKind ?? 'custom', 'install', effective)
      step('install', true, install ? 'dry-run: would install the runtime when missing' : 'dry-run: nothing to install for this service kind')
      step('script', true, `dry-run: would run the stored script (${effective.scriptName || `${effective.name}-deploy`})`)
      step('restart', true, 'dry-run: would stop → upload → restart via the stored script')
      return { ok: true, steps }
    }

    // ── connect ──────────────────────────────────────────────────────────────
    let conn
    try {
      conn = await connect(effective, { vault: this.vault, logger: this.logger })
      step('connect', true, `${effective.user}@${effective.host}:${effective.port ?? 22}`)
    } catch (err) {
      step('connect', false, String(err?.message ?? err))
      return { ok: false, steps }
    }

    try {
      // ── detect ─────────────────────────────────────────────────────────────
      let findings = null
      let summary = null
      try {
        const probe = await exec(conn, PROBE_SCRIPT, { timeoutMs: 60000 })
        findings = parseProbeOutput(probe.stdout)
        summary = summarize(findings, effective)
        step('detect', true, (summary.split('\n')[0] ?? 'detected'), { summary })
      } catch (err) {
        step('detect', false, `探测失败(继续发布):${String(err?.message ?? err)}`)
      }

      // ── resolve the publish directory ──────────────────────────────────────
      const suggested = suggestUploadDir(effective, findings)
      const uploadDir = configuredUploadDir ?? suggested.dir
      if (!uploadDir) {
        step('uploadDir', false, '无法确定上传目录:既未在目标中配置,探测也未给出候选(可设 uploadDir 后重试)')
        return { ok: false, steps, findings, summary }
      }
      step('uploadDir', true, `${uploadDir}${suggested.source === 'detected' ? '(来自探测建议)' : ''}`)

      // ── install the runtime when it is missing ─────────────────────────────
      const kind = effective.serviceKind ?? 'custom'
      const installCommand = commandFor(kind, 'install', effective)
      const present = isServicePresent(kind, findings)
      if (!present && installCommand) {
        if (!allowInstall) {
          step('install', false, `运行时缺失,但本次未允许安装(需要 allowInstall)。将尝试用现有环境继续。`, { skipped: true })
        } else {
          const result = await exec(conn, installCommand, { timeoutMs: 600000 })
          const tail = `${result.stdout}${result.stderr}`.trim().split('\n').slice(-6).join('\n')
          const ok = step('install', result.code === 0, tail || `exit ${result.code}`)
          if (!ok) return { ok: false, steps, findings, summary }
        }
      } else if (installCommand) {
        step('install', true, '运行时已存在,跳过安装', { skipped: true })
      }

      // ── release mode: publish into a new timestamped directory, then point
      //    the web server's config at it (nothing is overwritten in place) ──
      if ((effective.deployMode ?? 'inplace') === 'release') {
        return await this.#deployRelease(conn, site, effective, { files, steps, findings, summary })
      }

      // ── the remote-side script (generated on first publish, editable after) ─
      let scriptName = effective.scriptName || `${effective.name}-deploy`
      let scriptText = null
      if (this.scripts) {
        const ensured = this.scripts.ensureFor({ ...effective, scriptName }, { findings })
        scriptName = ensured.name
        scriptText = ensured.content
        step('script', true, `${scriptName}.sh(${ensured.created ? '首次生成' : '沿用已存储版本'},${Buffer.byteLength(scriptText, 'utf8')} 字节)`, { scriptName })
      } else {
        step('script', false, '脚本仓库不可用,跳过远端脚本', { skipped: true })
      }

      // ── upload over SFTP ───────────────────────────────────────────────────
      const session = await sftp(conn)
      try {
        await mkdirp(session, uploadDir)
      } catch (err) {
        step('upload', false, `创建远端目录失败 ${uploadDir}:${err?.message ?? err}`)
        return { ok: false, steps, findings, summary }
      }
      let uploaded = 0
      const dirs = new Set([uploadDir])
      for (const file of files) {
        const remoteFile = `${uploadDir.replace(/\/$/, '')}/${file.rel}`
        const dir = remoteFile.slice(0, remoteFile.lastIndexOf('/'))
        if (dir && !dirs.has(dir)) {
          try {
            await mkdirp(session, dir)
          } catch (err) {
            step('upload', false, `创建远端目录失败 ${dir}:${err?.message ?? err}`)
            return { ok: false, steps, findings, summary }
          }
          dirs.add(dir)
        }
        try {
          await fastPut(session, file.abs, remoteFile)
        } catch (err) {
          step('upload', false, `上传 ${file.rel} → ${remoteFile} 失败:${err?.message ?? err}`)
          return { ok: false, steps, findings, summary }
        }
        uploaded += 1
      }
      step('upload', true, `${uploaded} files → ${uploadDir}`)

      // ── run it: backup → stop → (files already in place) → start → verify ──
      if (scriptText) {
        // The script arrives on stdin (`bash -s`), so the remote keeps no copy.
        const run = await execStdin(conn, 'bash -s', scriptText, { timeoutMs: 900000 })
        const tail = `${run.stdout}${run.stderr}`.trim().split('\n').slice(-12).join('\n')
        step('run-script', run.code === 0, tail || `exit ${run.code}`, { scriptName })
        if (run.code !== 0) {
          return { ok: false, steps, findings, summary, uploadDir }
        }
      }

      // ── local-side health probe, if the site declares one ─────────────────
      if (site.port) {
        const url = site.url || `http://127.0.0.1:${site.port}${site.healthPath || '/'}`
        step('health', true, `本站健康探测请针对远端地址执行:${url}(远端监听端口已在脚本输出中列出)`, { skipped: true })
      }

      return { ok: !steps.some((s) => !s.ok && !s.skipped), steps, findings, summary, uploadDir, scriptName }
    } catch (err) {
      step('error', false, String(err?.message ?? err))
      return { ok: false, steps }
    } finally {
      close(conn)
    }
  }

  // ── release mode ─────────────────────────────────────────────────────────

  /**
   * Publish into `<releasesDir>/<YYYYMMDD-HHMMSS>` and switch the config's
   * Context docBase to it. The previous release is left untouched on disk, so
   * `rollback()` is one config switch plus one restart.
   *
   * Safety rules: the config is only rewritten when the target Context is found
   * (otherwise the publish aborts before touching anything), the old config is
   * copied aside first, and the new config is uploaded to a temporary path and
   * then moved over the original.
   */
  async #deployRelease(conn, site, target, { files, steps, findings, summary }) {
    const step = (name, ok, detail, extra = {}) => {
      steps.push({ name, ok, detail, ...extra })
      return ok
    }
    const releasesDir = target.releasesDir
    const configFile = target.configFile
    if (!releasesDir) {
      step('validate', false, 'release 模式必须配置 releasesDir(发布目录的父目录,例如 /opt/releases)')
      return { ok: false, steps, findings, summary }
    }
    if (!configFile) {
      step('validate', false, 'release 模式必须配置 configFile(要改写 docBase 的配置文件,例如 /opt/tomcat9/conf/server.xml)')
      return { ok: false, steps, findings, summary }
    }

    const stamp = releaseStamp()
    const releaseDir = releasePath(releasesDir, stamp)
    step('release-dir', true, `${releaseDir}(本次发布目录)`)

    try {
      const dirResult = await exec(conn, `mkdir -p ${shellQuote(releaseDir)} && test -d ${shellQuote(releaseDir)} && echo ok`, { timeoutMs: 60000 })
      if (dirResult.code !== 0) {
        step('release-dir', false, `无法创建发布目录:${(dirResult.stderr || dirResult.stdout).trim()}`)
        return { ok: false, steps, findings, summary }
      }

      // ── upload into the release directory ────────────────────────────────
      const session = await sftp(conn)
      let uploaded = 0
      const dirs = new Set([releaseDir])
      for (const file of files) {
        const remoteFile = `${releaseDir.replace(/\/$/, '')}/${file.rel}`
        const dir = remoteFile.slice(0, remoteFile.lastIndexOf('/'))
        if (dir && !dirs.has(dir)) {
          try {
            await mkdirp(session, dir)
          } catch (err) {
            step('upload', false, `创建远端目录失败 ${dir}:${err?.message ?? err}`)
            return { ok: false, steps, findings, summary }
          }
          dirs.add(dir)
        }
        try {
          await fastPut(session, file.abs, remoteFile)
        } catch (err) {
          step('upload', false, `上传 ${file.rel} → ${remoteFile} 失败:${err?.message ?? err}`)
          return { ok: false, steps, findings, summary }
        }
        uploaded += 1
      }
      step('upload', true, `${uploaded} files → ${releaseDir}`)

      // ── switch the config over to the new release ────────────────────────
      const read = await exec(conn, `cat ${shellQuote(configFile)}`, { timeoutMs: 60000 })
      if (read.code !== 0 || read.stdout.trim() === '') {
        step('config-read', false, `读不到配置文件 ${configFile}:${(read.stderr || '').trim() || `exit ${read.code}`}`)
        return { ok: false, steps, findings, summary }
      }
      const rewritten = rewriteDocBase(read.stdout, { contextPath: target.contextPath ?? '/', newDocBase: releaseDir })
      if (!rewritten.changed) {
        step('config-rewrite', false, `拒绝改写配置:${rewritten.reason}`)
        return { ok: false, steps, findings, summary }
      }
      step('config-rewrite', true, `docBase:${rewritten.previousDocBase ?? '(原无)'} → ${releaseDir}`, {
        previousDocBase: rewritten.previousDocBase,
        releaseDir,
      })

      const backupPath = `${configFile}.bak-${stamp}`
      const tempPath = `${configFile}.new-${stamp}`
      const backup = await exec(conn, `cp -a ${shellQuote(configFile)} ${shellQuote(backupPath)}`, { timeoutMs: 60000 })
      if (backup.code !== 0) {
        step('config-backup', false, `备份配置失败:${(backup.stderr || '').trim()}`)
        return { ok: false, steps, findings, summary }
      }
      step('config-backup', true, backupPath)

      const configSession = await sftp(conn)
      await fastPut(configSession, await tempFile(rewritten.xml), tempPath)
      const swap = await exec(conn, `mv ${shellQuote(tempPath)} ${shellQuote(configFile)} && echo ok`, { timeoutMs: 60000 })
      if (swap.code !== 0) {
        step('config-swap', false, `替换配置失败(原文件仍在,备份在 ${backupPath}):${(swap.stderr || '').trim()}`)
        return { ok: false, steps, findings, summary }
      }
      step('config-swap', true, `${configFile} 已指向新发布`)

      // ── restart the service so the new docBase takes effect ──────────────
      if (target.restartOnDeploy === false) {
        step('restart', true, '按目标配置跳过重启(restartOnDeploy: false);Context reloadable=true 时会自行加载', { skipped: true })
      } else {
        const restart = commandFor(target.serviceKind ?? 'custom', 'restart', target)
        if (!restart) {
          step('restart', false, `服务类型 ${target.serviceKind} 没有可用的重启命令,请配置 restartCommand`, { skipped: true })
        } else {
          const result = await exec(conn, restart, { timeoutMs: 180000 })
          const tail = `${result.stdout}${result.stderr}`.trim().split('\n').slice(-4).join('\n')
          step('restart', result.code === 0, tail || `exit ${result.code}`)
        }
      }

      // ── verify the site actually answers ─────────────────────────────────
      const probe = await exec(
        conn,
        `sleep 3; code=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/ 2>/dev/null || true); ` +
          `echo "https=$code"; title=$(curl -sk https://127.0.0.1/ 2>/dev/null | grep -oE '<title>[^<]*</title>' | head -1); echo "title=$title"`,
        { timeoutMs: 90000 },
      )
      const probeText = probe.stdout.trim()
      const codeOk = /https=2\d\d|https=3\d\d/.test(probeText)
      step('verify', codeOk, probeText.replace(/\n/g, ' · ') || '未取得响应', { important: true })

      // ── keep the newest N releases, drop the rest ────────────────────────
      const keep = Number(target.keepReleases ?? 3)
      if (keep > 0) {
        const prune = await exec(
          conn,
          `ls -1dt ${shellQuote(releasesDir)}/*/ 2>/dev/null | tail -n +${keep + 1} | xargs -r rm -rf`,
          { timeoutMs: 120000 },
        )
        step('prune', prune.code === 0, `保留最近 ${keep} 个发布目录${prune.code === 0 ? '' : `:${(prune.stderr || '').trim()}`}`)
      }

      const failed = steps.some((s) => !s.ok && !s.skipped)
      return { ok: !failed, steps, findings, summary, uploadDir: releaseDir, release: { stamp, dir: releaseDir, configFile, previousDocBase: rewritten.previousDocBase } }
    } catch (err) {
      step('error', false, String(err?.message ?? err))
      return { ok: false, steps, findings, summary }
    }
  }

  /** Newest-first release directories for a target. */
  async releases(target) {
    let conn
    try {
      conn = await connect(target, { vault: this.vault, logger: this.logger })
      const dir = target.releasesDir
      if (!dir) return { ok: false, error: '目标未配置 releasesDir' }
      const result = await exec(conn, `ls -1dt ${shellQuote(dir)}/*/ 2>/dev/null | head -50`, { timeoutMs: 60000 })
      const config = target.configFile ? await exec(conn, `cat ${shellQuote(target.configFile)} 2>/dev/null`, { timeoutMs: 60000 }) : null
      const current = config?.code === 0 ? (listCurrentDocBase(config.stdout, target.contextPath ?? '/') ?? null) : null
      return { ok: true, releases: parseReleaseListing(result.stdout, dir), currentDocBase: current }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    } finally {
      close(conn)
    }
  }

  /**
   * Point the config back at an earlier release and restart. `to` may be a
   * release name; omitted, the previous release is used.
   */
  async rollback(site, target, { to = null } = {}) {
    const steps = []
    const step = (name, ok, detail) => {
      steps.push({ name, ok, detail })
      return ok
    }
    let conn
    try {
      conn = await connect(target, { vault: this.vault, logger: this.logger })
      step('connect', true, `${target.user}@${target.host}:${target.port ?? 22}`)

      const dir = target.releasesDir
      const configFile = target.configFile
      if (!dir || !configFile) return { ok: false, steps, error: '回滚需要 releasesDir 与 configFile' }

      const listing = await exec(conn, `ls -1dt ${shellQuote(dir)}/*/ 2>/dev/null | head -50`, { timeoutMs: 60000 })
      const releases = parseReleaseListing(listing.stdout, dir)
      if (releases.length === 0) return { ok: false, steps, error: `没有找到任何发布目录(${dir})` }

      const config = await exec(conn, `cat ${shellQuote(configFile)}`, { timeoutMs: 60000 })
      if (config.code !== 0) return { ok: false, steps, error: `读不到配置文件 ${configFile}` }
      const currentDocBase = listCurrentDocBase(config.stdout, target.contextPath ?? '/')
      const currentName = currentDocBase ? currentDocBase.split('/').filter(Boolean).pop() : null
      const chosen = to ? releases.find((r) => r.name === to) ?? { name: to, path: releasePath(dir, to) } : previousRelease(releases, currentName)
      if (!chosen) {
        step('choose', false, `当前已是列表中最旧的发布(${currentName}),没有更早的可以回滚`)
        return { ok: false, steps }
      }
      step('choose', true, `回滚目标:${chosen.name}(当前:${currentName ?? '未知'})`)

      const rewritten = rewriteDocBase(config.stdout, { contextPath: target.contextPath ?? '/', newDocBase: chosen.path })
      if (!rewritten.changed) {
        step('config-rewrite', false, `拒绝改写配置:${rewritten.reason}`)
        return { ok: false, steps }
      }
      const stamp = releaseStamp()
      const backupPath = `${configFile}.bak-rollback-${stamp}`
      const backup = await exec(conn, `cp -a ${shellQuote(configFile)} ${shellQuote(backupPath)}`, { timeoutMs: 60000 })
      step('config-backup', backup.code === 0, backupPath)
      if (backup.code !== 0) return { ok: false, steps }

      const tempPath = `${configFile}.new-${stamp}`
      const session = await sftp(conn)
      await fastPut(session, await tempFile(rewritten.xml), tempPath)
      const swap = await exec(conn, `mv ${shellQuote(tempPath)} ${shellQuote(configFile)} && echo ok`, { timeoutMs: 60000 })
      step('config-swap', swap.code === 0, `${configFile} → ${chosen.path}`)
      if (swap.code !== 0) return { ok: false, steps }

      const restart = commandFor(target.serviceKind ?? 'custom', 'restart', target)
      if (restart) {
        const result = await exec(conn, restart, { timeoutMs: 180000 })
        step('restart', result.code === 0, `${result.stdout}${result.stderr}`.trim().split('\n').slice(-3).join(' · ') || `exit ${result.code}`)
      }
      const probe = await exec(conn, `sleep 3; curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/ 2>/dev/null || true`, { timeoutMs: 90000 })
      step('verify', /2\d\d|3\d\d/.test(probe.stdout), `https=${probe.stdout.trim()}`)
      return { ok: !steps.some((s) => !s.ok), steps, rolledBackTo: chosen.path, configFile }
    } catch (err) {
      step('error', false, String(err?.message ?? err))
      return { ok: false, steps }
    } finally {
      close(conn)
    }
  }
}

/** The docBase of the Context serving `contextPath`, or null. */
function listCurrentDocBase(xml, contextPath) {
  for (const context of listContextsSafe(xml)) {
    if (context.path === contextPath) return context.docBase
  }
  return null
}

function listContextsSafe(xml) {
  const out = []
  const tagRe = /<Context\b[^>]*?\/?>/g
  let match
  while ((match = tagRe.exec(String(xml ?? ''))) !== null) {
    const attrs = {}
    const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    let attr
    while ((attr = attrRe.exec(match[0])) !== null) attrs[attr[1]] = attr[3] ?? attr[4] ?? ''
    out.push({ path: attrs.path ?? '', docBase: attrs.docBase ?? null })
  }
  return out
}

/** Write config text to a temp file so SFTP can upload it. */
async function tempFile(text) {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sm-config-'))
  const file = join(dir, 'config.xml')
  writeFileSync(file, text, 'utf8')
  return file
}
