/**
 * dsh-wei-sitecontrol — registry: the site/target record model and its JSON
 * persistence under $DSH_HOME/storages/dsh-wei-sitecontrol.
 *
 * Pure data layer: no process, no network. The supervisor (lifecycle.js),
 * the built-in git layer (gitops.js) and the SSH deployer (deploy.js) all read
 * their inputs from the records produced here.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function defaultDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-wei-sitecontrol')
}

/** Stable id for a site: derived from workspace + name so re-registering is idempotent. */
export function siteId(workspace, name) {
  return createHash('sha1').update(`${resolve(workspace)}::${name}`).digest('hex').slice(0, 12)
}

const SECRET_FIELDS = ['password', 'passphrase', 'token', 'privateKey']

function str(value) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim()
}

function optionalStr(value) {
  const s = str(value)
  return s === '' ? null : s
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return str(value).toLowerCase() === 'true'
}

function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function strList(value) {
  if (Array.isArray(value)) return value.map((v) => str(v)).filter(Boolean)
  const s = str(value)
  return s === '' ? [] : s.split(',').map((v) => v.trim()).filter(Boolean)
}

function envMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_FIELDS.includes(k)) continue
    out[str(k)] = str(v)
  }
  return out
}

function absoluteOrNull(value, base) {
  const s = optionalStr(value)
  if (s === null) return null
  return isAbsolute(s) ? s : resolve(base, s)
}

/**
 * Build a normalized site record from user/agent input, merging over an
 * existing record when one is supplied. Unknown fields are dropped.
 */
