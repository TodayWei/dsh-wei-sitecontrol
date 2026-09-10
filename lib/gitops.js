/**
 * dsh-wei-sitecontrol — gitops: the built-in git layer.
 *
 * Uses pure-JS isomorphic-git, so no system `git` binary is required.
 * Consequence worth knowing: isomorphic-git speaks HTTP(S) only, so an SSH
 * remote (`git@host:path`) cannot be pushed from here — that case returns an
 * explicit error telling the user to switch the remote to HTTPS or install a
 * real git binary. Local operations (status/add/commit) work in every case.
 */
import fs from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let cached = null

async function loadGit() {
  if (cached === null) {
    const [gitModule, httpModule] = await Promise.all([
      import('isomorphic-git'),
      import('isomorphic-git/http/node'),
    ])
    cached = { git: gitModule.default ?? gitModule, http: httpModule.default ?? httpModule }
  }
  return cached
}

/** True for scp-style and ssh:// remotes, which isomorphic-git cannot use. */
export function isSshRemote(remote) {
  const value = String(remote ?? '')
  return value.startsWith('ssh://') || /^[^/@\s]+@[^/\s]+:/.test(value)
}

/** True when the configured value is a URL rather than a remote *name*. */
function looksLikeUrl(value) {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|git@|[^/@\s]+@[^/\s]+:)/.test(String(value ?? ''))
}

function describeChange(row) {
  // statusMatrix row: [filepath, head(0/1), workdir(0/1/2), stage(0/1/2/3)].
  // `workdir === 2` only means "differs from HEAD" — it covers both a brand new
  // file and an edited tracked one, so the head/stage columns decide the label.
  const [filepath, head, workdir, stage] = row
  if (head === 1 && workdir === 1 && stage === 1) return null
  if (head === 0 && workdir === 0 && stage === 0) return null
  let code
  if (head === 0 && stage === 0) code = 'untracked'
  else if (head === 0) code = 'added'
  else if (stage === 0) code = 'deleted'
  else if (stage === 3) code = 'conflicted'
  else code = 'modified'
  return { path: filepath, code }
}

export class GitOps {
  constructor({ authorName = 'DSH Site Manager', authorEmail = 'site-manager@localhost', logger } = {}) {
    this.authorName = authorName
    this.authorEmail = authorEmail
    this.logger = logger
  }

  /** Resolve the repository directory for a site, or null when it is not a repo. */
  repoDir(site) {
    const dir = site?.git?.dir || site?.workspace
    if (!dir) return null
    return existsSync(join(dir, '.git')) ? dir : null
  }

  /**
   * Create a repository for a site that has none yet, so the built-in git
   * layer can version it without a system git binary. Idempotent: an existing
   * repository is reported back untouched.
   */
  async init(site, { initialBranch = null } = {}) {
    const dir = site?.git?.dir || site?.workspace
    if (!dir) throw new Error(`site "${site?.name ?? '?'}" has no workspace to initialize`)
    if (!existsSync(dir)) throw new Error(`site workspace does not exist: ${dir}`)
    const { git } = await loadGit()
    const branch = initialBranch || site?.git?.branch || 'main'
    if (existsSync(join(dir, '.git'))) {
      let current = null
      try {
        current = (await git.currentBranch({ fs, dir, fullname: false })) ?? null
      } catch {
        /* a fresh repository with no commit yet */
      }
      return { ok: true, dir, already: true, branch: current ?? branch }
    }
    await git.init({ fs, dir, defaultBranch: branch })
    return { ok: true, dir, already: false, branch }
  }

  async requireRepo(site) {
    if (!site.git?.enabled) throw new Error(`site "${site.name}" has no git configuration`)
    const dir = this.repoDir(site)
    if (!dir) {
      throw new Error(`site "${site.name}" is not a git repository (no .git in ${site.git.dir || site.workspace})`)
    }
    return dir
  }

