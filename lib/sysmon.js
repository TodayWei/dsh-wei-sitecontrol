/**
 * dsh-wei-sitecontrol — sysmon: what this machine is doing right now.
 *
 * Two questions, answered without adding a dependency:
 *
 *   1) How loaded is this machine?   CPU / memory / disk / load, sampled from
 *      Node's own `os` and `fs.statfs` — no subprocess involved.
 *   2) What is running?              The process tree under the DSH process,
 *      plus every supervised site, each reduced to a short human label
 *      ("名字" only — the panel deliberately shows no progress).
 *
 * The process table needs one PowerShell call per sample on Windows
 * (`Get-CimInstance Win32_Process`) and `ps` elsewhere. That call is cached for
 * a short window so several panels or tools polling at once cost one sample.
 *
 * CPU accounting:
 *   - Windows gives cumulative kernel+user time (100 ns units) per process, so
 *     the percentage is a delta between two samples. The first sample cannot
 *     know it yet and reports `null` rather than inventing a number.
 *   - POSIX `ps` already reports a percentage; it is used as-is.
 *   - `cpuPercent` is relative to ONE core, so a busy 4-thread job can read
 *     above 100% — the same convention as the panel's machine-level bar, which
 *     is divided by the core count.
 *
 * Everything here is pure except `listProcesses`; time and the process source
 * are injectable so the maths can be tested without touching the real machine.
 */
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { matchesSiteCommand, signatureTokens } from './lifecycle.js'

/** Marker so the sampler can recognise (and hide) its own probe process. */
export const PROBE_MARKER = 'dsh-sysmon-sample'

const WIN_CPU_UNITS_PER_SEC = 1e7 // Win32_Process Kernel/UserModeTime are 100 ns
const SAMPLE_CACHE_MS = 1500
const MAX_TASK_DEPTH = 4
const MAX_TASKS = 40
const MAX_CMD_CHARS = 96

// ─────────────────────────────────────────────────────────────── machine

/** Used-space percentage from fs.statfs, or null when it is unavailable. */
export function statfsUsage(path) {
  try {
    if (typeof fs.statfsSync !== 'function') return null
    const st = fs.statfsSync(path)
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bfree) * Number(st.bsize)
    if (!Number.isFinite(total) || total <= 0) return null
    return { path, totalBytes: total, freeBytes: free, usedPercent: ((total - free) / total) * 100 }
  } catch {
    return null
  }
}

function enumerateDisks() {
  if (process.platform !== 'win32') return [statfsUsage('/')].filter(Boolean)
  const out = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (!fs.existsSync(root)) continue
    } catch {
      continue
    }
    const usage = statfsUsage(root)
    if (usage) out.push(usage)
  }
  return out
}

/** CPU share (0-100) from two cumulative-tick samples. */
export function cpuPercentBetween(prev, cur) {
  if (!prev) return null
  const totalDelta = cur.total - prev.total
  const idleDelta = cur.idle - prev.idle
  if (!(totalDelta > 0)) return null
  const busy = 1 - idleDelta / totalDelta
  return Math.max(0, Math.min(100, busy * 100))
}

export function readCpuTicks() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total }
}

export function machineSample({ now = Date.now(), disks = true } = {}) {
  const ticks = readCpuTicks()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  return {
    ticks,
    cores: os.cpus().length,
    load1: os.loadavg?.()[0] ?? null,
    uptimeSec: os.uptime(),
    hostname: os.hostname(),
    platform: process.platform,
    cpuPercent: null, // filled by the stateful sampler below
    memUsedBytes: totalMem - freeMem,
    memTotalBytes: totalMem,
    memPercent: totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : null,
    disks: disks ? enumerateDisks() : [],
    sampledAt: new Date(now).toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────── processes

function runPowerShell(script, timeout = 15000) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  })
}

