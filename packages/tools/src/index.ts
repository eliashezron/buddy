import type Anthropic from '@anthropic-ai/sdk'
import type { AnyTool } from '@wa/core'
import { calendarListEvents } from './calendar-list-events.js'
import { cancelCalendarEvent } from './cancel-calendar-event.js'
import { createCalendarEvent } from './create-calendar-event.js'
import { createDocument } from './create-document.js'
import { createPresentation } from './create-presentation.js'
import { createSpreadsheet } from './create-spreadsheet.js'
import { deleteCalendarEvent } from './delete-calendar-event.js'
import { driveRead } from './drive-read.js'
import { editDocument } from './edit-document.js'
import { editPresentation } from './edit-presentation.js'
import { editSpreadsheet } from './edit-spreadsheet.js'
import { driveSearch } from './drive-search.js'
import { fetchPage } from './fetch-page.js'
import { gmailCreateDraft } from './gmail-create-draft.js'
import { gmailRead } from './gmail-read.js'
import { gmailSendEmail } from './gmail-send-email.js'
import { gmailSearch } from './gmail-search.js'
import { manageConnections } from './manage-connections.js'
import { sendCalendarInvite } from './send-calendar-invite.js'
import { shareFile } from './share-file.js'
import { undoLastAction } from './undo-last-action.js'
import { createWebSearchTool } from './web-search.js'

export { fetchPage, safeFetch, extractText, MAX_TEXT_CHARS } from './fetch-page.js'
export { assertFetchableUrl, BlockedUrlError, isPublicAddress } from './net-guard.js'
export { collectSearchOutput, createWebSearchTool, type Source } from './web-search.js'
export { calendarListEvents } from './calendar-list-events.js'
export { createCalendarEvent } from './create-calendar-event.js'
export { deleteCalendarEvent } from './delete-calendar-event.js'
export { createDocument, markdownToHtml, multipartBody } from './create-document.js'
export { cellValue, createSpreadsheet, userEnteredCell } from './create-spreadsheet.js'
export { createPresentation, slideRequests } from './create-presentation.js'
export { driveRead } from './drive-read.js'
export { editDocument } from './edit-document.js'
export { editPresentation } from './edit-presentation.js'
export { editSpreadsheet } from './edit-spreadsheet.js'
export { driveSearch } from './drive-search.js'
export { fileIdFrom } from './google-drive.js'
export { buildRawEmail, gmailCreateDraft } from './gmail-create-draft.js'
export { gmailSendEmail } from './gmail-send-email.js'
export { extractEmailText, gmailRead } from './gmail-read.js'
export { gmailSearch } from './gmail-search.js'
export { GoogleApiError } from './google-api.js'
export { manageConnections } from './manage-connections.js'
export { cancelCalendarEvent } from './cancel-calendar-event.js'
export { sendCalendarInvite } from './send-calendar-invite.js'
export { shareFile } from './share-file.js'
export { undoLastAction } from './undo-last-action.js'

export interface ToolDeps {
  anthropic: Anthropic
  searchModel: string
  /** Search through an OpenAI Responses endpoint (development provider) instead of Anthropic. */
  responsesSearch?: { apiKey: string; baseUrl: string; model: string }
  /** Google connectors configured on this server (GOOGLE_CLIENT_ID set). */
  google?: boolean
}

/** Every tool available to the agent. One file per tool; each needs an eval in packages/agent/evals. */
export function createTools(deps: ToolDeps): AnyTool[] {
  const tools: AnyTool[] = [createWebSearchTool({ anthropic: deps.anthropic, model: deps.searchModel, ...(deps.responsesSearch ? { responses: deps.responsesSearch } : {}) }), fetchPage, undoLastAction]
  if (deps.google) tools.push(
      calendarListEvents,
      createCalendarEvent,
      deleteCalendarEvent,
      sendCalendarInvite,
      cancelCalendarEvent,
      gmailSearch,
      gmailRead,
      gmailCreateDraft,
      gmailSendEmail,
      driveSearch,
      driveRead,
      createDocument,
      createSpreadsheet,
      createPresentation,
      editDocument,
      editSpreadsheet,
      editPresentation,
      shareFile,
      manageConnections,
    )
  return tools
}
