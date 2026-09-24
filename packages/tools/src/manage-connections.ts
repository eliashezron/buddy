import { CAPABILITIES, defineTool } from '@wa/core'
import { z } from 'zod'

export const manageConnections = defineTool({
  name: 'manage_connections',
  description:
    'Show which accounts the user has connected (and what access each allows), or disconnect one. Use when ' +
    'the user asks what you can access, or says "disconnect Google" / "remove access". Disconnecting revokes ' +
    'access at Google and deletes the stored keys. Only on the user\'s own request.',
  risk: 'low_write',
  input: z.object({
    action: z.enum(['list', 'disconnect']),
    provider: z.enum(['google']).optional().describe('Required for disconnect'),
  }),
  preview: ({ action, provider }) => (action === 'list' ? 'List connected accounts' : `Disconnect ${provider ?? 'account'}`),
  async execute({ action, provider }, ctx) {
    if (action === 'list') {
      const list = await ctx.services.connections.list()
      return {
        ok: true as const,
        connections: list.map((c) => ({
          provider: c.provider,
          account: c.account ?? null,
          access: c.capabilities.map((cap) => `${CAPABILITIES[cap].product}: ${CAPABILITIES[cap].label}`),
        })),
      }
    }
    if (!provider) return { ok: false as const, error: 'provider is required to disconnect' }
    const removed = await ctx.services.connections.disconnect(provider)
    return { ok: true as const, disconnected: removed, provider }
  },
})
