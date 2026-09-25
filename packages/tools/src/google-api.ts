import { NeedsConnectionError, type Capability, type ToolContext } from '@wa/core'
import type { z } from 'zod'

export class GoogleApiError extends Error {
  override name = 'GoogleApiError'
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Calls a Google API as the current user. Missing or revoked access becomes
 * NeedsConnectionError, which the agent loop turns into a just-in-time connect link.
 */
export async function googleApi<S extends z.ZodType>(
  ctx: ToolContext,
  capabilities: Capability[],
  url: string,
  opts: { method?: string; body?: unknown; schema: S },
): Promise<z.infer<S>>
export async function googleApi(
  ctx: ToolContext,
  capabilities: Capability[],
  url: string,
  opts: { method: string; body?: unknown },
): Promise<void>
export async function googleApi(
  ctx: ToolContext,
  capabilities: Capability[],
  url: string,
  opts: { method?: string; body?: unknown; schema?: z.ZodType },
): Promise<unknown> {
  const token = await ctx.services.credentials.accessToken(capabilities)
  const timeout = AbortSignal.timeout(15_000)
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
  })
  if (res.status === 401) throw new NeedsConnectionError(capabilities, 'revoked')
  const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined)
  if (res.status === 403 && JSON.stringify(json ?? '').includes('insufficient')) {
    throw new NeedsConnectionError(capabilities, 'missing_permission')
  }
  if (!res.ok) {
    const message = (json as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${res.status}`
    throw new GoogleApiError(res.status, `google api: ${message}`)
  }
  return opts.schema ? opts.schema.parse(json) : undefined
}

/** "Fri 25 Sep, 10:00" in the user's timezone, so the model doesn't convert times itself. */
export function formatLocal(iso: string, timeZone: string, allDay = false): string {
  const d = new Date(iso)
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: allDay ? 'UTC' : timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(allDay ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }),
  }).format(d)
}

/** ISO 8601 with an explicit offset, e.g. 2026-09-25T10:00:00+03:00. */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
