import { describe, expect, it } from 'vitest'
import { assertFetchableUrl, BlockedUrlError, isPublicAddress } from '../src/net-guard.js'

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe'])(
    'blocks %s',
    (ip) => expect(isPublicAddress(ip)).toBe(false),
  )

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (ip) => expect(isPublicAddress(ip)).toBe(true))

  it.each([
    'file:///etc/passwd',
    'ftp://example.com',
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data',
    'http://user:pw@example.com/',
    'http://example.com:8080/',
    'http://metadata.google.internal/',
    'not a url',
  ])('rejects %s before any network call', (url) => {
    expect(() => assertFetchableUrl(url)).toThrow(BlockedUrlError)
  })

  it('accepts ordinary public URLs', () => {
    expect(assertFetchableUrl('https://example.com/a?b=c').hostname).toBe('example.com')
  })
})
