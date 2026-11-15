import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

type V4Range = readonly [number, number, number, number]

/** 私网 / 保留 / 回环 / 链路本地 / 组播网段。 */
const PRIVATE_V4: readonly V4Range[] = [
  [0, 0, 0, 0],
  [10, 0, 0, 0],
  [100, 64, 0, 0],
  [127, 0, 0, 0],
  [169, 254, 0, 0],
  [172, 16, 0, 0],
  [192, 0, 0, 0],
  [192, 0, 2, 0],
  [192, 88, 99, 0],
  [192, 168, 0, 0],
  [198, 18, 0, 0],
  [198, 51, 100, 0],
  [203, 0, 113, 0],
  [224, 0, 0, 0],
  [240, 0, 0, 0],
]

const PRIVATE_V4_PREFIX: readonly number[] = [8, 8, 10, 8, 16, 12, 24, 24, 24, 16, 15, 24, 24, 4, 4]

const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number)
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!
}

function isPrivateV4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  return PRIVATE_V4.some((range, index) => {
    const prefix = PRIVATE_V4_PREFIX[index]!
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (value & mask) === (ipv4ToInt(range.join('.')) & mask)
  })
}

/** IPv4/IPv6 字面量是否落在私网、回环、链路本地或保留段。 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateV4(address)
  if (family !== 6) return true

  const value = address.toLowerCase()
  if (value === '::' || value === '::1') return true
  if (value.startsWith('fc') || value.startsWith('fd')) return true
  if (/^fe[89ab]/.test(value)) return true
  if (value.startsWith('ff')) return true
  if (value.startsWith('2001:db8')) return true

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (mapped) return isPrivateV4(mapped[1]!)
  return false
}

function assertNotPrivate(hostname: string): void {
  let host = hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host) throw new UnsafeUrlError('URL 缺少主机名。')
  if (host === 'localhost' || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UnsafeUrlError(`禁止访问本机/内网地址：${hostname}`)
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new UnsafeUrlError(`禁止访问本机/内网地址：${hostname}`)
  }
}

/** 只接受无凭据的 http/https URL，且主机不是本机/内网字面量。 */
export function parseHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError(`非法 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`只允许 http/https：${url.protocol}`)
  }
  if (url.username || url.password) throw new UnsafeUrlError('URL 不允许携带凭据。')
  assertNotPrivate(url.hostname)
  return url
}

/**
 * 解析并校验远端 HTTP URL：字面量与 DNS 解析结果都不得是私网地址。
 * 注意：DNS 重绑定需要在真正建立连接时再校验一次（M1 接入抓取代理时补上）。
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const url = parseHttpUrl(raw)
  if (isIP(url.hostname)) return url

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true })
  } catch {
    throw new UnsafeUrlError(`DNS 解析失败：${url.hostname}`)
  }
  if (!addresses.length) throw new UnsafeUrlError(`DNS 无结果：${url.hostname}`)
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new UnsafeUrlError(`域名解析到内网地址：${url.hostname} → ${entry.address}`)
    }
  }
  return url
}
