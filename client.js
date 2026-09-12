/**
 * dsh-wei-sitecontrol — browser half.
 *
 * Hand-written module-table bundle, same shape as dsh-farm's client half:
 * the file registers a factory with window.__ModuleLoader__ and the factory's
 * exports are the client plugin. No imports, no JSX, no bundler syntax —
 * `require` resolves the platform seed table (react) and nothing else.
 *
 * UI:
 *  - sidebar.footer.action → ▶︎ button with a "running sites" badge, toggles
 *    the panel
 *  - shell.overlay         → right-hand drawer: sites grouped by workspace,
 *                            lifecycle buttons, live log view (2s polling,
 *                            tail + keyword search), git status/commit/push,
 *                            delete behind a confirm dialog, and an "add site"
 *                            form
 *  - the site's 发布 (deploy) tab is a four-section workspace, in order:
 *      ① 服务器目标   natural-language 环境描述 textarea (保存描述 stores the text
 *                     only; 按描述建档并连服务器确认 posts it to /provision, adopts
 *                     the returned target, shows 服务器确认 / derived / canPublish),
 *                     then the environment banner (from the archive readme) with
 *                     sourceDir + collapsible notes, then the target picker
 *                     + editor (save / ping / detect, with the detected uploadDir
 *                     offered as a one-click suggestion, the host's own `filled`
 *                     list echoed back, and the read-only `verified` environment
 *                     snapshot incl. the publish docBase the deploy will rewrite).
 *                     "新建目标" clears the form, focuses 名称 and says so.
 *      ② 密钥保险库   key metadata + fingerprint, import by upload or by local
 *                     path, delete behind a confirm — never the key itself
 *      ③ 发布计划与发布  deploy-plan preview (steps, `$ command`, server
 *                     summary) then the publish itself with allowInstall, the
 *                     scheduled-publish form (datetime-local + note → /schedules)
 *                     with a cancellable schedule list, plus release history and a
 *                     confirmed roll-back to an old release
 *      ④ 存储的部署脚本  stored remote scripts: load, edit, save, generate
 *
 * Host contract (all JSON, all under /dsh-wei-sitecontrol):
 *  GET    /sites                              → { sites: Site[] }
 *  POST   /sites                              → { site: Site }
 *  DELETE /sites/<id>                         → { ok: true }
 *  POST   /sites/<id>/start|stop|restart       → { site: Site }
 *  GET    /sites/<id>/logs?tail&search        → { lines: string[] }
 *  GET    /sites/<id>/health                  → { ok, status, ms, url }
 *  GET    /sites/<id>/git/status              → { branch, changed, ahead, behind, lastCommit, remote }
 *  POST   /sites/<id>/git/commit              → { oid, message }
 *  POST   /sites/<id>/git/push                → { ok, remote, branch }
 *  POST   /sites/<id>/deploy                  → { ok, steps: [{ name, ok, detail }] }   body { target, allowInstall, dryRun }
 *  POST   /sites/<id>/deploy-plan             → { ok, steps: [{ name, detail, command }], summary, uploadDir, uploadDirSource }
 *  GET    /sites/<id>/releases?target=<name>   → { ok, releases: [{ name, path }], currentDocBase }   (newest → oldest)
 *  POST   /sites/<id>/rollback                → { ok, steps: [{ name, ok, detail }], rolledBackTo, configFile, error }
 *                                               body { target, to? }
 *  GET    /targets                            → { targets: Target[] }
 *  POST   /targets                            → { target: Target }   body: name, host, port, user,
 *                                               keyName, uploadDir, serviceKind, serviceName, backup, keepReleases,
 *                                               environment, appHome, notes, deployMode, releasesDir, configFile,
 *                                               contextPath, restartOnDeploy, envText
 *                                               (sourceDir is host-owned, read-only here)
 *                                               "保存描述" sends just { name, envText }: text only, no SSH.
 *  POST   /targets/<name>/ping                → { ok, detail }
 *  POST   /targets/<name>/provision           → { ok, target, derived: { parsed, assumed }, confirmed: string[],
 *                                               summary, error, canPublish }   body { text, user? }
 *                                               (parses the natural-language description, then confirms over SSH)
 *  POST   /targets/<name>/detect              → { ok, summary, findings, raw, suggestedUploadDir, suggestedSource,
 *                                               filled: string[], target: Target }   (or { ok: false, error })
 *  GET    /schedules                          → { schedules: [{ id, siteName, targetName, at, status, note, createdAt,
 *                                               startedAt, finishedAt, result: { ok, steps, uploadDir }, error }] }
 *  POST   /schedules                          → { schedule }   body { site, target, at, note? }
 *  DELETE /schedules/<id>                     → { ok: true }
 *  GET    /keys                               → { keys: KeyMeta[], dir }
 *  POST   /keys                               → { key: KeyMeta }   body { name, content } | { name, path }
 *  DELETE /keys/<name>                        → { name, removed }
 *  GET    /scripts                            → { scripts: [{ name, bytes, updatedAt }] }
 *  POST   /scripts                            → { script }   body { name, content } | { target }
 *  GET    /scripts/<name>                     → { name, content }
 *  GET    /status                             → { sites, running }
 *
 * No credential field is ever rendered or sent: the deploy target list and the
 * git API are both secret-free by contract, and the push call deliberately
 * sends no token. The one place a private key passes through the panel is the
 * vault upload, where the text read from the chosen file goes straight into the
 * POST body — it is never written to the store, a title, or a log.
 */
