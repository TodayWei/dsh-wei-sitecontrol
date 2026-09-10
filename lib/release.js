/**
 * dsh-wei-sitecontrol — release: timestamped release directories plus the
 * config switch that points the server at the newest one.
 *
 * Why: overwriting files in place gives no rollback. Publishing into
 * `<releasesDir>/<YYYYMMDD-HHMMSS>/` and then rewriting the web server's
 * `docBase` keeps every previous release on disk, so a rollback is one config
 * switch (and one restart) away.
 *
 * Everything here is pure string work on the config file, because a bad rewrite
 * of `server.xml` would take a production site down. `rewriteDocBase` is
 * deliberately conservative: it refuses to guess, reports what it found, and
 * never touches a file it does not recognise.
 */

/** `20260910-131500` — sortable, filename-safe, no colons. */
export function releaseStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function releasePath(releasesDir, stamp) {
  return `${String(releasesDir).replace(/\/+$/, '')}/${stamp}`
}

/** Parse the attributes of one tag body (`path="/" docBase="/x"` …). */
function attributesOf(tag) {
  const attrs = {}
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match
  while ((match = re.exec(tag)) !== null) {
    attrs[match[1]] = match[3] ?? match[4] ?? ''
  }
  return attrs
}

function quoteFor(tag) {
  return tag.includes('="') ? '"' : "'"
}

/**
 * Point the Context that serves `contextPath` at `newDocBase`.
 *
 * Conservative contract:
 *  - only `<Context …>` elements are considered, in any attribute order;
 *  - `path` must match `contextPath` (a Context without `path` means the ROOT
 *    context, which is what Tomcat uses for `path=""`);
 *  - a missing `docBase` is inserted, never invented elsewhere;
 *  - when no Context matches, `changed` is false and the caller must abort.
 */
export function rewriteDocBase(xml, { contextPath = '/', newDocBase } = {}) {
  const source = String(xml ?? '')
  if (!newDocBase) throw new Error('newDocBase is required')
  if (!source.includes('<Context')) return { changed: false, reason: '配置文件里没有找到任何 <Context> 元素' }

  const normalizedTarget = contextPath === '' ? '' : contextPath
  const tagRe = /<Context\b[^>]*?\/?>/g
  let match
  let changed = false
  let previousDocBase = null
  let matchedContext = null

  const out = source.replace(tagRe, (tag) => {
    if (changed) return tag
    const attrs = attributesOf(tag)
    const path = attrs.path === undefined ? '' : attrs.path
    if (path !== normalizedTarget) return tag
    changed = true
    matchedContext = path === '' ? '(ROOT)' : path
    const quote = quoteFor(tag)
    if (attrs.docBase === undefined) {
      // Insert next to `path` so the result stays readable.
      return tag.replace(/(<Context\b[^>]*?)(\/?>)$/, `$1 docBase=${quote}${newDocBase}${quote}$2`)
    }
    previousDocBase = attrs.docBase
    const attrRe = new RegExp(`docBase\\s*=\\s*("${escapeRe(attrs.docBase)}"|'${escapeRe(attrs.docBase)}')`)
    return tag.replace(attrRe, `docBase=${quote}${newDocBase}${quote}`)
  })

  if (!changed) {
    return { changed: false, reason: `配置文件里没有 path="${contextPath}" 的 <Context>(可能用了别的 context 路径)` }
  }
  return { changed: true, xml: out, previousDocBase, context: matchedContext }
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Pull every `<Context>` with its path and docBase, for reporting. */
export function listContexts(xml) {
  const out = []
  const tagRe = /<Context\b[^>]*?\/?>/g
  let match
  while ((match = tagRe.exec(String(xml ?? ''))) !== null) {
    const attrs = attributesOf(match[0])
    out.push({ path: attrs.path ?? '', docBase: attrs.docBase ?? null })
  }
  return out
}

/** Newest-first release names from a `ls -1dt <dir>/*` listing. */
export function parseReleaseListing(stdout, releasesDir) {
  const prefix = String(releasesDir).replace(/\/+$/, '')
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${prefix}/`))
    .map((line) => ({ path: line, name: line.slice(prefix.length + 1) }))
    .filter((entry) => /^\d{8}-\d{6}$/.test(entry.name) || entry.name !== '')
}

/** The release before `current`, i.e. the rollback candidate. */
export function previousRelease(releases, current) {
  const names = releases.map((r) => r.name)
  const index = names.indexOf(current)
  if (index === -1) return releases.length > 1 ? releases[1] : null
  return releases[index + 1] ?? null
}
