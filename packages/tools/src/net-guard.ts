import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'

/**
 * SSRF guard for anything that fetches a URL chosen by the model (and therefore,
 * indirectly, by untrusted content). Blocks loopback, private, link-local, CGNAT,
 * multicast and reserved ranges, including cloud metadata (169.254.169.254).
 */
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) is checked as IPv4. Not added to the BlockList:
    // Node applies ::ffff rules to plain IPv4 lookups too, which would block everything.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped) return isPublicAddress(mapped[1]!)
    // Hex spelling, e.g. ::ffff:7f00:1 (how WHATWG URL normalises [::ffff:127.0.0.1]).
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
    if (hex) {
      const hi = parseInt(hex[1]!, 16)
      const lo = parseInt(hex[2]!, 16)
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return !blocked.check(address, 'ipv6')
  }
  return false
}

export class BlockedUrlError extends Error {
  override name = 'BlockedUrlError'
}

/** Validates scheme, port and literal-IP hosts before any network activity. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BlockedUrlError('not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BlockedUrlError('only http(s) URLs are allowed')
  if (url.username || url.password) throw new BlockedUrlError('credentials in URLs are not allowed')
  if (url.port && url.port !== '80' && url.port !== '443') throw new BlockedUrlError('non-standard ports are not allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new BlockedUrlError('local hostnames are not allowed')
  }
  if (isIP(host) && !isPublicAddress(host)) throw new BlockedUrlError('private addresses are not allowed')
  return url
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/**
 * A `lookup` for http(s).request that rejects non-public resolutions. Because the
 * check happens on the address actually used to connect, DNS rebinding can't
 * slip a private IP in between validation and connection.
 */
export function guardedLookup(hostname: string, options: object, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, [])
    const list = addresses as LookupAddress[]
    const bad = list.find((a) => !isPublicAddress(a.address))
    if (bad || list.length === 0) {
      return callback(Object.assign(new BlockedUrlError('host resolves to a private address'), { code: 'EBLOCKED' }), [])
    }
    if ((options as { all?: boolean }).all) return callback(null, list)
    const first = list[0]!
    callback(null, first.address, first.family)
  })
}
