import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { CAPABILITIES, type ConnectionEvent } from '@wa/core'
import { completeAuthorization, hashToken, startAuthorization, type GoogleConnectorDeps } from '@wa/connectors'

export interface OAuthRouteOptions {
  google: GoogleConnectorDeps
  enqueue: (events: ConnectionEvent[]) => Promise<void>
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Tiny self-contained page: no scripts, no external resources, no caching, no referrer. */
function page(reply: FastifyReply, status: number, title: string, body: string) {
  return reply
    .code(status)
    .headers({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escape(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;` +
        `color:#1a1a1a;line-height:1.5}h1{font-size:1.4rem}p{color:#444}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#bbb}}</style>` +
        `</head><body><h1>${escape(title)}</h1><p>${body}</p></body></html>`,
    )
}

export const oauthRoutes: FastifyPluginAsync<OAuthRouteOptions> = async (app, opts) => {
  // The chat link lands here; we check it is live, then send the user to Google.
  app.get<{ Querystring: { s?: string } }>('/oauth/google/start', async (req, reply) => {
    const url = req.query.s ? await startAuthorization(opts.google, req.query.s) : null
    if (!url) {
      return page(reply, 410, 'This link has expired', 'Connect links work once and expire after 15 minutes. Ask the assistant again for a new one.')
    }
    // no-referrer keeps the link token out of Google's logs.
    return reply.code(302).headers({ location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).send()
  })

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>('/oauth/google/callback', async (req, reply) => {
    const outcome = await completeAuthorization(opts.google, req.query)
    if (outcome.kind === 'invalid') {
      return page(reply, 410, 'This link has already been used', 'Ask the assistant again if you still want to connect.')
    }
    const event: ConnectionEvent = {
      kind: 'connection',
      id: hashToken(req.query.state ?? ''),
      outcome: outcome.kind,
      userId: outcome.userId,
      triggerMessageId: outcome.triggerMessageId,
      requested: outcome.requested,
      missing: outcome.kind === 'connected' ? outcome.missing : [],
      account: outcome.kind === 'connected' ? outcome.account : null,
    }
    await opts.enqueue([event])
    req.log.info({ outcome: outcome.kind }, 'google authorization finished')

    if (outcome.kind === 'denied') return page(reply, 200, 'Nothing was connected', 'You can close this page and go back to the chat.')
    if (outcome.kind === 'failed') return page(reply, 502, 'Something went wrong', 'Please go back to the chat and ask again for a new link.')
    const what = [...new Set(outcome.requested.map((c) => CAPABILITIES[c].product))].join(' and ')
    const who = outcome.account ? ` for ${escape(outcome.account)}` : ''
    return page(reply, 200, `${escape(what)} connected`, `Connected${who}. You can close this page and go back to the chat; the assistant will carry on.`)
  })
}
