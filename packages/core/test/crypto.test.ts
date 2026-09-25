import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createLocalCipher } from '../src/crypto.js'

const key = randomBytes(32).toString('base64')

describe('createLocalCipher (AES-256-GCM)', () => {
  const c = createLocalCipher(key)

  it('round-trips and never produces the same ciphertext twice', () => {
    const a = c.encrypt('1//refresh-token', 'google:user1:refresh')
    const b = c.encrypt('1//refresh-token', 'google:user1:refresh')
    expect(a).not.toBe(b)
    expect(a).not.toContain('refresh-token')
    expect(c.decrypt(a, 'google:user1:refresh')).toBe('1//refresh-token')
  })

  it("won't decrypt under another row's context (tokens can't be swapped between users)", () => {
    const a = c.encrypt('secret', 'google:user1:refresh')
    expect(() => c.decrypt(a, 'google:user2:refresh')).toThrow()
  })

  it('detects tampering and the wrong key', () => {
    const a = c.encrypt('secret', 'ctx')
    const parts = a.split('.')
    parts[3] = Buffer.from('tampered').toString('base64url')
    expect(() => c.decrypt(parts.join('.'), 'ctx')).toThrow()
    expect(() => createLocalCipher(randomBytes(32).toString('base64')).decrypt(a, 'ctx')).toThrow()
  })

  it('rejects keys that are not 32 bytes', () => {
    expect(() => createLocalCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
  })
})