export function normalizeSite(input = {}, existing = null) {
  const workspace = absoluteOrNull(input.workspace, process.cwd()) ?? existing?.workspace ?? process.cwd()
  const name = optionalStr(input.name) ?? existing?.name
  if (!name) throw new Error('site name is required')
  const command = optionalStr(input.command) ?? existing?.command ?? null
  const gitInput = input.git && typeof input.git === 'object' ? input.git : {}
  const remote = optionalStr(gitInput.remote ?? input.gitRemote) ?? existing?.git?.remote ?? null
  const branch = optionalStr(gitInput.branch ?? input.gitBranch) ?? existing?.git?.branch ?? null
  const gitDir = absoluteOrNull(gitInput.dir ?? input.gitDir, workspace) ?? existing?.git?.dir ?? workspace
  const tokenEnv = optionalStr(gitInput.tokenEnv ?? input.gitTokenEnv) ?? existing?.git?.tokenEnv ?? null
  const now = new Date().toISOString()
  return {
    id: existing?.id ?? optionalStr(input.id) ?? siteId(workspace, name),
    name,
    workspace,
    command,
    cwd: absoluteOrNull(input.cwd, workspace) ?? existing?.cwd ?? workspace,
    env: { ...(existing?.env ?? {}), ...envMap(input.env) },
    port: intOrNull(input.port) ?? existing?.port ?? null,
    url: optionalStr(input.url) ?? existing?.url ?? null,
    healthPath: optionalStr(input.healthPath) ?? existing?.healthPath ?? '/',
    installCommand: optionalStr(input.installCommand) ?? existing?.installCommand ?? null,
    installedAt: existing?.installedAt ?? null,
    autoStart: bool(input.autoStart, existing?.autoStart ?? false),
    autoRestart: bool(input.autoRestart, existing?.autoRestart ?? false),
    stopGraceMs: intOrNull(input.stopGraceMs) ?? existing?.stopGraceMs ?? null,
    git: remote || branch || existing?.git?.enabled
      ? { enabled: true, dir: gitDir, remote, branch, tokenEnv, authorName: optionalStr(gitInput.authorName) ?? existing?.git?.authorName ?? null, authorEmail: optionalStr(gitInput.authorEmail) ?? existing?.git?.authorEmail ?? null }
      : null,
    deployTargets: strList(input.deployTargets ?? input.targets).length > 0
      ? strList(input.deployTargets ?? input.targets)
      : (existing?.deployTargets ?? []),
    exclude: strList(input.exclude).length > 0 ? strList(input.exclude) : (existing?.exclude ?? []),
    notes: optionalStr(input.notes) ?? existing?.notes ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export const SERVICE_KINDS = ['static', 'httpd', 'nginx', 'tomcat', 'docker', 'custom']

/** Normalize an SSH deploy target. Secrets are kept out of the record itself. */
export function normalizeTarget(input = {}, existing = null) {
  const name = optionalStr(input.name) ?? existing?.name
  if (!name) throw new Error('target name is required')
  const host = optionalStr(input.host) ?? existing?.host
  if (!host) throw new Error('target host is required')
  const privateKeyPath = optionalStr(input.privateKeyPath) ?? existing?.privateKeyPath ?? null
  const password = optionalStr(input.password) ?? existing?.password ?? null
  const keyName = optionalStr(input.keyName) ?? existing?.keyName ?? null
  if (!keyName && !privateKeyPath && !password) {
    throw new Error(`目标 "${name}" 需要凭据:keyName(保险库密钥)、privateKeyPath 或 password 三者之一`)
  }
  const serviceKind = optionalStr(input.serviceKind) ?? existing?.serviceKind ?? 'custom'
  if (!SERVICE_KINDS.includes(serviceKind)) {
    throw new Error(`serviceKind 必须是以下之一:${SERVICE_KINDS.join(', ')}`)
  }
  return {
    name,
    host,
    port: intOrNull(input.port) ?? existing?.port ?? 22,
    user: optionalStr(input.user) ?? existing?.user ?? 'root',
    // Credentials. `keyName` points into the vault and is the preferred form;
    // the inline fields remain for machines where the key already lives on disk.
    keyName,
    privateKeyPath,
    privateKey: optionalStr(input.privateKey) ?? existing?.privateKey ?? null,
    passphrase: optionalStr(input.passphrase) ?? existing?.passphrase ?? null,
    password,
    // Where the program is published.
    uploadDir: optionalStr(input.uploadDir ?? input.remotePath) ?? existing?.uploadDir ?? existing?.remotePath ?? null,
    remotePath: optionalStr(input.uploadDir ?? input.remotePath) ?? existing?.uploadDir ?? existing?.remotePath ?? null,
    // What runs it.
    serviceKind,
    serviceName: optionalStr(input.serviceName) ?? existing?.serviceName ?? null,
    // Where the runtime itself lives (e.g. a Tomcat CATALINA_HOME) and a free
    // description of the environment, both usually filled by a profile import.
    appHome: optionalStr(input.appHome) ?? existing?.appHome ?? null,
    environment: optionalStr(input.environment) ?? existing?.environment ?? null,
    // The raw natural-language description the operator pasted in (or that came
    // from a hostreadme.txt). Kept verbatim so nothing is lost and the panel can
    // show it back; every other field is derived from it.
    envText: typeof input.envText === 'string' && input.envText.trim() !== '' ? input.envText : (existing?.envText ?? null),
    // The folder this target's credentials/notes were imported from, if any.
    sourceDir: optionalStr(input.sourceDir) ?? existing?.sourceDir ?? null,
    // Static content served straight from disk needs no restart; a WAR/class
    // change does. Default true keeps the documented stop→upload→restart flow.
    restartOnDeploy: input.restartOnDeploy === undefined ? (existing?.restartOnDeploy ?? true) : bool(input.restartOnDeploy, true),
    // How files reach the server:
    //   inplace — overwrite `uploadDir` (simple, no rollback history)
    //   release — upload into `<releasesDir>/<YYYYMMDD-HHMMSS>` and switch the
    //             web server's config to point at it, keeping every old release
    deployMode: (() => {
      const mode = optionalStr(input.deployMode) ?? existing?.deployMode ?? 'inplace'
      if (!['inplace', 'release'].includes(mode)) throw new Error('deployMode 必须是 inplace 或 release')
      return mode
    })(),
    releasesDir: optionalStr(input.releasesDir) ?? existing?.releasesDir ?? null,
    // The config file whose Context docBase gets switched (e.g. Tomcat server.xml)
    configFile: optionalStr(input.configFile) ?? existing?.configFile ?? null,
    contextPath: optionalStr(input.contextPath) ?? existing?.contextPath ?? '/',
    // Explicit commands always win over the per-kind defaults.
    detectCommand: optionalStr(input.detectCommand) ?? existing?.detectCommand ?? null,
    installCommand: optionalStr(input.installCommand) ?? existing?.installCommand ?? null,
    stopCommand: optionalStr(input.stopCommand) ?? existing?.stopCommand ?? null,
    startCommand: optionalStr(input.startCommand) ?? existing?.startCommand ?? null,
    restartCommand: optionalStr(input.restartCommand) ?? existing?.restartCommand ?? null,
    preCommand: optionalStr(input.preCommand) ?? existing?.preCommand ?? null,
    postCommand: optionalStr(input.postCommand) ?? existing?.postCommand ?? null,
    // Backup / rollback. Backing up before overwriting is the default; a target
    // turns it off explicitly with `backup: false`.
    backup: input.backup === undefined ? (existing?.backup ?? true) : bool(input.backup, true),
    backupDir: optionalStr(input.backupDir) ?? existing?.backupDir ?? null,
    keepReleases: intOrNull(input.keepReleases) ?? existing?.keepReleases ?? 3,
    // Named script persisted in the plugin's scripts store, if any.
    scriptName: optionalStr(input.scriptName) ?? existing?.scriptName ?? null,
    notes: optionalStr(input.notes) ?? existing?.notes ?? null,
    // Snapshot of what the server actually reported, written by site_server_detect
    // so the panel and later sessions can see the confirmed environment.
    verified: input.verified ?? existing?.verified ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function stripSecrets(record) {
  const out = { ...record }
  for (const field of SECRET_FIELDS) delete out[field]
  if (out.git) delete out.git.token
  return out
}

/** Site as the API/UI sees it: no secrets, current runtime status attached. */
export function publicSite(site, status) {
  const clean = stripSecrets(site)
  return {
    ...clean,
    git: site.git ? { enabled: true, remote: site.git.remote, branch: site.git.branch, dir: site.git.dir } : null,
    status: status ?? { state: 'stopped', pid: null, startedAt: null, exitCode: null, restarts: 0 },
  }
}

/** Target as the API/UI sees it: credentials replaced by presence flags. */
export function publicTarget(target, vault = null) {
  const keyName = target.keyName ?? null
  const key = vault && keyName && vault.has(keyName) ? vault.describe(keyName) : null
  return {
    name: target.name,
    host: target.host,
    port: target.port,
    user: target.user,
    // `uploadDir` is the modern name; `remotePath` is kept as the alias the
    // first release used, and both always resolve to the same value.
    uploadDir: target.uploadDir ?? target.remotePath ?? null,
    remotePath: target.uploadDir ?? target.remotePath ?? null,
    keyName,
    keyFingerprint: key?.fingerprint ?? null,
    hasKey: Boolean(keyName || target.privateKey || target.privateKeyPath),
    hasPassword: Boolean(target.password),
    serviceKind: target.serviceKind,
    serviceName: target.serviceName,
    appHome: target.appHome,
    environment: target.environment,
    envText: target.envText,
    sourceDir: target.sourceDir,
    restartOnDeploy: target.restartOnDeploy !== false,
    deployMode: target.deployMode ?? 'inplace',
    releasesDir: target.releasesDir,
    configFile: target.configFile,
    contextPath: target.contextPath ?? '/',
    detectCommand: target.detectCommand,
    installCommand: target.installCommand,
    stopCommand: target.stopCommand,
    startCommand: target.startCommand,
    restartCommand: target.restartCommand,
    preCommand: target.preCommand,
    postCommand: target.postCommand,
    backup: target.backup !== false,
    backupDir: target.backupDir,
    keepReleases: target.keepReleases,
    scriptName: target.scriptName,
    notes: target.notes,
    verified: target.verified ?? null,
    updatedAt: target.updatedAt,
  }
}

/** Tiny JSON store with atomic-ish writes (write temp, then rename). */
export class JsonStore {
  constructor(dir, logger) {
    this.dir = dir
    this.logger = logger
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'registry.json')
  }

  read() {
    const empty = { version: 1, sites: [], targets: [], schedules: [] }
    if (!existsSync(this.path)) return empty
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      return {
        version: 1,
        sites: Array.isArray(parsed.sites) ? parsed.sites : [],
        targets: Array.isArray(parsed.targets) ? parsed.targets : [],
        schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
      }
    } catch (err) {
      this.logger?.warn?.('[dsh-wei-sitecontrol] registry read failed: %s', err.message)
      return empty
    }
  }

  write(data) {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, ...data }, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }
}
