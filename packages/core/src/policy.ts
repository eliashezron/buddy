import type { Risk } from './tool.js'

export type PolicyDecision =
  | { kind: 'run' }
  | { kind: 'run_with_undo'; undoWindowMs: number }
  | { kind: 'needs_approval'; approvalTtlMs: number }

export const UNDO_WINDOW_MS = 10 * 60_000
export const APPROVAL_TTL_MS = 15 * 60_000

/**
 * The policy gate (CLAUDE.md, "Risk levels drive the policy gate").
 *
 * `outbound` and `money` always need a fresh approval from the user's own message,
 * no matter what the model or any content says. There is deliberately no input that
 * lets content-derived instructions skip this; approvals are recorded against an
 * `actions` row and checked by id, never inferred from text.
 */
export function decide(risk: Risk): PolicyDecision {
  switch (risk) {
    case 'read':
      return { kind: 'run' }
    case 'low_write':
      return { kind: 'run_with_undo', undoWindowMs: UNDO_WINDOW_MS }
    case 'outbound':
    case 'money':
      return { kind: 'needs_approval', approvalTtlMs: APPROVAL_TTL_MS }
  }
}