/** Raw process table: cumulative CPU seconds plus command lines. */
export function listProcesses({ platform = process.platform, run = runPowerShell } = {}) {
  if (platform === 'win32') {
    const out = run(
      `# ${PROBE_MARKER}\n` +
        'Get-CimInstance Win32_Process | ' +
        'Select-Object ProcessId,ParentProcessId,Name,CommandLine,KernelModeTime,UserModeTime,WorkingSetSize | ' +
        'ConvertTo-Json -Compress -Depth 3',
    )
    const text = String(out ?? '').trim()
    if (!text) return []
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId ?? 0),
      name: String(row.Name ?? ''),
      cmd: String(row.CommandLine ?? ''),
      cumulativeCpuSec:
        (Number(row.KernelModeTime ?? 0) + Number(row.UserModeTime ?? 0)) / WIN_CPU_UNITS_PER_SEC,
      memBytes: Number(row.WorkingSetSize ?? 0),
    }))
  }
  // POSIX: `pcpu` is already a percentage, so no delta maths is needed.
  const out = run('ps -eo pid=,ppid=,pcpu=,rss=,comm=,args=')
  return String(out ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/)
      if (!m) return null
      return {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        cpuPercent: Number(m[3]),
        name: m[5],
        cmd: m[6] || m[5],
        memBytes: Number(m[4]) * 1024,
      }
    })
    .filter(Boolean)
}

/** True for the sampler's own probe process, which must never be listed. */
export function isProbeProcess(proc) {
  const cmd = String(proc?.cmd ?? '')
  return cmd.includes(PROBE_MARKER) || /Get-CimInstance Win32_Process/.test(cmd)
}

/**
 * A short, stable label for a process: the most informative token of its command
 * line (script file, module, or executable), never the whole thing.
 */
export function shortLabel(proc) {
  const cmd = String(proc?.cmd ?? '').trim()
  if (!cmd) return String(proc?.name ?? 'process')
  const tokens = cmd
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => t && !t.startsWith('-'))
  // A script (bin.js, gallery_server.js, http.server) says far more about what a
  // process is doing than the interpreter in front of it, so scripts outrank
  // plain paths, which outrank anything else that merely contains a dot.
  const scoreOf = (token) => {
    if (/\.(js|mjs|cjs|ts|tsx|py|sh|bash|ps1|rb|php|jar)$/i.test(token)) return 3
    if (/[/\\]/.test(token)) return 2
    if (/\.[a-z0-9]{1,5}$/i.test(token)) return 1
    return 0
  }
  let interesting = null
  let bestScore = 0
  for (const token of tokens) {
    const score = scoreOf(token)
    if (score > 0 && score >= bestScore) {
      interesting = token
      bestScore = score
    }
  }
  const base = interesting ? interesting.split(/[/\\]/).pop() : String(proc?.name ?? 'process')
  // Keep one meaningful argument when it names a port or a subcommand.
  const port = tokens.find((t) => /^\d{2,5}$/.test(t))
  const sub = tokens.find((t) => /^(serve|server|start|watch|dev|build|test|run|http\.server)$/i.test(t))
  const tail = [base, sub && !base.includes(sub) ? sub : null, port ? `:${port}` : null].filter(Boolean).join(' ')
  return tail.length > 64 ? `${tail.slice(0, 63)}…` : tail
}

function truncate(text, max = MAX_CMD_CHARS) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** Depth of a pid below `rootPid`, or null when it is not a descendant. */
export function depthBelow(procsByPid, pid, rootPid, limit = MAX_TASK_DEPTH + 2) {
  let depth = 0
  let cur = procsByPid.get(pid)
  while (cur && depth <= limit) {
    if (cur.ppid === rootPid) return depth + 1
    if (!cur.ppid || cur.ppid === cur.pid) return null
    cur = procsByPid.get(cur.ppid)
    depth += 1
  }
  return null
}

// ─────────────────────────────────────────────────────────────── sampler

export class Monitor {
  constructor({ cacheMs = SAMPLE_CACHE_MS } = {}) {
    this.cacheMs = cacheMs
    this.prevTicks = null
    this.prevProcs = new Map() // pid -> { at, cpuSec }
    this.cache = null
  }

  /** Machine resources. The first call cannot report a CPU percentage. */
  machine(now = Date.now()) {
    const sample = machineSample({ now })
    sample.cpuPercent = cpuPercentBetween(this.prevTicks, sample.ticks)
    this.prevTicks = sample.ticks
    delete sample.ticks
    return sample
  }