window.__ModuleLoader__.load({ id: 'dsh-wei-sitecontrol', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  const React = require('react')
  const h = React.createElement

  const API = '/dsh-wei-sitecontrol'

  // ── tiny shared store ───────────────────────────────────────────────────
  const emptyLog = () => ({ tail: 500, q: '', lines: [], loaded: false, busy: false, error: undefined })
  const emptyGit = () => ({ message: '', status: undefined, loaded: false, loading: false, busy: false, error: undefined, result: undefined })
  const emptyDeploy = () => ({
    target: '', dryRun: false, allowInstall: false, busy: false, ok: undefined,
    steps: undefined, error: undefined, result: undefined,
    planBusy: false, plan: undefined, planError: undefined,
    // Release history + roll-back, scoped to one (site, target) pair.
    // `releases === undefined` means "not fetched yet", `[]` means "none found".
    releases: undefined, releasesBusy: false, releasesError: undefined,
    releasesTarget: '', currentDocBase: '',
    rollbackBusy: '', rollbackSteps: undefined, rollbackResult: undefined, rollbackError: undefined,
  })
  const emptyHealth = () => ({ busy: false, result: undefined, error: undefined })

  // The server-target editor. Everything here is non-secret by construction:
  // the only credential the panel can *name* is a vault key reference.
  // `verified` is the host's read-only detect snapshot — displayed, never edited.
  const emptyTargetForm = () => ({
    name: '', host: '', port: '22', user: 'root', keyName: '', uploadDir: '',
    serviceKind: 'custom', serviceName: '', backup: true, keepReleases: '3',
    environment: '', appHome: '', sourceDir: '', notes: '', notesOpen: false,
    deployMode: 'inplace', releasesDir: '', configFile: '', contextPath: '/',
    restartOnDeploy: true, verified: null,
    // Natural-language environment description (the panel's own text, stored on
    // the target and quoted back by the host during a provision). Never a secret.
    envText: '', saveEnvBusy: false, provisionBusy: false, provision: undefined,
    provisionError: undefined, canPublish: undefined,
    synced: '', busy: false, error: undefined, ok: undefined,
    pingBusy: false, ping: undefined, pingError: undefined,
    detectBusy: false, detect: undefined, detectError: undefined,
  })

  // Scheduled publishes. The list is global (the host owns the timer); the form
  // half only carries what the user has typed so far.
  const emptySchedules = () => ({
    list: [], loaded: false, busy: false, error: undefined,
    at: '', note: '', creating: false, formError: undefined, ok: undefined,
    delBusy: {}, open: {},
  })

  // Key vault UI state. `pickedBytes` is a length, never content.
  const emptyVault = () => ({
    keys: [], dir: '', loaded: false, busy: false, error: undefined,
    name: '', path: '', uploading: false, importBusy: false, pickedBytes: null,
    formError: undefined, formOk: undefined, delBusy: {},
  })

  // Stored deploy-script editor. `rev` bumps whenever the host hands us new
  // content, so the local textarea draft resyncs without a store write per key.
  const emptyScripts = () => ({
    list: [], loaded: false, busy: false, error: undefined, loading: false,
    name: '', content: '', rev: 0, saveBusy: false, genBusy: false,
    ok: undefined, formError: undefined,
  })

  // Key material read from a file input lives here and nowhere else: it is
  // handed straight to the POST body and cleared, never put in the store, a
  // title, or a log line.
  let pendingKeyContent = ''

  const store = {
    open: false,
    sites: [],
    loaded: false,
    error: undefined,        // last list-load failure
    actionError: undefined,  // last failed action, survives a refresh
    notice: undefined,       // last success message
    busy: {},                // site id → in-flight lifecycle action
    detail: undefined,       // { id, tab, log, git, deploy, health }
    confirm: undefined,      // { site, busy, error } — pending delete
    openerEl: null,          // element that opened the drawer (toggle exemption)
    targets: [],
    targetsLoaded: false,
    targetsBusy: false,
    targetsError: undefined,
    form: { open: false, values: {}, busy: false, error: undefined, ok: undefined },
    targetForm: emptyTargetForm(),  // server target editor (never holds secrets)
    vault: emptyVault(),            // key vault: metadata only
    scripts: emptyScripts(),        // stored deploy scripts
    schedules: emptySchedules(),    // scheduled publishes
    monitor: null,                  // last /monitor snapshot (machine + names only)
    monitorOpen: false,             // is the monitor section expanded
    monitorBusy: false,
    monitorError: undefined,
    listeners: new Set(),
    emit() { for (const fn of [...this.listeners]) { try { fn() } catch {} } },
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
  }

  const useSiteManager = () => {
    const [, force] = React.useReducer((n) => n + 1, 0)
    React.useEffect(() => store.subscribe(force), [])
  }

  /**
   * The shared notice, but self-clearing: a message that only explains what the
   * click did ("switched to a new target") should not stay on screen until the
   * user dismisses it. A newer notice wins, so the timer never eats fresh text.
   */
  const noticeSoon = (text, ms) => {
    setTimeout(() => {
      if (store.notice === text) {
        store.notice = undefined
        store.emit()
      }
    }, ms || 6000)
  }

  /**
   * Machine resources plus the names of what is currently running.
   *
   * Deliberately polled only while the monitor section is open, and only every
   * couple of seconds: the host caches its sample, and nothing a human needs to
   * decide anything by changes faster than that. Named tasks only — this never
   * carries progress or output, so switching it on cannot flood the panel while
   * other work is in flight.
   */
  const loadMonitor = async () => {
    store.monitorBusy = true
    try {
      store.monitor = await jsonFetch(`${API}/monitor`)
      store.monitorError = undefined
    } catch (err) {
      store.monitorError = errText(err)
    } finally {
      store.monitorBusy = false
      store.emit()
    }
  }

  // ── transport helpers (never throw raw parse errors at the UI) ──────────
  const errText = (err) => {
    if (!err) return '未知错误'
    if (typeof err === 'string') return err
    return err.message ? String(err.message) : String(err)
  }

  const jsonFetch = async (path, options) => {
    let res
    try {
      res = await fetch(path, options)
    } catch (err) {
      throw new Error(`请求失败 ${path}: ${errText(err)}`)
    }
    const text = await res.text().catch(() => '')
    let body = {}
    if (text) {
      try { body = JSON.parse(text) } catch { body = {} }
    }
    if (!res.ok) {
      const detail = body && (body.error || body.message) ? (body.error || body.message) : `HTTP ${res.status}`
      throw new Error(String(detail))
    }
    return body && typeof body === 'object' ? body : {}
  }

  const postJson = (path, payload) => jsonFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })

  const seg = (value) => encodeURIComponent(String(value == null ? '' : value))

  // ── data loading ────────────────────────────────────────────────────────
  const closeDetail = () => { store.detail = undefined }

  const refresh = async () => {
    try {
      const body = await jsonFetch(`${API}/sites`)
      const sites = Array.isArray(body.sites) ? body.sites : []
      store.sites = sites
      store.loaded = true
      store.error = undefined
      const live = new Set(sites.map((s) => s.id))
      if (store.detail && !live.has(store.detail.id)) closeDetail()
      if (store.confirm && !live.has(store.confirm.site.id)) store.confirm = undefined
    } catch (err) {
      store.error = errText(err)
    }
    store.emit()
  }

  const loadTargets = async () => {
    if (store.targetsBusy) return
    store.targetsBusy = true
    store.targetsError = undefined
    store.emit()
    try {
      const body = await jsonFetch(`${API}/targets`)
      store.targets = Array.isArray(body.targets) ? body.targets : []
      store.targetsLoaded = true
    } catch (err) {
      store.targetsError = errText(err)
    }
    store.targetsBusy = false
    store.emit()
  }

  // ── key vault (metadata only — key material never enters the store) ─────
  const loadKeys = async () => {
    const vault = store.vault
    if (vault.busy) return
    vault.busy = true
    vault.error = undefined
    store.emit()
    try {
      const body = await jsonFetch(`${API}/keys`)
      vault.keys = Array.isArray(body.keys) ? body.keys.filter(Boolean) : []
      vault.dir = body.dir ? String(body.dir) : ''
      vault.loaded = true
    } catch (err) {
      vault.error = errText(err)
      vault.loaded = true
    }
    vault.busy = false
    store.emit()
  }

  /** Browser-side file read; the text is returned to the caller only. */
  const readFileText = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('浏览器无法读取所选文件'))
    reader.readAsText(file)
  })

  const uploadKey = async (name, content) => {
    const vault = store.vault
    vault.uploading = true
    vault.formError = undefined
    vault.formOk = undefined
    store.emit()
    try {
      const body = await postJson(`${API}/keys`, { name, content })
      const meta = body && body.key ? body.key : null
      vault.formOk = meta
        ? `已导入密钥 ${meta.name}${meta.keyType ? ` · ${meta.keyType}` : ''}${meta.bytes == null ? '' : ` · ${meta.bytes} 字节`}`
        : `已导入密钥 ${name}`
      vault.name = ''
      vault.path = ''
      vault.pickedBytes = null
      pendingKeyContent = ''
    } catch (err) {
      vault.formError = errText(err)
    }
    vault.uploading = false
    store.emit()
    if (!vault.formError) await loadKeys()
  }

  const pickKeyFile = async (ev) => {
    const input = ev && ev.target
    const file = input && input.files && input.files[0]
    if (!file) return
    const vault = store.vault
    vault.formError = undefined
    vault.formOk = undefined
    vault.uploading = true
    store.emit()
    let text = ''
    try {
      text = await readFileText(file)
    } catch (err) {
      vault.uploading = false
      vault.pickedBytes = null
      vault.formError = `读取文件失败:${errText(err)}`
      store.emit()
      return
    }
    // Held in the closure (and the module scratch) only until the POST lands.
    pendingKeyContent = text
    vault.pickedBytes = text.length
    const name = (vault.name || '').trim()
    if (!name) {
      vault.uploading = false
      vault.formError = `已读取 ${text.length} 字节;请填写密钥名后点「上传密钥」`
      store.emit()
      return
    }
    await uploadKey(name, text)
    try {
      input.value = ''
    } catch {
      /* some browsers refuse to clear a file input; harmless either way */
    }
  }

  const uploadPendingKey = async (fileRef) => {
    const vault = store.vault
    if (vault.uploading) return
    const name = (vault.name || '').trim()
    vault.formError = undefined
    vault.formOk = undefined
    if (!name) {
      vault.formError = '请先填写密钥名(字母、数字、点、下划线、连字符)'
      store.emit()
      return
    }
    if (!pendingKeyContent) {
      vault.formError = '请先选择要上传的密钥文件'
      store.emit()
      return
    }
    await uploadKey(name, pendingKeyContent)
    if (fileRef && fileRef.current) {
      try {
        fileRef.current.value = ''
      } catch {
        /* ignore */
      }
    }
  }

  const importKeyFromPath = async () => {
    const vault = store.vault
    if (vault.importBusy) return
    const name = (vault.name || '').trim()
    const sourcePath = (vault.path || '').trim()
    vault.formError = undefined
    vault.formOk = undefined
    if (!name) {
      vault.formError = '请先填写密钥名'
      store.emit()
      return
    }
    if (!sourcePath) {
      vault.formError = '请填写本机私钥的绝对路径'
      store.emit()
      return
    }
    vault.importBusy = true
    store.emit()
    try {
      const body = await postJson(`${API}/keys`, { name, path: sourcePath })
      const meta = body && body.key ? body.key : null
      vault.formOk = `已从本机路径导入密钥 ${meta && meta.name ? meta.name : name}`
      vault.name = ''
      vault.path = ''
    } catch (err) {
      vault.formError = errText(err)
    }
    vault.importBusy = false
    store.emit()
    if (!vault.formError) await loadKeys()
  }

  const removeKey = async (key) => {
    const vault = store.vault
    if (!key || vault.delBusy[key.name]) return
    const ok = window.confirm(`确定从保险库删除密钥“${key.name}”?所有引用它的发布目标都会连不上服务器。`)
    if (!ok) return
    vault.delBusy[key.name] = true
    vault.formError = undefined
    vault.formOk = undefined
    store.emit()
    try {
      await jsonFetch(`${API}/keys/${seg(key.name)}`, { method: 'DELETE' })
      vault.formOk = `已删除密钥 ${key.name}`
    } catch (err) {
      vault.formError = `删除密钥失败:${errText(err)}`
    }
    delete vault.delBusy[key.name]
    store.emit()
    await loadKeys()
  }

  // ── stored deploy scripts ───────────────────────────────────────────────
  const loadScripts = async () => {
    const scripts = store.scripts
    if (scripts.busy) return
    scripts.busy = true
    scripts.error = undefined
    store.emit()
    try {
      const body = await jsonFetch(`${API}/scripts`)
      scripts.list = Array.isArray(body.scripts) ? body.scripts.filter(Boolean) : []
      scripts.loaded = true
    } catch (err) {
      scripts.error = errText(err)
      scripts.loaded = true
    }
    scripts.busy = false
    store.emit()
  }

  const openScript = async (name) => {
    const scripts = store.scripts
    if (scripts.loading) return
    scripts.loading = true
    scripts.error = undefined
    scripts.ok = undefined
    store.emit()
    try {
      const body = await jsonFetch(`${API}/scripts/${seg(name)}`)
      scripts.name = body && body.name ? String(body.name) : String(name)
      scripts.content = typeof body.content === 'string' ? body.content : ''
      scripts.rev += 1
    } catch (err) {
      scripts.error = `读取脚本失败:${errText(err)}`
    }
    scripts.loading = false
    store.emit()
  }

  const saveScript = async (name, content) => {
    const scripts = store.scripts
    if (scripts.saveBusy) return
    const clean = String(name || '').trim()
    scripts.formError = undefined
    scripts.ok = undefined
    if (!clean) {
      scripts.formError = '请先填写脚本名,或从上面的列表里选一个脚本'
      store.emit()
      return
    }
    if (!content || String(content).trim() === '') {
      scripts.formError = '脚本内容为空,无法保存'
      store.emit()
      return
    }
    scripts.saveBusy = true
    store.emit()
    try {
      const body = await postJson(`${API}/scripts`, { name: clean, content: String(content) })
      const meta = body && body.script ? body.script : null
      scripts.name = meta && meta.name ? String(meta.name) : clean
      scripts.ok = `已保存脚本 ${scripts.name}${meta && meta.bytes != null ? `(${meta.bytes} 字节)` : ''}`
    } catch (err) {
      scripts.formError = errText(err)
    }
    scripts.saveBusy = false
    store.emit()
    await loadScripts()
  }

  const generateScript = async (targetName) => {
    const scripts = store.scripts
    if (scripts.genBusy) return
    const target = String(targetName || '').trim()
    scripts.formError = undefined
    scripts.ok = undefined
    if (!target) {
      scripts.formError = '请先在上方选择发布目标,再生成默认脚本'
      store.emit()
      return
    }
    scripts.genBusy = true
    store.emit()
    try {
      const body = await postJson(`${API}/scripts`, { target })
      const meta = body && body.script ? body.script : null
      scripts.name = meta && meta.name ? String(meta.name) : ''
      scripts.content = typeof body.content === 'string' ? body.content : ''
      scripts.rev += 1
      scripts.ok = meta && meta.created
        ? `已为 ${target} 生成默认脚本 ${scripts.name}`
        : `已载入 ${target} 的现有脚本 ${scripts.name}`
    } catch (err) {
      scripts.formError = errText(err)
    }
    scripts.genBusy = false
    store.emit()
    await loadScripts()
  }

  const openDetail = (site, tab) => {
    if (store.detail && store.detail.id === site.id && store.detail.tab === tab) {
      closeDetail()
      store.emit()
      return
    }
    if (!store.detail || store.detail.id !== site.id) {
      store.detail = {
        id: site.id,
        tab,
        log: emptyLog(),
        git: emptyGit(),
        deploy: emptyDeploy(),
        health: emptyHealth(),
      }
    } else {
      store.detail.tab = tab
    }
    const detail = store.detail
    if (tab === 'git') loadGitStatus(detail.git, site.id)
    if (tab === 'deploy') {
      if (!store.targetsLoaded) loadTargets()
      if (!store.vault.loaded) loadKeys()
      if (!store.scripts.loaded) loadScripts()
      if (!store.schedules.loaded) loadSchedules()
    }
    store.emit()
  }

  const loadLogs = async (log, siteId) => {
    if (log.busy) return
    log.busy = true
    try {
      const qs = `tail=${seg(log.tail)}${log.q ? `&search=${seg(log.q)}` : ''}`
      const body = await jsonFetch(`${API}/sites/${seg(siteId)}/logs?${qs}`)
      const lines = Array.isArray(body.lines) ? body.lines : []
      log.lines = lines.map((line) => (typeof line === 'string' ? line : String(line)))
      log.loaded = true
      log.error = undefined
    } catch (err) {
      log.error = errText(err)
      log.loaded = true
    }
    log.busy = false
    store.emit()
  }

  const loadGitStatus = async (git, siteId) => {
    if (git.loading) return
    git.loading = true
    git.error = undefined
    store.emit()
    try {
      const body = await jsonFetch(`${API}/sites/${seg(siteId)}/git/status`)
      git.status = body && typeof body === 'object' ? body : {}
      git.loaded = true
    } catch (err) {
      git.error = errText(err)
    }
    git.loading = false
    store.emit()
  }

  const act = async (site, action) => {
    if (store.busy[site.id]) return
    const label = ACTION_TEXT[action] || action
    store.busy[site.id] = action
    store.actionError = undefined
    store.notice = undefined
    store.emit()
    try {
      await postJson(`${API}/sites/${seg(site.id)}/${action}`, {})
      store.notice = `${site.name}:${label}已提交`
    } catch (err) {
      store.actionError = `${site.name} · ${label}失败:${errText(err)}`
    }
    delete store.busy[site.id]
    await refresh()
    store.emit()
  }

  // Free a port whose holder is an orphan left behind by a force-killed DSH.
  const reclaim = async (site) => {
    if (store.busy[site.id]) return
    store.busy[site.id] = 'reclaim'
    store.actionError = undefined
    store.notice = undefined
    store.emit()
    try {
      const res = await postJson(`${API}/sites/${seg(site.id)}/reclaim`, { confirm: true })
      if (res && res.ok === false) throw new Error(res.detail || '未能释放端口')
      store.notice = `${site.name}:已释放端口 ${res.port}(终止 pid ${res.pid}),现在可以点「启动」`
    } catch (err) {
      store.actionError = `${site.name} · 释放端口失败:${errText(err)}`
    }
    delete store.busy[site.id]
    await refresh()
    store.emit()
  }

  const doCommit = async (site, git) => {
    if (git.busy) return
    const message = (git.message || '').trim()
    if (!message) {
      git.error = '请先填写提交信息'
      store.emit()
      return
    }
    git.busy = true
    git.error = undefined
    git.result = undefined
    store.emit()
    try {
      const body = await postJson(`${API}/sites/${seg(site.id)}/git/commit`, { message, all: true })
      const oid = body && body.oid ? String(body.oid).slice(0, 8) : ''
      git.result = oid ? `已提交 ${oid}` : '已提交'
      git.message = ''
    } catch (err) {
      git.error = errText(err)
    }
    git.busy = false
    store.emit()
    await loadGitStatus(git, site.id)
  }

  // No token is sent: the UI never collects credentials. Private remotes rely
  // on the host's own credential setup (tokenEnv / credential helper).
  const doPush = async (site, git) => {
    if (git.busy) return
    git.busy = true
    git.error = undefined
    git.result = undefined
    store.emit()
    try {
      const body = await postJson(`${API}/sites/${seg(site.id)}/git/push`, {})
      const remote = body && body.remote ? body.remote : '远端'
      const branch = body && body.branch ? body.branch : ''
      git.result = branch ? `已推送 ${remote}/${branch}` : `已推送 ${remote}`
    } catch (err) {
      git.error = errText(err)
    }
    git.busy = false
    store.emit()
    await loadGitStatus(git, site.id)
  }

  // ── server targets (editor for the non-secret half of a target) ─────────
  const fillTargetForm = (target) => {
    const form = store.targetForm
    form.name = target && target.name ? String(target.name) : ''
    form.host = target && target.host ? String(target.host) : ''
    form.port = String(target && target.port != null ? target.port : 22)
    form.user = target && target.user ? String(target.user) : 'root'
    form.keyName = target && target.keyName ? String(target.keyName) : ''
    form.uploadDir = target ? String(target.uploadDir || target.remotePath || '') : ''
    form.serviceKind = target && SERVICE_KINDS.indexOf(target.serviceKind) >= 0 ? target.serviceKind : 'custom'
    form.serviceName = target && target.serviceName ? String(target.serviceName) : ''
    form.backup = target ? target.backup !== false : true
    form.keepReleases = String(target && target.keepReleases != null ? target.keepReleases : 3)
    // Archive metadata + release layout. sourceDir is host-owned (it comes from
    // the archive's readme) and is shown read-only, never posted back.
    form.environment = target && target.environment ? String(target.environment) : ''
    form.appHome = target ? String(target.appHome || '') : ''
    form.sourceDir = target ? String(target.sourceDir || '') : ''
    form.notes = target && target.notes != null ? String(target.notes) : ''
    form.notesOpen = false
    form.deployMode = target && target.deployMode === 'release' ? 'release' : 'inplace'
    form.releasesDir = target ? String(target.releasesDir || '') : ''
    form.configFile = target ? String(target.configFile || '') : ''
    form.contextPath = target && target.contextPath ? String(target.contextPath) : '/'
    form.restartOnDeploy = target ? target.restartOnDeploy !== false : true
    form.verified = target && target.verified && typeof target.verified === 'object' ? target.verified : null
    // The natural-language description the user may edit and re-provision from.
    form.envText = target && target.envText != null ? String(target.envText) : ''
    form.synced = form.name
    form.error = undefined
    form.ok = undefined
    form.ping = undefined
    form.pingError = undefined
    form.detect = undefined
    form.detectError = undefined
    form.provision = undefined
    form.provisionError = undefined
    // Only a fresh provision response can speak for the new target.
    form.canPublish = undefined
  }

  // One selection drives both the editor and the publish action, so the two
  // selects in the deploy page can never disagree.
  const chooseTarget = (name) => {
    const wanted = String(name || '')
    const dep = store.detail && store.detail.deploy ? store.detail.deploy : null
    if (dep) {
      dep.target = wanted
      // A release history belongs to one target: drop it rather than show the
      // previous machine's releases under the new machine's name.
      if (String(dep.releasesTarget || '') !== wanted) {
        dep.releases = undefined
        dep.releasesTarget = ''
        dep.currentDocBase = ''
        dep.releasesError = undefined
        dep.rollbackSteps = undefined
        dep.rollbackResult = undefined
        dep.rollbackError = undefined
      }
    }
    const found = store.targets.filter((t) => t && t.name === wanted)[0] || null
    fillTargetForm(found)
    store.emit()
  }

  const actionTargetName = () => {
    const form = store.targetForm
    const typed = (form.name || '').trim()
    if (typed) return typed
    return store.detail && store.detail.deploy ? String(store.detail.deploy.target || '').trim() : ''
  }

  const saveTarget = async () => {
    const form = store.targetForm
    if (form.busy) return
    form.error = undefined
    form.ok = undefined
    const name = (form.name || '').trim()
    if (!name) {
      form.error = '目标名必填(字母、数字、点、下划线、连字符)'
      store.emit()
      return
    }
    const host = (form.host || '').trim()
    if (!host) {
      form.error = '主机地址必填,例如 192.168.1.10 或 web.example.com'
      store.emit()
      return
    }
    const payload = { name, host, serviceKind: form.serviceKind || 'custom', backup: form.backup !== false }
    const user = (form.user || '').trim()
    if (user) payload.user = user
    const portRaw = String(form.port == null ? '' : form.port).trim()
    if (portRaw) {
      const port = Number(portRaw)
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        form.error = '端口需为 1–65535 的整数'
        store.emit()
        return
      }
      payload.port = Math.trunc(port)
    }
    const uploadDir = (form.uploadDir || '').trim()
    if (uploadDir) payload.uploadDir = uploadDir
    const serviceName = (form.serviceName || '').trim()
    if (serviceName) payload.serviceName = serviceName
    // A vault reference is the only credential this panel may name. Leaving the
    // select empty omits the field, which the host reads as "keep the existing
    // credential"; the panel never collects a password or a private key.
    const keyName = (form.keyName || '').trim()
    if (keyName) payload.keyName = keyName
    const keepRaw = String(form.keepReleases == null ? '' : form.keepReleases).trim()
    if (keepRaw) {
      const keep = Number(keepRaw)
      if (!Number.isFinite(keep) || keep < 0 || keep > 100) {
        form.error = '保留份数需为 0–100 的整数'
        store.emit()
        return
      }
      payload.keepReleases = Math.trunc(keep)
    }
    // Archive metadata + release layout. Text fields are omitted when blank so a
    // save never wipes a value the host owns but this form does not show.
    const environment = (form.environment || '').trim()
    if (environment) payload.environment = environment
    const appHome = (form.appHome || '').trim()
    if (appHome) payload.appHome = appHome
    const notes = (form.notes || '').trim()
    if (notes) payload.notes = notes
    payload.deployMode = form.deployMode === 'release' ? 'release' : 'inplace'
    const releasesDir = (form.releasesDir || '').trim()
    if (releasesDir) payload.releasesDir = releasesDir
    const configFile = (form.configFile || '').trim()
    if (configFile) payload.configFile = configFile
    const contextPath = (form.contextPath || '').trim()
    if (contextPath) payload.contextPath = contextPath
    payload.restartOnDeploy = form.restartOnDeploy !== false
    // Carried along so editing the description and then hitting 「保存目标」 never
    // silently drops it. Blank still means "leave whatever the host has".
    const envText = String(form.envText == null ? '' : form.envText)
    if (envText.trim()) payload.envText = envText
    form.busy = true
    store.emit()
    try {
      const body = await postJson(`${API}/targets`, payload)
      const saved = body && body.target && body.target.name ? String(body.target.name) : name
      form.name = saved
      form.synced = saved
      if (body && body.target && body.target.envText != null) form.envText = String(body.target.envText)
      form.ok = `已保存目标 ${saved}(${body && body.target && body.target.uploadDir ? body.target.uploadDir : uploadDir || '未设置上传目录'})`
      const dep = store.detail ? store.detail.deploy : null
      if (dep && !dep.target) dep.target = saved
    } catch (err) {
      form.error = `保存目标失败:${errText(err)}`
    }
    form.busy = false
    store.emit()
    await loadTargets()
  }

  /** 「保存描述」: text only — no SSH, no probe, no field changes. */
  const saveEnvText = async () => {
    const form = store.targetForm
    if (form.saveEnvBusy) return
    form.error = undefined
    form.ok = undefined
    const name = (form.name || '').trim()
    if (!name) {
      form.error = '请先填写目标名,再保存环境描述'
      store.emit()
      return
    }
    const text = String(form.envText == null ? '' : form.envText)
    form.saveEnvBusy = true
    store.emit()
    try {
      const body = await postJson(`${API}/targets`, { name, envText: text })
      const saved = body && body.target && body.target.name ? String(body.target.name) : name
      form.name = saved
      form.synced = saved
      form.ok = `已保存目标 ${saved} 的环境描述(${text.length} 字),未连接服务器`
    } catch (err) {
      form.error = `保存环境描述失败:${errText(err)}`
    }
    form.saveEnvBusy = false
    store.emit()
    await loadTargets()
  }

  /**
   * 「按描述建档并连服务器确认」: the host parses the description, probes the
   * machine, stores the result and hands back the (updated) target. We adopt that
   * target wholesale so the form shows what the server actually said.
   */
  const provisionTarget = async () => {
    const form = store.targetForm
    if (form.provisionBusy) return
    form.provisionError = undefined
    form.provision = undefined
    const name = actionTargetName()
    const typedEnv = String(form.envText == null ? '' : form.envText)
    if (!name) {
      form.provisionError = '请先填写目标名(通常就是描述里的 ip),再按描述建档'
      store.emit()
      return
    }
    if (!typedEnv.trim()) {
      form.provisionError = '环境描述为空:请先填写描述文本(ip / ssh 端口 / 用途 / 发布目录)'
      store.emit()
      return
    }
    const user = (form.user || '').trim()
    form.provisionBusy = true
    store.emit()
    try {
      const payload = { text: typedEnv }
      if (user) payload.user = user
      const body = await postJson(`${API}/targets/${seg(name)}/provision`, payload)
      const updated = body && body.target && typeof body.target === 'object' ? body.target : null
      if (updated && updated.name) {
        const savedName = String(updated.name)
        // Refilling clears stale results, so adopt first and store the outcome after.
        fillTargetForm(updated)
        if (!String(form.envText || '').trim()) form.envText = typedEnv
        const dep = store.detail && store.detail.deploy ? store.detail.deploy : null
        if (dep) dep.target = savedName
        const list = store.targets.slice()
        const idx = list.findIndex((t) => t && t.name === savedName)
        if (idx >= 0) list[idx] = updated
        else list.push(updated)
        store.targets = list
        store.targetsLoaded = true
      }
      form.provision = {
        ok: body && body.ok !== false,
        confirmed: (Array.isArray(body.confirmed) ? body.confirmed : [])
          .filter((item) => item != null && String(item).trim() !== '')
          .map((item) => String(item)),
        summary: body && body.summary != null ? String(body.summary) : '',
        error: body && body.error != null ? String(body.error) : '',
        derived: body && body.derived && typeof body.derived === 'object' ? body.derived : null,
        canPublish: body ? body.canPublish !== false : true,
        adopted: !!updated,
      }
      form.canPublish = form.provision.canPublish
    } catch (err) {
      form.provisionError = `建档失败:${errText(err)}`
    }
    form.provisionBusy = false
    store.emit()
    await loadTargets()
  }

  const pingTarget = async () => {
    const form = store.targetForm
    if (form.pingBusy) return
    form.pingError = undefined
    form.ping = undefined
    const name = actionTargetName()
    if (!name) {
      form.pingError = '请先选择或填写目标名'
      store.emit()
      return
    }
    form.pingBusy = true
    store.emit()
    try {
      const body = await postJson(`${API}/targets/${seg(name)}/ping`, {})
      form.ping = { ok: body && body.ok === true, detail: body && body.detail != null ? String(body.detail) : '' }
    } catch (err) {
      form.pingError = `测试连接失败:${errText(err)}`
    }
    form.pingBusy = false
    store.emit()
  }

  const detectTarget = async () => {
    const form = store.targetForm
    if (form.detectBusy) return
    form.detectError = undefined
    form.detect = undefined
    const name = actionTargetName()
    if (!name) {
      form.detectError = '请先选择或填写目标名'
      store.emit()
      return
    }
    form.detectBusy = true
    store.emit()
    try {
      const body = await postJson(`${API}/targets/${seg(name)}/detect`, {})
      const filled = (Array.isArray(body.filled) ? body.filled : [])
        .filter((item) => item != null && String(item).trim() !== '')
        .map((item) => String(item))
      // The host persists what it probed: adopt its returned target so the fields
      // it just filled in (uploadDir, configFile, appHome, …) and the new
      // `verified` snapshot are visible immediately. Done *before* the detect
      // block is stored, because refilling the form clears stale results.
      const updated = body && body.target && typeof body.target === 'object' ? body.target : null
      if (updated && updated.name) {
        const savedName = String(updated.name)
        fillTargetForm(updated)
        const dep = store.detail && store.detail.deploy ? store.detail.deploy : null
        if (dep) dep.target = savedName
        const list = store.targets.slice()
        const idx = list.findIndex((t) => t && t.name === savedName)
        if (idx >= 0) list[idx] = updated
        else list.push(updated)
        store.targets = list
        store.targetsLoaded = true
      }
      form.detect = {
        ok: body && body.ok !== false,
        summary: body && body.summary != null ? String(body.summary) : '',
        error: body && body.error != null ? String(body.error) : '',
        findings: body && body.findings && typeof body.findings === 'object' ? body.findings : null,
        suggestedUploadDir: body && body.suggestedUploadDir != null ? String(body.suggestedUploadDir) : '',
        suggestedSource: body && body.suggestedSource != null ? String(body.suggestedSource) : '',
        filled,
        adopted: !!updated,
      }
    } catch (err) {
      form.detectError = `探测服务器失败:${errText(err)}`
    }
    form.detectBusy = false
    store.emit()
  }

  const runPlan = async (site, dep) => {
    if (dep.planBusy) return
    const target = (dep.target || '').trim()
    if (!target) {
      dep.planError = '请先选择发布目标'
      store.emit()
      return
    }
    dep.planBusy = true
    dep.planError = undefined
    dep.plan = undefined
    store.emit()
    try {
      const body = await postJson(`${API}/sites/${seg(site.id)}/deploy-plan`, { target, detect: true })
      dep.plan = {
        ok: body && body.ok !== false,
        steps: body && Array.isArray(body.steps) ? body.steps : [],
        summary: body && body.summary != null ? String(body.summary) : '',
        uploadDir: body && body.uploadDir != null ? String(body.uploadDir) : '',
        uploadDirSource: body && body.uploadDirSource != null ? String(body.uploadDirSource) : '',
      }
    } catch (err) {
      dep.planError = `预览发布计划失败:${errText(err)}`
    }
    dep.planBusy = false
    store.emit()
  }

  const runDeploy = async (site, dep) => {
    if (dep.busy) return
    const target = (dep.target || '').trim()
    if (!target) {
      dep.error = '请先选择发布目标'
      store.emit()
      return
    }
    dep.busy = true
    dep.error = undefined
    dep.steps = undefined
    dep.result = undefined
    dep.ok = undefined
    store.emit()
    try {
      const body = await postJson(`${API}/sites/${seg(site.id)}/deploy`, {
        target,
        allowInstall: dep.allowInstall === true,
        dryRun: dep.dryRun === true,
      })
      const steps = body && Array.isArray(body.steps) ? body.steps : []
      dep.steps = steps
      dep.ok = !!(body && body.ok)
      dep.result = dep.ok ? '发布成功' : '发布未全部成功'
      if (!dep.ok) {
        // Never reduce a failed publish to the word "failed": name every step
        // that did not succeed and quote the host's own detail.
        const failed = steps.filter((s) => s && !s.ok && !s.skipped)
        dep.error = failed.length
          ? `发布未全部成功:${failed.map((s) => `${s.name || '步骤'} — ${s.detail || 'host 未给出详情'}`).join(';')}`
          : '发布未全部成功,但 host 未给出失败原因;请看下方步骤明细'
      }
    } catch (err) {
      dep.error = `发布失败:${errText(err)}`
    }
    dep.busy = false
    store.emit()
  }

  // ── release history + roll-back ─────────────────────────────────────────
  /**
   * Newest → oldest, straight from the server's release directory.
   * Deliberately does NOT touch the roll-back result fields: this same function
   * is the refresh that runs right after a roll-back, and clearing them here
   * would erase the step report the user just asked for.
   */
  const loadReleases = async (site, dep) => {
    if (dep.releasesBusy) return
    const target = (dep.target || '').trim()
    dep.releasesError = undefined
    if (!target) {
      dep.releasesError = '请先选择发布目标'
      store.emit()
      return
    }
    dep.releasesBusy = true
    store.emit()
    try {
      const body = await jsonFetch(`${API}/sites/${seg(site.id)}/releases?target=${seg(target)}`)
      dep.releases = (Array.isArray(body.releases) ? body.releases : []).filter(Boolean)
      dep.currentDocBase = body && body.currentDocBase != null ? String(body.currentDocBase) : ''
      dep.releasesTarget = target
    } catch (err) {
      dep.releasesError = `读取发布历史失败:${errText(err)}`
    }
    dep.releasesBusy = false
    store.emit()
  }

  /** The 「发布历史」 button: a fresh look, so previous roll-back output goes. */
  const showReleases = (site, dep) => {
    dep.rollbackSteps = undefined
    dep.rollbackResult = undefined
    dep.rollbackError = undefined
    dep.releasesError = undefined
    loadReleases(site, dep)
  }

  const doRollback = async (site, dep, release) => {
    if (dep.rollbackBusy) return
    const target = (dep.target || '').trim()
    if (!target) {
      dep.rollbackError = '请先选择发布目标'
      store.emit()
      return
    }
    const name = release && release.name ? String(release.name) : ''
    if (!name) {
      dep.rollbackError = '该发布版本没有名字,无法回滚'
      store.emit()
      return
    }
    const where = release && release.path ? `(${release.path})` : ''
    const ok = window.confirm(
      `确定回滚到 ${name} ${where}?\n\n这会改写服务器上 ${target} 的 docBase 指向该版本,` +
      '当前配置文件会先备份为 .bak-<时间戳>。回滚后请自行确认服务已重启。')
    if (!ok) return
    dep.rollbackBusy = name
    dep.rollbackError = undefined
    dep.rollbackSteps = undefined
    dep.rollbackResult = undefined
    store.emit()
    try {
      const body = await postJson(`${API}/sites/${seg(site.id)}/rollback`, { target, to: name })
      const steps = Array.isArray(body.steps) ? body.steps : []
      const error = body && body.error != null ? String(body.error) : ''
      const rolledBackTo = body && body.rolledBackTo ? String(body.rolledBackTo) : name
      const configFile = body && body.configFile ? String(body.configFile) : ''
      dep.rollbackSteps = steps
      dep.rollbackResult = {
        ok: !!(body && body.ok),
        rolledBackTo, configFile, error,
      }
      if (!dep.rollbackResult.ok) {
        const failed = steps.filter((s) => s && !s.ok && !s.skipped)
        // The host's own error text is kept verbatim; the prefix just keeps it
        // from looking like an unrelated failure in the middle of the section.
        dep.rollbackError = error ? `回滚失败:${error}` : (failed.length
          ? `回滚未成功:${failed.map((s) => `${s.name || '步骤'} — ${s.detail || 'host 未给出详情'}`).join(';')}`
          : '回滚未成功,但 host 未给出失败原因;请看下方步骤明细')
      }
    } catch (err) {
      dep.rollbackError = `回滚失败:${errText(err)}`
    }
    dep.rollbackBusy = ''
    store.emit()
    // The docBase just moved, so the history's "current" marker is stale.
    await loadReleases(site, dep)
  }

  // ── scheduled publishes ─────────────────────────────────────────────────
  const loadSchedules = async () => {
    const sched = store.schedules
    if (sched.busy) return
    sched.busy = true
    sched.error = undefined
    store.emit()
    try {
      const body = await jsonFetch(`${API}/schedules`)
      sched.list = (Array.isArray(body.schedules) ? body.schedules : []).filter(Boolean)
      sched.loaded = true
    } catch (err) {
      sched.error = `排期列表读取失败:${errText(err)}`
      sched.loaded = true
    }
    sched.busy = false
    store.emit()
  }

  /**
   * The picker is a `datetime-local`, so its value carries no zone; `new Date()`
   * reads it in the browser's own zone and `toISOString()` puts the explicit UTC
   * instant on the wire. The host therefore needs no timezone guesswork.
   */
  const createSchedule = async (site, dep) => {
    const sched = store.schedules
    if (sched.creating) return
    sched.formError = undefined
    sched.ok = undefined
    if (!site || !site.id) {
      sched.formError = '站点未就绪,无法排期'
      store.emit()
      return
    }
    const target = String((dep && dep.target) || '').trim()
    if (!target) {
      sched.formError = '请先选择发布目标,再设定定时发布'
      store.emit()
      return
    }
    const raw = String(sched.at || '').trim()
    if (!raw) {
      sched.formError = '请先选择发布时间(datetime-local)'
      store.emit()
      return
    }
    const when = new Date(raw)
    if (Number.isNaN(when.getTime())) {
      sched.formError = `无法识别的时间:${raw}`
      store.emit()
      return
    }
    sched.creating = true
    store.emit()
    try {
      const payload = { site: site.id, target, at: when.toISOString() }
      const note = String(sched.note || '').trim()
      if (note) payload.note = note
      await postJson(`${API}/schedules`, payload)
      sched.at = ''
      sched.note = ''
      sched.ok = `已排定:${localTimeLabel(when)} 发布 → ${target}`
    } catch (err) {
      sched.formError = `设定定时发布失败:${errText(err)}`
    }
    sched.creating = false
    store.emit()
    await loadSchedules()
  }

  const cancelSchedule = async (rec) => {
    const sched = store.schedules
    const id = rec && rec.id ? String(rec.id) : ''
    if (!id || sched.delBusy[id]) return
    const label = rec && rec.at ? localTimeLabel(rec.at) : '该排期'
    const ok = window.confirm(`确定取消 ${label} → ${rec && rec.targetName ? rec.targetName : '目标'} 的排期?取消后不会再发布。`)
    if (!ok) return
    sched.delBusy[id] = true
    sched.formError = undefined
    sched.ok = undefined
    store.emit()
    try {
      await jsonFetch(`${API}/schedules/${seg(id)}`, { method: 'DELETE' })
      sched.ok = `已取消排期 ${label}`
    } catch (err) {
      sched.formError = `取消排期失败:${errText(err)}`
    }
    delete sched.delBusy[id]
    store.emit()
    await loadSchedules()
  }

  const runHealth = async (site, health) => {
    if (health.busy) return
    health.busy = true
    health.error = undefined
    health.result = undefined
    store.emit()
    try {
      const body = await jsonFetch(`${API}/sites/${seg(site.id)}/health`)
      health.result = body && typeof body === 'object' ? body : {}
    } catch (err) {
      health.error = errText(err)
    }
    health.busy = false
    store.emit()
  }

  const deleteSite = async () => {
    const pending = store.confirm
    if (!pending || pending.busy) return
    pending.busy = true
    pending.error = undefined
    store.emit()
    try {
      await jsonFetch(`${API}/sites/${seg(pending.site.id)}`, { method: 'DELETE' })
    } catch (err) {
      pending.busy = false
      pending.error = errText(err)
      store.emit()
      return
    }
    if (store.detail && store.detail.id === pending.site.id) closeDetail()
    store.confirm = undefined
    store.notice = `已删除站点 ${pending.site.name}`
    await refresh()
    store.emit()
  }

  const submitForm = async () => {
    const form = store.form
    if (form.busy) return
    const values = form.values || {}
    const name = (values.name || '').trim()
    if (!name) {
      form.error = '名称必填'
      form.ok = undefined
      store.emit()
      return
    }
    const payload = { name }
    for (const key of ['workspace', 'command', 'healthPath', 'installCommand', 'gitRemote', 'gitBranch']) {
      const value = (values[key] || '').trim()
      if (value) payload[key] = value
    }
    const portRaw = (values.port || '').trim()
    if (portRaw) {
      const port = Number(portRaw)
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        form.error = '端口需为 1–65535 的整数'
        form.ok = undefined
        store.emit()
        return
      }
      payload.port = Math.trunc(port)
    }
    form.busy = true
    form.error = undefined
    form.ok = undefined
    store.emit()
    try {
      const body = await postJson(`${API}/sites`, payload)
      const added = body && body.site && body.site.name ? body.site.name : name
      form.ok = `已添加站点 ${added}`
      form.values = {}
    } catch (err) {
      form.error = errText(err)
    }
    form.busy = false
    await refresh()
    store.emit()
  }

  // ── view helpers ────────────────────────────────────────────────────────
  const ACTION_TEXT = { start: '启动', stop: '停止', restart: '重启', reclaim: '释放端口' }
  // The documented union is stopped|starting|running|failed; the supervisor can
  // additionally report `unhealthy` (health probe failed) and `stopping`, so
  // both are mapped here and anything unknown degrades to a neutral dot.
  const STATE_TEXT = {
    running: '运行中', starting: '启动中', stopped: '已停止',
    failed: '失败', unhealthy: '异常', stopping: '停止中',
  }
  const STATE_CLASS = {
    running: 'dshsm-st-running', starting: 'dshsm-st-starting', stopped: 'dshsm-st-stopped',
    failed: 'dshsm-st-failed', unhealthy: 'dshsm-st-unhealthy', stopping: 'dshsm-st-stopping',
  }

  const statusOf = (site) => {
    const s = site && site.status ? site.status : {}
    return {
      state: s.state || 'stopped',
      pid: s.pid == null ? null : s.pid,
      exitCode: s.exitCode == null ? null : s.exitCode,
      restarts: s.restarts == null ? 0 : s.restarts,
      // Passed through, not invented: the row's conflict warning, its 释放端口
      // button and the 启动 guard all read `st.conflict`, which used to be
      // dropped here — throwing away the one signal that explains a dead start.
      conflict: s.conflict || null,
    }
  }

  const isLive = (site) => {
    const state = statusOf(site).state
    return state === 'running' || state === 'starting' || state === 'unhealthy'
  }

  const runningCount = () => store.sites.filter(isLive).length

  const groupSites = (sites) => {
    const byWs = new Map()
    for (const site of sites) {
      const ws = site && site.workspace ? site.workspace : '(未指定工作区)'
      if (!byWs.has(ws)) byWs.set(ws, [])
      byWs.get(ws).push(site)
    }
    return [...byWs.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([ws, list]) => [ws, list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))])
  }

  const shortOid = (oid) => (oid ? String(oid).slice(0, 8) : '')

  const SERVICE_KINDS = ['static', 'httpd', 'nginx', 'tomcat', 'docker', 'custom']
  const SERVICE_KIND_TEXT = {
    static: '静态站点', httpd: 'Apache httpd', nginx: 'Nginx',
    tomcat: 'Tomcat', docker: 'Docker', custom: '自定义',
  }

  // Schedule lifecycle. The documented union is pending|running|done|failed|
  // cancelled; anything else degrades to a neutral grey badge.
  const SCHEDULE_STATE = {
    pending: { text: '待执行', cls: 'dshsm-sch-pending' },
    running: { text: '执行中', cls: 'dshsm-sch-running' },
    done: { text: '已完成', cls: 'dshsm-sch-done' },
    failed: { text: '失败', cls: 'dshsm-sch-failed' },
    cancelled: { text: '已取消', cls: 'dshsm-sch-cancelled' },
  }

  /** A timestamp in the *viewer's* local zone (the host stores an instant). */
  const localTimeLabel = (value) => {
    if (value == null || value === '') return '时间未知'
    const d = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /** ok → ✓, explicitly skipped → ○, anything else → ✗. */
  const stepMark = (step) => {
    if (step && step.ok) return { mark: '✓', cls: 'dshsm-step-ok' }
    if (step && step.skipped) return { mark: '○', cls: 'dshsm-step-skip' }
    return { mark: '✗', cls: 'dshsm-step-bad' }
  }

  const stamp = (value) => (value ? String(value).replace('T', ' ').slice(0, 19) : '时间未知')

  /** One-line digest of a detect payload; the full text stays in `summary`. */
  const findingsHint = (findings) => {
    if (!findings || typeof findings !== 'object') return null
    const parts = []
    const os = findings.os && typeof findings.os === 'object' ? findings.os : {}
    if (os.pretty || os.id) parts.push(`系统 ${os.pretty || os.id}`)
    const kinds = [['httpd', 'httpd'], ['nginx', 'nginx'], ['tomcat', 'tomcat'], ['docker', 'docker']]
    for (const pair of kinds) {
      const item = findings[pair[0]]
      if (item && typeof item === 'object' && 'present' in item) parts.push(`${pair[1]} ${item.present ? '有' : '无'}`)
    }
    if (parts.length === 0) return null
    return h('div', { className: 'dshsm-hint', style: { marginTop: 4 } }, parts.join(' · '))
  }

  /** A multi-line string, rendered line by line with newlines preserved. */
  const preLines = (text, opts) => h('div', Object.assign({ className: 'dshsm-pre' }, opts || {}),
    String(text).split(/\r?\n/).map((line, i) => h('div', { key: i, className: 'dshsm-logline' }, line)),
  )

  // ── read-only views of the host's detect snapshot ───────────────────────
  /** Trailing-slash- and separator-insensitive path compare for docBase. */
  const normalizePath = (value) => String(value == null ? '' : value).replace(/\\/g, '/').replace(/\/+$/, '')

  /** Is this release the one the server's config currently points at? */
  const isCurrentRelease = (currentDocBase, release) => {
    const cur = normalizePath(currentDocBase)
    if (!cur || !release) return false
    const name = String(release.name || '')
    const path = normalizePath(release.path)
    if (name && cur === name) return true
    if (path && (cur === path || cur.endsWith('/' + name))) return true
    if (name && cur.endsWith('/' + name)) return true
    return false
  }

  // The host may report a service as a boolean, a version string, or an object;
  // anything truthy means "present". Kept permissive on purpose.
  const svcPresent = (value) => {
    if (value == null) return false
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value > 0
    if (typeof value === 'string') return value.trim() !== ''
    if (typeof value === 'object') {
      for (const key of ['present', 'installed', 'running', 'enabled']) {
        if (key in value) return !!value[key]
      }
      if ('version' in value) return !!value.version
      return Object.keys(value).length > 0
    }
    return !!value
  }

  const kvRow = (label, value) => h('div', { className: 'dshsm-kv' },
    h('span', { className: 'dshsm-kv-key' }, label),
    h('span', { className: 'dshsm-mono' }, value == null || value === '' ? '未识别' : String(value)),
  )

  /**
   * The `verified` snapshot is evidence, never an input: nothing here is bound to
   * the form. `publish` is highlighted because its docBase is what a publish
   * actually rewrites — that is the fact worth double-checking by eye.
   */
  const verifiedBlock = (verified) => {
    if (!verified) {
      return h('div', { className: 'dshsm-hint', style: { marginTop: 6 } },
        '还没有探测过快照,点「探测服务器」写入')
    }
    const os = verified.os && typeof verified.os === 'object' ? verified.os : {}
    const services = verified.services && typeof verified.services === 'object' ? verified.services : {}
    const tomcat = verified.tomcat && typeof verified.tomcat === 'object' ? verified.tomcat : null
    const docker = verified.docker && typeof verified.docker === 'object' ? verified.docker : null
    const publish = verified.publish && typeof verified.publish === 'object' ? verified.publish : null
    const contexts = Array.isArray(verified.contexts) ? verified.contexts.filter(Boolean) : []
    const listen = Array.isArray(verified.listen) ? verified.listen.filter((item) => item != null) : []
    const webappsEntries = tomcat && Array.isArray(tomcat.webappsEntries) ? tomcat.webappsEntries.filter((x) => x != null) : []
    const dockerContainers = docker && Array.isArray(docker.containers) ? docker.containers.filter((x) => x != null) : []
    const svcLine = (key, label) => h('span', { key, className: 'dshsm-svc' },
      `${label} `,
      h('span', { className: svcPresent(services[key]) ? 'dshsm-step-ok' : 'dshsm-step-skip' },
        svcPresent(services[key]) ? '✓' : '✗'),
    )
    const listenText = (item) => {
      if (typeof item === 'string') return item
      try { return JSON.stringify(item) } catch { return String(item) }
    }
    return h('div', { className: 'dshsm-subblock' },
      h('div', { className: 'dshsm-row' },
        h('strong', { style: { fontSize: 11 } }, '环境快照'),
        h('span', { className: 'dshsm-hint' },
          `${stamp(verified.at)}${verified.host ? ` · ${verified.host}` : ''}${verified.port != null ? `:${verified.port}` : ''}`),
        os.pretty || os.id ? h('span', { className: 'dshsm-tag' }, String(os.pretty || os.id)) : null,
        os.kernel ? h('span', { className: 'dshsm-tag' }, String(os.kernel)) : null,
        verified.init ? h('span', { className: 'dshsm-tag' }, `init ${verified.init}`) : null,
        verified.packageManager ? h('span', { className: 'dshsm-tag' }, `包管理 ${verified.packageManager}`) : null,
      ),
      h('div', { className: 'dshsm-row', style: { marginTop: 2 } },
        svcLine('tomcat', 'Tomcat'),
        svcLine('nginx', 'nginx'),
        svcLine('httpd', 'httpd'),
        svcLine('docker', 'Docker'),
      ),
      tomcat ? h('div', { style: { marginTop: 4 } },
        kvRow('Tomcat home', tomcat.home),
        kvRow('unit', tomcat.unit),
        kvRow('appBase', tomcat.appBase),
        kvRow('webapps', tomcat.webapps),
        webappsEntries.length
          ? h('div', { className: 'dshsm-kv' },
              h('span', { className: 'dshsm-kv-key' }, 'webapps 项'),
              h('span', { className: 'dshsm-mono' },
                `${webappsEntries.slice(0, 8).join('、')}${webappsEntries.length > 8 ? ` … 共 ${webappsEntries.length} 项` : ''}`),
            )
          : null,
      ) : null,
      docker && (docker.version || dockerContainers.length)
        ? h('div', { style: { marginTop: 4 } },
            kvRow('Docker', docker.version),
            dockerContainers.length
              ? h('div', { className: 'dshsm-kv' },
                  h('span', { className: 'dshsm-kv-key' }, '容器'),
                  h('span', { className: 'dshsm-mono' },
                    dockerContainers.slice(0, 5).map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join(' · ')),
                )
              : null,
          )
        : null,
      h('div', { className: 'dshsm-subblock dshsm-publish', style: { marginTop: 6 } },
        h('div', { className: 'dshsm-publish-label' }, '发布目标(来自服务器配置)'),
        publish
          ? h('div', null,
              kvRow('docBase', publish.docBase),
              kvRow('contextPath', publish.contextPath),
              kvRow('configFile', publish.configFile),
            )
          : h('div', { className: 'dshsm-hint' }, '未从服务器配置中识别到发布目录'),
      ),
      contexts.length
        ? h('div', { style: { marginTop: 6 } },
            h('div', { className: 'dshsm-hint' }, `Context 声明(显示前 ${Math.min(5, contexts.length)} / 共 ${contexts.length} 条)`),
            contexts.slice(0, 5).map((ctx, i) => h('div', { key: i, className: 'dshsm-kv' },
              h('span', { className: 'dshsm-kv-key' }, `${ctx.file || '?'}:${ctx.line == null ? '?' : ctx.line}`),
              h('span', { className: 'dshsm-mono' },
                `${ctx.path == null ? '' : ctx.path}${ctx.docBase ? ` → ${ctx.docBase}` : ''}${ctx.kind ? ` [${ctx.kind}]` : ''}`),
            )),
            contexts.length > 5
              ? h('div', { className: 'dshsm-hint' }, `… 其余 ${contexts.length - 5} 条未显示`)
              : null,
          )
        : null,
      listen.length
        ? h('div', { style: { marginTop: 6 } },
            h('div', { className: 'dshsm-hint' }, `监听(显示前 ${Math.min(5, listen.length)} / 共 ${listen.length} 条)`),
            h('div', { className: 'dshsm-mono dshsm-hint' }, listen.slice(0, 5).map(listenText).join(' · ')),
            listen.length > 5
              ? h('div', { className: 'dshsm-hint' }, `… 其余 ${listen.length - 5} 条未显示`)
              : null,
          )
        : null,
      verified.summary ? preLines(String(verified.summary), { style: { marginTop: 6, maxHeight: 140 } }) : null,
    )
  }

  // ── styles (single <style>, dshsm- prefixed, theme-safe) ────────────────
  const CSS = `
.dshsm-panel{display:flex;flex-direction:column;flex:1;min-height:0;height:100%}
.dshsm-badge{position:relative;display:inline-flex;align-items:center;justify-content:center}
.dshsm-badge-n{position:absolute;top:-2px;right:-4px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;
  background:#4c7dff;color:#fff;font-size:10px;line-height:14px;text-align:center;font-weight:600}
.dshsm-entry{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;max-width:100%}
.dshsm-entry-icon{flex:none;line-height:1}
.dshsm-entry-label{font-size:inherit;line-height:1;opacity:.92;overflow:hidden;text-overflow:ellipsis}
.dshsm-drawer{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:96vw;z-index:10000;
  display:flex;flex-direction:column;pointer-events:auto;
  background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);
  border-left:1px solid rgba(127,127,127,.35);box-shadow:-8px 0 24px rgba(0,0,0,.28)}
.dshsm-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 12px;
  border-bottom:1px solid rgba(127,127,127,.35)}
.dshsm-title{font-size:14px;font-weight:600;flex:1;min-width:110px}
.dshsm-sub{font-size:11px;opacity:.6}
.dshsm-body{flex:1;min-height:0;overflow-y:auto;padding:8px 12px 20px}
.dshsm-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0}
.dshsm-btn{border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;border-radius:6px;
  padding:3px 8px;font-size:12px;line-height:1.6;cursor:pointer;white-space:nowrap;font-family:inherit}
.dshsm-btn:hover{background:rgba(127,127,127,.18)}
.dshsm-btn:disabled{opacity:.5;cursor:not-allowed}
.dshsm-btn:disabled:hover{background:transparent}
/* ── semantic tones ──────────────────────────────────────────────────────
   A tone supplies the hue; the fill modifier decides how loud it is:
   .dshsm-btn-solid = white on saturated hue (touches production),
   .dshsm-btn-hollow = hue text + 1px hue border + tint (saves, refreshes).
   Both are :not(:disabled)-scoped, so a disabled button loses its colour
   entirely and falls back to the neutral 50%-opacity look above. */
.dshsm-btn-go{--dshsm-hue:#1f9d55;--dshsm-hue-strong:#17864a;--dshsm-tint:rgba(31,157,85,.18)}
.dshsm-btn-primary,.dshsm-btn-outline{--dshsm-hue:#2f6fed;--dshsm-hue-strong:#245fd6;--dshsm-tint:rgba(47,111,237,.18)}
.dshsm-btn-danger{--dshsm-hue:#e5484d;--dshsm-hue-strong:#cf3b40;--dshsm-tint:rgba(229,72,77,.18)}
.dshsm-btn-warn{--dshsm-hue:#d97706;--dshsm-hue-strong:#b96405;--dshsm-tint:rgba(217,119,6,.18)}
.dshsm-btn-solid:not(:disabled){background:var(--dshsm-hue);border-color:var(--dshsm-hue);color:#fff}
.dshsm-btn-solid:not(:disabled):hover{background:var(--dshsm-hue-strong);border-color:var(--dshsm-hue-strong)}
.dshsm-btn-solid:not(:disabled):active{background:var(--dshsm-hue-strong);border-color:var(--dshsm-hue-strong)}
.dshsm-btn-hollow:not(:disabled){color:var(--dshsm-hue);border-color:var(--dshsm-hue);background:var(--dshsm-tint)}
.dshsm-btn-hollow:not(:disabled):hover{background:var(--dshsm-hue);border-color:var(--dshsm-hue);color:#fff}
.dshsm-btn-hollow:not(:disabled):active{background:var(--dshsm-hue-strong);border-color:var(--dshsm-hue-strong);color:#fff}
.dshsm-btn-solid:not(:disabled):active,.dshsm-btn-hollow:not(:disabled):active{transform:translateY(1px)}
.dshsm-btn-solid:disabled,.dshsm-btn-hollow:disabled{background:transparent;border-color:rgba(127,127,127,.4);color:inherit;transform:none}
.dshsm-btn:focus-visible{outline:2px solid var(--dshsm-hue,currentColor);outline-offset:1px}
.dshsm-btn-on{background:rgba(127,127,127,.22);border-color:currentColor}
.dshsm-btn-on:not(:disabled):hover{background:rgba(127,127,127,.32)}
.dshsm-banner{display:flex;gap:8px;align-items:flex-start;margin:6px 0;padding:6px 8px;border-radius:6px;
  font-size:11px;line-height:1.6;cursor:pointer}
.dshsm-banner span{flex:1;word-break:break-all}
.dshsm-banner-err{color:var(--dsw-alias-label-danger,#ff453a);border:1px solid rgba(255,69,58,.45);background:rgba(255,69,58,.08)}
.dshsm-banner-ok{color:#34c759;border:1px solid rgba(52,199,89,.45);background:rgba(52,199,89,.08)}
.dshsm-form{margin:8px 0;padding:10px;border-radius:8px;border:1px solid rgba(127,127,127,.35)}
.dshsm-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.dshsm-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshsm-field label{font-size:11px;opacity:.65}
.dshsm-input{width:100%;box-sizing:border-box;padding:5px 7px;border-radius:6px;font-size:12px;font-family:inherit;
  border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.08);color:inherit}
.dshsm-input:focus{outline:1px solid rgba(127,127,127,.6);outline-offset:0}
.dshsm-ws{margin:10px 0 4px;font-size:11px;opacity:.65;letter-spacing:.03em;word-break:break-all}
.dshsm-site{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-bottom:6px;padding:8px;
  border-radius:8px;border:1px solid rgba(127,127,127,.3)}
.dshsm-dot{width:8px;height:8px;border-radius:4px;flex:none;margin-top:5px}
.dshsm-st-running{background:#34c759}
.dshsm-st-starting{background:#ff9f0a}
.dshsm-st-unhealthy{background:#ff9f0a}
.dshsm-st-stopping{background:#ff9f0a}
.dshsm-st-stopped{background:#98989d}
.dshsm-st-failed{background:#ff453a}
.dshsm-site-main{flex:1 1 200px;min-width:0}
.dshsm-site-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:600}
.dshsm-tag{font-size:10px;padding:0 5px;border-radius:4px;border:1px solid rgba(127,127,127,.45);opacity:.85}
.dshsm-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:3px;font-size:11px;opacity:.65}
.dshsm-cmd{font-family:ui-monospace,SFMono-Regular,monospace;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshsm-link{color:inherit;text-decoration:underline;text-underline-offset:2px;word-break:break-all}
.dshsm-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dshsm-detail{margin:-2px 0 8px;padding:8px;border-radius:8px;
  border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.06)}
.dshsm-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:6px}
.dshsm-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshsm-row + .dshsm-row{margin-top:6px}
.dshsm-log{min-height:120px;max-height:320px;overflow:auto;border-radius:6px;padding:8px;
  background:rgba(127,127,127,.12);font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.5}
.dshsm-logline{white-space:pre-wrap;word-break:break-all}
.dshsm-list{max-height:150px;overflow:auto;border-radius:6px;padding:6px;background:rgba(127,127,127,.1);
  font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.6}
.dshsm-step{display:flex;gap:6px;align-items:flex-start;font-size:11px;line-height:1.6}
.dshsm-step-ok{color:#34c759}
.dshsm-step-bad{color:var(--dsw-alias-label-danger,#ff453a)}
.dshsm-hint{font-size:11px;opacity:.6;line-height:1.6;word-break:break-all}
.dshsm-empty{padding:20px 0;font-size:12px;line-height:1.7;text-align:center;opacity:.55}
.dshsm-mask{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.45);pointer-events:auto}
.dshsm-modal{width:380px;max-width:90vw;padding:16px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);
  border:1px solid rgba(127,127,127,.4);box-shadow:0 12px 32px rgba(0,0,0,.4)}
.dshsm-modal-title{font-size:14px;font-weight:600;margin-bottom:6px}
.dshsm-modal-text{font-size:12px;line-height:1.6;opacity:.7;word-break:break-all}
.dshsm-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.dshsm-sec{margin:8px 0 0;padding:8px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.04)}
.dshsm-sec-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;font-weight:600;margin-bottom:6px}
.dshsm-mon{margin:8px 0 0;padding:8px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.04)}
.dshsm-mon-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 14px}
.dshsm-mon-metric{display:flex;align-items:center;gap:6px;font-size:11px;min-width:0}
.dshsm-mon-k{min-width:34px;opacity:.65}
.dshsm-mon-v{font-family:ui-monospace,SFMono-Regular,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshsm-mon-bar{flex:1 1 60px;min-width:50px;height:6px;border-radius:3px;background:rgba(127,127,127,.25);overflow:hidden}
.dshsm-mon-fill{height:100%;border-radius:3px;transition:width .3s ease}
.dshsm-mon-sub{font-size:11px;opacity:.65;margin:8px 0 4px}
.dshsm-mon-list{max-height:200px;overflow:auto;border-radius:6px;padding:6px;background:rgba(127,127,127,.1);
  font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.6}
.dshsm-mon-task{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshsm-mon-task + .dshsm-mon-task{margin-top:3px}
.dshsm-mon-task-label{flex:1 1 150px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsm-mon-badge{font-size:10px;padding:0 4px;border-radius:4px;border:1px solid rgba(127,127,127,.45);opacity:.8}
.dshsm-mon-num{opacity:.7;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshsm-mon-chips{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;opacity:.7;margin-top:6px}
.dshsm-pre{max-height:200px;overflow:auto;border-radius:6px;padding:6px 8px;background:rgba(127,127,127,.1);
  font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-all}
.dshsm-cmdblock{margin-left:14px;white-space:pre-wrap;word-break:break-all;opacity:.8;
  font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.5}
.dshsm-step-skip{opacity:.6}
.dshsm-warn{color:#ff9f0a}
.dshsm-textarea{width:100%;box-sizing:border-box;min-height:160px;padding:6px 8px;border-radius:6px;resize:vertical;
  border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.08);color:inherit;
  font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.55}
.dshsm-textarea:focus{outline:1px solid rgba(127,127,127,.6)}
.dshsm-key{display:flex;flex-direction:column;gap:2px;margin-top:4px;padding:6px;border-radius:6px;
  border:1px solid rgba(127,127,127,.25)}
.dshsm-check{display:flex;align-items:center;gap:4px;font-size:11px;line-height:1.6;opacity:.85}
.dshsm-file{font-size:11px}
.dshsm-full{grid-column:1 / -1}
.dshsm-textarea-sm{min-height:56px;font-family:inherit;font-size:12px}
.dshsm-env{margin:6px 0 8px;padding:8px 10px;border-radius:8px;border:1px solid rgba(76,125,255,.45);
  border-left:3px solid #4c7dff;background:rgba(76,125,255,.1)}
.dshsm-env-label{font-size:10px;letter-spacing:.06em;opacity:.6}
.dshsm-env-text{font-size:13px;font-weight:600;line-height:1.6;white-space:pre-wrap;word-break:break-all;margin-top:2px}
.dshsm-env-empty{font-weight:400;font-size:12px;opacity:.55}
.dshsm-env-meta{font-size:11px;line-height:1.7;opacity:.72;word-break:break-all;margin-top:4px}
.dshsm-env-meta b{font-weight:600;opacity:.9}
.dshsm-env-notes{margin-top:2px;font-size:11px;line-height:1.65;opacity:.75;white-space:pre-wrap;word-break:break-all;
  max-height:240px;overflow:auto;font-family:ui-monospace,SFMono-Regular,monospace}
.dshsm-env-notes-collapsed{max-height:42px;overflow:hidden}
.dshsm-readonly{padding:5px 7px;border-radius:6px;border:1px dashed rgba(127,127,127,.45);
  background:rgba(127,127,127,.06);font-size:11px;line-height:1.6;word-break:break-all;opacity:.9;
  font-family:ui-monospace,SFMono-Regular,monospace}
.dshsm-filled{margin-top:4px;font-size:11px;line-height:1.6;color:#34c759;word-break:break-all}
.dshsm-subblock{margin-top:6px;padding:6px 8px;border-radius:6px;
  border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.05)}
.dshsm-publish{border-color:rgba(255,159,10,.55);background:rgba(255,159,10,.1)}
.dshsm-publish-label{font-size:10px;letter-spacing:.06em;opacity:.7;margin-bottom:2px}
.dshsm-kv{display:flex;gap:6px;font-size:11px;line-height:1.7;word-break:break-all}
.dshsm-kv-key{opacity:.6;flex:none;min-width:84px}
.dshsm-mono{font-family:ui-monospace,SFMono-Regular,monospace;word-break:break-all}
.dshsm-svc{margin-right:9px;font-size:11px;line-height:1.6;white-space:nowrap}
.dshsm-note{margin-top:6px;padding:6px 8px;border-radius:6px;font-size:11px;line-height:1.65;
  word-break:break-all;opacity:.85;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.07)}
.dshsm-rel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 0}
.dshsm-envtext{margin-top:2px}
.dshsm-envtext .dshsm-textarea{min-height:74px}
.dshsm-mode{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0 6px}
.dshsm-sch{flex:none;font-size:10px;line-height:1.7;padding:0 5px;border-radius:4px;border:1px solid currentColor;opacity:.95}
.dshsm-sch-pending{color:#4c7dff}
.dshsm-sch-running{color:#ff9f0a}
.dshsm-sch-done{color:#34c759}
.dshsm-sch-failed{color:var(--dsw-alias-label-danger,#ff453a)}
.dshsm-sch-cancelled{color:#98989d}
.dshsm-schrow{display:flex;flex-direction:column;gap:2px;padding:5px 6px;border-radius:6px;
  border:1px solid rgba(127,127,127,.22)}
.dshsm-schrow + .dshsm-schrow{margin-top:4px}
.dshsm-dt{width:172px;flex:none}
`
  const styleInjected = { value: false }
  const ensureStyles = () => {
    if (styleInjected.value) return
    styleInjected.value = true
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-wei-sitecontrol'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  /**
   * `options.tone` colours a button by intent, so a glance is enough to tell how
   * much a click can hurt:
   *   'go'      solid green  — touches production (开始发布 / 设定定时发布)
   *   'primary' solid blue   — next step of the main flow (探测 / 建档 / 预览 / 上传)
   *   'outline' bordered blue— saves and refreshes that reach nothing remote
   *   'danger'  solid red    — irreversible (删除 / 释放端口 / 回滚 / 取消排期)
   *   'warn'    bordered amber — stop / slow down
   * `options.fill` overrides the default fill for a tone, which is how the site
   * row gets a *bordered* green 启动 (`{ tone: 'go', fill: false }`).
   * Everything else is unchanged: `danger: true` still works and now renders as
   * solid red; `active` / `disabled` / `title` / `key` behave exactly as before.
   */
  const TONE_FILL = { go: true, primary: true, outline: false, danger: true, warn: false }
  const btn = (label, onClick, opts) => {
    const options = opts || {}
    let className = 'dshsm-btn'
    const tone = options.tone || (options.danger ? 'danger' : '')
    if (tone) className += ` dshsm-btn-${tone}`
    if (tone) {
      const filled = options.fill == null ? TONE_FILL[tone] === true : options.fill === true
      className += filled ? ' dshsm-btn-solid' : ' dshsm-btn-hollow'
    }
    if (options.active) className += ' dshsm-btn-on'
    return h('button', {
      key: options.key,
      className,
      title: options.title,
      disabled: options.disabled,
      onClick,
    }, label)
  }

  // ── sidebar footer button ───────────────────────────────────────────────
  const SiteManagerButton = (props) => {
    useSiteManager()
    ensureStyles()
    // Keeps the badge fresh whether or not the drawer is open.
    React.useEffect(() => {
      refresh()
      const timer = setInterval(refresh, 5000)
      return () => clearInterval(timer)
    }, [])
    const wide = props && props.wide
    const n = runningCount()
    // The sidebar collapses to a 56px rail, which has room for the icon only.
    // Any other state (`wide === true`, or a slot that passes no `wide` at all)
    // shows the text label next to the glyph.
    const showLabel = wide !== false
    return h('button', {
      className: 'dshsm-badge dshsm-btn dshsm-entry',
      style: { position: 'relative', border: 'none', fontSize: wide ? 14 : 16, padding: wide ? '4px 8px' : 6 },
      title: `站点控制器 · 运行中 ${n}`,
      onClick: (e) => {
        // Remember which element opened the drawer: its outside-pointerdown
        // handler exempts this button so a press here is still a plain toggle
        // (see Overview).
        store.openerEl = (e && e.currentTarget) || (e && e.target) || null
        store.open = !store.open
        if (!store.open) {
          closeDetail()
          store.confirm = undefined
        }
        refresh()
        store.emit()
      },
    },
      h('span', { className: 'dshsm-entry-icon' }, '▶︎'),
      showLabel ? h('span', { className: 'dshsm-entry-label' }, '站点控制器') : null,
      n > 0 ? h('span', { className: 'dshsm-badge-n' }, String(n)) : null,
    )
  }

  // ── add-site form ───────────────────────────────────────────────────────
  const AddSiteForm = () => {
    useSiteManager()
    const form = store.form
    if (!form.open) return null
    const values = form.values || {}
    const set = (key) => (e) => { form.values[key] = e.target.value; store.emit() }
    const field = (key, label, placeholder, opts) => h('div', { className: 'dshsm-field', key },
      h('label', null, label),
      h('input', {
        className: 'dshsm-input',
        type: opts && opts.number ? 'number' : 'text',
        value: values[key] || '',
        placeholder: placeholder || '',
        onChange: set(key),
        onKeyDown: (e) => { if (e.key === 'Enter') submitForm() },
      }),
    )
    return h('div', { className: 'dshsm-form' },
      h('div', { className: 'dshsm-row' },
        h('strong', { style: { fontSize: 12 } }, '添加站点'),
        h('span', { className: 'dshsm-hint' }, '名称必填;工作区留空则由 host 决定,端口留空表示无端口'),
      ),
      h('div', { className: 'dshsm-grid' },
        field('name', '名称 *', 'my-site'),
        field('workspace', '工作区', 'E:\\projects\\my-app'),
        field('command', '启动命令', 'npm run dev'),
        field('port', '端口', '3000', { number: true }),
        field('healthPath', '健康路径', '/'),
        field('installCommand', '安装命令', 'npm install'),
        field('gitRemote', 'Git 远程', 'origin'),
        field('gitBranch', 'Git 分支', 'main'),
      ),
      form.error ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { form.error = undefined; store.emit() },
      }, h('span', null, form.error)) : null,
      form.ok ? h('div', {
        className: 'dshsm-banner dshsm-banner-ok', title: '点击关闭',
        onClick: () => { form.ok = undefined; store.emit() },
      }, h('span', null, form.ok)) : null,
      h('div', { className: 'dshsm-row', style: { marginTop: 8, justifyContent: 'flex-end' } },
        btn('取消', () => { form.open = false; form.error = undefined; form.ok = undefined; store.emit() }),
        btn(form.busy ? '保存中…' : '保存', submitForm, { disabled: form.busy, tone: 'outline' }),
      ),
    )
  }

  // ── log view (2s polling while mounted) ─────────────────────────────────
  const LogView = (props) => {
    useSiteManager()
    const site = props.site
    const log = props.log
    const [draft, setDraft] = React.useState(log.q || '')
    const [tailDraft, setTailDraft] = React.useState(String(log.tail))
    const boxRef = React.useRef(null)
    const stickRef = React.useRef(true)

    React.useEffect(() => {
      let stopped = false
      const tick = () => { if (!stopped) loadLogs(log, site.id) }
      tick()
      const timer = setInterval(tick, 2000)
      return () => { stopped = true; clearInterval(timer) }
    }, [site.id, log.tail, log.q])

    // Follow the tail until the user scrolls up.
    React.useEffect(() => {
      const el = boxRef.current
      if (el && stickRef.current) el.scrollTop = el.scrollHeight
    })

    const onScroll = () => {
      const el = boxRef.current
      if (!el) return
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    }
    const applySearch = () => { log.q = draft.trim(); store.emit() }
    const applyTail = () => {
      const n = Math.trunc(Number(tailDraft))
      if (!Number.isFinite(n) || n <= 0) { setTailDraft(String(log.tail)); return }
      log.tail = Math.min(5000, Math.max(10, n))
      setTailDraft(String(log.tail))
      store.emit()
    }

    return h('div', null,
      h('div', { className: 'dshsm-row' },
        h('span', { className: 'dshsm-hint' }, `每 2 秒自动刷新 · 共 ${log.lines.length} 行`),
        h('span', { style: { flex: 1 } }),
        h('span', { className: 'dshsm-hint' }, 'tail'),
        h('input', {
          className: 'dshsm-input', style: { width: 72 }, type: 'number', min: 10, max: 5000,
          value: tailDraft,
          onChange: (e) => setTailDraft(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') applyTail() },
          onBlur: applyTail,
        }),
        h('input', {
          className: 'dshsm-input', style: { width: 150 }, type: 'text', placeholder: '关键字搜索',
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') applySearch() },
        }),
        btn('查询', applySearch),
        btn('立即刷新', () => loadLogs(log, site.id), { disabled: log.busy, tone: 'outline' }),
      ),
      log.error ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { log.error = undefined; store.emit() },
      }, h('span', null, `日志读取失败:${log.error}`)) : null,
      h('div', { className: 'dshsm-log', ref: boxRef, onScroll },
        log.lines.length === 0
          ? h('div', { className: 'dshsm-empty' },
              log.loaded
                ? (log.q ? `没有匹配 “${log.q}” 的日志行` : '暂无日志输出')
                : '加载中…')
          : log.lines.map((line, i) => h('div', { className: 'dshsm-logline', key: i }, line)),
      ),
    )
  }

  // ── git section ─────────────────────────────────────────────────────────
  const GitView = (props) => {
    useSiteManager()
    const site = props.site
    const git = props.git
    React.useEffect(() => { loadGitStatus(git, site.id) }, [site.id])
    const status = git.status || {}
    const changed = Array.isArray(status.changed) ? status.changed : []
    const last = status.lastCommit || null
    const busy = git.busy || git.loading
    return h('div', null,
      h('div', { className: 'dshsm-row' },
        h('span', { className: 'dshsm-hint' },
          `分支 ${status.branch || (site.git && site.git.branch) || '—'} · 变更 ${changed.length} 个文件`),
        status.ahead != null ? h('span', { className: 'dshsm-hint' }, `领先 ${status.ahead}`) : null,
        status.behind != null ? h('span', { className: 'dshsm-hint' }, `落后 ${status.behind}`) : null,
        h('span', { style: { flex: 1 } }),
        btn(git.loading ? '读取中…' : '↻ 刷新状态', () => loadGitStatus(git, site.id), { disabled: git.loading, tone: 'outline' }),
      ),
      h('div', { className: 'dshsm-row' },
        h('span', { className: 'dshsm-hint' }, `远程 ${status.remote || (site.git && site.git.remote) || '—'}`),
      ),
      last ? h('div', { className: 'dshsm-row' },
        h('span', { className: 'dshsm-hint' },
          `最近提交 ${shortOid(last.oid)} ${last.message || ''}${last.author ? ` · ${last.author}` : ''}${last.when ? ` · ${last.when}` : ''}`),
      ) : null,
      changed.length
        ? h('div', { className: 'dshsm-list', style: { marginTop: 6 } },
            changed.slice(0, 50).map((file, i) => h('div', { key: i }, String(file))),
            changed.length > 50 ? h('div', { className: 'dshsm-hint' }, `… 其余 ${changed.length - 50} 个未显示`) : null)
        : h('div', { className: 'dshsm-hint', style: { marginTop: 6 } },
            git.loaded ? '工作区干净,没有待提交的变更' : '正在读取 git 状态…'),
      git.error ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { git.error = undefined; store.emit() },
      }, h('span', null, git.error)) : null,
      git.result ? h('div', {
        className: 'dshsm-banner dshsm-banner-ok', title: '点击关闭',
        onClick: () => { git.result = undefined; store.emit() },
      }, h('span', null, git.result)) : null,
      h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
        h('input', {
          className: 'dshsm-input', style: { flex: 1, minWidth: 160 }, type: 'text', placeholder: '提交信息',
          value: git.message || '',
          onChange: (e) => { git.message = e.target.value; store.emit() },
          onKeyDown: (e) => { if (e.key === 'Enter') doCommit(site, git) },
        }),
        btn(git.busy ? '处理中…' : '提交', () => doCommit(site, git), { disabled: busy || !(git.message || '').trim() }),
        btn('推送', () => doPush(site, git), { disabled: busy, title: '推送当前分支到远程(不在前端收集任何凭证)' }),
      ),
    )
  }

  // ── deploy section ①: server target (non-secret fields only) ────────────
  const TargetsSection = (props) => {
    useSiteManager()
    const dep = props.dep
    const form = store.targetForm
    const vault = store.vault
    const targets = store.targets
    // Focus target for 「新建目标」: clearing an already-empty form is invisible,
    // so the click moves the caret to the field the user must fill next.
    const nameRef = React.useRef(null)
    const targetField = (key, label, placeholder, opts) => h('div', { className: 'dshsm-field', key },
      h('label', null, label),
      h('input', {
        className: 'dshsm-input',
        type: opts && opts.number ? 'number' : 'text',
        ref: opts && opts.ref ? opts.ref : undefined,
        value: form[key] == null ? '' : String(form[key]),
        placeholder: placeholder || '',
        onChange: (e) => { form[key] = e.target.value; form.error = undefined; store.emit() },
      }),
    )
    const targetText = (key, label, placeholder) => h('div', { className: 'dshsm-field dshsm-full', key },
      h('label', null, label),
      h('textarea', {
        className: 'dshsm-textarea dshsm-textarea-sm', spellCheck: false,
        value: form[key] == null ? '' : String(form[key]),
        placeholder: placeholder || '',
        onChange: (e) => { form[key] = e.target.value; form.error = undefined; store.emit() },
      }),
    )
    const detect = form.detect
    const provision = form.provision
    const chosen = targets.filter((t) => t && t.name === String(dep.target || ''))[0] || null
    const environment = String(form.environment || '').trim()
    const notes = String(form.notes || '').trim()
    const sourceDir = String(form.sourceDir || '').trim()
    const editing = String(form.synced || '').trim()
    const envText = form.envText == null ? '' : String(form.envText)
    const busyAny = form.busy || form.saveEnvBusy || form.provisionBusy
    // Prefer the form's copy (refreshed by detect), fall back to the selected
    // target's own record.
    const verified = form.verified && typeof form.verified === 'object'
      ? form.verified
      : (chosen && chosen.verified && typeof chosen.verified === 'object' ? chosen.verified : null)
    const releaseMode = form.deployMode === 'release'
    const releasesDir = String(form.releasesDir || '').trim()
    const configFile = String(form.configFile || '').trim()
    const contextPath = String(form.contextPath || '').trim() || '/'
    return h('div', { className: 'dshsm-sec' },
      h('div', { className: 'dshsm-sec-title' },
        h('span', null, '① 服务器目标'),
        h('span', { className: 'dshsm-hint' }, '选择已有目标即载入下方表单;这里只处理非密钥字段'),
        h('span', { style: { flex: 1 } }),
        btn(store.targetsBusy ? '读取中…' : '↻ 刷新目标', loadTargets, { disabled: store.targetsBusy, tone: 'outline' }),
      ),
      // Natural-language description first: paste/keep the readme text here, then
      // either store it as-is or let the host parse it and confirm over SSH.
      h('div', { className: 'dshsm-envtext' },
        h('div', { className: 'dshsm-row' },
          h('strong', { style: { fontSize: 11 } }, '环境描述(自然语言)'),
          h('span', { className: 'dshsm-hint' },
            '按档案 readme 的写法填写:ip / ssh端口 / 描述 / 发布目录。只放描述文本,不要放私钥内容'),
        ),
        h('textarea', {
          className: 'dshsm-textarea', spellCheck: false,
          placeholder: 'ip:203.0.113.10\nssh端口:TCP:22\n描述:示例公司官网。使用tomcat服务,tomcat应用目录在:/opt/tomcat9。静态web站点。程序发布目录在/srv/www。',
          value: envText,
          onChange: (e) => {
            form.envText = e.target.value
            form.error = undefined
            form.provisionError = undefined
            store.emit()
          },
        }),
        h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
          btn(form.saveEnvBusy ? '保存中…' : '保存描述', saveEnvText, {
            disabled: busyAny,
            tone: 'outline',
            title: '只把这段文本存到目标上,不连接服务器、不改任何字段',
          }),
          btn(form.provisionBusy ? '建档中…' : '按描述建档并连服务器确认', provisionTarget, {
            disabled: busyAny,
            tone: 'primary',
            title: '解析描述 → 连接服务器确认 → 回填目标字段(不改密钥)',
          }),
          h('span', { className: 'dshsm-hint' },
            envText.trim() ? `${envText.length} 字` : '描述为空'),
        ),
        form.provisionError ? h('div', {
          className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
          onClick: () => { form.provisionError = undefined; store.emit() },
        }, h('span', null, `连服务器失败:${form.provisionError} —— 字段以描述为准,可先「保存描述」稍后再试`)) : null,
        provision ? h('div', { className: 'dshsm-subblock' },
          h('div', { className: 'dshsm-row' },
            h('span', { className: provision.ok ? 'dshsm-step-ok' : 'dshsm-step-bad' },
              provision.ok ? '✓ 已按描述建档' : '✗ 建档未完成'),
            provision.adopted ? h('span', { className: 'dshsm-hint' }, '表单已按 host 返回的目标刷新') : null,
            provision.canPublish === false
              ? h('span', { className: 'dshsm-warn' }, '⚠ 缺少发布目录或密钥,还不能发布')
              : null,
          ),
          provision.confirmed.length
            ? h('div', { className: 'dshsm-filled' }, `服务器确认:${provision.confirmed.join(' · ')}`)
            : h('div', { className: 'dshsm-hint' }, '服务器没有返回任何确认项'),
          provision.error
            ? h('div', { className: 'dshsm-note dshsm-warn' }, `连服务器失败:${provision.error};字段以描述为准`)
            : null,
          provision.derived && provision.derived.parsed && typeof provision.derived.parsed === 'object'
            ? h('div', { className: 'dshsm-hint' },
                `描述解析:${Object.keys(provision.derived.parsed)
                  .filter((k) => provision.derived.parsed[k] != null && String(provision.derived.parsed[k]) !== '')
                  .map((k) => `${k}=${provision.derived.parsed[k]}`).join(' · ') || '无有效字段'}`)
            : null,
          Array.isArray(provision.derived && provision.derived.assumed) && provision.derived.assumed.length
            ? h('div', { className: 'dshsm-hint' }, `以下为推测值:${provision.derived.assumed.join(' · ')}`)
            : null,
        ) : null,
      ),
      // 环境描述 summary: the one line that says what this machine is for.
      h('div', { className: 'dshsm-env' },
        h('div', { className: 'dshsm-env-label' }, '环境 / 用途(来自档案)'),
        environment
          ? h('div', { className: 'dshsm-env-text' }, environment)
          : h('div', { className: 'dshsm-env-text dshsm-env-empty' },
              '未填写环境描述 —— 在上面的「环境描述」里写好后点「按描述建档并连服务器确认」,这里就会显示'),
        h('div', { className: 'dshsm-env-meta' },
          h('b', null, '档案来源 '),
          sourceDir
            ? h('span', { className: 'dshsm-mono' }, sourceDir)
            : h('span', null, '未记录(host 会从档案 readme 里带出)'),
        ),
        notes
          ? h('div', null,
              h('div', { className: 'dshsm-env-meta' }, h('b', null, '档案说明')),
              h('div', {
                className: 'dshsm-env-notes' + (form.notesOpen ? '' : ' dshsm-env-notes-collapsed'),
              }, notes),
              notes.length > 80
                ? btn(form.notesOpen ? '收起说明' : `展开说明(${notes.length} 字)`, () => {
                    form.notesOpen = !form.notesOpen
                    store.emit()
                  })
                : null,
            )
          : null,
      ),
      store.targetsError ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { store.targetsError = undefined; store.emit() },
      }, h('span', null, `发布目标读取失败:${store.targetsError}`)) : null,
      h('div', { className: 'dshsm-row' },
        h('select', {
          className: 'dshsm-input', style: { flex: 1, minWidth: 170 },
          value: dep.target || '',
          onChange: (e) => chooseTarget(e.target.value),
        },
          h('option', { value: '' }, store.targetsBusy ? '读取目标中…' : '选择已有目标…'),
          targets.map((t) => h('option', { key: t.name, value: t.name },
            `${t.name} · ${t.user}@${t.host}:${t.port}`)),
        ),
        btn('新建目标', () => {
          if (store.detail && store.detail.deploy) store.detail.deploy.target = ''
          fillTargetForm(null)
          store.notice = '已切换到新建目标,请填写名称与地址'
          noticeSoon('已切换到新建目标,请填写名称与地址', 6000)
          store.emit()
          const input = nameRef.current
          if (input && typeof input.focus === 'function') {
            try { input.focus() } catch { /* a detached input cannot take focus; harmless */ }
          }
        }, { title: '清空表单并把光标移到「名称」;填好后点「保存目标」即为新增目标' }),
      ),
      // Which target the editor is bound to — the two selects share this one
      // choice, and a silent empty form was the confusing part.
      h('div', { className: 'dshsm-mode' },
        h('span', { className: 'dshsm-tag' }, editing ? `正在编辑:${editing}` : '新建目标(尚未保存)'),
        h('span', { className: 'dshsm-hint' },
          editing
            ? '改完点「保存目标」写回 host;下面的字段只影响这台目标'
            : '请填写名称、主机与部署方式,然后点「保存目标」'),
      ),
      store.targetsLoaded && targets.length === 0 && !store.targetsBusy
        ? h('div', { className: 'dshsm-note' },
            '还没有部署目标:可在下面填写「环境描述」后点「按描述建档并连服务器确认」,或直接手填字段后保存。')
        : null,
      h('div', { className: 'dshsm-grid' },
        targetField('name', '目标名 *', 'prod-web', { ref: nameRef }),
        targetField('host', '主机 *', '192.168.1.10'),
        targetField('port', '端口', '22', { number: true }),
        targetField('user', 'SSH 用户', 'root'),
        h('div', { className: 'dshsm-field', key: 'keyName' },
          h('label', null, '密钥(来自保险库)'),
          h('select', {
            className: 'dshsm-input',
            value: form.keyName || '',
            onChange: (e) => { form.keyName = e.target.value; form.error = undefined; store.emit() },
          },
            h('option', { value: '' }, vault.keys.length ? '不指定(沿用目标已有凭据)' : '保险库中还没有密钥'),
            vault.keys.map((k) => h('option', { key: k.name, value: k.name },
              `${k.name}${k.keyType ? ` · ${k.keyType}` : ''}`)),
          ),
        ),
        targetField('uploadDir', '上传目录', '/var/www/html'),
        h('div', { className: 'dshsm-field', key: 'serviceKind' },
          h('label', null, '服务类型'),
          h('select', {
            className: 'dshsm-input',
            value: form.serviceKind || 'custom',
            onChange: (e) => { form.serviceKind = e.target.value; store.emit() },
          },
            SERVICE_KINDS.map((kind) => h('option', { key: kind, value: kind },
              `${kind} · ${SERVICE_KIND_TEXT[kind] || ''}`)),
          ),
        ),
        targetField('serviceName', '服务名(如 httpd / 容器名)', 'httpd'),
        targetField('keepReleases', '保留发布份数', '3', { number: true }),
        h('div', { className: 'dshsm-field', key: 'backup' },
          h('label', null, '发布前备份'),
          h('label', { className: 'dshsm-check' },
            h('input', {
              type: 'checkbox', checked: form.backup !== false,
              onChange: (e) => { form.backup = e.target.checked; store.emit() },
            }),
            '覆盖前在服务器上保留上一版本',
          ),
        ),
        targetText('environment', '环境 / 用途', '例如:示例站点生产环境 · 由档案 readme 提供'),
        targetText('notes', '档案说明(notes)', '档案里其余需要留存的说明文本,可多行'),
        targetField('appHome', '运行时目录 appHome', '/opt/tomcat9'),
        h('div', { className: 'dshsm-field', key: 'sourceDir' },
          h('label', null, '档案来源目录(只读)'),
          h('div', { className: 'dshsm-readonly', title: sourceDir || undefined },
            sourceDir || '未记录 —— 由 host 从档案 readme 带出,不从面板提交'),
        ),
        h('div', { className: 'dshsm-field', key: 'deployMode' },
          h('label', null, '发布方式'),
          h('select', {
            className: 'dshsm-input',
            value: form.deployMode === 'release' ? 'release' : 'inplace',
            onChange: (e) => { form.deployMode = e.target.value; store.emit() },
          },
            h('option', { value: 'inplace' }, 'inplace · 就地覆盖 uploadDir'),
            h('option', { value: 'release' }, 'release · 新建带时间戳的发布目录'),
          ),
        ),
        targetField('releasesDir', '发布目录父目录(release)', '/opt/releases'),
        targetField('configFile', '配置文件(release)', '/opt/tomcat9/conf/server.xml'),
        targetField('contextPath', '上下文路径', '/'),
        h('div', { className: 'dshsm-field', key: 'restartOnDeploy' },
          h('label', null, '发布后动作'),
          h('label', { className: 'dshsm-check' },
            h('input', {
              type: 'checkbox', checked: form.restartOnDeploy !== false,
              onChange: (e) => { form.restartOnDeploy = e.target.checked; store.emit() },
            }),
            '发布时停止并重启服务',
          ),
        ),
      ),
      releaseMode
        ? h('div', { className: 'dshsm-note' },
            `release 模式:发布会在 ${releasesDir || '(未填发布目录父目录)'} 下新建 <时间戳> 目录并把内容放进去,`
            + `再改写 ${configFile || '(未填配置文件)'} 里 ${contextPath} 的 docBase 指向新目录;`
            + '原配置会先备份为 .bak-<时间戳>,之后可以在「③ 发布计划与发布 → 发布历史」里一键回滚到任意旧版本。',
          )
        : null,
      form.error ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { form.error = undefined; store.emit() },
      }, h('span', null, form.error)) : null,
      form.ok ? h('div', {
        className: 'dshsm-banner dshsm-banner-ok', title: '点击关闭',
        onClick: () => { form.ok = undefined; store.emit() },
      }, h('span', null, form.ok)) : null,
      h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
        btn(form.busy ? '保存中…' : '保存目标', saveTarget, { disabled: busyAny, tone: 'outline' }),
        btn(form.pingBusy ? '连接中…' : '测试连接', pingTarget, {
          disabled: busyAny, tone: 'outline', title: '登录一次并读取远端系统信息',
        }),
        btn(form.detectBusy ? '探测中…' : '探测服务器', detectTarget, {
          disabled: busyAny, tone: 'primary', title: '只读探测:已有的 web 服务器、目录与监听端口',
        }),
      ),
      form.pingError || form.ping ? h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
        form.pingError
          ? h('span', { className: 'dshsm-step-bad' }, `✗ ${form.pingError}`)
          : h('span', { className: form.ping.ok ? 'dshsm-step-ok' : 'dshsm-step-bad' },
              form.ping.ok ? '✓ 连接成功' : '✗ 连接失败'),
        form.ping && form.ping.detail
          ? h('span', { className: 'dshsm-cmd', title: form.ping.detail }, form.ping.detail)
          : null,
      ) : null,
      form.detectError ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { form.detectError = undefined; store.emit() },
      }, h('span', null, form.detectError)) : null,
      detect ? h('div', { style: { marginTop: 6 } },
        h('div', { className: 'dshsm-row' },
          h('span', { className: detect.ok ? 'dshsm-step-ok' : 'dshsm-step-bad' },
            detect.ok ? '✓ 探测完成' : '✗ 探测失败'),
          detect.suggestedSource === 'detected'
            ? h('span', { className: 'dshsm-hint' }, '建议目录来自服务器实际探测')
            : null,
          detect.adopted ? h('span', { className: 'dshsm-hint' }, '表单已按 host 落库的目标刷新') : null,
        ),
        // The host persists what it probed; echo back exactly what it filled so
        // the change is visible rather than mysterious.
        detect.filled && detect.filled.length
          ? h('div', { className: 'dshsm-filled' }, `本次自动补齐:${detect.filled.join(', ')}`)
          : null,
        detect.summary ? preLines(detect.summary, { style: { marginTop: 4 } }) : null,
        !detect.summary && detect.error ? h('div', { className: 'dshsm-hint' }, detect.error) : null,
        findingsHint(detect.findings),
        detect.suggestedUploadDir ? h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
          h('span', { className: 'dshsm-hint' }, `建议上传目录:${detect.suggestedUploadDir}`),
          btn('采用建议', () => {
            form.uploadDir = detect.suggestedUploadDir
            store.notice = `已把上传目录填为 ${detect.suggestedUploadDir} —— 还要点「保存目标」才会写入`
            store.emit()
          }, { title: '只填入表单,不会自动保存', tone: 'outline' }),
        ) : null,
      ) : null,
      verifiedBlock(verified),
    )
  }

  // ── deploy section ②: key vault (metadata in, key material never out) ───
  const KeysSection = () => {
    useSiteManager()
    const vault = store.vault
    const fileRef = React.useRef(null)
    const keys = vault.keys
    return h('div', { className: 'dshsm-sec' },
      h('div', { className: 'dshsm-sec-title' },
        h('span', null, '② 密钥保险库'),
        h('span', { className: 'dshsm-hint' }, '只显示元数据与指纹;私钥内容永不回显'),
        h('span', { style: { flex: 1 } }),
        btn(vault.busy ? '读取中…' : '↻ 刷新', loadKeys, { disabled: vault.busy, tone: 'outline' }),
      ),
      vault.dir ? h('div', { className: 'dshsm-hint' }, `存储目录 ${vault.dir}`) : null,
      vault.error ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { vault.error = undefined; store.emit() },
      }, h('span', null, `密钥列表读取失败:${vault.error}`)) : null,
      keys.length
        ? keys.map((key) => h('div', { className: 'dshsm-key', key: key.name },
            h('div', { className: 'dshsm-row' },
              h('strong', { style: { fontSize: 12 } }, key.name),
              key.keyType ? h('span', { className: 'dshsm-tag' }, String(key.keyType)) : null,
              key.encrypted ? h('span', { className: 'dshsm-tag' }, '加密私钥') : null,
              h('span', { className: 'dshsm-hint' }, `${key.bytes == null ? '?' : key.bytes} 字节`),
              h('span', { className: 'dshsm-hint' }, stamp(key.uploadedAt)),
              h('span', { style: { flex: 1 } }),
              btn(vault.delBusy[key.name] ? '删除中…' : '删除', () => removeKey(key), {
                danger: true, disabled: !!vault.delBusy[key.name], title: `从保险库删除 ${key.name}`,
              }),
            ),
            h('div', { className: 'dshsm-hint', style: { fontFamily: 'ui-monospace,SFMono-Regular,monospace' } },
              key.fingerprint
                ? `指纹 ${key.fingerprint}`
                : '指纹 不可用(加密私钥需要口令才能算出公钥指纹)'),
            key.warning ? h('div', { className: 'dshsm-warn', style: { fontSize: 11, lineHeight: 1.6 } },
              `⚠ ${key.warning}`) : null,
          ))
        : h('div', { className: 'dshsm-hint', style: { marginTop: 4 } },
            vault.loaded ? '保险库中还没有密钥 —— 用下面两种方式导入 PEM 私钥' : '正在读取密钥列表…'),
      h('div', { className: 'dshsm-row', style: { marginTop: 8 } },
        h('input', {
          className: 'dshsm-input', style: { flex: '1 1 120px', minWidth: 110 }, type: 'text',
          placeholder: '密钥名(字母数字 . _ -)',
          value: vault.name || '',
          onChange: (e) => { vault.name = e.target.value; vault.formError = undefined; store.emit() },
        }),
        h('input', {
          className: 'dshsm-input dshsm-file', style: { flex: '1 1 160px' }, type: 'file', ref: fileRef,
          title: '选择 PEM 私钥文件;内容只在浏览器内读取后直接上传,不显示也不保存到界面状态',
          onChange: (e) => pickKeyFile(e),
        }),
        btn(vault.uploading ? '上传中…' : '上传密钥', () => uploadPendingKey(fileRef), { disabled: vault.uploading, tone: 'primary' }),
      ),
      h('div', { className: 'dshsm-hint', style: { marginTop: 2 } },
        vault.pickedBytes == null
          ? '选择文件后会在浏览器内读取文本并直接上传(内容不会显示在界面上)'
          : `已读取 ${vault.pickedBytes} 字节,等待上传(内容不会显示)`),
      h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
        h('input', {
          className: 'dshsm-input', style: { flex: 1, minWidth: 170 }, type: 'text',
          placeholder: '本机私钥绝对路径,如 C:\\Users\\me\\.ssh\\id_rsa',
          value: vault.path || '',
          onChange: (e) => { vault.path = e.target.value; vault.formError = undefined; store.emit() },
        }),
        btn(vault.importBusy ? '导入中…' : '从本机路径导入', importKeyFromPath, { disabled: vault.importBusy, tone: 'primary' }),
      ),
      vault.formError ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { vault.formError = undefined; store.emit() },
      }, h('span', null, vault.formError)) : null,
      vault.formOk ? h('div', {
        className: 'dshsm-banner dshsm-banner-ok', title: '点击关闭',
        onClick: () => { vault.formOk = undefined; store.emit() },
      }, h('span', null, vault.formOk)) : null,
    )
  }

  // ── deploy section ③: plan preview + publish ────────────────────────────
  const PlanSection = (props) => {
    useSiteManager()
    const site = props.site
    const dep = props.dep
    const targets = store.targets
    const sched = store.schedules
    const chosen = targets.filter((t) => t.name === dep.target)[0] || null
    const declared = Array.isArray(site.deployTargets) ? site.deployTargets : []
    const plan = dep.plan
    return h('div', { className: 'dshsm-sec' },
      h('div', { className: 'dshsm-sec-title' },
        h('span', null, '③ 发布计划与发布'),
        h('span', { className: 'dshsm-hint' }, '先预览计划(只读探测),确认后再发布'),
        h('span', { style: { flex: 1 } }),
        btn(sched.busy ? '读取中…' : '↻ 排期', loadSchedules, {
          disabled: sched.busy, tone: 'outline', title: '刷新定时发布列表',
        }),
      ),
      h('div', { className: 'dshsm-row' },
        h('select', {
          className: 'dshsm-input', style: { flex: 1, minWidth: 170 },
          value: dep.target || '',
          onChange: (e) => chooseTarget(e.target.value),
        },
          h('option', { value: '' }, store.targetsBusy ? '读取目标中…' : '选择发布目标…'),
          targets.map((t) => h('option', { key: t.name, value: t.name },
            `${t.name} · ${t.user}@${t.host}:${t.port}`)),
        ),
        h('label', { className: 'dshsm-check' },
          h('input', {
            type: 'checkbox', checked: !!dep.dryRun,
            onChange: (e) => { dep.dryRun = e.target.checked; store.emit() },
          }),
          '演练 (dryRun)',
        ),
        btn(dep.planBusy ? '预览中…' : '预览计划', () => runPlan(site, dep), {
          disabled: dep.planBusy || dep.busy || !dep.target, tone: 'primary',
        }),
        btn(dep.busy ? '发布中…' : '开始发布', () => runDeploy(site, dep), {
          disabled: dep.busy || dep.planBusy || !dep.target, tone: 'go',
        }),
      ),
      // ── 定时发布: right next to 「开始发布」 ───────────────────────────────
      h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
        h('span', { className: 'dshsm-hint' }, '定时发布'),
        h('input', {
          className: 'dshsm-input dshsm-dt', type: 'datetime-local',
          value: sched.at || '',
          onChange: (e) => { sched.at = e.target.value; sched.formError = undefined; store.emit() },
          title: '按本机时区选择时间;提交时会转成 ISO 瞬时时间',
        }),
        h('input', {
          className: 'dshsm-input', style: { flex: '1 1 110px', minWidth: 96 }, type: 'text',
          placeholder: '备注(可选)',
          value: sched.note || '',
          onChange: (e) => { sched.note = e.target.value; store.emit() },
          onKeyDown: (e) => { if (e.key === 'Enter') createSchedule(site, dep) },
        }),
        btn(sched.creating ? '排定中…' : '设定定时发布', () => createSchedule(site, dep), {
          disabled: sched.creating || !dep.target,
          tone: 'go',
          title: '到点后由 host 按与「开始发布」相同的流程自动发布',
        }),
      ),
      store.targetForm.canPublish === false
        ? h('div', { className: 'dshsm-note dshsm-warn' }, '⚠ 缺少发布目录或密钥,还不能发布')
        : null,
      sched.formError ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { sched.formError = undefined; store.emit() },
      }, h('span', null, sched.formError)) : null,
      sched.ok ? h('div', {
        className: 'dshsm-banner dshsm-banner-ok', title: '点击关闭',
        onClick: () => { sched.ok = undefined; store.emit() },
      }, h('span', null, sched.ok)) : null,
      sched.error ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { sched.error = undefined; store.emit() },
      }, h('span', null, sched.error)) : null,
      h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
        h('span', { className: 'dshsm-hint' }, `排期${sched.loaded ? `(${sched.list.length})` : ''}`),
      ),
      sched.list.length
        ? h('div', { className: 'dshsm-list', style: { maxHeight: 220 } },
            sched.list.map((rec) => {
              const id = rec && rec.id ? String(rec.id) : ''
              const state = SCHEDULE_STATE[rec && rec.status] || {
                text: rec && rec.status ? String(rec.status) : '状态未知',
                cls: 'dshsm-sch-cancelled',
              }
              const expanded = !!sched.open[id]
              const result = rec && rec.result && typeof rec.result === 'object' ? rec.result : null
              const steps = result && Array.isArray(result.steps) ? result.steps.filter(Boolean) : []
              const hasDetail = !!(result || (rec && rec.error))
              return h('div', { key: id || `${rec && rec.at}-${rec && rec.targetName}`, className: 'dshsm-schrow' },
                h('div', { className: 'dshsm-row' },
                  h('span', { className: `dshsm-sch ${state.cls}` }, state.text),
                  h('strong', { style: { fontSize: 11 } }, localTimeLabel(rec && rec.at)),
                  h('span', { className: 'dshsm-hint' },
                    rec && rec.targetName ? `目标 ${rec.targetName}` : '目标未记录'),
                  rec && rec.siteName ? h('span', { className: 'dshsm-hint' }, `站点 ${rec.siteName}`) : null,
                  rec && rec.note ? h('span', { className: 'dshsm-hint', title: String(rec.note) }, `备注 ${rec.note}`) : null,
                  h('span', { style: { flex: 1 } }),
                  hasDetail ? btn(expanded ? '收起详情' : '详情', () => {
                    sched.open[id] = !expanded
                    store.emit()
                  }) : null,
                  rec && rec.status === 'pending' ? btn(sched.delBusy[id] ? '取消中…' : '取消', () => cancelSchedule(rec), {
                    tone: 'danger',
                    disabled: !!sched.delBusy[id],
                    title: `取消 ${localTimeLabel(rec && rec.at)} 的排期`,
                  }) : null,
                ),
                expanded ? h('div', { className: 'dshsm-subblock' },
                  result && result.uploadDir
                    ? h('div', { className: 'dshsm-kv' },
                        h('span', { className: 'dshsm-kv-key' }, '上传目录'),
                        h('span', { className: 'dshsm-mono' }, String(result.uploadDir)))
                    : null,
                  steps.length
                    ? steps.map((step, i) => h('div', {
                        key: i,
                        className: `dshsm-step ${stepMark(step).cls}`,
                      },
                        h('span', null, stepMark(step).mark),
                        h('span', null, `${step && step.name ? step.name : '步骤'}${step && step.detail ? ` — ${step.detail}` : ''}`),
                      ))
                    : h('div', { className: 'dshsm-hint' }, '该排期还没有步骤记录'),
                  rec && rec.error ? h('div', { className: 'dshsm-warn', style: { fontSize: 11, lineHeight: 1.6 } },
                    `错误:${rec.error}`) : null,
                  h('div', { className: 'dshsm-hint' },
                    `创建 ${localTimeLabel(rec && rec.createdAt)}`
                    + (rec && rec.startedAt ? ` · 开始 ${localTimeLabel(rec.startedAt)}` : '')
                    + (rec && rec.finishedAt ? ` · 结束 ${localTimeLabel(rec.finishedAt)}` : '')),
                ) : null,
              )
            }))
        : h('div', { className: 'dshsm-hint' }, sched.loaded ? '还没有排期' : '正在读取排期…'),
      chosen ? h('div', { className: 'dshsm-hint', style: { marginTop: 4 } },
        `目标 ${chosen.name} → ${chosen.user}@${chosen.host}:${chosen.port}${chosen.uploadDir || chosen.remotePath ? ` · ${chosen.uploadDir || chosen.remotePath}` : ''} · ${chosen.hasKey ? '已配置密钥' : '未配置密钥'}`) : null,
      declared.length ? h('div', { className: 'dshsm-hint', style: { marginTop: 2 } },
        `该站点声明的目标:${declared.join('、')}`) : null,
      h('label', { className: 'dshsm-check', style: { marginTop: 6 } },
        h('input', {
          type: 'checkbox', checked: dep.allowInstall === true,
          onChange: (e) => { dep.allowInstall = e.target.checked; store.emit() },
        }),
        '允许在服务器上安装缺失的运行时(如 httpd/nginx)',
      ),
      dep.planError ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { dep.planError = undefined; store.emit() },
      }, h('span', null, dep.planError)) : null,
      plan ? h('div', { style: { marginTop: 6 } },
        h('div', { className: 'dshsm-row' },
          h('span', { className: plan.ok ? 'dshsm-step-ok' : 'dshsm-step-bad' },
            plan.ok ? '✓ 发布计划' : '✗ 发布计划不可用'),
          h('span', { className: 'dshsm-hint' },
            `上传目录 ${plan.uploadDir || '未确定'}${plan.uploadDirSource === 'detected' ? '(来自探测)' : plan.uploadDirSource ? '(来自目标配置)' : ''}`),
        ),
        plan.steps.length
          ? h('div', { className: 'dshsm-list', style: { marginTop: 4 } },
              plan.steps.map((step, i) => h('div', { key: i },
                h('div', { className: 'dshsm-step' },
                  h('span', null, '•'),
                  h('span', null, `${step && step.name ? step.name : '步骤'}:${step && step.detail ? ` ${step.detail}` : ''}`),
                ),
                step && step.command ? h('div', { className: 'dshsm-cmdblock' }, `$ ${step.command}`) : null,
              )))
          : h('div', { className: 'dshsm-hint' }, 'host 未返回任何步骤'),
        plan.summary ? h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
          h('span', { className: 'dshsm-hint' }, '服务器现状'),
        ) : null,
        plan.summary ? preLines(plan.summary, { style: { marginTop: 2 } }) : null,
      ) : null,
      dep.error ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { dep.error = undefined; store.emit() },
      }, h('span', null, dep.error)) : null,
      dep.result ? h('div', {
        className: 'dshsm-banner ' + (dep.ok ? 'dshsm-banner-ok' : 'dshsm-banner-err'),
        title: '点击关闭',
        onClick: () => { dep.result = undefined; dep.steps = undefined; dep.ok = undefined; store.emit() },
      }, h('span', null, dep.result)) : null,
      dep.steps ? h('div', { className: 'dshsm-list', style: { marginTop: 6 } },
        dep.steps.length === 0
          ? h('div', { className: 'dshsm-hint' }, 'host 未返回任何步骤')
          : dep.steps.map((step, i) => h('div', {
              key: i,
              className: `dshsm-step ${stepMark(step).cls}`,
            },
              h('span', null, stepMark(step).mark),
              h('span', null, `${step && step.name ? step.name : '步骤'}${step && step.detail ? ` — ${step.detail}` : ''}`),
            )),
      ) : null,
      // ── release history + roll-back (needs a target) ─────────────────────
      h('div', { className: 'dshsm-row', style: { marginTop: 8 } },
        btn(dep.releasesBusy ? '读取中…' : '发布历史', () => showReleases(site, dep), {
          disabled: dep.releasesBusy || !dep.target,
          tone: 'outline',
          title: '列出服务器上的发布目录(新→旧)与当前 docBase,可回滚到任意旧版本',
        }),
        dep.releasesTarget ? h('span', { className: 'dshsm-hint' }, `目标 ${dep.releasesTarget}`) : null,
        dep.releases ? h('span', { className: 'dshsm-hint' }, `${dep.releases.length} 个版本`) : null,
        h('span', { style: { flex: 1 } }),
        dep.releases === undefined ? null : btn('收起历史', () => {
          dep.releases = undefined
          dep.releasesTarget = ''
          dep.currentDocBase = ''
          dep.releasesError = undefined
          dep.rollbackSteps = undefined
          dep.rollbackResult = undefined
          dep.rollbackError = undefined
          store.emit()
        }),
      ),
      dep.releasesError ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { dep.releasesError = undefined; store.emit() },
      }, h('span', null, dep.releasesError)) : null,
      dep.releases === undefined ? null : h('div', { style: { marginTop: 4 } },
        h('div', { className: 'dshsm-hint' },
          `当前 docBase:${dep.currentDocBase || '未识别 —— 服务器配置里没有可解析的发布目录'}`),
        dep.releases.length === 0
          ? h('div', { className: 'dshsm-hint' }, '没有找到任何发布目录(该目标可能仍是 inplace 模式)')
          : h('div', { className: 'dshsm-list', style: { marginTop: 4 } },
              dep.releases.map((rel, i) => {
                const name = rel && rel.name ? String(rel.name) : `#${i + 1}`
                const path = rel && rel.path ? String(rel.path) : ''
                const current = isCurrentRelease(dep.currentDocBase, rel)
                return h('div', { key: name, className: 'dshsm-rel' },
                  h('span', { className: current ? 'dshsm-step-ok' : 'dshsm-step-skip' },
                    current ? '● 当前生效' : '○'),
                  h('strong', { style: { fontSize: 11 } }, name),
                  path ? h('span', { className: 'dshsm-mono dshsm-hint', title: path }, path) : null,
                  h('span', { style: { flex: 1 } }),
                  current
                    ? null
                    : btn(dep.rollbackBusy === name ? '回滚中…' : '回滚到此版本', () => doRollback(site, dep, rel), {
                        tone: 'danger',
                        disabled: !!dep.rollbackBusy || !(rel && rel.name),
                        title: `回滚到 ${name}(会二次确认)`,
                      }),
                )
              }),
            ),
      ),
      dep.rollbackError ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { dep.rollbackError = undefined; store.emit() },
      }, h('span', null, dep.rollbackError)) : null,
      dep.rollbackResult && dep.rollbackResult.ok ? h('div', {
        className: 'dshsm-banner dshsm-banner-ok', title: '点击关闭',
        onClick: () => { dep.rollbackResult = undefined; dep.rollbackSteps = undefined; store.emit() },
      }, h('span', null,
        `已回滚到 ${dep.rollbackResult.rolledBackTo}`
        + (dep.rollbackResult.configFile ? ` · 已改写 ${dep.rollbackResult.configFile}` : '')
        + ' · 原配置已备份为 .bak-<时间戳>')) : null,
      dep.rollbackSteps ? h('div', { className: 'dshsm-list', style: { marginTop: 6 } },
        dep.rollbackSteps.length === 0
          ? h('div', { className: 'dshsm-hint' }, 'host 未返回任何步骤')
          : dep.rollbackSteps.map((step, i) => h('div', {
              key: i,
              className: `dshsm-step ${stepMark(step).cls}`,
            },
              h('span', null, stepMark(step).mark),
              h('span', null, `${step && step.name ? step.name : '步骤'}${step && step.detail ? ` — ${step.detail}` : ''}`),
            )),
      ) : null,
    )
  }

  // ── deploy section ④: stored deploy scripts ─────────────────────────────
  const ScriptsSection = (props) => {
    useSiteManager()
    const dep = props.dep
    const scripts = store.scripts
    const [draft, setDraft] = React.useState(scripts.content || '')
    // Resync the editor only when the host handed us new content, so typing does
    // not re-render the whole drawer on every keystroke.
    React.useEffect(() => { setDraft(scripts.content || '') }, [scripts.rev])
    return h('div', { className: 'dshsm-sec' },
      h('div', { className: 'dshsm-sec-title' },
        h('span', null, '④ 存储的部署脚本'),
        h('span', { className: 'dshsm-hint' }, '远端脚本(备份/停止/启动/校验),发布时经标准输入执行'),
        h('span', { style: { flex: 1 } }),
        btn(scripts.busy ? '读取中…' : '↻ 刷新', loadScripts, { disabled: scripts.busy, tone: 'outline' }),
        btn(scripts.genBusy ? '生成中…' : '生成默认脚本', () => generateScript(dep.target), {
          disabled: scripts.genBusy, tone: 'outline', title: '按当前选中的发布目标生成默认脚本',
        }),
      ),
      scripts.error ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { scripts.error = undefined; store.emit() },
      }, h('span', null, scripts.error)) : null,
      scripts.list.length
        ? h('div', { className: 'dshsm-list' },
            scripts.list.map((item) => h('div', { key: item.name, className: 'dshsm-row' },
              btn(item.name, () => openScript(item.name), {
                active: scripts.name === item.name,
                disabled: scripts.loading,
                title: '点击载入到下方编辑框',
              }),
              h('span', { className: 'dshsm-hint' }, `${item.bytes == null ? '?' : item.bytes} 字节`),
              h('span', { className: 'dshsm-hint' }, stamp(item.updatedAt)),
            )))
        : h('div', { className: 'dshsm-hint' },
            scripts.loaded ? '还没有存储的脚本 —— 点「生成默认脚本」按当前目标生成一个' : '正在读取脚本列表…'),
      h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
        h('input', {
          className: 'dshsm-input', style: { flex: '1 1 160px', minWidth: 130 }, type: 'text',
          placeholder: '脚本名(字母数字 . _ -)',
          value: scripts.name || '',
          onChange: (e) => { scripts.name = e.target.value; scripts.formError = undefined; store.emit() },
        }),
        h('span', { className: 'dshsm-hint' }, '保存即写入该名字(已存在则覆盖)'),
      ),
      h('textarea', {
        className: 'dshsm-textarea', spellCheck: false,
        placeholder: '从上面的列表选一个脚本载入,或点「生成默认脚本」',
        value: draft,
        onChange: (e) => setDraft(e.target.value),
      }),
      scripts.formError ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { scripts.formError = undefined; store.emit() },
      }, h('span', null, scripts.formError)) : null,
      scripts.ok ? h('div', {
        className: 'dshsm-banner dshsm-banner-ok', title: '点击关闭',
        onClick: () => { scripts.ok = undefined; store.emit() },
      }, h('span', null, scripts.ok)) : null,
      h('div', { className: 'dshsm-row', style: { marginTop: 6, justifyContent: 'flex-end' } },
        btn('清空编辑框', () => setDraft(''), { title: '只清空编辑框,不影响已保存的脚本' }),
        btn(scripts.saveBusy ? '保存中…' : '保存', () => saveScript(scripts.name, draft), { disabled: scripts.saveBusy, tone: 'outline' }),
      ),
    )
  }

  // ── deploy view: ① target ② keys ③ plan+publish ④ scripts ──────────────
  const DeployView = (props) => {
    useSiteManager()
    const site = props.site
    const dep = props.dep
    React.useEffect(() => {
      if (!store.targetsLoaded) loadTargets()
      if (!store.vault.loaded) loadKeys()
      if (!store.scripts.loaded) loadScripts()
      if (!store.schedules.loaded) loadSchedules()
    }, [])
    return h('div', null,
      h(TargetsSection, { dep }),
      h(KeysSection, null),
      h(PlanSection, { site, dep }),
      h(ScriptsSection, { dep }),
    )
  }

  // ── health section ──────────────────────────────────────────────────────
  const HealthView = (props) => {
    useSiteManager()
    const site = props.site
    const health = props.health
    const result = health.result
    return h('div', null,
      h('div', { className: 'dshsm-row' },
        btn(health.busy ? '检测中…' : '开始检测', () => runHealth(site, health), { disabled: health.busy }),
        h('span', { className: 'dshsm-hint' }, site.url || (site.port ? `端口 ${site.port}` : '该站点未声明 URL')),
        h('span', { className: 'dshsm-hint' }, `健康路径 ${site.healthPath || '/'}`),
      ),
      health.error ? h('div', {
        className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
        onClick: () => { health.error = undefined; store.emit() },
      }, h('span', null, health.error)) : null,
      result ? h('div', { className: 'dshsm-row', style: { marginTop: 6 } },
        h('span', { className: result.ok ? 'dshsm-step-ok' : 'dshsm-step-bad' },
          result.ok ? '✓ 可达' : '✗ 不可达'),
        h('span', { className: 'dshsm-hint' },
          `HTTP ${result.status == null ? '无响应' : result.status}${result.ms == null ? '' : ` · ${result.ms}ms`}`),
        h('span', { className: 'dshsm-hint' }, result.url || ''),
        result.error ? h('span', { className: 'dshsm-hint' }, String(result.error)) : null,
      ) : null,
    )
  }

  // ── per-site detail block ───────────────────────────────────────────────
  const SiteDetail = (props) => {
    useSiteManager()
    const site = props.site
    const detail = store.detail
    if (!detail || detail.id !== site.id) return null
    const tab = detail.tab
    const tabBtn = (id, label) => btn(label, () => openDetail(site, id), {
      key: id,
      active: tab === id,
      title: tab === id ? '再次点击收起' : undefined,
    })
    return h('div', { className: 'dshsm-detail' },
      h('div', { className: 'dshsm-tabs' },
        tabBtn('logs', '日志'),
        tabBtn('git', 'Git'),
        tabBtn('deploy', '发布'),
        tabBtn('health', '健康'),
        h('span', { style: { flex: 1 } }),
        btn('收起', () => { closeDetail(); store.emit() }),
      ),
      tab === 'logs' ? h(LogView, { site, log: detail.log }) : null,
      tab === 'git' ? h(GitView, { site, git: detail.git }) : null,
      tab === 'deploy' ? h(DeployView, { site, dep: detail.deploy }) : null,
      tab === 'health' ? h(HealthView, { site, health: detail.health }) : null,
    )
  }

  // ── one site row ────────────────────────────────────────────────────────
  const SiteRow = (props) => {
    useSiteManager()
    const site = props.site
    const st = statusOf(site)
    const pending = store.busy[site.id]
    const anyBusy = !!pending
    const url = site.url || null
    const detailOpen = !!(store.detail && store.detail.id === site.id)
    return h(React.Fragment, null,
      h('div', { className: 'dshsm-site' },
        h('span', {
          className: `dshsm-dot ${STATE_CLASS[st.state] || 'dshsm-st-stopped'}`,
          title: `${STATE_TEXT[st.state] || st.state}`,
        }),
        h('div', { className: 'dshsm-site-main' },
          h('div', { className: 'dshsm-site-name' },
            site.name,
            h('span', { className: 'dshsm-tag' }, STATE_TEXT[st.state] || st.state),
            site.port != null ? h('span', { className: 'dshsm-tag' }, `:${site.port}`) : null,
            st.pid != null ? h('span', { className: 'dshsm-tag' }, `pid ${st.pid}`) : null,
          ),
          h('div', { className: 'dshsm-meta' },
            url
              ? h('a', {
                  className: 'dshsm-link', href: url, target: '_blank', rel: 'noreferrer noopener',
                  title: `在新标签打开 ${url}`,
                }, url)
              : h('span', null, '无 URL'),
            site.command ? h('span', { className: 'dshsm-cmd', title: site.command }, site.command) : null,
          ),
          (st.exitCode != null || st.restarts)
            ? h('div', { className: 'dshsm-meta' },
                st.exitCode != null ? h('span', null, `退出码 ${st.exitCode}`) : null,
                st.restarts ? h('span', null, `重启 ${st.restarts} 次`) : null,
              )
            : null,
          st.conflict
            ? h('div', { className: 'dshsm-meta dshsm-conflict' },
                h('span', { style: { color: '#ff453a' } },
                  `⚠ 端口 ${st.conflict.port} 被 pid ${st.conflict.pid} 占用 —— 通常是上次强制结束 DSH 时留下的进程,点右侧「释放端口」即可`),
              )
            : null,
        ),
        h('div', { className: 'dshsm-actions' },
          st.conflict
            ? btn(pending === 'reclaim' ? '释放中…' : '释放端口', () => reclaim(site), { disabled: anyBusy, tone: 'danger' })
            : null,
          btn(pending === 'start' ? '启动中…' : '启动', () => act(site, 'start'), {
            tone: 'go', fill: false,
            disabled: anyBusy || st.state === 'running' || st.state === 'starting' || Boolean(st.conflict),
          }),
          btn(pending === 'stop' ? '停止中…' : '停止', () => act(site, 'stop'), {
            tone: 'warn',
            disabled: anyBusy || st.state === 'stopped',
          }),
          btn(pending === 'restart' ? '重启中…' : '重启', () => act(site, 'restart'), {
            tone: 'primary', fill: false, disabled: anyBusy,
          }),
          btn('日志', () => openDetail(site, 'logs'), { active: detailOpen && store.detail.tab === 'logs' }),
          btn('Git', () => openDetail(site, 'git'), { active: detailOpen && store.detail.tab === 'git' }),
          btn('发布', () => openDetail(site, 'deploy'), { active: detailOpen && store.detail.tab === 'deploy' }),
          btn('健康', () => openDetail(site, 'health'), { active: detailOpen && store.detail.tab === 'health' }),
          btn('删除', () => {
            store.confirm = { site, busy: false, error: undefined }
            store.emit()
          }, { danger: true, title: `删除站点 ${site.name}` }),
        ),
      ),
      h(SiteDetail, { site }),
    )
  }

  // ── delete confirmation ─────────────────────────────────────────────────
  const ConfirmDelete = () => {
    useSiteManager()
    const pending = store.confirm
    if (!pending) return null
    const site = pending.site
    const cancel = () => { if (pending.busy) return; store.confirm = undefined; store.emit() }
    return h('div', { className: 'dshsm-mask', onClick: cancel },
      h('div', { className: 'dshsm-modal', onClick: (e) => e.stopPropagation() },
        h('div', { className: 'dshsm-modal-title' }, `确认删除站点“${site.name}”?`),
        h('div', { className: 'dshsm-modal-text' },
          `${site.workspace || '(未指定工作区)'} · 端口 ${site.port == null ? '无' : site.port}。删除会同时移除注册记录;项目文件与已产生的日志不会被改动。`),
        pending.error ? h('div', { className: 'dshsm-banner dshsm-banner-err' }, h('span', null, pending.error)) : null,
        h('div', { className: 'dshsm-modal-actions' },
          btn('取消', cancel, { disabled: pending.busy }),
          btn(pending.busy ? '删除中…' : '确认删除', deleteSite, { danger: true, disabled: pending.busy }),
        ),
      ),
    )
  }

  // ── monitor: machine load and the names of whatever is running ──────────
  /** Threshold colours, matching the status lamps: calm, warning, alarm. */
  const monColor = (percent) =>
    percent == null ? '#98989d' : percent >= 90 ? '#ff453a' : percent >= 70 ? '#ff9f0a' : '#34c759'

  const monBar = (percent) =>
    h('div', { className: 'dshsm-mon-bar' },
      h('div', {
        className: 'dshsm-mon-fill',
        style: { width: `${Math.max(0, Math.min(100, Number(percent) || 0))}%`, background: monColor(percent) },
      }))

  const monPercent = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(0)}%` : '—')
  const monBytes = (value) => {
    const n = Number(value || 0)
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
    return `${(n / 1024).toFixed(0)} KB`
  }

  /**
   * Polls only while expanded, so a closed panel costs nothing. Shows names and
   * usage only — never progress or task output — which is the whole point: it
   * must stay readable while DSH is busy doing the actual work.
   */
  const MonitorSection = () => {
    React.useEffect(() => {
      if (!store.monitorOpen) return undefined
      loadMonitor()
      const timer = setInterval(loadMonitor, 2000)
      return () => clearInterval(timer)
    }, [store.monitorOpen])
    if (!store.monitorOpen) return null

    const snap = store.monitor
    const machine = snap ? snap.machine : null
    const busySites = snap ? snap.sites.filter((s) => s.pids.length > 0) : []
    const tasks = snap ? snap.tasks : []

    return h('div', { className: 'dshsm-mon' },
      h('div', { className: 'dshsm-sec-title' },
        h('span', null, '监视 · 本机负载与在跑的任务'),
        h('span', { className: 'dshsm-hint' },
          snap
            ? `${new Date(snap.sampledAt).toLocaleTimeString()} 采样 · 每 2 秒${store.monitorBusy ? ' · 采样中' : ''}`
            : (store.monitorBusy ? '采样中…' : '')),
        btn('↻ 立即采样', () => loadMonitor(), { tone: 'outline' }),
      ),
      store.monitorError
        ? h('div', { className: 'dshsm-banner dshsm-banner-err' }, h('span', null, `监视读取失败:${store.monitorError}`))
        : null,
      !snap || !machine
        ? h('div', { className: 'dshsm-hint' }, store.monitorBusy ? '正在采样…' : '还没有数据')
        : h(React.Fragment, null,
            h('div', { className: 'dshsm-mon-grid' },
              h('div', { className: 'dshsm-mon-metric' },
                h('span', { className: 'dshsm-mon-k' }, 'CPU'),
                monBar(machine.cpuPercent),
                h('span', { className: 'dshsm-mon-v' }, `${monPercent(machine.cpuPercent)} ×${machine.cores}`)),
              h('div', { className: 'dshsm-mon-metric' },
                h('span', { className: 'dshsm-mon-k' }, '内存'),
                monBar(machine.memPercent),
                h('span', { className: 'dshsm-mon-v' }, `${monPercent(machine.memPercent)} ${monBytes(machine.memUsedBytes)}/${monBytes(machine.memTotalBytes)}`)),
            ),
            (machine.disks || []).length
              ? h('div', { className: 'dshsm-mon-chips' },
                  machine.disks.map((d) => h('span', { key: d.path }, `${d.path} 已用 ${d.usedPercent.toFixed(0)}%`)))
              : null,
            snap.probeError
              ? h('div', { className: 'dshsm-banner dshsm-banner-err' },
                  h('span', null, `进程列表不可用:${snap.probeError}(上面 CPU / 内存仍然有效)`))
              : null,
            h('div', { className: 'dshsm-mon-sub' }, busySites.length ? `站点占用(${busySites.length} 个在跑)` : '站点占用:没有站点进程在跑'),
            busySites.length
              ? h('div', { className: 'dshsm-mon-list' },
                  busySites.map((s) => h('div', { className: 'dshsm-mon-task', key: s.id },
                    h('span', { className: 'dshsm-mon-badge' }, s.port == null ? 'site' : `:${s.port}`),
                    h('span', { className: 'dshsm-mon-task-label', title: `${s.name} · pid ${s.pids.join(',')}` }, s.name),
                    h('span', { className: 'dshsm-mon-num' }, `CPU ${monPercent(s.cpuPercent)}`),
                    h('span', { className: 'dshsm-mon-num' }, monBytes(s.memBytes)),
                    h('span', { className: 'dshsm-mon-num' }, `pid ${s.pids.join(',')}`))))
              : null,
            h('div', { className: 'dshsm-mon-sub' }, `在跑的任务(只有名字,共 ${tasks.length} 个)`),
            h('div', { className: 'dshsm-mon-list' },
              tasks.length
                ? tasks.map((t) => h('div', { className: 'dshsm-mon-task', key: t.pid },
                    h('span', { className: 'dshsm-mon-badge' }, t.kind === 'dsh' ? 'DSH' : t.kind === 'site' ? '站点' : `子进程 d${t.depth}`),
                    h('span', { className: 'dshsm-mon-task-label', title: t.cmd || t.label }, t.label),
                    h('span', { className: 'dshsm-mon-num' }, `CPU ${monPercent(t.cpuPercent)}`),
                    h('span', { className: 'dshsm-mon-num' }, monBytes(t.memBytes)),
                    h('span', { className: 'dshsm-mon-num' }, `pid ${t.pid}`)))
                : '没有可显示的任务'),
          ),
    )
  }

  // ── drawer panel ────────────────────────────────────────────────────────
  const SiteManagerPanel = () => {
    useSiteManager()
    ensureStyles()
    React.useEffect(() => {
      refresh()
      loadTargets()
    }, [])
    // Esc unwinds the innermost layer: confirm dialog → detail → drawer.
    React.useEffect(() => {
      const onKey = (e) => {
        if (e.key !== 'Escape') return
        if (store.confirm) {
          if (store.confirm.busy) return
          store.confirm = undefined
        } else if (store.detail) {
          closeDetail()
        } else {
          store.open = false
        }
        store.emit()
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [])

    const groups = groupSites(store.sites)
    const closing = () => {
      if (store.confirm) return
      closeDetail()
      store.open = false
      store.emit()
    }

    return h('div', { className: 'dshsm-panel' },
      h('div', { className: 'dshsm-head' },
        h('span', { className: 'dshsm-title' },
          `▶︎ 站点控制器${store.loaded ? ` · ${store.sites.length} 个站点 / 运行中 ${runningCount()}` : ''}`),
        btn(store.form.open ? '收起表单' : '＋ 添加站点', () => {
          store.form.open = !store.form.open
          store.form.error = undefined
          store.form.ok = undefined
          store.emit()
        }, { active: store.form.open }),
        btn(store.monitorOpen ? '▾ 监视' : '▸ 监视', () => {
          store.monitorOpen = !store.monitorOpen
          if (!store.monitorOpen) store.monitor = null
          store.emit()
        }, { tone: 'outline', active: store.monitorOpen, title: '本机 CPU / 内存 / 磁盘与正在跑的任务(只有名字)' }),
        btn('↻ 刷新', refresh, { tone: 'outline' }),
        btn('✕', closing, { title: '关闭面板' }),
      ),
      h('div', { className: 'dshsm-body' },
        AddSiteForm(),
        store.error
          ? h('div', {
              className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
              onClick: () => { store.error = undefined; store.emit() },
            }, h('span', null, `读取站点列表失败:${store.error}`))
          : null,
        store.actionError
          ? h('div', {
              className: 'dshsm-banner dshsm-banner-err', title: '点击关闭',
              onClick: () => { store.actionError = undefined; store.emit() },
            }, h('span', null, store.actionError))
          : null,
        store.notice
          ? h('div', {
              className: 'dshsm-banner dshsm-banner-ok', title: '点击关闭',
              onClick: () => { store.notice = undefined; store.emit() },
            }, h('span', null, store.notice))
          : null,
        !store.error && groups.length === 0
          ? h('div', { className: 'dshsm-empty' },
              store.loaded ? '还没有站点 — 用上面的「添加站点」表单新建,或让 agent 调用 site_* 工具注册' : '加载中…')
          : null,
        MonitorSection(),
        groups.map(([ws, list]) => h('div', { key: ws },
          h('div', { className: 'dshsm-ws' }, ws),
          list.map((site) => h(SiteRow, { key: site.id, site })),
        )),
      ),
    )
  }

  // ── overlay host: our own right-hand drawer ─────────────────────────────
  const Overview = () => {
    useSiteManager()
    const open = store.open
    const drawerRef = React.useRef(null)
    const closeAll = () => {
      if (store.confirm) return // the dialog owns the screen until answered
      closeDetail()
      store.open = false
      store.emit()
    }
    // Outside-click close, the standard React way: a capture-phase pointerdown
    // listener that exists only while the drawer is open. Effects run after the
    // DOM update for the render that flipped `open`, so the listener is installed
    // *after* the click that opened the drawer has finished dispatching — that
    // click can never reach it, and no timer is needed.
    //
    // There deliberately is no full-viewport click-catcher any more: this drawer
    // is a child of the shell's overlay layer, whose CSS is
    // `.pI_x6G_overlayLayer{pointer-events:none}` + `.pI_x6G_overlayLayer>*{pointer-events:auto}`
    // — i.e. the seat is click-through by design, and *every* direct child opts
    // into pointer events. A catcher div therefore covered the whole app,
    // including the sidebar button that opens this very drawer, making any stray
    // click (even one landing on that button) a close hit.
    React.useEffect(() => {
      if (!open) return undefined
      const onDown = (e) => {
        const el = drawerRef.current
        if (!el || typeof el.contains !== 'function') return
        const target = e && e.target ? e.target : null
        if (target && el.contains(target)) return // inside the drawer: leave it alone
        // The sidebar button is this drawer's own toggle, so it must not be
        // treated as "outside": closing here and letting the click that follows
        // this pointerdown run would toggle it straight back open.
        const opener = store.openerEl
        if (target && opener && typeof opener.contains === 'function' && opener.contains(target)) return
        closeAll()
      }
      document.addEventListener('pointerdown', onDown, true)
      return () => document.removeEventListener('pointerdown', onDown, true)
    }, [open])
    if (!open) return null
    return h(React.Fragment, null,
      h('div', { className: 'dshsm-drawer', ref: drawerRef, style: { pointerEvents: 'auto' } },
        h(SiteManagerPanel),
      ),
      h(ConfirmDelete),
    )
  }

  // ── plugin ──────────────────────────────────────────────────────────────
  module.exports = {
    inject: ['slots'],
    apply(ctx) {
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'dsh-wei-sitecontrol-button', order: 100, label: '站点控制器' },
        SiteManagerButton,
      )), 'dsh-wei-sitecontrol: footer button')

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-wei-sitecontrol.panel', order: 100, label: '站点控制器' },
        Overview,
      )), 'dsh-wei-sitecontrol: management drawer')
    },
  }

  return module.exports
} })
