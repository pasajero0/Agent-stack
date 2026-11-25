export type StepRow = { step: string; sec: number; done: boolean }
export type TaskRow = {
  id: string
  ac: string[]
  tier: string
  desc: string
  done: boolean
  attempts: number
  checksFailed: boolean
  feedback: string
  notes: string[]
  model: string
  cost: number
  denials: string[]
  commit: string
  diff: string
}
export type CallRow = { n: number; step: string; cost: number; model: string; turns: number; denials: string[]; status: string; report: string }
export type Gate = {
  gate: string
  title: string
  question: string
  answers: string
  waitSec: number
}
export type Snap = {
  lang: string
  theme: string
  callRows: CallRow[]
  runId: string
  description: string
  evalTask: string
  nowLast: string
  checkCmds: string[]
  quickReviewLines: number
  checkTypicalSec: number
  checkResults: { cmd: string; exit: number; skipped: boolean }[]
  stage: string
  mode: string
  status: string
  step: string
  stepSec: number
  model: string
  workSec: number
  cost: number
  costUnknown: number
  preCost: Record<string, number>
  calls: number
  estimateSec: number
  ageSec: number
  steps: StepRow[]
  tasks: TaskRow[]
  actions: string[]
  gate: Gate | null
  findings: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'run-panel': { snap: Shaped<Snap | null> }
  }
}
