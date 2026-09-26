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
/** A non-JSON request body, e.g. a Drive multipart upload. */
export interface RawBody {
  contentType: string
  data: string
}

export async function googleApi<S extends z.ZodType>(
  ctx: ToolContext,
  capabilities: Capability[],
  url: string,
  opts: { method?: string; body?: unknown; raw?: RawBody; schema: S },
): Promise<z.infer<S>>
export async function googleApi(ctx: ToolContext, capabilities: Capability[], url: string, opts: { text: true }): Promise<string>
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
  opts: { method?: string; body?: unknown; raw?: RawBody; schema?: z.ZodType; text?: boolean },
): Promise<unknown> {
  const token = await ctx.services.credentials.accessToken(capabilities)
  const timeout = AbortSignal.timeout(15_000)
  const contentType = opts.raw?.contentType ?? (opts.body ? 'application/json' : undefined)
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
    ...(opts.raw ? { body: opts.raw.data } : opts.body ? { body: JSON.stringify(opts.body) } : {}),
    signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
  })
  // Exports (text/plain, text/csv) come back as text when they succeed; errors are always JSON.
  if (opts.text && res.ok) return res.text()
  const json = await checkGoogleResponse(ctx, capabilities, res)
  return opts.schema ? opts.schema.parse(json) : undefined
}

/**
 * The parsed JSON body of a successful response. Missing or revoked access becomes
 * NeedsConnectionError; a disabled API or any other failure becomes GoogleApiError.
 */
async function checkGoogleResponse(ctx: ToolContext, capabilities: Capability[], res: Response): Promise<unknown> {
  if (res.status === 401) throw new NeedsConnectionError(capabilities, 'revoked')
  const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined)
  if (res.status === 403 && JSON.stringify(json ?? '').includes('insufficient')) {
    throw new NeedsConnectionError(capabilities, 'missing_permission')
  }
  // The API itself is switched off in the Cloud project (e.g. the Docs API was never
  // enabled). Not the user's fault and not a permission they can grant: say so plainly.
  if (res.status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/.test(JSON.stringify(json ?? ''))) {
    const api = /(Google [A-Za-z ]+ API)/.exec(JSON.stringify(json))?.[1] ?? 'This Google API'
    ctx.logger.error({ status: 403, api }, 'google api disabled in the cloud project')
    throw new GoogleApiError(403, `${api} is not enabled in the app's Google Cloud project. Tell the user the admin needs to enable it; nothing was changed.`)
  }
  if (!res.ok) {
    const message = (json as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${res.status}`
    throw new GoogleApiError(res.status, `google api: ${message}`)
  }
  return json
}

/**
 * Uploads a file to the user's Drive (resumable upload: one request for the metadata, one
 * for the bytes, so files over Drive's 5 MB multipart limit work too).
 */
export async function googleUpload<S extends z.ZodType>(
  ctx: ToolContext,
  capabilities: Capability[],
  file: { name: string; mimeType: string; data: Uint8Array },
  opts: { fields: string; schema: S },
): Promise<z.infer<S>> {
  const token = await ctx.services.credentials.accessToken(capabilities)
  const signal = () => {
    const timeout = AbortSignal.timeout(60_000)
    return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  }
  const start = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(opts.fields)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': file.mimeType,
      'X-Upload-Content-Length': String(file.data.length),
    },
    body: JSON.stringify({ name: file.name, mimeType: file.mimeType }),
    signal: signal(),
  })
  const session = start.headers.get('location')
  if (!start.ok || !session) {
    await checkGoogleResponse(ctx, capabilities, start)
    throw new GoogleApiError(start.status, 'google api: upload session not started')
  }
  const res = await fetch(session, {
    method: 'PUT',
    headers: { 'Content-Type': file.mimeType },
    body: file.data,
    signal: signal(),
  })
  return opts.schema.parse(await checkGoogleResponse(ctx, capabilities, res))
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
