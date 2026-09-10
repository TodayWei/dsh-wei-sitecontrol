/**
 * dsh-wei-sitecontrol — vault: the private-key store.
 *
 * Design rules, in order of importance:
 *
 *  1. Key material never leaves this module as text. `read()` returns bytes for
 *     the SSH client only; every API/tool/log path uses `describe()`/`list()`,
 *     which expose metadata plus a public-key fingerprint and nothing else.
 *  2. Keys land on disk with owner-only access: `chmod 600` on POSIX and an
 *     explicit `icacls` grant (inheritance removed) on Windows.
 *  3. A key is validated at import time. A PEM that cannot be parsed is
 *     rejected; a passphrase-protected key is accepted and marked `encrypted`
 *     (no fingerprint, since the public half needs the passphrase).
 *  4. The fingerprint is the ssh-keygen style SHA256 of the public blob, so a
 *     human can confirm the stored key really is the one they meant to upload.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import ssh2 from 'ssh2'

// ssh2 is CommonJS; its `utils` is not exposed as a named ESM export.
const { utils } = ssh2

// Unicode names are allowed (server profiles are often named in Chinese), but
// nothing that could traverse or confuse a path, and no control characters.
const NAME_RE = /^[^\s\\/:*?"<>|\u0000-\u001f][^\\/:*?"<>|\u0000-\u001f]{0,63}$/
const MAX_KEY_BYTES = 64 * 1024
const PEM_MARKER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

function assertKeyName(name) {
  const clean = String(name ?? '').trim()
  if (!NAME_RE.test(clean) || clean === '.' || clean === '..') {
    throw new Error('密钥名不合法:不能包含 \\ / : * ? " < > | 或控制字符,长度 1-64,首字符不能是空白')
  }
  return clean
}

/** Parse the PEM just enough to classify it, never to expose it. */
function inspect(text) {
  const parsed = utils.parseKey(text)
  if (parsed instanceof Error) {
    // An encrypted key is a legitimate key: the public half simply needs the
    // passphrase, so no fingerprint is reported.
    if (/passphrase/i.test(parsed.message)) return { ok: true, encrypted: true, keyType: null, fingerprint: null, warning: null }
    // PKCS#8 ("BEGIN PRIVATE KEY") is not usable by the built-in SSH client.
    // Store it anyway and say so loudly, instead of silently failing at connect.
    if (/unsupported key format/i.test(parsed.message)) {
      return {
        ok: true,
        encrypted: false,
        keyType: 'unsupported-format',
        fingerprint: null,
        warning: '该 PEM 格式(PKCS#8 / "BEGIN PRIVATE KEY")不受内置 SSH 客户端支持;请用 `ssh-keygen -p -m PEM -f key.pem` 转为 PEM,或改用 OpenSSH 格式密钥。',
      }
    }
    return { ok: false, error: parsed.message }
  }
  let fingerprint = null
  let keyType = parsed.type ?? null
  try {
    const publicBlob = parsed.getPublicSSH()
    fingerprint = `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`
  } catch {
    /* a key whose public half is unavailable still works for auth */
  }
  return { ok: true, encrypted: false, keyType, fingerprint, warning: null }
}

export class KeyVault {
  constructor({ dataDir, logger }) {
    this.dir = join(dataDir, 'keys')
    mkdirSync(this.dir, { recursive: true })
    this.logger = logger
    this.#restrictDir()
  }

  #restrictDir() {
    try {
      chmodSync(this.dir, 0o700)
    } catch {
      /* Windows has no POSIX mode; the ACL pass below covers it */
    }
    if (process.platform === 'win32') {
      try {
        const user = process.env.USERNAME || process.env.USER
        if (user) execFileSync('icacls', [this.dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' })
      } catch (err) {
        this.logger?.warn?.('[dsh-wei-sitecontrol] 无法收紧密钥目录 ACL: %s', err?.message ?? err)
      }
    }
  }

  #path(name) {
    return join(this.dir, `${assertKeyName(name)}.pem`)
  }

  /** Import a key from pasted content or from a path on this machine. */
  add(name, { content, path: sourcePath, overwrite = false } = {}) {
    const dest = this.#path(name)
    if (existsSync(dest) && !overwrite) throw new Error(`密钥 "${name}" 已存在(如需替换请显式覆盖)`)
    let bytes
    if (typeof content === 'string' && content.trim() !== '') bytes = Buffer.from(content, 'utf8')
    else if (typeof sourcePath === 'string' && sourcePath.trim() !== '') {
      if (!existsSync(sourcePath)) throw new Error(`文件不存在:${sourcePath}`)
      bytes = readFileSync(sourcePath)
    } else {
      throw new Error('需要提供 content 或 path 之一')
    }
    if (bytes.length === 0) throw new Error('密钥内容为空')
    if (bytes.length > MAX_KEY_BYTES) throw new Error(`密钥文件过大(${bytes.length} 字节),请确认是 PEM 私钥`)
    const text = bytes.toString('utf8')
    if (!PEM_MARKER.test(text)) throw new Error('内容不像 PEM 私钥(缺少 "-----BEGIN ... PRIVATE KEY-----")')
    const info = inspect(text)
    if (!info.ok) throw new Error(`密钥无法解析:${info.error}`)

    const tmp = `${dest}.incoming`
    writeFileSync(tmp, bytes, { mode: 0o600 })
    renameSync(tmp, dest)
    this.#restrictFile(dest)
    this.logger?.info?.('[dsh-wei-sitecontrol] 已导入密钥 "%s"(%d 字节%s)', name, bytes.length, info.fingerprint ? `,${info.fingerprint}` : ',加密私钥')
    if (info.warning) this.logger?.warn?.('[dsh-wei-sitecontrol] 密钥 "%s":%s', name, info.warning)
    return this.describe(name)
  }

  #restrictFile(file) {
    try {
      chmodSync(file, 0o600)
    } catch {
      /* Windows: handled below */
    }
    if (process.platform !== 'win32') return
    try {
      const user = process.env.USERNAME || process.env.USER
      if (!user) return
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, stdio: 'ignore' })
    } catch (err) {
      this.logger?.warn?.('[dsh-wei-sitecontrol] 无法收紧密钥文件 ACL(%s),请人工确认权限', err?.message ?? err)
    }
  }

  /** Metadata only — this is what every API and tool surface may see. */
  describe(name) {
    const file = this.#path(name)
    if (!existsSync(file)) return null
    const stat = statSync(file)
    const info = inspect(readFileSync(file, 'utf8'))
    return {
      name: String(name),
      bytes: stat.size,
      uploadedAt: stat.mtime.toISOString(),
      encrypted: info.encrypted === true,
      keyType: info.keyType ?? null,
      fingerprint: info.fingerprint ?? null,
      warning: info.warning ?? null,
    }
  }

  list() {
    return readdirSync(this.dir)
      .filter((file) => file.endsWith('.pem'))
      .map((file) => this.describe(file.replace(/\.pem$/, '')))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Bytes for the SSH client. Never return this to a caller that renders. */
  read(name) {
    const file = this.#path(name)
    if (!existsSync(file)) throw new Error(`密钥 "${name}" 不存在,请先用 site_key_add 导入`)
    return readFileSync(file)
  }

  has(name) {
    try {
      return existsSync(this.#path(name))
    } catch {
      return false
    }
  }

  remove(name) {
    const file = this.#path(name)
    if (!existsSync(file)) throw new Error(`密钥 "${name}" 不存在`)
    rmSync(file, { force: true })
    return { name: String(name), removed: true }
  }
}
