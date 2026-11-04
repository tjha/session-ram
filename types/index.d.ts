export type Row = {
  pid: number
  sessionId: string | null
  title: string
  /** The session process plus every process under it (lint, tsc, dev servers). */
  mb: number
  childMb: number
  /** null when the app did not say. */
  isWorking: boolean | null
  isSelf: boolean
}

export type View = {
  rows: Row[]
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