  async status(site) {
    const dir = await this.requireRepo(site)
    const { git } = await loadGit()
    const branch = (await git.currentBranch({ fs, dir, fullname: false })) ?? null
    let changed = []
    try {
      const matrix = await git.statusMatrix({ fs, dir })
      changed = matrix.map(describeChange).filter(Boolean)
    } catch (err) {
      this.logger?.warn?.('[dsh-wei-sitecontrol] statusMatrix failed: %s', err.message)
    }
    let lastCommit = null
    try {
      const [head] = await git.log({ fs, dir, depth: 1 })
      if (head) {
        lastCommit = {
          oid: head.oid,
          message: String(head.commit?.message ?? '').split('\n')[0],
          author: head.commit?.author?.name ?? '',
          when: head.commit?.author?.timestamp ? new Date(head.commit.author.timestamp * 1000).toISOString() : null,
        }
      }
    } catch {
      /* an unborn branch has no commits yet */
    }
    const remotes = await this.#remotes(git, dir)
    // `site.git.remote` may hold either a remote *name* (origin) or a full URL;
    // both are accepted everywhere this layer resolves a remote.
    const configured = site.git?.remote ?? null
    const remoteUrl = remotes.find((r) => r.remote === configured)?.url ?? (looksLikeUrl(configured) ? configured : null) ?? remotes[0]?.url ?? null
    const { ahead, behind } = await this.#divergence(git, dir, branch, remotes, configured)
    return {
      dir,
      branch,
      changed,
      ahead,
      behind,
      lastCommit,
      remote: remoteUrl,
      remotes,
    }
  }

  async #remotes(git, dir) {
    try {
      return await git.listRemotes({ fs, dir })
    } catch {
      return []
    }
  }

  async #divergence(git, dir, branch, remotes, configured) {
    if (!branch || remotes.length === 0) return { ahead: null, behind: null }
    const preferred = remotes.some((r) => r.remote === configured) ? configured : remotes[0].remote
    try {
      const localOid = await git.resolveRef({ fs, dir, ref: branch })
      const remoteOid = await git.resolveRef({ fs, dir, ref: `refs/remotes/${remote}/${branch}` })
      if (localOid === remoteOid) return { ahead: 0, behind: 0 }
      const localLog = await git.log({ fs, dir, ref: branch, depth: 500 })
      const remoteLog = await git.log({ fs, dir, ref: `refs/remotes/${remote}/${branch}`, depth: 500 })
      const remoteSet = new Set(remoteLog.map((c) => c.oid))
      const localSet = new Set(localLog.map((c) => c.oid))
      return {
        ahead: localLog.filter((c) => !remoteSet.has(c.oid)).length,
        behind: remoteLog.filter((c) => !localSet.has(c.oid)).length,
      }
    } catch {
      return { ahead: null, behind: null }
    }
  }

  /** Stage everything that changed and create one commit. */
  async commit(site, message, { all = true } = {}) {
    const dir = await this.requireRepo(site)
    const { git } = await loadGit()
    if (!message || String(message).trim() === '') throw new Error('commit message is required')
    let staged = 0
    if (all) {
      const matrix = await git.statusMatrix({ fs, dir })
      for (const row of matrix) {
        const change = describeChange(row)
        if (!change) continue
        await git.add({ fs, dir, filepath: change.path })
        staged += 1
      }
    }
    const oid = await git.commit({
      fs,
      dir,
      message: String(message),
      author: {
        name: site.git?.authorName || this.authorName,
        email: site.git?.authorEmail || this.authorEmail,
      },
    })
    return { oid, message: String(message).split('\n')[0], staged }
  }

  /** Push the current branch. HTTP(S) remotes only — see the module header. */
  async push(site, { remote, branch, token } = {}) {
    const dir = await this.requireRepo(site)
    const { git, http } = await loadGit()
    const remotes = await this.#remotes(git, dir)
    const configured = site.git?.remote ?? null
    const explicit = remote && remotes.some((r) => r.remote === remote) ? remote : null
    const remoteName = explicit ?? (remotes.some((r) => r.remote === configured) ? configured : null) ?? remote ?? remotes[0]?.remote ?? 'origin'
    const remoteUrl =
      remotes.find((r) => r.remote === remoteName)?.url ?? (looksLikeUrl(configured) ? configured : null)
    if (!remoteUrl) throw new Error(`remote "${remoteName}" is not configured in ${dir}`)
    if (isSshRemote(remoteUrl)) {
      throw new Error(
        `remote "${remoteName}" is an SSH url (${remoteUrl}); the built-in git layer only supports HTTP(S). ` +
          'Change the remote to https://… (with a token) or install a git binary and push outside DSH.',
      )
    }
    const ref = branch || (await git.currentBranch({ fs, dir, fullname: false })) || site.git?.branch
    if (!ref) throw new Error('cannot determine the branch to push')
    const authToken = token || (site.git?.tokenEnv ? process.env[site.git.tokenEnv] : null)
    const result = await git.push({
      fs,
      http,
      dir,
      remote: remoteName,
      ref,
      onAuth: authToken
        ? () => ({ username: authToken, password: authToken })
        : undefined,
      onAuthFailure: () => ({ cancel: true }),
    })
    return {
      ok: result?.ok !== false,
      remote: remoteName,
      branch: ref,
      url: remoteUrl,
      refs: result?.refs ?? {},
    }
  }
}