  /** Per-process CPU percentage, from the delta against the previous sample. */
  cpuPercentFor(proc, now) {
    if (typeof proc.cpuPercent === 'number') return Math.max(0, proc.cpuPercent)
    if (typeof proc.cumulativeCpuSec !== 'number') return null
    const prev = this.prevProcs.get(proc.pid)
    if (!prev) return null
    const dtSec = (now - prev.at) / 1000
    if (!(dtSec > 0)) return null
    const used = proc.cumulativeCpuSec - prev.cpuSec
    if (used < 0) return null // pid reuse
    return Math.max(0, (used / dtSec) * 100)
  }

  rememberProcesses(procs, now) {
    const next = new Map()
    for (const proc of procs) {
      next.set(proc.pid, {
        at: now,
        cpuSec: typeof proc.cumulativeCpuSec === 'number' ? proc.cumulativeCpuSec : 0,
      })
    }
    this.prevProcs = next
  }

  /**
   * Build the monitor view.
   *
   * @param {object} options
   * @param {Array}  options.sites    registered sites ({id,name,command,port,status})
   * @param {number} options.dshPid   root of the process tree to report
   * @param {Array}  [options.procs]  process table (tests inject this)
   * @param {number} [options.now]
   */
  snapshot({ sites = [], dshPid = process.pid, procs = null, now = Date.now(), platform, run, tolerateProbeFailure = false } = {}) {
    // Several pollers in the same second (panel + tool + a second browser tab)
    // must not each spawn a PowerShell process.
    if (this.cache && !procs && this.cache.dshPid === dshPid && now - this.cache.at < this.cacheMs) {
      return this.cache.value
    }
    let processes
    let probeError = null
    try {
      processes = procs ?? listProcesses({ platform, run })
    } catch (err) {
      // A panel that loses only the process table should still show machine
      // resources and say what is missing; a caller that needs exactness
      // (tests, the agent tool's strict mode) can keep the throw.
      if (!tolerateProbeFailure) throw err
      probeError = String(err?.message || err)
      processes = []
    }
    const machine = {
      ...machineSample({ now }),
    }
    machine.cpuPercent = cpuPercentBetween(this.prevTicks, machine.ticks)
    this.prevTicks = machine.ticks
    delete machine.ticks

    const byPid = new Map(processes.map((p) => [p.pid, p]))
    const visible = processes.filter((p) => !isProbeProcess(p))

    const cpuOf = (proc) => (this.cpuPercentForInteractive(proc, now))
    const enrich = (proc) => ({
      pid: proc.pid,
      name: proc.name,
      label: shortLabel(proc),
      cmd: truncate(proc.cmd),
      cpuPercent: cpuOf(proc),
      memBytes: proc.memBytes ?? 0,
    })

    // Site processes: matched by the same conservative rule the orphan sweep
    // uses, so a task labelled with a site name really is that site's process.
    const siteViews = sites.map((site) => {
      const mine = visible.filter((p) => p.pid === site.pid || (site.command && matchesSiteCommand(p.cmd, site.command)))
      const totals = mine.reduce(
        (acc, p) => ({
          cpuPercent: acc.cpuPercent + (cpuOf(p) ?? 0),
          memBytes: acc.memBytes + (p.memBytes ?? 0),
          knownCpu: acc.knownCpu || cpuOf(p) !== null,
        }),
        { cpuPercent: 0, memBytes: 0, knownCpu: false },
      )
      return {
        id: site.id,
        name: site.name,
        state: site.status?.state ?? site.state ?? 'unknown',
        port: site.port ?? null,
        pids: mine.map((p) => p.pid),
        cpuPercent: totals.knownCpu ? totals.cpuPercent : null,
        memBytes: totals.memBytes,
        processes: mine.map(enrich),
      }
    })

    const sitePids = new Set(siteViews.flatMap((s) => s.pids))
    const tasks = []
    const dshProc = byPid.get(dshPid)
    if (dshProc && !isProbeProcess(dshProc)) {
      tasks.push({ ...enrich(dshProc), kind: 'dsh', depth: 0, label: 'DSH 本体' })
    }
    for (const proc of visible) {
      if (proc.pid === dshPid) continue
      const depth = depthBelow(byPid, proc.pid, dshPid)
      const site = siteViews.find((s) => s.pids.includes(proc.pid))
      if (depth === null && !site) continue // unrelated to this DSH
      if (depth !== null && depth > MAX_TASK_DEPTH) continue
      if (proc.name === '' && !proc.cmd) continue
      tasks.push({
        ...enrich(proc),
        kind: site ? 'site' : 'child',
        site: site ? site.name : null,
        depth: depth ?? 1,
        label: site ? `站点 · ${site.name}` : enrich(proc).label,
      })
    }
    const ordered = tasks
      .sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || b.memBytes - a.memBytes)
      .slice(0, MAX_TASKS)

