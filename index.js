/**
 * dsh-wei-sitecontrol — Node half.
 *
 * One place to keep the websites/**HTTP services** built on this DSH machine:
 *
 *  - registry: site records (workspace, start command, port, URL, dependency
 *    install command, git config, deploy targets) persisted under
 *    $DSH_HOME/storages/dsh-wei-sitecontrol/registry.json
 *  - lifecycle: start / stop / restart / status / logs / health, with an
 *    in-memory ring buffer plus an on-disk append log per site
 *  - git: status / commit / push through pure-JS isomorphic-git (no system git)
 *  - deploy: publish a site to a server over SSH (SFTP upload + remote commands)
 *  - HTTP API under /dsh-wei-sitecontrol for the browser half
 *  - agent tools: site_list/register/unregister/start/stop/restart/logs/
 *    health/git_status/git_commit/git_push/deploy/target_add/target_list
 *
 * The browser half (exports["./client"]) renders the sidebar entry and the
 * management panel against this HTTP API.
 */
import { JsonStore, defaultDataDir, normalizeSite, normalizeTarget, publicSite, publicTarget, siteId, SERVICE_KINDS } from './lib/registry.js'
import { Supervisor } from './lib/lifecycle.js'
import { GitOps } from './lib/gitops.js'
import { Deployer, suggestUploadDir } from './lib/deploy.js'
import { KeyVault } from './lib/vault.js'
import { ScriptStore } from './lib/scripts.js'
import { SERVICE_PLAYBOOK } from './lib/detect.js'
import { importProfile } from './lib/profile.js'
import { confirmFromProbe, provisionFromText } from './lib/provision.js'
import { Scheduler } from './lib/schedule.js'

export const name = 'dsh-wei-sitecontrol'

/** The agent tool registry and the Web HTTP carrier must exist before mount. */
export const inject = ['tools', 'webServer']

