import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { createLogger } from '@wa/core'
import { collectSearchOutput, createWebSearchTool } from '../src/web-search.js'

type Block = Anthropic.Beta.Messages.BetaContentBlock

const blocks = [
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [
      { type: 'web_search_result', title: 'Rate A', url: 'https://a.example', encrypted_content: 'x', page_age: null },
      { type: 'web_search_result', title: 'Rate B', url: 'https://b.example', encrypted_content: 'x', page_age: null },
    ],
  },
  {
    type: 'text',
    text: '1 USD ≈ 3,700 UGX.',
    citations: [{ type: 'web_search_result_location', url: 'https://b.example', title: 'Rate B', cited_text: '', encrypted_index: '' }],
  },
] as unknown as Block[]

describe('collectSearchOutput', () => {
  it('joins text and lists cited sources first', () => {
    const out = collectSearchOutput(blocks)
    expect(out.summary).toBe('1 USD ≈ 3,700 UGX.')
    expect(out.sources.map((s) => s.url)).toEqual(['https://a.example', 'https://b.example'])
  })

  it('tolerates error results, which are objects not lists', () => {
    const err = [{ type: 'web_search_tool_result', tool_use_id: 's', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }] as unknown as Block[]
    expect(collectSearchOutput(err)).toEqual({ summary: '', sources: [] })
  })
})

describe('web_search tool', () => {
  it('uses the server-side web search tool and resumes on pause_turn', async () => {
    const requests: unknown[] = []
    const responses = [
      { stop_reason: 'pause_turn', content: [] },
      { stop_reason: 'end_turn', content: blocks },
    ]
    const anthropic = {
      beta: { messages: { create: async (p: unknown) => (requests.push(structuredClone(p)), responses.shift()) } },
    } as unknown as Anthropic
    const tool = createWebSearchTool({ anthropic, model: 'claude-sonnet-5' })
    const out = await tool.execute(
      { query: 'usd to ugx' },
      { userId: 'u', runId: 'r', actionId: 'a', timezone: 'Africa/Kampala', now: new Date('2026-09-24T09:00:00Z'), logger: createLogger({ name: 't', level: 'silent' }) },
    )
    expect(out).toMatchObject({ ok: true, summary: '1 USD ≈ 3,700 UGX.' })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ model: 'claude-sonnet-5', tools: [{ type: 'web_search_20260209', name: 'web_search' }] })
  })
})