    this.rememberProcesses(processes, now)
    const value = { machine, sites: siteViews, tasks: ordered, probeError, sampledAt: new Date(now).toISOString(), dshPid }
    this.cache = { at: now, dshPid, value }
    return value
  }

  /** CPU percentage for a plain process row (see the class docs for units). */
  cpuPercentForInteractive(proc, now) {
    if (typeof proc.cpuPercent === 'number') return Math.max(0, proc.cpuPercent)
    if (typeof proc.cumulativeCpuSec !== 'number') return null
    const prev = this.prevProcs.get(proc.pid)
    if (!prev || !(now > prev.at)) return null
    const used = proc.cumulativeCpuSec - prev.cpuSec
    if (used < 0) return null
    return Math.max(0, (used / ((now - prev.at) / 1000)) * 100)
  }
}

/** One-line human summary, used by the agent-facing tool and the panel header. */
export function summarize(snapshot) {
  const m = snapshot.machine
  const cpu = m.cpuPercent === null ? '—' : `${m.cpuPercent.toFixed(0)}%`
  const mem = m.memPercent === null ? '—' : `${m.memPercent.toFixed(0)}%`
  const running = snapshot.sites.filter((s) => ['running', 'starting', 'unhealthy'].includes(s.state)).length
  return `CPU ${cpu}(×${m.cores}) · 内存 ${mem} · 站点 ${running}/${snapshot.sites.length} 运行 · 任务 ${snapshot.tasks.length}`
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${value} B`
}

export function formatPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(0)}%` : '—'
}

/**
 * The text an agent (or a human reading the tool result) gets. Deliberately
 * names only: no task progress, no output, nothing that changes every second.
 */
export function formatSnapshot(snapshot, { includeTasks = true } = {}) {
  const lines = [`${summarize(snapshot)}  ·  ${snapshot.sampledAt}`]
  const disks = (snapshot.machine?.disks ?? []).map((d) => `${d.path} ${d.usedPercent.toFixed(0)}%`).join('  |  ')
  if (disks) lines.push(`磁盘: ${disks}`)
  const busy = snapshot.sites.filter((s) => s.pids.length > 0)
  if (busy.length === 0) lines.push('站点占用: 没有站点进程在跑')
  else {
    lines.push('站点占用:')
    for (const site of busy) {
      lines.push(
        `  ${site.name}  ${site.state}  ${site.port == null ? '' : `:${site.port}  `}CPU ${formatPercent(site.cpuPercent)}  内存 ${formatBytes(site.memBytes)}  pid ${site.pids.join(',')}`,
      )
    }
  }
  if (includeTasks) {
    lines.push(`在跑的任务(只有名字,共 ${snapshot.tasks.length} 个):`)
    for (const task of snapshot.tasks) {
      lines.push(
        `  [${task.kind}] ${task.label}  pid ${task.pid}  CPU ${formatPercent(task.cpuPercent)}  内存 ${formatBytes(task.memBytes)}  ·  ${task.cmd}`,
      )
    }
  }
  if (snapshot.probeError) lines.push(`⚠ 进程列表不可用:${snapshot.probeError}(CPU/内存仍有效)`)
  return lines.join('\n')
}

export { signatureTokens }
