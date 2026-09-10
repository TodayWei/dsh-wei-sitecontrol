/**
 * dsh-wei-sitecontrol — lifecycle: the process supervisor for registered sites.
 *
 * Sites run as children of the DSH process (so they are reclaimed when DSH
 * exits), with a small status machine, a per-site log ring buffer plus an
 * on-disk append log, an optional health probe, and bounded auto-restart.
 *
 * Cross-platform stop: POSIX signals the process group; Windows uses
 * `taskkill /T /F` so npm/pnpm shim trees actually die.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RING_DEFAULT = 5000
const STOP_GRACE_DEFAULT = 3000
const RESTART_MAX = 5
const RESTART_BASE_MS = 1000
const HEALTH_TIMEOUT_MS = 3000

/** Read a process command line, or null when it cannot be read. */
export function processCommandLine(pid) {
  if (!pid) return null
  try {
    if (process.platform !== 'win32') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null
    }
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    )
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * The distinctive tokens of a site's own start command, used to recognise the
 * process that site left behind. Script file names and port numbers survive
 * into the child's command line; the interpreter path and generic flags do not.
 */
export function signatureTokens(command) {
  return String(command ?? '')
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter(
      (token) =>
        token !== '' &&
        !token.startsWith('-') &&
        // Script names (`gallery_server.js`, `http.server`), ports, and paths
        // survive into a child's command line; interpreters and flags do not.
        (/[.]/.test(token) || /^\d{2,5}$/.test(token) || /[/\\]/.test(token)),
    )
}

/**
 * Whether a candidate command line is this site's own orphan. Deliberately
 * conservative: every distinctive token must appear, and anything that looks
 * like the harness itself is refused outright.
 */
export function matchesSiteCommand(cmdline, command) {
  if (!cmdline) return false
  const lower = cmdline.toLowerCase()
  if (lower.includes('@deepseek-ai/dsh') || lower.includes('lib\\bin.js') || lower.includes('lib/bin.js')) return false
  const tokens = signatureTokens(command)
  if (tokens.length === 0) return false
  return tokens.every((token) => cmdline.includes(token))
}

const LIVE_STATES = new Set(['starting', 'running', 'unhealthy'])

/**
 * Best-effort lookup of the process listening on a TCP port.
 *
 * A site's preview server is a child of DSH, so a hard kill of DSH can leave
 * that child alive holding the port; the next DSH boot then cannot start the
 * site. Knowing the owning pid turns an opaque EADDRINUSE into something the
 * panel and the agent can act on. Windows-only (netstat -ano); elsewhere the
 * pre-check is skipped rather than blocking a legitimate start.
 */
export function portOwner(port) {
  if (process.platform !== 'win32' || !port) return null
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    const needle = `:${port}`
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      const cols = line.trim().split(/\s+/)
      const local = cols[1] ?? ''
      if (!local.endsWith(needle)) continue
      const pid = Number(cols[cols.length - 1])
      if (Number.isFinite(pid) && pid > 0) return pid
    }
  } catch {
    /* netstat unavailable — skip the pre-check rather than block a start */
  }
  return null
}

export class Supervisor {
  constructor({ dataDir, logger, ringLines = RING_DEFAULT, stopGraceMs = STOP_GRACE_DEFAULT }) {
    this.dataDir = dataDir
    this.logger = logger
    this.ringLines = ringLines
    this.stopGraceMs = stopGraceMs
    this.logDir = join(dataDir, 'logs')
    mkdirSync(this.logDir, { recursive: true })
    /** @type {Map<string, { child: import('node:child_process').ChildProcess|null, state: string, pid: number|null, startedAt: string|null, exitCode: number|null, restarts: number, ring: string[], health: object|null }>} */
    this.runtime = new Map()
    /** @type {Set<(siteId: string, status: object) => void>} */
    this.listeners = new Set()
    this.disposed = false
  }

