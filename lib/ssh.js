/**
 * dsh-wei-sitecontrol — ssh: connection, command and transfer primitives.
 *
 * Every credential path resolves through the vault (or an explicit on-disk key
 * / password for machines that predate it). Nothing here ever returns key
 * material to a caller that renders.
 */
import ssh2 from 'ssh2'
import { existsSync, readFileSync } from 'node:fs'

// ssh2 ships CommonJS: named ESM imports are not reliably detected, so take the
// default export and destructure. (`Client` happens to be lexer-visible while
// `utils` is not, which is exactly the kind of trap this avoids.)
const { Client } = ssh2

export const WORKSPACE_EXCLUDES = ['node_modules', '.git', '.dsh', '.cache', '__pycache__', '.venv', '.idea', '.vscode', '.DS_Store']

/** Open a connection, resolving the credential from whichever source the target names. */
export function connect(target, { vault = null, logger = null, readyTimeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    const options = {
      host: target.host,
      port: target.port ?? 22,
      username: target.user ?? 'root',
      readyTimeout,
      keepaliveInterval: 10000,
    }
    try {
      if (target.keyName) {
        if (!vault) throw new Error('target uses a vault key but no vault is available')
        options.privateKey = vault.read(target.keyName)
        if (target.passphrase) options.passphrase = target.passphrase
      } else if (target.privateKey) {
        options.privateKey = target.privateKey
        if (target.passphrase) options.passphrase = target.passphrase
      } else if (target.privateKeyPath) {
        if (!existsSync(target.privateKeyPath)) throw new Error(`私钥文件不存在:${target.privateKeyPath}`)
        options.privateKey = readFileSync(target.privateKeyPath)
        if (target.passphrase) options.passphrase = target.passphrase
      }
      if (target.password) options.password = target.password
    } catch (err) {
      reject(err)
      return
    }
    conn.on('ready', () => resolve(conn))
    conn.on('error', (err) => {
      logger?.warn?.('[dsh-wei-sitecontrol] ssh error %s@%s:%s — %s', target.user, target.host, target.port, err.message)
      reject(err)
    })
    conn.connect(options)
  })
}

/** Run one shell command and collect its output. Never rejects on a non-zero exit. */
export function exec(conn, command, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        conn.end()
      } catch {
        /* already closed */
      }
      reject(new Error(`command timed out after ${timeoutMs}ms: ${command.slice(0, 80)}`))
    }, timeoutMs)
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk) => {
        stdout += String(chunk)
      })
      stream.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      stream.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 0, stdout, stderr })
      })
      stream.on('error', (streamErr) => {
        clearTimeout(timer)
        reject(streamErr)
      })
    })
  })
}

export function sftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, session) => (err ? reject(err) : resolve(session)))
  })
}

/**
 * Run a command whose body arrives on stdin. Used for stored deploy scripts so
 * the remote never keeps a copy on disk (`bash -s`).
 */
export function execStdin(conn, command, input, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        conn.end()
      } catch {
        /* already closed */
      }
      reject(new Error(`remote script timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk) => {
        stdout += String(chunk)
      })
      stream.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      stream.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 0, stdout, stderr })
      })
      stream.on('error', (streamErr) => {
        clearTimeout(timer)
        reject(streamErr)
      })
      stream.end(String(input ?? ''))
    })
  })
}

/**
 * Create a remote directory chain.
 *
 * `sftp.mkdir(path, { recursive: true }, cb)` does NOT recurse — ssh2 takes the
 * second argument as file attributes, so a nested path silently failed and the
 * next `fastPut` died with "No such file". Each level is therefore created
 * explicitly, and a real error is raised instead of swallowed.
 */
export function mkdirp(session, dir) {
  const normalized = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '' || normalized === '/') return Promise.resolve()
  const absolute = normalized.startsWith('/')
  const segments = normalized.split('/').filter(Boolean)
  let current = absolute ? '' : null
  return segments.reduce(
    (chain, segment) =>
      chain.then(
        () =>
          new Promise((resolve, reject) => {
            current = current === null ? segment : `${current}/${segment}`
            const target = current
            session.mkdir(target, (err) => {
              // SFTP reports "already exists" as SSH_FX_FAILURE (4) in v3 and as
              // FILE_ALREADY_EXISTS (11) in later versions.
              if (!err || err.code === 4 || err.code === 11) {
                resolve()
                return
              }
              reject(new Error(`mkdir ${target} 失败:${err.message}`))
            })
          }),
      ),
    Promise.resolve(),
  )
}

export function fastPut(session, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    session.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()))
  })
}

export function close(conn) {
  try {
    conn?.end()
  } catch {
    /* already closed */
  }
}

/** POSIX single-quote a value for safe interpolation into a remote command. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** `systemctl stop x` style runner that also reports a missing unit clearly. */
export function serviceCommand(kind, action, serviceName) {
  const name = serviceName || defaultServiceName(kind)
  if (!name) return null
  return `systemctl ${action} ${name}`
}

export function defaultServiceName(kind) {
  switch (kind) {
    case 'httpd':
      return 'httpd'
    case 'nginx':
      return 'nginx'
    case 'tomcat':
      return 'tomcat'
    default:
      return null
  }
}
