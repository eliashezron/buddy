import type Anthropic from '@anthropic-ai/sdk'
import type { AnyTool } from '@wa/core'
import { fetchPage } from './fetch-page.js'
import { createWebSearchTool } from './web-search.js'

export { fetchPage, safeFetch, extractText, MAX_TEXT_CHARS } from './fetch-page.js'
export { assertFetchableUrl, BlockedUrlError, isPublicAddress } from './net-guard.js'
export { collectSearchOutput, createWebSearchTool, type Source } from './web-search.js'

export interface ToolDeps {
  anthropic: Anthropic
  searchModel: string
}

/** Every tool available to the agent. One file per tool; each needs an eval in packages/agent/evals. */
export function createTools(deps: ToolDeps): AnyTool[] {
  return [createWebSearchTool({ anthropic: deps.anthropic, model: deps.searchModel }), fetchPage]
}
