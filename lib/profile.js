/**
 * dsh-wei-sitecontrol — profile: import a server profile folder.
 *
 * The layout this mirrors is one folder per server:
 *
 *   keys/<服务器名>/<名称>.pem      秘钥
 *   keys/<服务器名>/hostreadme.txt  ip / ssh 端口 / 描述 / 目录说明
 *
 * `parseProfileText` is pure and tolerant (Chinese or ASCII labels, UTF-8 or
 * GBK-decoded text), so the same parser serves the panel, the agent tool and
 * the tests. `importProfile` reads the folder, stores the key in the vault
 * under the folder name and returns target fields ready to save.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Decode a readme that may be UTF-8 or GBK (Windows editors write GBK here). */
export function decodeTextFile(path) {
  const bytes = readFileSync(path)
  const utf8 = bytes.toString('utf8')
  // A GBK file decodes into the replacement character or lone surrogates here.
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(bytes)
  } catch {
    return utf8
  }
}

const firstMatch = (text, patterns) => {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

/**
 * Pull the facts out of a hostreadme.txt. Recognised (case-insensitive):
 *   ip: 1.2.3.4            ssh端口: TCP:22        描述: 任意文本
 *   程序发布目录在/xxx       tomcat应用目录在:/xxx
 */
export function parseProfileText(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n')
  const host = firstMatch(source, [/^\s*ip\s*[:：]\s*([^\s,;]+)/im, /^\s*(?:host|地址|主机)\s*[:：]\s*([^\s,;]+)/im])
  const portRaw = firstMatch(source, [
    /ssh\s*端口\s*[:：]\s*(?:TCP\s*[:：]\s*)?(\d+)/i,
    /ssh\s*port\s*[:：]\s*(\d+)/i,
    /端口\s*[:：]\s*(?:TCP\s*[:：]\s*)?(\d{2,5})/i,
  ])
  const environment = firstMatch(source, [/描述\s*[:：]\s*(.+)/i, /说明\s*[:：]\s*(.+)/i, /环境\s*[:：]\s*(.+)/i])
  const uploadDir = firstMatch(source, [
    /程序发布目录在\s*[:：]?\s*([^\s,;,。]+)/i,
    /发布目录\s*[:：]\s*([^\s,;,。]+)/i,
    /publish\s*dir\s*[:：]?\s*([^\s,;,。]+)/i,
  ])
  const appHome = firstMatch(source, [
    /tomcat\s*应用目录在\s*[:：]?\s*([^\s,;,。]+)/i,
    /(?:应用|应用目录|安装目录|应用程式目录)\s*[:：]\s*([^\s,;,。]+)/i,
    /CATALINA_HOME\s*[:：]?\s*([^\s,;,。]+)/i,
  ])
  const serviceKind = /tomcat/i.test(source) ? 'tomcat' : /nginx/i.test(source) ? 'nginx' : /(httpd|apache)/i.test(source) ? 'httpd' : /docker|容器/i.test(source) ? 'docker' : 'static'
  const serviceName = (() => {
    const explicit = firstMatch(source, [/服务(?:名|单元)\s*[:：]\s*([^\s,;,。]+)/i])
    if (explicit) return explicit
    // A CATALINA_HOME ending in tomcat9 strongly implies the tomcat9 unit.
    const version = appHome?.match(/(tomcat\d+)$/i)?.[1]
    return version ? version.toLowerCase() : null
  })()
  const note = source
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s*(ip|ssh\s*端口|ssh\s*port)\s*[:：]/i.test(line))
    .join('\n')
    .trim()

  return {
    host,
    port: portRaw ? Number(portRaw) : 22,
    environment,
    uploadDir,
    appHome,
    serviceKind,
    serviceName,
    notes: note || null,
  }
}

/** Find the private key inside a profile folder. */
export function findKeyFile(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
  const candidates = readdirSync(dir).filter((file) => /\.(pem|key|ppk)$/i.test(file))
  if (candidates.length === 0) return null
  // Prefer ${folder}.pem, then the only candidate.
  const folder = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return join(dir, candidates.find((f) => f.toLowerCase() === `${folder.toLowerCase()}.pem`) ?? candidates[0])
}

export function findReadmeFile(dir) {
  if (!existsSync(dir)) return null
  const names = readdirSync(dir).filter((file) => /\.(txt|md)$/i.test(file))
  if (names.length === 0) return null
  const preferred = names.find((f) => /host|readme|说明|server/i.test(f)) ?? names[0]
  return join(dir, preferred)
}

/**
 * Import one profile folder into the vault and produce target input.
 * No network, no DSH API: the caller decides what to save.
 */
export function importProfile({ dir, vault, name = null, logger = null }) {
  if (!existsSync(dir)) throw new Error(`档案目录不存在:${dir}`)
  const profileName = name || dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  const keyFile = findKeyFile(dir)
  if (!keyFile) throw new Error(`目录里没有 .pem/.key 密钥文件:${dir}`)
  const readmeFile = findReadmeFile(dir)
  const parsed = readmeFile ? parseProfileText(decodeTextFile(readmeFile)) : {}
  const keyMeta = vault.add(profileName, { path: keyFile, overwrite: true })
  logger?.info?.('[dsh-wei-sitecontrol] 已从档案目录导入密钥 %s(%s)', keyMeta.name, keyMeta.fingerprint ?? '加密私钥')

  return {
    name: profileName,
    sourceDir: dir,
    keyName: keyMeta.name,
    keyFingerprint: keyMeta.fingerprint,
    keyWarning: keyMeta.warning ?? null,
    readmeFile,
    host: parsed.host ?? null,
    port: parsed.port ?? 22,
    environment: parsed.environment ?? null,
    uploadDir: parsed.uploadDir ?? null,
    appHome: parsed.appHome ?? null,
    serviceKind: parsed.serviceKind ?? 'custom',
    serviceName: parsed.serviceName ?? null,
    notes: parsed.notes ?? null,
    missing: [
      parsed.host ? null : '档案里没有 ip',
      parsed.uploadDir ? null : '档案里没有发布目录(发布前需要补)',
    ].filter(Boolean),
  }
}
