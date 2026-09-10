/**
 * dsh-wei-sitecontrol — scripts: the SSH deploy script store.
 *
 * A target may carry a named shell script kept in the plugin's own storage
 * (`<dataDir>/scripts/<name>.sh`). The script owns the *remote* side of a
 * publish — backup, stop, start, verify — while the file transfer itself is
 * done over SFTP by the deployer. `ensureFor()` writes a commented default the
 * first time a target is published, so the user has something concrete to edit
 * instead of an empty box.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SERVICE_PLAYBOOK, commandFor } from './detect.js'

// Same rule as the key vault: Unicode is fine, path syntax and control
// characters are not.
const NAME_RE = /^[^\s\\/:*?"<>|\u0000-\u001f][^\\/:*?"<>|\u0000-\u001f]{0,63}$/
const MAX_SCRIPT_BYTES = 256 * 1024

export class ScriptStore {
  constructor({ dataDir, logger }) {
    this.dir = join(dataDir, 'scripts')
    this.logger = logger
    mkdirSync(this.dir, { recursive: true })
  }

  #path(name) {
    const clean = String(name ?? '').trim()
    if (!NAME_RE.test(clean) || clean === '.' || clean === '..') {
      throw new Error('脚本名不合法:不能包含 \\ / : * ? " < > | 或控制字符,长度 1-64,首字符不能是空白')
    }
    return join(this.dir, `${clean}.sh`)
  }

  list() {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((file) => file.endsWith('.sh'))
      .map((file) => {
        const stat = statSync(join(this.dir, file))
        return { name: file.replace(/\.sh$/, ''), bytes: stat.size, updatedAt: stat.mtime.toISOString() }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Write the exact bytes the remote will run; atomic, so a half-write never runs. */
  save(name, content) {
    const text = String(content ?? '')
    if (text.trim() === '') throw new Error('脚本内容为空')
    if (Buffer.byteLength(text, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('脚本过大(>256KB)')
    const dest = this.#path(name)
    const tmp = `${dest}.incoming`
    writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
    renameSync(tmp, dest)
    const stat = statSync(dest)
    return { name: String(name), bytes: stat.size, updatedAt: stat.mtime.toISOString() }
  }

  read(name) {
    const file = this.#path(name)
    if (!existsSync(file)) throw new Error(`脚本 "${name}" 不存在`)
    return readFileSync(file, 'utf8')
  }

  remove(name) {
    const file = this.#path(name)
    if (!existsSync(file)) throw new Error(`脚本 "${name}" 不存在`)
    rmSync(file, { force: true })
    return { name: String(name), removed: true }
  }

  /** The default remote-side script for a target; safe to hand to a human to edit. */
  generate(target = {}, findings = null) {
    const kind = target.serviceKind ?? 'custom'
    const label = (SERVICE_PLAYBOOK[kind] ?? {}).label ?? kind
    const uploadDir = target.uploadDir ?? target.remotePath ?? '<待配置 uploadDir>'
    const stop = commandFor(kind, 'stop', target)
    const restart = commandFor(kind, 'restart', target) ?? commandFor(kind, 'start', target)
    const install = commandFor(kind, 'install', target)
    const backupDir = target.backupDir ?? `${uploadDir}.bak`
    const keep = target.keepReleases ?? 3
    const stamp = new Date().toISOString()

    return `#!/usr/bin/env bash
# dsh-wei-sitecontrol 生成的发布脚本(远端侧)
# 目标:${target.name}  ${target.user ?? 'root'}@${target.host}:${target.port ?? 22}   服务类型:${label}(${kind})
${target.environment ? `# 环境描述:${target.environment}\n` : ''}${target.appHome ? `# 运行时目录:${target.appHome}\n` : ''}${target.serviceName ? `# 服务单元:${target.serviceName}\n` : ''}# 生成时间:${stamp}
#
# 执行时机:文件已由 SFTP 上传到 UPLOAD_DIR 之后,由 dsh-wei-sitecontrol 通过
#   bash -s(标准输入)执行,不在远端留下脚本文件。
# 你可以直接编辑本文件;发布时按顺序执行,set -e 保证任一步失败即中止。
${findings ? `# 最近一次探测:${findings.os?.pretty ?? findings.os?.id ?? '未知系统'};httpd=${findings.httpd?.present ? 'yes' : 'no'} nginx=${findings.nginx?.present ? 'yes' : 'no'} tomcat=${findings.tomcat?.present ? 'yes' : 'no'} docker=${findings.docker?.present ? 'yes' : 'no'}\n` : ''}
set -euo pipefail

UPLOAD_DIR=${shell(uploadDir)}
BACKUP_DIR=${shell(backupDir)}
KEEP_RELEASES=${keep}
${target.scriptName ? `# 注意:本脚本自身的名字是 ${target.scriptName}` : ''}

log() { echo "[deploy] $*"; }

# ── 1. 环境检查 ────────────────────────────────────────────────────────────
log "检查上传目录 $UPLOAD_DIR"
mkdir -p "\${UPLOAD_DIR}"
[ -d "\${UPLOAD_DIR}" ] || { echo "[deploy] 上传目录不存在且无法创建"; exit 1; }
command -v systemctl >/dev/null 2>&1 && log "systemd 可用" || log "无 systemd,将直接调用服务命令"

# ── 2. 备份当前版本 ────────────────────────────────────────────────────────
if [ -n "$(ls -A "\${UPLOAD_DIR}" 2>/dev/null || true)" ]; then
  mkdir -p "\${BACKUP_DIR}"
  SNAP="\${BACKUP_DIR}/$(date +%Y%m%d-%H%M%S)"
  log "备份 \${UPLOAD_DIR} → \${SNAP}"
  cp -a "\${UPLOAD_DIR}/." "\${SNAP}/" 2>/dev/null || true
  # 只保留最近 KEEP_RELEASES 份,旧的自动清理
  ls -1dt "\${BACKUP_DIR}"/* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
else
  log "上传目录为空,跳过备份"
fi

${target.restartOnDeploy === false
    ? `# ── 3/4. 跳过停止与启动(目标配置 restartOnDeploy: false)────────────────────
# 该站点直接从磁盘提供服务(静态内容),文件上传完成即生效;需要重启时把
# 目标里的 restartOnDeploy 改回 true,或在下面自行添加命令。`
    : `# ── 3. 停止服务 ────────────────────────────────────────────────────────────
${stop ? `log "停止服务"\n${stop}` : '# 未配置停止命令(静态站点通常无需停止)'}

# (SFTP 上传在此时由 dsh-wei-sitecontrol 完成,本脚本不负责传文件)

# ── 4. 启动 / 重启服务 ─────────────────────────────────────────────────────
${restart ? `log "启动服务"\n${restart}` : '# 未配置启动命令'}`}

# ── 5. 校验 ────────────────────────────────────────────────────────────────
log "上传目录内容(前 20 项)"
ls -lh "\${UPLOAD_DIR}" | head -20 || true
log "监听端口(前 15 行)"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | head -15 || true
${install ? `\n# 参考:该服务类型的安装命令(仅首次需要,默认不执行)\n# ${install.replace(/\n/g, '\n# ')}\n` : ''}
log "完成"
`
  }

  /** Return the target's script, creating the default on first use. */
  ensureFor(target, { findings = null } = {}) {
    const name = target.scriptName || `${target.name}-deploy`
    const file = this.#path(name)
    if (!existsSync(file)) {
      const content = this.generate(target, findings)
      this.save(name, content)
      this.logger?.info?.('[dsh-wei-sitecontrol] 已为 %s 生成默认发布脚本 %s.sh', target.name, name)
      return { name, created: true, content }
    }
    return { name, created: false, content: this.read(name) }
  }
}

/** single-quote for bash */
function shell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
