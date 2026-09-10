/**
 * dsh-wei-sitecontrol — provision: from a natural-language environment description
 * to a fully populated target.
 *
 * The operator pastes something like:
 *
 *   ip:203.0.113.10
 *   ssh端口:TCP:22
 *   描述：示例公司官网。使用tomcat服务，tomcat应用目录在：/opt/tomcat9。
 *        静态web站点。程序发布目录在/srv/www。
 *
 * `provisionFromText` turns that into target fields, and the SSH probe then
 * overrides the *derived* guesses with what the server's own configuration says
 * (docBase, config file, context path, unit). The raw text is stored too, so the
 * description survives in the database even though the folder only keeps the pem.
 */
import { parseProfileText } from './profile.js'

/** Derive target fields from the description alone (no network). */
export function provisionFromText(text) {
  const parsed = parseProfileText(text)
  const patch = { envText: String(text ?? '') }
  const assumed = []
  if (parsed.host) {
    patch.host = parsed.host
  }
  if (parsed.port) patch.port = parsed.port
  if (parsed.environment) patch.environment = parsed.environment
  if (parsed.uploadDir) {
    patch.uploadDir = parsed.uploadDir
    patch.remotePath = parsed.uploadDir
  }
  if (parsed.appHome) {
    patch.appHome = parsed.appHome
    // Standard Tomcat layout: <home>/conf/server.xml and a sibling releases dir.
    patch.configFile = `${parsed.appHome.replace(/\/+$/, '')}/conf/server.xml`
    const base = parsed.appHome.replace(/\/[^/]+\/?$/, '')
    if (base && base !== parsed.appHome) patch.releasesDir = `${base}/releases`
    assumed.push('configFile', 'releasesDir')
  }
  if (parsed.serviceKind) patch.serviceKind = parsed.serviceKind
  if (parsed.serviceName) patch.serviceName = parsed.serviceName
  // A description that names Tomcat implies a release-capable deployment.
  if (patch.serviceKind === 'tomcat') patch.deployMode = 'release'
  return { patch, parsed, assumed }
}

/**
 * Merge the probe's authoritative facts over the derived ones. The server's own
 * configuration wins: the text says what the operator *means*, the config says
 * what is *true*.
 */
export function confirmFromProbe(target, findings) {
  const patch = {}
  const confirmed = []
  const set = (field, value, label) => {
    if (value === null || value === undefined || String(value).trim() === '') return
    if (target[field] === value) return
    patch[field] = value
    confirmed.push(`${label ?? field}=${value}`)
  }
  if (findings?.publish) {
    set('uploadDir', findings.publish.docBase, '发布目录(docBase)')
    if (patch.uploadDir !== undefined) patch.remotePath = patch.uploadDir
    set('configFile', findings.publish.configFile, '配置文件')
    set('contextPath', findings.publish.contextPath, 'context')
  }
  if (findings?.tomcat?.catalinaHome) set('appHome', findings.tomcat.catalinaHome, 'CATALINA_HOME')
  if (findings?.tomcat?.unit) set('serviceName', findings.tomcat.unit, '服务单元')
  if (findings && ['tomcat', 'nginx', 'httpd', 'docker', 'static'].includes(target.serviceKind)) {
    const kind = findings.tomcat?.present ? 'tomcat' : findings.nginx?.present ? 'nginx' : findings.httpd?.present ? 'httpd' : findings.docker?.present ? 'docker' : 'static'
    if (kind !== target.serviceKind) {
      patch.serviceKind = kind
      confirmed.push(`serviceKind=${kind}`)
    }
  }
  // Release mode needs both a config file and a releases directory; derive the
  // releases dir next to the runtime when only the config file is known.
  if (!target.releasesDir && !patch.releasesDir && (patch.configFile || target.configFile)) {
    const configFile = patch.configFile ?? target.configFile
    const base = configFile.replace(/\/conf\/.*$/, '').replace(/\/[^/]+\/?$/, '')
    if (base) {
      patch.releasesDir = `${base}/releases`
      confirmed.push(`releasesDir=${patch.releasesDir}(推断)`)
    }
  }
  if ((patch.serviceKind ?? target.serviceKind) === 'tomcat' && !target.deployMode) {
    patch.deployMode = 'release'
  }
  return { patch, confirmed }
}
