/**
 * WebDAV 配置（#131）：地址、账号、密码保存在全局设置表。
 * 密码只在服务端使用，下发页面时只给「是否已设置」；
 * 私网/环回地址默认拒绝，需在配置里显式打开「允许私网」。
 */

import { isIP } from 'node:net'
import { isPrivateAddress } from '../net/guard.js'

export interface WebdavConfig {
  url: string
  username: string
  password: string
  allowPrivate: boolean
}

/** 下发给页面的配置：密码打码成 hasPassword，不返回原值。 */
export interface PublicWebdavConfig {
  url: string
  username: string
  hasPassword: boolean
  allowPrivate: boolean
}

/** 设置表里的 WebDAV 字段名；对外返回设置前必须整组剔除。 */
export const WEBDAV_SETTING_KEYS = Object.freeze([
  'webdavUrl',
  'webdavUsername',
  'webdavPassword',
  'webdavAllowPrivate',
] as const)

export const WEBDAV_URL_MAX = 2048
export const WEBDAV_USERNAME_MAX = 200
export const WEBDAV_PASSWORD_MAX = 500

/** 只在本机/内网才用的主机后缀，与 net/guard.ts 的判定保持一致。 */
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']

export class WebdavConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebdavConfigError'
  }
}

function textWithin(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 读设置时归一：缺字段补空串、超长截断、坏类型回落空值；密码原样保留（不 trim）。 */
export function normalizeWebdavConfig(input: unknown): WebdavConfig {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    url: textWithin(source.webdavUrl, WEBDAV_URL_MAX).trim(),
    username: textWithin(source.webdavUsername, WEBDAV_USERNAME_MAX).trim(),
    password: textWithin(source.webdavPassword, WEBDAV_PASSWORD_MAX),
    allowPrivate: source.webdavAllowPrivate === true,
  }
}

export function publicWebdavConfig(config: WebdavConfig): PublicWebdavConfig {
  return {
    url: config.url,
    username: config.username,
    hasPassword: config.password.length > 0,
    allowPrivate: config.allowPrivate,
  }
}

/** 把 WebDAV 字段从任意设置对象里剔除；所有下发给页面的设置都要经过它。 */
export function withoutWebdavSettings<T>(settings: T): T {
  if (!settings || typeof settings !== 'object') return settings
  const copy: Record<string, unknown> = { ...(settings as Record<string, unknown>) }
  for (const key of WEBDAV_SETTING_KEYS) delete copy[key]
  return copy as T
}

/**
 * 校验用户填的 WebDAV 地址：只接受无凭据的 http/https 绝对地址。
 * 地址按目录理解，请求时会自动补结尾斜杠。
 */
export function parseWebdavAddress(raw: unknown): URL {
  if (typeof raw !== 'string' || !raw.trim()) throw new WebdavConfigError('请填写 WebDAV 地址')
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new WebdavConfigError('WebDAV 地址不是合法网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebdavConfigError('WebDAV 地址只支持 http 或 https')
  }
  if (url.username || url.password) {
    throw new WebdavConfigError('WebDAV 地址里不要写账号密码，请分开填')
  }
  if (!url.hostname) throw new WebdavConfigError('WebDAV 地址缺少主机名')
  return url
}

/** 目录请求地址：保留原路径，只补结尾斜杠（部分服务端把无斜杠的集合当 301/404）。 */
export function webdavDirectoryHref(url: URL): string {
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  return `${url.origin}${path}`
}

/** 字面量层面的私网判定：本机、内网后缀、私网/保留 IP。域名是否解析到内网要等请求时查 DNS。 */
export function isPrivateWebdavHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  return isIP(host) !== 0 && isPrivateAddress(host)
}

/** 把文本里出现的密码换成星号，保证错误信息、日志都不回显凭据。 */
export function redactWebdavPassword(text: string, password: string): string {
  if (!password) return text
  return text.split(password).join('******')
}
