/**
 * dsh-wei-sitecontrol — githttp: the HTTP(S) transport used by the git layer.
 *
 * isomorphic-git ships its own Node client, but it is unusable in two very
 * common real-world setups. Both were reproduced on this machine:
 *
 *   1) "Request timed out" on every push.
 *      That client delegates to `simple-get`, which aborts the request when the
 *      socket emits 'timeout'. Node 19+ made the default global agent
 *      keep-alive with `timeout: 5000`, so five seconds of socket silence —
 *      which GitHub's `receive-pack` easily exceeds while it processes the
 *      packfile — kills an otherwise healthy push, with an error message that
 *      points at nothing useful.
 *
 *   2) "connect ETIMEDOUT" behind a proxy.
 *      `http(s).request` ignores the Windows WinINET system proxy, so on a
 *      machine that reaches GitHub only through a local proxy the TCP connect
 *      either hangs or is reset.
 *
 * This module is a drop-in implementation of isomorphic-git's HttpClient
 * contract (`{ request(req) => Promise<res> }`) that fixes both:
 *
 *   - Own connection handling: `keepAlive: false`, socket idle timeout off,
 *     so a slow-but-alive server is never mistaken for a dead one.
 *   - Direct first, then the proxy. A proxy is taken from HTTPS_PROXY /
 *     HTTP_PROXY / ALL_PROXY, or discovered by probing the usual local ports
 *     (127.0.0.1:7890 and friends), and is used via an HTTP CONNECT tunnel.
 *     Loopback, LAN and NO_PROXY hosts always go direct.
 *   - Request bodies accept Buffer / Uint8Array / string / array of chunks /
 *     async iterable, which is what isomorphic-git hands over.
 */
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import { URL } from 'node:url'

const IDLE_TIMEOUT_MS = Number(process.env.DSH_GIT_HTTP_TIMEOUT_MS || 15 * 60 * 1000)
const VERBOSE = process.env.DSH_GIT_HTTP_VERBOSE === '1'

function log(...args) {
  if (VERBOSE) console.error('  [githttp]', ...args)
}

/** Hosts that must never be routed through a proxy: loopback and RFC1918. */
export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '0.0.0.0') return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  return false
}

function noProxyMatches(hostname) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || ''
  if (!raw) return false
  const host = String(hostname || '').toLowerCase()
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry === '*' || host === entry || host.endsWith(`.${entry.replace(/^\./, '')}`))
}

