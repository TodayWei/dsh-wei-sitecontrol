/**
 * dsh-wei-sitecontrol — schedule: publish at a chosen time.
 *
 * Records live in the registry (so they survive a DSH restart) and each pending
 * entry is armed with a timer on mount. A publish that fires runs exactly the
 * same `deployer.deploy` path as a manual one, and its step report is stored on
 * the record so the panel can show what happened.
 */
import { randomUUID } from 'node:crypto'

/** Timers cannot hold very long delays, so long waits are re-armed. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000
const MIN_TIMER_MS = 500

export class Scheduler {
  /**
   * @param {object} options
   * @param {Array}  options.records  the registry's schedules array (live reference)
   * @param {Function} options.persist called after every state change
   * @param {Function} options.run      async (record) => deploy result
   */
  constructor({ logger, records = [], persist = () => {}, run, now = () => Date.now() } = {}) {
    this.logger = logger
    this.records = records
    this.persist = persist
    this.run = run
    this.now = now
    this.timers = new Map()
    this.disposed = false
  }

  list() {
    return [...this.records].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  }

  find(id) {
    return this.records.find((record) => record.id === id) ?? null
  }

  /** Create a schedule for `at` (ISO string or Date). */
  add({ siteId, siteName = null, targetName, at, allowInstall = false, note = null }) {
    const when = at instanceof Date ? at : new Date(String(at))
    if (Number.isNaN(when.getTime())) throw new Error(`无法解析发布时间:"${at}"(请给 ISO 时间,如 2026-09-10T22:30:00+08:00)`)
    const record = {
      id: randomUUID().slice(0, 8),
      siteId,
      siteName,
      targetName,
      at: when.toISOString(),
      allowInstall: allowInstall === true,
      note,
      status: 'pending',
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    }
    this.records.push(record)
    this.persist()
    this.#arm(record)
    this.logger?.info?.('[dsh-wei-sitecontrol] 已排定发布时间 %s(目标 %s)', record.at, targetName)
    return record
  }

  cancel(id) {
    const record = this.find(id)
    if (!record) throw new Error(`没有找到排期 ${id}`)
    if (record.status !== 'pending') throw new Error(`排期 ${id} 当前状态是 ${record.status},只能取消 pending 的排期`)
    record.status = 'cancelled'
    record.finishedAt = new Date(this.now()).toISOString()
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    this.persist()
    return record
  }

  /** Arm every pending record; called on mount so restarts do not lose plans. */
  armAll() {
    let armed = 0
    for (const record of this.records) {
      if (record.status !== 'pending') continue
      this.#arm(record)
      armed += 1
    }
    return armed
  }

  #arm(record) {
    if (this.disposed) return
    const delay = new Date(record.at).getTime() - this.now()
    if (delay > MAX_TIMER_MS) {
      // Re-arm later: keeps arbitrarily distant dates working.
      const timer = setTimeout(() => this.#arm(record), MAX_TIMER_MS)
      timer.unref?.()
      this.timers.set(record.id, timer)
      return
    }
    const wait = Math.max(MIN_TIMER_MS, delay)
    const timer = setTimeout(() => {
      this.timers.delete(record.id)
      void this.#fire(record)
    }, wait)
    timer.unref?.()
    this.timers.set(record.id, timer)
    if (delay < 0) this.logger?.warn?.('[dsh-wei-sitecontrol] 排期 %s 的时间已过(%s),立即执行', record.id, record.at)
  }

  async #fire(record) {
    if (this.disposed || record.status !== 'pending') return
    record.status = 'running'
    record.startedAt = new Date(this.now()).toISOString()
    this.persist()
    try {
      const result = await this.run(record)
      record.status = result?.ok ? 'done' : 'failed'
      record.result = {
        ok: result?.ok === true,
        uploadDir: result?.uploadDir ?? null,
        release: result?.release ?? null,
        steps: (result?.steps ?? []).map((step) => ({ name: step.name, ok: step.ok, skipped: step.skipped === true, detail: step.detail })),
      }
      record.error = result?.ok ? null : '发布未全部成功,详见 steps'
      this.logger?.[result?.ok ? 'info' : 'warn']?.('[dsh-wei-sitecontrol] 排期 %s 发布%s', record.id, result?.ok ? '成功' : '失败')
    } catch (err) {
      record.status = 'failed'
      record.error = String(err?.message ?? err)
      this.logger?.warn?.('[dsh-wei-sitecontrol] 排期 %s 发布异常:%s', record.id, record.error)
    }
    record.finishedAt = new Date(this.now()).toISOString()
    this.persist()
  }

  dispose() {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
