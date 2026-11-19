export type Row = {
  pid: number
  sessionId: string | null
  title: string
  /** The session process plus every process under it (lint, tsc, dev servers), and those that detached from it. */
  mb: number
  childMb: number
  /** null when the app did not say. */
  isWorking: boolean | null
  isSelf: boolean
  /** Auto stopped this session's turn for going over the limit; cleared once it is resumed. */
  isFlagged: boolean
}

export type View = {
  rows: Row[]
  /** Not in any loaded session's tree: what the app started (dev servers, MCP servers) and processes left by closed sessions. */
  otherMb: number
  /** The rows plus otherMb. */
  totalMb: number
  limitMb: number
  isAuto: boolean
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-ram': { view: Shaped<View> }
  }
}