// ------------------------------------------------------------------ proxies
function proxyCandidates() {
  const fromEnv = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ].filter(Boolean)
  const common = [
    'http://127.0.0.1:7890', // Clash / Clash Verge
    'http://127.0.0.1:7897', // Clash Verge (newer default)
    'http://127.0.0.1:10809', // v2rayN
    'http://127.0.0.1:10808',
    'http://127.0.0.1:1080', // generic socks/http
    'http://127.0.0.1:8889',
  ]
  const out = []
  const seen = new Set()
  for (const raw of [...fromEnv, ...common]) {
    const normalized = /^\w+:\/\//.test(raw) ? raw : `http://${raw}`
    let url
    try {
      url = new URL(normalized)
    } catch {
      continue
    }
    const key = `${url.hostname}:${url.port || 8080}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url, explicit: fromEnv.includes(raw) })
  }
  return out
}

function probePort(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

let proxyCache // undefined = not probed, null = none usable
async function findProxy() {
  if (proxyCache !== undefined) return proxyCache
  for (const candidate of proxyCandidates()) {
    const host = candidate.url.hostname
    const port = Number(candidate.url.port || (candidate.url.protocol === 'https:' ? 443 : 8080))
    if (candidate.explicit || (await probePort(host, port))) {
      proxyCache = { host, port, url: candidate.url }
      log(`using proxy ${host}:${port}`)
      return proxyCache
    }
  }
  proxyCache = null
  log('no proxy found, going direct')
  return proxyCache
}

/** Test seam: forget the cached proxy probe. */
export function resetProxyCache() {
  proxyCache = undefined
}

// ------------------------------------------------------------------ bodies
function collectAsync(iterable) {
  return (async () => {
    const chunks = []
    let size = 0
    for await (const chunk of iterable) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buffer)
      size += buffer.length
    }
    return Buffer.concat(chunks, size)
  })()
}

async function toBuffer(body) {
  if (body == null) return null
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (Array.isArray(body)) {
    const parts = []
    for (const part of body) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part))
    return Buffer.concat(parts)
  }
  if (typeof body[Symbol.asyncIterator] === 'function') return collectAsync(body)
  if (typeof body.getReader === 'function') return collectAsync(body)
  throw new TypeError('unsupported request body type')
}

// ------------------------------------------------------------------ sending
function headersFor(headers, buffer, url) {
  const out = { host: url.host, ...headers }
  if (buffer) out['content-length'] = String(buffer.length)
  return out
}

function handleResponse({ res, url, method, onProgress, resolve, reject, redirect }) {
  const status = res.statusCode
  if (status >= 300 && status < 400 && res.headers.location) {
    res.resume()
    // Hand the follow-up request's outcome back to THIS promise — forgetting
    // this makes a redirected request hang forever.
    redirect(res.headers.location).then(resolve, reject)
    return
  }
  const chunks = []
  let loaded = 0
  const total = Number(res.headers['content-length'] || 0)
  res.on('data', (chunk) => {
    chunks.push(chunk)
    loaded += chunk.length
    if (onProgress) onProgress({ phase: 'Receiving', loaded, total })
  })
  res.on('error', reject)
  res.on('end', () => {
    resolve({
      url,
      method,
      statusCode: status,
      statusMessage: res.statusMessage,
      headers: res.headers,
      body: (async function* () {
        for (const chunk of chunks) yield new Uint8Array(chunk)
      })(),
    })
  })
}

function sendDirect(options) {
  const { url, method, headers, buffer, onProgress, resolve, reject, depth, redirect } = options
  const target = new URL(url)
  const secure = target.protocol === 'https:'
  const mod = secure ? https : http
  const req = mod.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: headersFor(headers, buffer, target),
      // The whole point: a private agent with keep-alive off, so no inherited
      // 5-second idle timeout can abort a slow push.
      agent: new mod.Agent({ keepAlive: false }),
    },
    (res) => handleResponse({ res, url, method, onProgress, resolve, reject, redirect }),
  )
  req.on('error', reject)
  // Own idle timeout: long enough that a slow-but-alive server is never killed,
  // short enough that a truly dead connection eventually reports something.
  req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`socket idle for ${IDLE_TIMEOUT_MS}ms`)))
  if (buffer) req.end(buffer)
  else req.end()
}

function sendViaProxy(options) {
  const { proxy, url, method, headers, buffer, onProgress, resolve, reject, depth, redirect } = options
  const target = new URL(url)
  const authority = `${target.hostname}:${target.port || 443}`
  const auth = proxy.url.username
    ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.url.username)}:${decodeURIComponent(proxy.url.password)}`).toString('base64')}` }
    : {}
  const connectReq = http.request({
    host: proxy.host,
    port: proxy.port,
    method: 'CONNECT',
    path: authority,
    headers: { host: authority, ...auth },
  })
  connectReq.on('error', reject)
  connectReq.on('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy()
      reject(new Error(`proxy CONNECT ${authority} failed: HTTP ${res.statusCode}`))
      return
    }
    socket.setTimeout(0)
    const req = https.request(
      {
        socket,
        agent: false,
        hostname: target.hostname, // Node builds the Host header from this
        port: target.port || 443,
        servername: target.hostname, // SNI must be the real host, not the proxy
        path: `${target.pathname}${target.search}`,
        method,
        headers: headersFor(headers, buffer, target),
      },
      (res2) => handleResponse({ res: res2, url, method, onProgress, resolve, reject, redirect }),
    )
    req.on('error', reject)
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`socket idle for ${IDLE_TIMEOUT_MS}ms`)))
    if (buffer) req.end(buffer)
    else req.end()
  })
  connectReq.end()
}

const NETWORK_ERROR = /ETIMEDOUT|ETIMEOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|other side closed/i

async function send({ url, method, headers, buffer, onProgress, forceProxy = false, depth = 0 }) {
  if (depth > 5) throw new Error(`too many redirects fetching ${url}`)

  const redirect = (location) => {
    const next = new URL(location, url).toString()
    if (next === url) throw new Error(`redirect loop at ${url}`)
    const sameHost = new URL(next).host === new URL(url).host
    const nextHeaders = { ...headers }
    if (!sameHost) {
      delete nextHeaders.authorization
      delete nextHeaders.Authorization
    }
    const keepBody = method === 'GET' || method === 'HEAD'
    return send({
      url: next,
      method: keepBody ? method : 'GET',
      headers: nextHeaders,
      buffer: keepBody ? buffer : null,
      onProgress,
      forceProxy,
      depth: depth + 1,
    })
  }

  const attempt = (proxy) =>
    new Promise((resolve, reject) => {
      const options = { url, method, headers, buffer, onProgress, resolve, reject, depth, redirect }
      if (proxy) sendViaProxy({ ...options, proxy })
      else sendDirect(options)
    })

  const parsed = new URL(url)
  const proxyAllowed = !isPrivateHost(parsed.hostname) && !noProxyMatches(parsed.hostname)

  if (proxyAllowed) {
    const proxy = forceProxy || (await findProxy())
    if (proxy) {
      log(`${method} ${url} via proxy ${proxy.host}:${proxy.port}`)
      return attempt(proxy)
    }
  }

  try {
    log(`${method} ${url} direct`)
    return await attempt(null)
  } catch (err) {
    const message = String(err?.message || err)
    if (!proxyAllowed || !NETWORK_ERROR.test(message)) throw err
    log(`direct failed (${message}); re-probing proxy…`)
    proxyCache = undefined
    const proxy = await findProxy()
    if (!proxy) throw err
    return attempt(proxy)
  }
}

/**
 * isomorphic-git HttpClient entry point.
 * @returns {Promise<{url, method, statusCode, statusMessage, headers, body: AsyncIterable<Uint8Array>}>}
 */
export async function request({ url, method = 'GET', headers = {}, body, onProgress }) {
  const buffer = await toBuffer(body)
  if (buffer && onProgress) onProgress({ phase: 'Sending', loaded: buffer.length, total: buffer.length })
  return send({ url, method, headers, buffer, onProgress })
}

export default { request }
