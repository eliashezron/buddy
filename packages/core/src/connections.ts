/**
 * Connectors: accounts a user links so tools can act for them. Access is requested
 * just in time: nothing is asked up front, and a tool that needs a permission the user
 * hasn't granted raises NeedsConnectionError. The system (never the model) then sends
 * a one-time link asking for exactly that permission.
 */

export type Provider = 'google'

/** What a tool needs, in terms a user understands. Mapped to OAuth scopes per provider. */
export type Capability = 'calendar.read' | 'calendar.write' | 'gmail.read' | 'gmail.compose' | 'drive.read' | 'drive.create' | 'docs.edit' | 'sheets.edit'

export const CAPABILITIES: Record<Capability, { provider: Provider; product: string; label: string }> = {
  'calendar.read': { provider: 'google', product: 'Google Calendar', label: 'see your calendar events' },
  'calendar.write': { provider: 'google', product: 'Google Calendar', label: 'add and remove events on your calendar' },
  'gmail.read': { provider: 'google', product: 'Gmail', label: 'read your email' },
  'gmail.compose': { provider: 'google', product: 'Gmail', label: 'save email drafts for you to review' },
  'drive.read': { provider: 'google', product: 'Google Drive', label: 'find and read your Docs, Sheets and Slides' },
  'drive.create': { provider: 'google', product: 'Google Drive', label: 'create Docs, Sheets and Slides for you' },
  'docs.edit': { provider: 'google', product: 'Google Docs', label: 'edit your Google Docs' },
  'sheets.edit': { provider: 'google', product: 'Google Sheets', label: 'edit your Google Sheets' },
}

export type ConnectionProblem = 'not_connected' | 'missing_permission' | 'revoked'

export class NeedsConnectionError extends Error {
  override name = 'NeedsConnectionError'
  constructor(
    readonly capabilities: Capability[],
    readonly problem: ConnectionProblem,
  ) {
    super(`needs ${capabilities.join(', ')} (${problem})`)
  }
}

/** Access tokens for the current user. Throws NeedsConnectionError when access is missing. */
export interface CredentialProvider {
  accessToken(capabilities: Capability[]): Promise<string>
}

export interface ConnectionSummary {
  provider: Provider
  account?: string
  capabilities: Capability[]
}

export interface ConnectionManager {
  list(): Promise<ConnectionSummary[]>
  /** Revokes access at the provider and deletes the stored tokens. */
  disconnect(provider: Provider): Promise<boolean>
}

export interface UndoService {
  /** Undoes the user's most recent undoable action if its undo window is still open. */
  undoLatest(): Promise<{ undone: true; description: string } | { undone: false; reason: string }>
}

/** Per-user services available to tools. */
export interface ToolServices {
  credentials: CredentialProvider
  connections: ConnectionManager
  undo: UndoService
}

/** For contexts with no connectors (tests, evals, servers without Google configured). */
export function noServices(): ToolServices {
  return {
    credentials: {
      async accessToken(capabilities) {
        throw new NeedsConnectionError(capabilities, 'not_connected')
      },
    },
    connections: { list: async () => [], disconnect: async () => false },
    undo: { undoLatest: async () => ({ undone: false, reason: 'nothing to undo' }) },
  }
}
