import { describe, expect, it } from 'vitest'
import { APPROVAL_TTL_MS, decide } from '../src/policy.js'

describe('policy gate', () => {
  it('runs reads immediately and low writes with undo', () => {
    expect(decide('read')).toEqual({ kind: 'run' })
    expect(decide('low_write').kind).toBe('run_with_undo')
  })

  it('always requires approval for outbound and money, expiring after 15 minutes', () => {
    expect(decide('outbound')).toEqual({ kind: 'needs_approval', approvalTtlMs: APPROVAL_TTL_MS })
    expect(decide('money')).toEqual({ kind: 'needs_approval', approvalTtlMs: 15 * 60_000 })
  })
})