  logPath(siteId) {
    return join(this.logDir, `${siteId}.log`)
  }

  /** Runtime slot, created on demand. */
  slot(siteId) {
    let entry = this.runtime.get(siteId)
    if (!entry) {
      entry = { child: null, state: 'stopped', pid: null, startedAt: null, exitCode: null, restarts: 0, ring: [], health: null, stopping: false, timer: null, conflict: null }
      this.runtime.set(siteId, entry)
    }
    return entry
  }

  status(siteId) {
    const entry = this.slot(siteId)
    return {
      state: entry.state,
      pid: entry.pid,
      startedAt: entry.startedAt,
      exitCode: entry.exitCode,
      restarts: entry.restarts,
      health: entry.health,
      conflict: entry.conflict ?? null,
    }
  }

  isLive(siteId) {
    return LIVE_STATES.has(this.slot(siteId).state)
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(siteId) {
    const status = this.status(siteId)
    for (const fn of [...this.listeners]) {
      try {
        fn(siteId, status)
      } catch (err) {
        this.logger?.warn?.('[dsh-wei-sitecontrol] listener failed: %s', err?.message ?? err)
      }
    }
  }

  pushLine(siteId, line) {
    const entry = this.slot(siteId)
    entry.ring.push(line)
    if (entry.ring.length > this.ringLines) entry.ring.splice(0, entry.ring.length - this.ringLines)
    try {
      appendFileSync(this.logPath(siteId), `${line}\n`, 'utf8')
    } catch (err) {
      this.logger?.warn?.('[dsh-wei-sitecontrol] log append failed: %s', err.message)
    }
  }

  clearLog(siteId) {
    try {
      writeFileSync(this.logPath(siteId), '', 'utf8')
    } catch {
      /* nothing to clear */
    }
    this.slot(siteId).ring = []
  }

  readLog(siteId, { tail = 500, search = '' } = {}) {
    const entry = this.slot(siteId)
    let lines = entry.ring
    if (lines.length === 0 && existsSync(this.logPath(siteId))) {
      try {
        const size = statSync(this.logPath(siteId)).size
        // Cap what a single read pulls back from disk: the log file grows
        // unbounded, but the API only ever answers with a tail window.
        const maxBytes = 2 * 1024 * 1024
        const raw = size > maxBytes ? readFileSync(this.logPath(siteId)).subarray(size - maxBytes).toString('utf8') : readFileSync(this.logPath(siteId), 'utf8')
        const all = raw.split(/\r?\n/)
        lines = all.slice(Math.max(0, all.length - Math.max(tail, 200)))
      } catch {
        lines = []
      }
    }
    const needle = String(search ?? '').trim().toLowerCase()
    const filtered = needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines
    return filtered.slice(Math.max(0, filtered.length - Math.max(1, Math.min(10000, Number(tail) || 500))))
  }

  /** Start one site. Idempotent when already live. */
  start(site) {
    if (this.disposed) throw new Error('supervisor is disposed')
    if (!site.command) throw new Error(`site "${site.name}" has no start command`)
    const entry = this.slot(site.id)
    if (LIVE_STATES.has(entry.state)) return this.status(site.id)
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }

    // Pre-check the port: a leftover child from a force-killed DSH would make
    // the spawn fail with a bare EADDRINUSE deep in the child's own output.
    if (site.port) {
      const owner = portOwner(site.port)
      if (owner) {
        entry.state = 'failed'
        entry.pid = null
        entry.conflict = { pid: owner, port: site.port }
        this.pushLine(
          site.id,
          `[site-manager] 启动被阻止:端口 ${site.port} 已被 pid ${owner} 占用(很可能是上一次 DSH 遗留的孤儿进程)。` +
            `执行 reclaim 释放该端口,或手动结束 pid ${owner} 后重试。`,
        )
        this.emit(site.id)
        return this.status(site.id)
      }
    }
    entry.conflict = null

    entry.state = 'starting'
    entry.exitCode = null
    this.emit(site.id)
    this.pushLine(site.id, `[site-manager] starting in ${site.cwd}: ${site.command}`)

    const child = spawn(site.command, {
      cwd: site.cwd,
      env: { ...process.env, ...(site.env ?? {}), ...(site.port ? { PORT: String(site.port) } : {}) },
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    entry.child = child
    entry.pid = child.pid ?? null
    entry.startedAt = new Date().toISOString()
    entry.state = 'running'
    this.emit(site.id)

    const pipe = (stream) => {
      if (!stream) return
      stream.setEncoding?.('utf8')
      stream.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim() !== '') this.pushLine(site.id, line)
        }
      })
    }
    pipe(child.stdout)
    pipe(child.stderr)

    child.on('error', (err) => {
      entry.state = 'failed'
      this.pushLine(site.id, `[site-manager] spawn error: ${err.message}`)
      this.emit(site.id)
    })

    child.on('exit', (code, signal) => {
      entry.child = null
      entry.pid = null
      entry.exitCode = code ?? (signal ? -1 : 0)
      this.pushLine(site.id, `[site-manager] exited code=${entry.exitCode}${signal ? ` signal=${signal}` : ''}`)
      const wasStopping = entry.stopping
      entry.stopping = false
      entry.state = wasStopping || entry.exitCode === 0 ? 'stopped' : 'failed'
      this.emit(site.id)
      if (!wasStopping && entry.state === 'failed' && site.autoRestart && entry.restarts < RESTART_MAX) {
        entry.restarts += 1
        const delay = RESTART_BASE_MS * 2 ** (entry.restarts - 1)
        this.pushLine(site.id, `[site-manager] auto-restart ${entry.restarts}/${RESTART_MAX} in ${delay}ms`)
        entry.timer = setTimeout(() => {
          entry.timer = null
          if (!this.disposed && !LIVE_STATES.has(this.slot(site.id).state)) this.start(site)
        }, delay)
      }
    })
    return this.status(site.id)
  }

  stop(site, { graceMs } = {}) {
    const entry = this.slot(site.id)
    if (!entry.child || !entry.pid) {
      entry.state = 'stopped'
      entry.pid = null
      this.emit(site.id)
      return this.status(site.id)
    }
    const grace = Number(graceMs ?? site.stopGraceMs ?? this.stopGraceMs)
    entry.stopping = true
    const pid = entry.pid
    this.pushLine(site.id, `[site-manager] stopping pid=${pid}`)
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }, grace).unref?.()
    }
    if (entry.child) {
      entry.state = 'stopping'
      this.emit(site.id)
    }
    return this.status(site.id)
  }

  async restart(site) {
    this.stop(site)
    const deadline = Date.now() + 15000
    while (this.slot(site.id).child && Date.now() < deadline) {
      await sleep(200)
    }
    return this.start(site)
  }

  /**
   * Kill whatever holds this site's port — the orphan case after a force-killed
   * DSH left a preview server behind. Requires an explicit confirm and refuses
   * to touch the DSH process itself.
   */
  reclaim(site, { confirm = false } = {}) {
    const entry = this.slot(site.id)
    const conflict =
      entry.conflict ??
      (site.port
        ? (() => {
            const pid = portOwner(site.port)
            return pid ? { pid, port: site.port } : null
          })()
        : null)
    if (!conflict) return { ok: false, detail: 'no port conflict recorded for this site' }
    if (!confirm) {
      return { ok: false, detail: `port ${conflict.port} is held by pid ${conflict.pid}; repeat with confirm=true to kill it` }
    }
    if (conflict.pid === process.pid) return { ok: false, detail: 'refusing to kill the DSH process itself' }
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(conflict.pid), '/T', '/F'], { windowsHide: true })
      else process.kill(conflict.pid, 'SIGTERM')
    } catch (err) {
      return { ok: false, detail: `kill failed: ${err?.message ?? err}` }
    }
    entry.conflict = null
    this.pushLine(site.id, `[site-manager] 已回收端口 ${conflict.port}(终止 pid ${conflict.pid})`)
    this.emit(site.id)
    return { ok: true, pid: conflict.pid, port: conflict.port }
  }

  /**
   * Boot-time orphan sweep: a hard kill of DSH (power loss, Task Manager,
   * `taskkill /F`) leaves the supervised servers alive, so the next boot finds
   * its own ports taken. For every registered site whose port is held by a
   * process whose command line matches that site's own command, terminate it.
   *
   * Anything that does not match is left strictly alone and recorded as a
   * conflict instead, so the panel can show the pid and let a human decide.
   * Returns a report; never throws.
   */
  async reclaimOrphans(sites) {
    const report = []
    for (const site of sites) {
      if (!site.port) continue
      const pid = portOwner(site.port)
      if (!pid || pid === process.pid) continue
      const cmdline = processCommandLine(pid)
      const entry = this.slot(site.id)
      if (!matchesSiteCommand(cmdline, site.command)) {
        entry.conflict = { pid, port: site.port, foreign: true }
        this.pushLine(
          site.id,
          `[site-manager] 端口 ${site.port} 被 pid ${pid} 占用,但其命令行与本站点命令不匹配,已保持原状:` +
            `${cmdline ?? '(无法读取命令行)'} —— 如确认是遗留进程,可在面板点「释放端口」`,
        )
        this.emit(site.id)
        report.push({ site: site.name, port: site.port, pid, action: 'left-alone' })
        continue
      }
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        else process.kill(pid, 'SIGTERM')
        entry.conflict = null
        this.pushLine(site.id, `[site-manager] 启动清理:端口 ${site.port} 上的遗留进程 pid ${pid} 与本站点命令匹配,已终止`)
        report.push({ site: site.name, port: site.port, pid, action: 'reclaimed' })
      } catch (err) {
        report.push({ site: site.name, port: site.port, pid, action: 'failed', detail: String(err?.message ?? err) })
      }
      this.emit(site.id)
    }
    return report
  }

  /** Probe the site's HTTP endpoint. Never throws. */
  async health(site, timeoutMs = HEALTH_TIMEOUT_MS) {
    // `url` is the base the panel links to; the probe appends healthPath so a
    // site that only serves a sub-path (an MCP endpoint, an /api/health) is
    // still probed at the right place instead of at its origin.
    const rawPath = String(site.healthPath ?? '/').trim()
    const path = rawPath === '' ? '/' : rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    let url = null
    if (site.url) {
      const base = site.url.replace(/\/+$/, '')
      if (path === '/') url = `${base}/`
      else url = base.endsWith(path) ? base : `${base}${path}`
    } else if (site.port) {
      url = `http://127.0.0.1:${site.port}${path}`
    }
    if (!url) return { ok: false, status: null, ms: null, url: null, error: 'no port or url configured' }
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
      const result = { ok: res.status < 500, status: res.status, ms: Date.now() - started, url }
      this.slot(site.id).health = result
      if (this.slot(site.id).state === 'running' && !result.ok) this.slot(site.id).state = 'unhealthy'
      return result
    } catch (err) {
      const result = { ok: false, status: null, ms: Date.now() - started, url, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err) }
      this.slot(site.id).health = result
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  /** Stop everything this supervisor owns. Called on plugin dispose. */
  stopAll(sites) {
    this.disposed = true
    for (const site of sites) {
      const entry = this.runtime.get(site.id)
      if (entry?.timer) clearTimeout(entry.timer)
      if (entry?.child) {
        try {
          this.stop(site)
        } catch {
          /* best effort */
        }
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const constants = { RING_DEFAULT, STOP_GRACE_DEFAULT, RESTART_MAX }
