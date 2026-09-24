import { describe, expect, it } from 'vitest'
import { signBody, verifySignature } from '../src/signature.js'

const secret = 'app-secret'
const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}')

describe('verifySignature', () => {
  it('accepts a valid signature over the raw bytes', () => {
    expect(verifySignature(body, signBody(body, secret), secret)).toBe(true)
  })

  it('rejects a missing, malformed or wrong-prefix header', () => {
    expect(verifySignature(body, undefined, secret)).toBe(false)
    expect(verifySignature(body, 'sha1=abc', secret)).toBe(false)
    expect(verifySignature(body, 'sha256=nothex', secret)).toBe(false)
    expect(verifySignature(body, 'sha256=abcd', secret)).toBe(false)
  })

  it('rejects the wrong secret', () => {
    expect(verifySignature(body, signBody(body, 'other'), secret)).toBe(false)
  })

  it('rejects re-serialised JSON: verification must use the raw body', () => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2))
    expect(verifySignature(pretty, signBody(body, secret), secret)).toBe(false)
  })

  it('rejects a body modified after signing', () => {
    const tampered = Buffer.from(body.toString().replace('entry', 'entrx'))
    expect(verifySignature(tampered, signBody(body, secret), secret)).toBe(false)
  })
})
