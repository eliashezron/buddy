import type Anthropic from '@anthropic-ai/sdk'
import type { AnyTool } from '@wa/core'
import { calendarListEvents } from './calendar-list-events.js'
import { createCalendarEvent } from './create-calendar-event.js'
import { fetchPage } from './fetch-page.js'
import { gmailRead } from './gmail-read.js'
import { gmailSearch } from './gmail-search.js'
import { manageConnections } from './manage-connections.js'
import { undoLastAction } from './undo-last-action.js'
import { createWebSearchTool } from './web-search.js'

export { fetchPage, safeFetch, extractText, MAX_TEXT_CHARS } from './fetch-page.js'
export { assertFetchableUrl, BlockedUrlError, isPublicAddress } from './net-guard.js'
export { collectSearchOutput, createWebSearchTool, type Source } from './web-search.js'
export { calendarListEvents } from './calendar-list-events.js'
export { createCalendarEvent } from './create-calendar-event.js'
export { extractEmailText, gmailRead } from './gmail-read.js'
export { gmailSearch } from './gmail-search.js'
export { GoogleApiError } from './google-api.js'
export { manageConnections } from './manage-connections.js'
export { undoLastAction } from './undo-last-action.js'

export interface ToolDeps {
  anthropic: Anthropic
  searchModel: string
  /** Google connectors configured on this server (GOOGLE_CLIENT_ID set). */
  google?: boolean
}

/** Every tool available to the agent. One file per tool; each needs an eval in packages/agent/evals. */
export function createTools(deps: ToolDeps): AnyTool[] {
  const tools: AnyTool[] = [createWebSearchTool({ anthropic: deps.anthropic, model: deps.searchModel }), fetchPage, undoLastAction]
  if (deps.google) tools.push(calendarListEvents, createCalendarEvent, gmailSearch, gmailRead, manageConnections)
  return tools
}