const API_PREFIX = '/dsh-wei-sitecontrol'

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) reject(new Error('request body too large'))
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function parseJsonBody(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir || defaultDataDir()
  const store = new JsonStore(dataDir, ctx.logger)
  const supervisor = new Supervisor({
    dataDir,
    logger: ctx.logger,
    ringLines: config.ringLines,
    stopGraceMs: config.stopGraceMs,
  })
  const gitops = new GitOps({
    authorName: config.gitAuthorName || 'DSH Site Manager',
    authorEmail: config.gitAuthorEmail || 'site-manager@localhost',
    logger: ctx.logger,
  })
  const vault = new KeyVault({ dataDir, logger: ctx.logger })
  const scripts = new ScriptStore({ dataDir, logger: ctx.logger })
  const deployer = new Deployer({ logger: ctx.logger, vault, scripts })

  // ── registry access ──────────────────────────────────────────────────────
  const state = store.read()

  const sites = () => state.sites
  const targets = () => state.targets
  const schedules = () => state.schedules

  const persist = () => store.write({ sites: state.sites, targets: state.targets, schedules: state.schedules })

  // Scheduled publishes: records live in the registry and are re-armed on mount,
  // so a plan survives a DSH restart. Firing runs the same deploy path as a
  // manual publish.
  const scheduler = new Scheduler({
    logger: ctx.logger,
    records: state.schedules,
    persist,
    run: async (record) => {
      const site = sites().find((s) => s.id === record.siteId)
      const target = targets().find((t) => t.name === record.targetName)
      if (!site) throw new Error(`排期指向的站点已不存在:${record.siteId}`)
      if (!target) throw new Error(`排期指向的部署目标已不存在:${record.targetName}`)
      return deployer.deploy(site, target, { allowInstall: record.allowInstall === true })
    },
  })

  const view = (site) => publicSite(site, supervisor.status(site.id))
  /** Targets always render through the vault, so only fingerprints surface. */
  const targetView = (target) => publicTarget(target, vault)

  const listSites = (workspace) =>
    sites()
      .filter((site) => (workspace ? site.workspace === workspace : true))
      .map(view)

  const findSite = (ref) => {
    const key = String(ref ?? '').trim()
    if (key === '') return null
    return sites().find((site) => site.id === key) ?? sites().find((site) => site.name === key) ?? null
  }

  const findTarget = (ref) => targets().find((target) => target.name === String(ref ?? '').trim()) ?? null

  const upsertSite = (input) => {
    const existing = input.id
      ? sites().find((s) => s.id === input.id)
      : sites().find((s) => s.id === siteId(input.workspace ?? process.cwd(), input.name))
    const record = normalizeSite(input, existing ?? null)
    if (existing) {
      const index = sites().indexOf(existing)
      state.sites[index] = record
    } else {
      state.sites.push(record)
    }
    persist()
    return record
  }

  const removeSite = (ref) => {
    const site = findSite(ref)
    if (!site) throw new Error(`unknown site: ${ref}`)
    if (supervisor.isLive(site.id)) supervisor.stop(site)
    state.sites.splice(state.sites.indexOf(site), 1)
    persist()
    return site
  }

  const requireSite = (ref) => {
    const site = findSite(ref)
    if (!site) throw new Error(`unknown site: ${ref}. Use site_list to see registered sites.`)
    return site
  }

  /**
   * Fold a detection result into the target record: fill publish fields that are
   * still empty from the server's own configuration, derive the service kind and
   * unit, and store a timestamped `verified` snapshot. Existing values are never
   * overwritten — a human's explicit setting always wins.
   */
  const applyDetection = (target, probe, { overwrite = false } = {}) => {
    const f = probe.findings ?? {}
    const blank = (value) => value === null || value === undefined || String(value).trim() === ''
    const patch = {}
    const filled = []

    if (overwrite) {
      // provision path: the server's own configuration wins over values derived
      // from the operator's description text.
      const derived = confirmFromProbe(target, f)
      Object.assign(patch, derived.patch)
      filled.push(...derived.confirmed)
    } else {
      if (blank(target.uploadDir) && f.publish?.docBase) {
        patch.uploadDir = f.publish.docBase
        filled.push(`uploadDir=${f.publish.docBase}`)
      }
      if (blank(target.configFile) && f.publish?.configFile) {
        patch.configFile = f.publish.configFile
        filled.push(`configFile=${f.publish.configFile}`)
      }
      if (blank(target.appHome) && f.tomcat?.catalinaHome) {
        patch.appHome = f.tomcat.catalinaHome
        filled.push(`appHome=${f.tomcat.catalinaHome}`)
      }
      if (blank(target.serviceName) && f.tomcat?.unit) {
        const unit = String(f.tomcat.unit).replace(/\.service$/, '')
        patch.serviceName = unit
        filled.push(`serviceName=${unit}`)
      }
      if (blank(target.serviceKind) || target.serviceKind === 'custom') {
        const kind = f.tomcat?.present ? 'tomcat' : f.nginx?.present ? 'nginx' : f.httpd?.present ? 'httpd' : f.docker?.present ? 'docker' : 'static'
        if (kind !== target.serviceKind) {
          patch.serviceKind = kind
          filled.push(`serviceKind=${kind}`)
        }
      }
    }

    const verified = {
      at: new Date().toISOString(),
      host: target.host,
      port: target.port ?? 22,
      os: f.os ?? null,
      init: f.init ?? null,
      packageManager: f.packageManager ?? null,
      services: {
        httpd: f.httpd?.present === true,
        nginx: f.nginx?.present === true,
        tomcat: f.tomcat?.present === true,
        docker: f.docker?.present === true,
      },
      tomcat:
        f.tomcat?.present === true
          ? {
              home: f.tomcat.catalinaHome ?? null,
              unit: f.tomcat.unit ?? null,
              appBase: f.tomcat.appBase ?? null,
              webapps: f.tomcat.webapps ?? null,
              webappsEntries: f.tomcat.webappsEntries ?? [],
            }
          : null,
      docker: f.docker?.present === true ? { version: f.docker.version ?? null, containers: f.docker.containers ?? [] } : null,
      publish: f.publish ?? null,
      contexts: f.tomcat?.contexts ?? [],
      listen: (f.listen ?? []).slice(0, 8),
      webroots: f.webroots ?? [],
      summary: probe.summary ?? null,
    }

    const record = normalizeTarget({ ...target, ...patch, verified, name: target.name }, target)
    return { record, filled, verified }
  }

  const startSite = (site) => {
    supervisor.start(site)
    return view(site)
  }

  const stopSite = (site) => {
    supervisor.stop(site)
    return view(site)
  }

  const restartSite = async (site) => {
    await supervisor.restart(site)
    return view(site)
  }

  // ── HTTP API for the browser half ────────────────────────────────────────
  const registerRoute = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://local')
      const parts = url.pathname.split('/').filter(Boolean) // ['site-manager', ...]
      const method = req.method || 'GET'
      const body = async () => {
        try {
          return parseJsonBody(await readBody(req))
        } catch (err) {
          throw new Error(`invalid JSON body: ${err.message}`)
        }
      }
      // Actions that ignore the payload still consume it: an unread request
      // body would desync the next request on the same keep-alive connection.
      const drain = async () => {
        try {
          await readBody(req)
        } catch {
          /* nothing to do — the body is being discarded on purpose */
        }
      }

      try {
        if (parts.length === 2 && parts[1] === 'status' && method === 'GET') {
          const list = listSites()
          return json(res, 200, {
            sites: list.length,
            running: list.filter((s) => s.status.state === 'running' || s.status.state === 'unhealthy').length,
            dataDir,
            active: list.filter((s) => s.status.state !== 'stopped').length,
            conflicts: list.filter((s) => s.status.conflict).length,
          })
        }

        if (parts.length === 2 && parts[1] === 'targets') {
          if (method === 'GET') return json(res, 200, { targets: targets().map(targetView) })
          if (method === 'POST') {
            const input = await body()
            const existing = findTarget(input.name)
            const record = normalizeTarget(input, existing)
            // A vault reference must actually resolve, or every later publish
            // fails at connect time with a confusing error.
            if (record.keyName && !vault.has(record.keyName)) {
              return json(res, 400, { error: `保险库中没有名为 "${record.keyName}" 的密钥;可先用 site_key_add 导入(或把 keyName 去掉改用 privateKeyPath)` })
            }
            if (existing) state.targets[state.targets.indexOf(existing)] = record
            else state.targets.push(record)
            persist()
            return json(res, 200, { target: targetView(record) })
          }
        }

        // ── import a server profile folder (pem + hostreadme.txt) ───────────
        if (parts.length === 3 && parts[1] === 'targets' && parts[2] === 'import' && method === 'POST') {
          const input = await body()
          if (!input.dir) return json(res, 400, { error: '需要提供档案目录 dir(内含 .pem 与说明 txt)' })
          const imported = importProfile({ dir: input.dir, vault, name: input.name ?? null, logger: ctx.logger })
          const existing = findTarget(imported.name)
          const record = normalizeTarget(
            {
              ...imported,
              ...(input.overrides && typeof input.overrides === 'object' ? input.overrides : {}),
              name: imported.name,
            },
            existing,
          )
          if (existing) state.targets[state.targets.indexOf(existing)] = record
          else state.targets.push(record)
          persist()
          return json(res, 200, { target: targetView(record), imported })
        }

        if (parts.length === 3 && parts[1] === 'targets' && method === 'DELETE') {
          const target = findTarget(decodeURIComponent(parts[2]))
          if (!target) return json(res, 404, { error: `unknown target: ${parts[2]}` })
          state.targets.splice(state.targets.indexOf(target), 1)
          persist()
          return json(res, 200, { ok: true })
        }

        if (parts.length === 4 && parts[1] === 'targets' && parts[3] === 'ping' && method === 'POST') {
          const target = findTarget(decodeURIComponent(parts[2]))
          if (!target) return json(res, 404, { error: `unknown target: ${parts[2]}` })
          return json(res, 200, await deployer.ping(target))
        }

        // ── one-step provisioning: description → fields → server truth ──────
        if (parts.length === 4 && parts[1] === 'targets' && parts[3] === 'provision' && method === 'POST') {
          const input = await body()
          const target = findTarget(decodeURIComponent(parts[2]))
          if (!target) return json(res, 404, { error: `unknown target: ${parts[2]}` })
          let working = target
          let derived = null
          if (typeof input.text === 'string' && input.text.trim() !== '') {
            const result = provisionFromText(input.text)
            derived = { parsed: result.parsed, assumed: result.assumed }
            working = normalizeTarget({ ...working, ...result.patch, name: working.name }, working)
          }
          if (input.user) working = normalizeTarget({ ...working, user: input.user, name: working.name }, working)
          let confirmed = []
          let summary = null
          let probeError = null
          if (input.discover !== false) {
            const probe = await deployer.detect(working)
            if (!probe.ok) probeError = probe.error
            else {
              const applied = applyDetection(working, probe, { overwrite: true })
              working = applied.record
              confirmed = applied.filled
              summary = probe.summary
            }
          }
          const index = state.targets.indexOf(target)
          if (index === -1) state.targets.push(working)
          else state.targets[index] = working
          persist()
          return json(res, 200, {
            ok: probeError === null,
            target: targetView(working),
            derived,
            confirmed,
            summary,
            error: probeError,
            canPublish: Boolean(working.uploadDir && working.keyName),
          })
        }

        // ── scheduled publishes ─────────────────────────────────────────────
        if (parts.length === 2 && parts[1] === 'schedules') {
          if (method === 'GET') return json(res, 200, { schedules: scheduler.list() })
          if (method === 'POST') {
            const input = await body()
            const site = findSite(input.site)
            if (!site) return json(res, 404, { error: `unknown site: ${input.site}` })
            const target = findTarget(input.target)
            if (!target) return json(res, 404, { error: `unknown target: ${input.target}` })
            const record = scheduler.add({
              siteId: site.id,
              siteName: site.name,
              targetName: target.name,
              at: input.at,
              allowInstall: input.allowInstall === true,
              note: input.note ?? null,
            })
            return json(res, 200, { schedule: record })
          }
        }
        if (parts.length === 3 && parts[1] === 'schedules' && method === 'DELETE') {
          return json(res, 200, { schedule: scheduler.cancel(decodeURIComponent(parts[2])) })
        }

        // ── read-only reconnaissance of a target (what is on that server) ────
        // On success the confirmed facts are written back onto the target: empty
        // publish fields are filled from the server's own config, and a
        // timestamped `verified` snapshot is stored so nothing is forgotten.
        if (parts.length === 4 && parts[1] === 'targets' && parts[3] === 'detect' && method === 'POST') {
          const input = await body()
          const target = findTarget(decodeURIComponent(parts[2]))
          if (!target) return json(res, 404, { error: `unknown target: ${parts[2]}` })
          const probe = await deployer.detect(target)
          if (!probe.ok) return json(res, 200, probe)
          let updated = target
          let filled = []
          if (input.persist !== false) {
            const applied = applyDetection(target, probe)
            updated = applied.record
            filled = applied.filled
            state.targets[state.targets.indexOf(target)] = updated
            persist()
          }
          const suggested = suggestUploadDir(updated, probe.findings)
          return json(res, 200, {
            ok: true,
            findings: probe.findings,
            summary: probe.summary,
            raw: probe.raw,
            suggestedUploadDir: suggested.dir,
            suggestedSource: suggested.source,
            filled,
            target: targetView(updated),
          })
        }

        // ── key vault: metadata in, key material never out ───────────────────
        if (parts.length === 2 && parts[1] === 'keys') {
          if (method === 'GET') return json(res, 200, { keys: vault.list(), dir: vault.dir })
          if (method === 'POST') {
            const input = await body()
            // `content` is accepted for the browser upload path; `path` imports a
            // key that already exists on this machine. Neither is ever echoed back.
            const meta = vault.add(input.name, { content: input.content, path: input.path, overwrite: input.overwrite === true })
            return json(res, 200, { key: meta })
          }
        }
        if (parts.length === 3 && parts[1] === 'keys' && method === 'DELETE') {
          return json(res, 200, vault.remove(decodeURIComponent(parts[2])))
        }

        // ── stored deploy scripts ────────────────────────────────────────────
        if (parts.length === 2 && parts[1] === 'scripts') {
          if (method === 'GET') return json(res, 200, { scripts: scripts.list() })
          if (method === 'POST') {
            const input = await body()
            if (typeof input.content === 'string' && input.content.trim() !== '') {
              return json(res, 200, { script: scripts.save(input.name, input.content) })
            }
            const target = findTarget(input.target)
            if (!target) return json(res, 400, { error: '需要提供 content,或提供已存在的 target 以生成默认脚本' })
            const ensured = scripts.ensureFor(target, { findings: null })
            return json(res, 200, { script: { name: ensured.name, created: ensured.created }, content: ensured.content })
          }
        }
        if (parts.length === 3 && parts[1] === 'scripts') {
          const name = decodeURIComponent(parts[2])
          if (method === 'GET') return json(res, 200, { name, content: scripts.read(name) })
          if (method === 'DELETE') return json(res, 200, scripts.remove(name))
        }

        if (parts.length === 2 && parts[1] === 'sites') {
          if (method === 'GET') {
            const workspace = url.searchParams.get('workspace')
            return json(res, 200, { sites: listSites(workspace || undefined) })
          }
          if (method === 'POST') {
            const input = await body()
            // A new site must name its workspace explicitly: defaulting to the
            // DSH process cwd would silently register the wrong directory and
            // poison the name+workspace idempotency key.
            if (!input.id && String(input.workspace ?? '').trim() === '') {
              return json(res, 400, { error: 'workspace (absolute path) is required when registering a new site' })
            }
            const record = upsertSite(input)
            return json(res, 200, { site: view(record) })
          }
        }

        if (parts.length >= 3 && parts[1] === 'sites') {
          const ref = decodeURIComponent(parts[2])
          const site = findSite(ref)
          if (!site) return json(res, 404, { error: `unknown site: ${ref}` })
          const action = parts[3]
          if (!action) {
            if (method === 'GET') return json(res, 200, { site: view(site) })
            if (method === 'DELETE') {
              removeSite(site.id)
              return json(res, 200, { ok: true, id: site.id, name: site.name })
            }
          }
          if (action === 'start' && method === 'POST') {
            await drain()
            return json(res, 200, { site: startSite(site) })
          }
          if (action === 'stop' && method === 'POST') {
            await drain()
            return json(res, 200, { site: stopSite(site) })
          }
          if (action === 'restart' && method === 'POST') {
            await drain()
            return json(res, 200, { site: await restartSite(site) })
          }
          if (action === 'logs' && method === 'GET') {
            const tail = Number(url.searchParams.get('tail') || 500)
            const search = url.searchParams.get('search') || ''
            return json(res, 200, { lines: supervisor.readLog(site.id, { tail, search }) })
          }
          if (action === 'reclaim' && method === 'POST') {
            const input = await body()
            return json(res, 200, supervisor.reclaim(site, { confirm: input.confirm === true }))
          }
          if (action === 'health' && method === 'GET') return json(res, 200, await supervisor.health(site))
          if (action === 'git' && parts[4] === 'init' && method === 'POST') {
            const input = await body()
            const result = await gitops.init(site, { initialBranch: input.branch })
            // Make the record git-aware so status/commit work right after init.
            upsertSite({ id: site.id, gitBranch: site.git?.branch || input.branch || result.branch || 'main' })
            return json(res, 200, result)
          }
          if (action === 'git' && parts[4] === 'status' && method === 'GET') {
            if (!site.git?.enabled) return json(res, 400, { error: `site "${site.name}" has no git configuration` })
            return json(res, 200, await gitops.status(site))
          }
          if (action === 'git' && parts[4] === 'commit' && method === 'POST') {
            const input = await body()
            return json(res, 200, await gitops.commit(site, input.message, { all: input.all !== false }))
          }
          if (action === 'git' && parts[4] === 'push' && method === 'POST') {
            const input = await body()
            return json(res, 200, await gitops.push(site, { remote: input.remote, branch: input.branch, token: input.token }))
          }
          if (action === 'deploy' && method === 'POST') {
            const input = await body()
            const target = findTarget(input.target)
            if (!target) return json(res, 404, { error: `unknown target: ${input.target}` })
            const result = await deployer.deploy(site, target, {
              dryRun: input.dryRun === true,
              allowInstall: input.allowInstall === true,
              overrides: input.overrides && typeof input.overrides === 'object' ? input.overrides : {},
            })
            return json(res, 200, result)
          }
          // Release history and rollback for release-mode targets.
          if (action === 'releases' && method === 'GET') {
            const target = findTarget(url.searchParams.get('target'))
            if (!target) return json(res, 404, { error: `unknown target: ${url.searchParams.get('target')}` })
            return json(res, 200, await deployer.releases(target))
          }
          if (action === 'rollback' && method === 'POST') {
            const input = await body()
            const target = findTarget(input.target)
            if (!target) return json(res, 404, { error: `unknown target: ${input.target}` })
            return json(res, 200, await deployer.rollback(site, target, { to: input.to ?? null }))
          }

          // Preview a publish: `detect: true` connects read-only to fill in facts.
          if (action === 'deploy-plan' && method === 'POST') {
            const input = await body()
            const target = findTarget(input.target)
            if (!target) return json(res, 404, { error: `unknown target: ${input.target}` })
            const result = await deployer.plan(site, target, {
              detect: input.detect !== false,
              overrides: input.overrides && typeof input.overrides === 'object' ? input.overrides : {},
            })
            return json(res, 200, result)
          }
        }

        return json(res, 404, { error: `no such site-manager route: ${method} ${url.pathname}` })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) })
      }
    },
  })

  // ── agent tools ──────────────────────────────────────────────────────────
  const siteLine = (site) => {
    const s = site.status
    const bits = [
      `- ${site.name} (${site.id})`,
      `  state: ${s.state}${s.pid ? ` pid=${s.pid}` : ''}${s.exitCode !== null && s.exitCode !== undefined ? ` lastExit=${s.exitCode}` : ''}`,
      s.conflict ? `  ⚠ 端口 ${s.conflict.port} 被 pid ${s.conflict.pid} 占用 —— 用 site_reclaim 释放后再启动` : '',
      `  workspace: ${site.workspace}`,
      site.command ? `  command: ${site.command}` : '  command: (none — cannot be started)',
      site.url || site.port ? `  url: ${site.url || `http://127.0.0.1:${site.port}${site.healthPath}`}` : '',
      site.installCommand ? `  install: ${site.installCommand}` : '',
      site.git?.enabled ? `  git: ${site.git.remote || '(no remote)'}${site.git.branch ? ` @ ${site.git.branch}` : ''}` : '',
      site.deployTargets?.length ? `  deployTargets: ${site.deployTargets.join(', ')}` : '',
    ]
    return bits.filter(Boolean).join('\n')
  }

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }

  ctx.tools.register({
    name: 'site_list',
    description: 'List every website/HTTP service registered in dsh-wei-sitecontrol with its runtime state, port/URL, git and deploy targets. Optionally filter by workspace absolute path.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Optional workspace absolute path filter' },
      },
    },
    output: textOutput,
    execute: async (args) => {
      const list = listSites(args?.workspace || undefined)
      if (list.length === 0) return '(no sites registered yet)'
      return list.map(siteLine).join('\n')
    },
  })

  ctx.tools.register({
    name: 'site_register',
    description:
      'Register (or update) a website/HTTP service in dsh-wei-sitecontrol so its lifecycle, git and deploy can be managed. Re-registering the same name+workspace updates the existing record.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Site name (unique per workspace)' },
        workspace: { type: 'string', description: 'Absolute path of the project directory' },
        command: { type: 'string', description: 'Start command, e.g. "npm run dev"' },
        cwd: { type: 'string', description: 'Working directory, defaults to workspace' },
        port: { type: 'number', description: 'HTTP port the service listens on' },
        url: { type: 'string', description: 'Explicit URL, defaults to http://127.0.0.1:<port><healthPath>' },
        healthPath: { type: 'string', description: 'Health check path, default "/"' },
        installCommand: { type: 'string', description: 'Dependency install command, e.g. "npm ci"' },
        env: { type: 'object', description: 'Extra environment variables (flat string map)' },
        autoStart: { type: 'boolean', description: 'Start automatically when DSH starts' },
        autoRestart: { type: 'boolean', description: 'Restart automatically after a crash (max 5 attempts)' },
        gitRemote: { type: 'string', description: 'Git remote URL (HTTPS for the built-in git layer)' },
        gitBranch: { type: 'string', description: 'Git branch to track' },
        gitDir: { type: 'string', description: 'Repository directory, defaults to workspace' },
        gitTokenEnv: { type: 'string', description: 'Environment variable holding the git push token' },
        deployTargets: { type: 'string', description: 'Comma-separated deploy target names' },
        notes: { type: 'string', description: 'Free-form note' },
      },
      required: ['name', 'workspace'],
    },
    output: textOutput,
    execute: async (args) => {
      const record = upsertSite(args ?? {})
      return `registered site "${record.name}" (${record.id})\n${siteLine(view(record))}`
    },
  })

  ctx.tools.register({
    name: 'site_unregister',
    description: 'Remove a site from the dsh-wei-sitecontrol registry. A running site is stopped first.',
    parameters: {
      type: 'object',
      properties: { site: { type: 'string', description: 'Site id or unique name' } },
      required: ['site'],
    },
    output: textOutput,
    execute: async (args) => {
      const site = removeSite(args.site)
      return `unregistered site "${site.name}" (${site.id})`
    },
  })

  for (const [toolName, action] of [['site_start', 'start'], ['site_stop', 'stop'], ['site_restart', 'restart']]) {
    ctx.tools.register({
      name: toolName,
      description: {
        site_start: 'Start a registered site and return its new state.',
        site_stop: 'Stop a running site (graceful signal, forced after the grace period).',
        site_restart: 'Stop then start a site again.',
      }[toolName],
      parameters: {
        type: 'object',
        properties: { site: { type: 'string', description: 'Site id or unique name' } },
        required: ['site'],
      },
      output: textOutput,
      execute: async (args) => {
        const site = requireSite(args.site)
        const updated =
          action === 'start' ? startSite(site) : action === 'stop' ? stopSite(site) : await restartSite(site)
        return `${action} requested for "${site.name}"\n${siteLine(updated)}`
      },
    })
  }

  ctx.tools.register({
    name: 'site_logs',
    description: 'Read recent log lines of a site (in-memory ring plus its on-disk append log). Supports a tail count and a case-insensitive substring search.',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site id or unique name' },
        tail: { type: 'number', description: 'How many lines to return (default 200)' },
        search: { type: 'string', description: 'Case-insensitive substring filter' },
      },
      required: ['site'],
    },
    output: textOutput,
    execute: async (args) => {
      const site = requireSite(args.site)
      const lines = supervisor.readLog(site.id, { tail: Number(args.tail) || 200, search: args.search || '' })
      if (lines.length === 0) return `(no log lines for "${site.name}"${args.search ? ` matching "${args.search}"` : ''})`
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'site_health',
    description: 'Probe a site HTTP endpoint (url, or 127.0.0.1:port + healthPath) and report status code and latency.',
    parameters: {
      type: 'object',
      properties: { site: { type: 'string', description: 'Site id or unique name' } },
      required: ['site'],
    },
    output: textOutput,
    execute: async (args) => {
      const site = requireSite(args.site)
      const result = await supervisor.health(site)
      if (result.error) return `"${site.name}" health: FAIL ${result.error}${result.url ? ` (${result.url})` : ''}`
      return `"${site.name}" health: ${result.ok ? 'OK' : 'BAD'} status=${result.status} ${result.ms}ms url=${result.url}`
    },
  })

  ctx.tools.register({
    name: 'site_reclaim',
    description:
      "Free a site's port when a start was blocked because something already listens there — typically a preview server orphaned by a force-killed DSH. Reports the owning pid; pass confirm=true to terminate it.",
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site id or unique name' },
        confirm: { type: 'boolean', description: 'Set true to actually terminate the process holding the port' },
      },
      required: ['site'],
    },
    output: textOutput,
    execute: async (args) => {
      const site = requireSite(args.site)
      const result = supervisor.reclaim(site, { confirm: args.confirm === true })
      if (result.ok) return `reclaimed port ${result.port} for "${site.name}" (terminated pid ${result.pid}); start it again with site_start.`
      return `reclaim "${site.name}": ${result.detail}`
    },
  })

  ctx.tools.register({
    name: 'site_git',
    description:
      'Inspect or change a site git repository with the built-in git layer. action=init creates a repository when the directory has none; action=status lists the branch, changed files and divergence; commit stages everything and commits the given message; push pushes the branch to the HTTP(S) remote with an optional token (SSH remotes are not supported by the built-in layer).',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site id or unique name' },
        action: { type: 'string', enum: ['init', 'status', 'commit', 'push'], description: 'Which git operation to run' },
        message: { type: 'string', description: 'Commit message (action=commit)' },
        remote: { type: 'string', description: 'Remote name for push, default origin' },
        branch: { type: 'string', description: 'Branch to push, default current branch' },
        token: { type: 'string', description: 'HTTPS token for this push; omit to use the configured tokenEnv variable' },
      },
      required: ['site', 'action'],
    },
    output: textOutput,
    execute: async (args) => {
      const site = requireSite(args.site)
      if (args.action === 'init') {
        const result = await gitops.init(site, { initialBranch: args.branch })
        const record = upsertSite({ id: site.id, gitBranch: site.git?.branch || args.branch || result.branch || 'main' })
        return `git init ${result.already ? 'skipped (already a repository)' : 'done'} for "${record.name}" at ${result.dir} — branch ${result.branch}`
      }
      if (args.action === 'status') {
        const status = await gitops.status(site)
        const changed = status.changed.length
          ? status.changed.map((c) => `  ${c.code} ${c.path}`).join('\n')
          : '  (clean)'
        return [
          `site "${site.name}" git status (${status.dir})`,
          `branch: ${status.branch ?? '(detached)'}  remote: ${status.remote ?? '(none)'}  ahead: ${status.ahead ?? '?'} behind: ${status.behind ?? '?'}`,
          `last commit: ${status.lastCommit ? `${status.lastCommit.oid.slice(0, 8)} ${status.lastCommit.message} — ${status.lastCommit.author}` : '(none)'}`,
          `changed (${changed === '  (clean)' ? 0 : status.changed.length}):`,
          changed,
        ].join('\n')
      }
      if (args.action === 'commit') {
        const result = await gitops.commit(site, args.message ?? '', { all: true })
        return `committed ${result.oid.slice(0, 8)} on "${site.name}": ${result.message} (${result.staged} file(s) staged)`
      }
      const result = await gitops.push(site, { remote: args.remote, branch: args.branch, token: args.token })
      return `pushed "${site.name}" ${result.branch} → ${result.remote} (${result.url})${result.ok ? '' : ' — remote reported a non-ok result'}`
    },
  })

  ctx.tools.register({
    name: 'site_deploy',
    description:
      'Publish a site to a server over SSH: connect, probe the server, back up the current version, upload the workspace over SFTP (node_modules/.git/cache excluded), then stop → start the service through the stored deploy script. Use dryRun to preview locally without connecting, or site_deploy_plan to preview with real facts about the server.',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site id or unique name' },
        target: { type: 'string', description: 'Deploy target name' },
        dryRun: { type: 'boolean', description: 'Collect and report steps without connecting to the server' },
        allowInstall: { type: 'boolean', description: 'Allow running the install command when the runtime (httpd/nginx/docker) is missing' },
        uploadDir: { type: 'string', description: 'One-off override for the target upload directory' },
        serviceKind: { type: 'string', enum: SERVICE_KINDS, description: 'One-off override for the service kind' },
      },
      required: ['site', 'target'],
    },
    output: textOutput,
    execute: async (args) => {
      const site = requireSite(args.site)
      const target = findTarget(args.target)
      if (!target) return `unknown deploy target: ${args.target}. Use site_target_list to see targets.`
      const overrides = {}
      if (args.uploadDir) overrides.uploadDir = args.uploadDir
      if (args.serviceKind) overrides.serviceKind = args.serviceKind
      const result = await deployer.deploy(site, target, { dryRun: args.dryRun === true, allowInstall: args.allowInstall === true, overrides })
      const steps = result.steps.map((s) => `  ${s.ok ? 'OK  ' : s.skipped ? 'SKIP' : 'FAIL'} ${s.name}${s.detail ? `: ${s.detail}` : ''}`).join('\n')
      const facts = result.summary ? `\n探测结果:\n${result.summary}` : ''
      return `deploy "${site.name}" → ${target.name}: ${result.ok ? 'success' : 'FAILED'}\n${steps}${facts}`
    },
  })

  ctx.tools.register({
    name: 'site_deploy_plan',
    description:
      'Show exactly what a publish would do, without changing anything. With detect=true (default) it connects read-only and probes the server, so the plan and the suggested upload directory reflect reality.',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site id or unique name' },
        target: { type: 'string', description: 'Deploy target name' },
        detect: { type: 'boolean', description: 'Connect read-only to probe the server (default true)' },
      },
      required: ['site', 'target'],
    },
    output: textOutput,
    execute: async (args) => {
      const site = requireSite(args.site)
      const target = findTarget(args.target)
      if (!target) return `unknown deploy target: ${args.target}.`
      const plan = await deployer.plan(site, target, { detect: args.detect !== false })
      const steps = plan.steps.map((s, i) => `  ${i + 1}. ${s.name}: ${s.detail}${s.command ? `\n      $ ${s.command}` : ''}`).join('\n')
      const facts = plan.summary ? `\n服务器现状:\n${plan.summary}` : ''
      const dir = plan.uploadDir ? `\n建议上传目录:${plan.uploadDir}(${plan.uploadDirSource === 'detected' ? '来自探测' : '来自目标配置'})` : ''
      return `发布计划 "${site.name}" → ${target.name}:\n${steps}${facts}${dir}`
    },
  })

  ctx.tools.register({
    name: 'site_server_detect',
    description:
      'Probe a deploy target read-only: OS, package manager, installed httpd/nginx, Tomcat (CATALINA_HOME, conf/server.xml, webapps), Docker and its containers, systemd units, listening ports and candidate document roots.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Deploy target name' } },
      required: ['target'],
    },
    output: textOutput,
    execute: async (args) => {
      const target = findTarget(args.target)
      if (!target) return `unknown deploy target: ${args.target}.`
      const probe = await deployer.detect(target)
      if (!probe.ok) return `探测失败:${probe.error}`
      const applied = applyDetection(target, probe)
      state.targets[state.targets.indexOf(target)] = applied.record
      persist()
      const suggested = suggestUploadDir(applied.record, probe.findings)
      const view = targetView(applied.record)
      return [
        probe.summary,
        '',
        '已写回目标的发布环境:',
        `  上传目录:${view.uploadDir ?? '(未探测到,需手工配置)'}`,
        `  配置文件:${view.configFile ?? '(未探测到)'} · context=${view.contextPath ?? '/'}`,
        `  服务类型:${view.serviceKind}${view.serviceName ? ` · 单元 ${view.serviceName}` : ''}${view.appHome ? ` · 运行时目录 ${view.appHome}` : ''}`,
        applied.filled.length ? `  本次自动补齐:${applied.filled.join(', ')}` : '  (字段此前已配置,未改动)',
        `  快照时间:${view.verified?.at ?? '-'}`,
        suggested.dir ? `建议上传目录:${suggested.dir}(${suggested.source === 'detected' ? '来自探测' : '来自目标配置'})` : '未找到候选上传目录,请在目标里设定 uploadDir',
      ].join('\n')
    },
  })

  ctx.tools.register({
    name: 'site_key_add',
    description:
      'Import an SSH private key into the plugin vault. Provide `path` for a key already on this machine (preferred — the content never enters the conversation) or `content` for a browser upload. Only metadata and a public-key fingerprint are ever reported back.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Key name used by targets (letters, digits, . _ -)' },
        path: { type: 'string', description: 'Absolute path of the key file on this machine' },
        content: { type: 'string', description: 'PEM text (only when no file is available)' },
        overwrite: { type: 'boolean', description: 'Replace an existing key of the same name' },
      },
      required: ['name'],
    },
    output: textOutput,
    execute: async (args) => {
      const meta = vault.add(args.name, { path: args.path, content: args.content, overwrite: args.overwrite === true })
      return `密钥 "${meta.name}" 已存入保险库(${meta.bytes} 字节,类型 ${meta.keyType ?? '加密私钥'})\n指纹:${meta.fingerprint ?? '(加密私钥,无法计算指纹)'}${meta.warning ? `\n⚠ ${meta.warning}` : ''}\n后续在目标里用 keyName="${meta.name}" 引用它;密钥内容不会被返回或记录。`
    },
  })

  ctx.tools.register({
    name: 'site_key_list',
    description: 'List keys in the plugin vault (metadata and fingerprints only — never key material).',
    parameters: { type: 'object', properties: {} },
    output: textOutput,
    execute: async () => {
      const list = vault.list()
      if (list.length === 0) return '(保险库中还没有密钥)'
      return list
        .map((k) => `- ${k.name}: ${k.keyType ?? '加密私钥'} · ${k.fingerprint ?? '无指纹'} · ${k.bytes} 字节 · 导入于 ${k.uploadedAt}${k.warning ? `\n    ⚠ ${k.warning}` : ''}`)
        .join('\n')
    },
  })

  ctx.tools.register({
    name: 'site_key_remove',
    description: 'Delete a key from the plugin vault. Targets still referencing it will fail to connect until they are given another credential.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Key name' } },
      required: ['name'],
    },
    output: textOutput,
    execute: async (args) => {
      const used = targets().filter((t) => t.keyName === args.name).map((t) => t.name)
      const result = vault.remove(args.name)
      return `已删除密钥 "${result.name}"${used.length ? `(注意:目标 ${used.join(', ')} 仍引用它)` : ''}`
    },
  })

  ctx.tools.register({
    name: 'site_script',
    description:
      'Manage the stored SSH deploy scripts. action=list shows them, read returns one, save writes/overwrites one, generate creates the default script for a target and returns it. These scripts own the remote side of a publish (backup, stop, start, verify) and are executed via bash -s from stdin.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'save', 'generate'], description: 'What to do' },
        name: { type: 'string', description: 'Script name (read/save)' },
        target: { type: 'string', description: 'Target name (generate)' },
        content: { type: 'string', description: 'Script body (save)' },
      },
      required: ['action'],
    },
    output: textOutput,
    execute: async (args) => {
      if (args.action === 'list') {
        const list = scripts.list()
        return list.length === 0 ? '(还没有存储的脚本;首次发布时会自动生成)' : list.map((s) => `- ${s.name}.sh · ${s.bytes} 字节 · 更新于 ${s.updatedAt}`).join('\n')
      }
      if (args.action === 'read') return scripts.read(args.name)
      if (args.action === 'save') {
        const saved = scripts.save(args.name, args.content)
        return `已保存脚本 ${saved.name}.sh(${saved.bytes} 字节)`
      }
      const target = findTarget(args.target)
      if (!target) return `unknown deploy target: ${args.target}`
      const ensured = scripts.ensureFor(target, { findings: null })
      return `脚本 ${ensured.name}.sh ${ensured.created ? '已生成' : '已存在,以下为当前内容'}:\n\n${ensured.content}`
    },
  })

  ctx.tools.register({
    name: 'site_target_add',
    description:
      'Add or update an SSH deploy target: host/credentials, the upload directory, the service kind (which decides how the service is stopped and started), optional command overrides, and backup settings.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Target name' },
        host: { type: 'string', description: 'Server host or IP' },
        port: { type: 'number', description: 'SSH port, default 22' },
        user: { type: 'string', description: 'SSH user, default root' },
        keyName: { type: 'string', description: 'Vault key name (preferred credential)' },
        privateKeyPath: { type: 'string', description: 'Path to a key file already on this machine' },
        password: { type: 'string', description: 'Password (alternative to a key)' },
        passphrase: { type: 'string', description: 'Passphrase for the private key' },
        uploadDir: { type: 'string', description: 'Remote directory to publish into, e.g. /srv/www/site or Tomcat webapps' },
        serviceKind: { type: 'string', enum: SERVICE_KINDS, description: 'static | httpd | nginx | tomcat | docker | custom' },
        serviceName: { type: 'string', description: 'Service/unit/container name for docker or non-standard unit names' },
        installCommand: { type: 'string', description: 'Override the runtime install command (only run when allowInstall is set)' },
        stopCommand: { type: 'string', description: 'Override the stop command' },
        startCommand: { type: 'string', description: 'Override the start command' },
        restartCommand: { type: 'string', description: 'Override the restart command' },
        backup: { type: 'boolean', description: 'Back up the current directory before uploading (default true)' },
        backupDir: { type: 'string', description: 'Where backups go (default <uploadDir>.bak)' },
        keepReleases: { type: 'number', description: 'How many backups to keep (default 3)' },
        scriptName: { type: 'string', description: 'Deploy script name in the plugin store' },
        deployMode: { type: 'string', enum: ['inplace', 'release'], description: 'inplace 直接覆盖 uploadDir;release 每次发布到新时间戳目录并改配置指向它(可回滚)' },
        releasesDir: { type: 'string', description: 'release 模式下发布目录的父目录,例如 /opt/releases' },
        configFile: { type: 'string', description: 'release 模式下要改写的配置文件,例如 /opt/tomcat9/conf/server.xml' },
        contextPath: { type: 'string', description: '要切换的 Context 路径,默认 "/"' },
        restartOnDeploy: { type: 'boolean', description: '发布时是否停止/重启服务(默认 true;静态内容可设 false 零停机)' },
        notes: { type: 'string', description: 'Free-form note' },
      },
      required: ['name', 'host'],
    },
    output: textOutput,
    execute: async (args) => {
      const existing = findTarget(args.name)
      const record = normalizeTarget(args, existing)
      if (record.keyName && !vault.has(record.keyName)) {
        return `保险库中没有名为 "${record.keyName}" 的密钥;先 site_key_add 导入,或改用 privateKeyPath。`
      }
      if (existing) state.targets[state.targets.indexOf(existing)] = record
      else state.targets.push(record)
      persist()
      const view = targetView(record)
      const playbook = SERVICE_PLAYBOOK[record.serviceKind] ?? {}
      return [
        `目标 "${view.name}" 已保存:${view.user}@${view.host}:${view.port}`,
        `上传目录:${view.uploadDir ?? '(未设置 — 发布前必须设置,或先 site_server_detect 看建议)'}`,
        `服务类型:${record.serviceKind}(${playbook.label ?? ''})${view.serviceName ? ` · 服务名 ${view.serviceName}` : ''}`,
        `凭据:${view.keyName ? `保险库密钥 ${view.keyName}` : view.hasPassword ? '密码' : '本机密钥文件'}${view.keyFingerprint ? ` · ${view.keyFingerprint}` : ''}`,
        `备份:${view.backup ? `开启(保留 ${view.keepReleases} 份,目录 ${view.backupDir ?? `${view.uploadDir}.bak`})` : '已关闭'}`,
      ].join('\n')
    },
  })

  ctx.tools.register({
    name: 'site_target_import',
    description:
      'One-step server onboarding from a profile folder that holds a private key plus a description file (ip / ssh 端口 / 描述 / 发布目录). The key goes into the vault under the folder name, and ip, port, upload directory, service kind, CATALINA_HOME and the environment description become target fields. Nothing is uploaded or executed — review the result, then probe with site_server_detect.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Absolute path of the profile folder, e.g. E:\\keys\\示例站点' },
        name: { type: 'string', description: 'Target (and vault key) name; defaults to the folder name' },
        host: { type: 'string', description: 'Override the parsed ip' },
        port: { type: 'number', description: 'Override the parsed ssh port' },
        user: { type: 'string', description: 'SSH user (not in the folder description; defaults to root)' },
        uploadDir: { type: 'string', description: 'Override the parsed publish directory' },
        serviceKind: { type: 'string', enum: SERVICE_KINDS, description: 'Override the inferred service kind' },
        serviceName: { type: 'string', description: 'Override the service/unit name' },
      },
      required: ['dir'],
    },
    output: textOutput,
    execute: async (args) => {
      const { dir, ...overrides } = args
      const imported = importProfile({ dir, vault, name: overrides.name ?? null, logger: ctx.logger })
      const existing = findTarget(imported.name)
      const record = normalizeTarget({ ...imported, ...overrides, name: imported.name }, existing)
      if (record.keyName && !vault.has(record.keyName)) return `密钥 ${record.keyName} 导入失败,未创建目标。`
      if (existing) state.targets[state.targets.indexOf(existing)] = record
      else state.targets.push(record)
      persist()
      const view = targetView(record)
      return [
        `目标 "${view.name}" 已从档案导入并保存`,
        `地址:${view.user}@${view.host}:${view.port} · 密钥:${view.keyName}${view.keyFingerprint ? ` (${view.keyFingerprint})` : ''}`,
        `上传目录:${view.uploadDir ?? '(档案里没有,发布前需要补)'}`,
        `服务类型:${view.serviceKind}${view.serviceName ? ` · 单元 ${view.serviceName}` : ''}${view.appHome ? ` · 运行时目录 ${view.appHome}` : ''}`,
        view.environment ? `环境描述:${view.environment}` : '环境描述:(无)',
        imported.missing.length ? `⚠ 待补:${imported.missing.join(';')}` : '',
        '下一步:site_server_detect 探测真实环境,再 site_deploy_plan 预览发布。',
      ]
        .filter(Boolean)
        .join('\n')
    },
  })

  ctx.tools.register({
    name: 'site_releases',
    description:
      'List the release directories of a release-mode target, newest first, together with the docBase the config currently points at. Use it to pick a rollback target.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Deploy target name' } },
      required: ['target'],
    },
    output: textOutput,
    execute: async (args) => {
      const target = findTarget(args.target)
      if (!target) return `unknown deploy target: ${args.target}.`
      const result = await deployer.releases(target)
      if (!result.ok) return `读取发布列表失败:${result.error}`
      if (result.releases.length === 0) return `目标 "${target.name}" 还没有发布目录(${target.releasesDir ?? '未配置 releasesDir'})`
      const lines = result.releases.map((r, i) => `  ${i === 0 ? '→' : ' '} ${r.name}${r.path === result.currentDocBase ? '  ← 当前生效' : ''}`)
      return `发布历史(${target.releasesDir}):\n${lines.join('\n')}\n当前 docBase:${result.currentDocBase ?? '(读不到配置)'}`
    },
  })

  ctx.tools.register({
    name: 'site_rollback',
    description:
      'Roll a release-mode target back: point the config docBase at an earlier release directory and restart the service. Without `to`, the previous release is chosen. The config is backed up before it is rewritten, and the site is verified afterwards.',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site id or unique name (used for reporting)' },
        target: { type: 'string', description: 'Deploy target name' },
        to: { type: 'string', description: 'Release name to roll back to, e.g. 20260910-140000' },
      },
      required: ['site', 'target'],
    },
    output: textOutput,
    execute: async (args) => {
      const site = requireSite(args.site)
      const target = findTarget(args.target)
      if (!target) return `unknown deploy target: ${args.target}.`
      const result = await deployer.rollback(site, target, { to: args.to ?? null })
      const steps = (result.steps ?? []).map((s) => `  ${s.ok ? 'OK  ' : 'FAIL'} ${s.name}${s.detail ? `: ${s.detail}` : ''}`).join('\n')
      return `回滚 "${site.name}" → ${target.name}: ${result.ok ? `成功(已切到 ${result.rolledBackTo})` : 'FAILED'}\n${steps}${result.error ? `\n${result.error}` : ''}`
    },
  })

  ctx.tools.register({
    name: 'site_target_provision',
    description:
      'One-step provisioning from a natural-language environment description. The text is stored verbatim in the database (the folder only needs the pem), parsed for ip / ssh port / description / publish dir / CATALINA_HOME, and then confirmed over SSH by reading the server\'s own configuration (docBase, config file, context path, unit). Returns what was derived and what the server confirmed.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name (create it first with site_target_add or site_target_import)' },
        text: {
          type: 'string',
          description: 'The environment description, e.g. "ip:203.0.113.10\\nssh端口:TCP:22\\n描述：示例公司官网。使用tomcat服务，tomcat应用目录在：/opt/tomcat9。程序发布目录在/srv/www。"',
        },
        discover: { type: 'boolean', description: 'Connect over SSH and confirm against the server config (default true)' },
        user: { type: 'string', description: 'SSH user, if the description does not say' },
      },
      required: ['target'],
    },
    output: textOutput,
    execute: async (args) => {
      const target = findTarget(args.target)
      if (!target) return `unknown deploy target: ${args.target}.`
      let working = target
      let derived = null
      if (typeof args.text === 'string' && args.text.trim() !== '') {
        const result = provisionFromText(args.text)
        derived = result
        working = normalizeTarget({ ...working, ...result.patch, name: working.name }, working)
      }
      if (args.user) working = normalizeTarget({ ...working, user: args.user, name: working.name }, working)
      let confirmed = []
      let summary = null
      let probeError = null
      if (args.discover !== false) {
        const probe = await deployer.detect(working)
        if (!probe.ok) probeError = probe.error
        else {
          const applied = applyDetection(working, probe, { overwrite: true })
          working = applied.record
          confirmed = applied.filled
          summary = probe.summary
        }
      }
      const index = state.targets.indexOf(target)
      if (index === -1) state.targets.push(working)
      else state.targets[index] = working
      persist()
      const view = targetView(working)
      const lines = [
        `目标 "${view.name}" 已建档并保存`,
        `地址:${view.user}@${view.host}:${view.port} · 密钥:${view.keyName ?? '(未设置)'}`,
        `环境描述:${view.environment ?? '(未从文本解析到)'}`,
        `发布目录:${view.uploadDir ?? '(未确定)'}`,
        `运行时目录:${view.appHome ?? '(未确定)'} · 服务单元:${view.serviceName ?? '(未确定)'} · 类型:${view.serviceKind}`,
        `配置文件:${view.configFile ?? '(未确定)'} · context=${view.contextPath ?? '/'} · 发布模式:${view.deployMode}`,
      ]
      if (derived?.assumed?.length) lines.push(`(由描述推断,已被探测确认或修正:${derived.assumed.join(', ')})`)
      lines.push(confirmed.length ? `服务器确认:${confirmed.join(', ')}` : '(服务器未带来新信息)')
      if (probeError) lines.push(`⚠ 探测失败:${probeError}(字段以描述为准,可稍后重试)`)
      lines.push('下一步:site_deploy_plan 预览,或 site_deploy 直接发布,或 site_schedule_publish 定时发布。')
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'site_schedule_publish',
    description:
      'Schedule a publish for a specific time. The plan is stored in the database and re-armed after a DSH restart; when it fires it runs exactly the same deploy path as a manual publish, and the step report is kept on the record.',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site id or unique name' },
        target: { type: 'string', description: 'Deploy target name' },
        at: { type: 'string', description: 'When to publish, ISO 8601, e.g. 2026-09-10T22:30:00+08:00' },
        allowInstall: { type: 'boolean', description: 'Allow installing a missing runtime during that publish' },
        note: { type: 'string', description: 'Why this window was chosen' },
      },
      required: ['site', 'target', 'at'],
    },
    output: textOutput,
    execute: async (args) => {
      const site = requireSite(args.site)
      const target = findTarget(args.target)
      if (!target) return `unknown deploy target: ${args.target}.`
      const record = scheduler.add({
        siteId: site.id,
        siteName: site.name,
        targetName: target.name,
        at: args.at,
        allowInstall: args.allowInstall === true,
        note: args.note ?? null,
      })
      return `已排定:${record.at} 发布 "${site.name}" → ${target.name}(排期 id ${record.id})\n用 site_schedule_list 查看,site_schedule_cancel 取消。`
    },
  })

  ctx.tools.register({
    name: 'site_schedule_list',
    description: 'List publish schedules with their status (pending / running / done / failed / cancelled) and the step report of finished ones.',
    parameters: { type: 'object', properties: {} },
    output: textOutput,
    execute: async () => {
      const list = scheduler.list()
      if (list.length === 0) return '(没有发布排期)'
      return list
        .map((s) => {
          const head = `- ${s.id} ${s.status} @ ${s.at} → ${s.siteName ?? s.siteId} / ${s.targetName}${s.note ? `(${s.note})` : ''}`
          if (s.status === 'done' || s.status === 'failed') {
            const failed = (s.result?.steps ?? []).filter((step) => !step.ok && !step.skipped).map((step) => step.name)
            return `${head}\n    ${s.finishedAt ?? ''}${s.error ? ` · ${s.error}` : ''}${failed.length ? ` · 失败步骤:${failed.join(', ')}` : ''}`
          }
          return head
        })
        .join('\n')
    },
  })

  ctx.tools.register({
    name: 'site_schedule_cancel',
    description: 'Cancel a pending publish schedule by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Schedule id' } },
      required: ['id'],
    },
    output: textOutput,
    execute: async (args) => {
      const record = scheduler.cancel(args.id)
      return `排期 ${record.id} 已取消(原定 ${record.at})`
    },
  })

  ctx.tools.register({
    name: 'site_target_list',
    description: 'List SSH deploy targets with their upload directory, service kind and credential reference (never credentials themselves).',
    parameters: { type: 'object', properties: {} },
    output: textOutput,
    execute: async () => {
      const list = targets().map(targetView)
      if (list.length === 0) return '(no deploy targets configured)'
      return list
        .map(
          (t) =>
            `- ${t.name}: ${t.user}@${t.host}:${t.port} → ${t.uploadDir ?? '(未设置 uploadDir)'} · ${t.serviceKind} · ` +
            `凭据=${t.keyName ? `vault:${t.keyName}` : t.hasPassword ? 'password' : 'keyfile'} · 备份=${t.backup ? 'on' : 'off'}`,
        )
        .join('\n')
    },
  })

  // ── lifecycle of the plugin itself ───────────────────────────────────────
  // Boot-time orphan sweep. DSH can be hard-killed (power loss, Task Manager,
  // taskkill /F), which leaves this plugin's own servers alive and holding
  // their ports — there is no shutdown hook to run in that case. Only a process
  // whose command line matches the site's own command is terminated; anything
  // else is left alone and surfaced as a conflict for the panel to explain.
  // Disable with `config.autoReclaimOrphans: false`.
  if (config.autoReclaimOrphans !== false && sites().some((site) => site.port)) {
    const sweepTimer = setTimeout(() => {
      Promise.resolve(supervisor.reclaimOrphans(sites()))
        .then((report) => {
          const reclaimed = report.filter((r) => r.action === 'reclaimed')
          const left = report.filter((r) => r.action === 'left-alone')
          if (reclaimed.length > 0) {
            ctx.logger?.info?.(
              '[dsh-wei-sitecontrol] 启动清理:已终止 %d 个遗留进程(%s)',
              reclaimed.length,
              reclaimed.map((r) => `${r.site} pid ${r.pid}`).join(', '),
            )
          }
          if (left.length > 0) {
            ctx.logger?.warn?.('[dsh-wei-sitecontrol] %d 个端口被非本站点进程占用,已保持原状,请在面板确认后手动释放', left.length)
          }
        })
        .catch((err) => ctx.logger?.warn?.('[dsh-wei-sitecontrol] orphan sweep failed: %s', err?.message ?? err))
    }, 1500)
    ctx.effect(() => () => clearTimeout(sweepTimer), 'dsh-wei-sitecontrol: orphan sweep timer')
  }

  // Sites marked autoStart come up once the profile is serving.
  const autoStartSites = sites().filter((site) => site.autoStart && site.command)
  if (autoStartSites.length > 0) {
    const timer = setTimeout(() => {
      for (const site of autoStartSites) {
        try {
          if (!supervisor.isLive(site.id)) supervisor.start(site)
        } catch (err) {
          ctx.logger?.warn?.('[dsh-wei-sitecontrol] autoStart "%s" failed: %s', site.name, err.message)
        }
      }
    }, 2000)
    ctx.effect(() => () => clearTimeout(timer), 'dsh-wei-sitecontrol: autoStart timer')
  }

  // Scheduled publishes are re-armed on mount so a restart never loses a plan.
  const armedSchedules = scheduler.armAll()
  if (armedSchedules > 0) ctx.logger?.info?.('[dsh-wei-sitecontrol] 已恢复 %d 个待执行的发布排期', armedSchedules)
  ctx.effect(() => () => scheduler.dispose(), 'dsh-wei-sitecontrol: publish scheduler')

  ctx.effect(() => () => supervisor.stopAll(sites()), 'dsh-wei-sitecontrol: stop supervised sites')
  ctx.effect(() => () => registerRoute(), 'dsh-wei-sitecontrol: HTTP API route')

  ctx.logger?.info?.('[dsh-wei-sitecontrol] %d site(s), %d target(s) loaded from %s', sites().length, targets().length, dataDir)
}
