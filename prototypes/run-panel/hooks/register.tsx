import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { CallRow, Gate, Snap, StepRow, TaskRow } from '../types'

// Trial pane for agent-stack driver runs. Lives outside the repo; not part of any release.
// Ideas: sources/visualization-2026-11-25.md.
const PANE = 'run-panel'
const VIEW_HTML = '.claude/tmp/run-view.html'
const VIEW_DATA = '.claude/tmp/run-view.data.js'
let ROOT = ''
let GIT_CWD = ''
/** The repo root: the nearest folder up from the session cwd that holds .claude/gates.json. */
async function rootOf($: Engine): Promise<string> {
  if (ROOT) return ROOT
  let dir = await $.session.cwd()
  for (let i = 0; i < 12 && dir; i++) {
    if (await $.fs.exists(`${dir}/.claude/gates.json`)) return (ROOT = dir)
    const up = dir.replace(/\/[^/]+$/, '')
    if (up === dir) break
    dir = up
  }
  return (ROOT = await $.session.cwd())
}
const STALE_SEC = 60
const DEAD_SEC = 600
const snap = atom({ plugin: 'run-panel', key: 'snap' } as const, null, { shape: 'snap-5' })

// Theme: VS Code's colorTheme (or the OS when VS Code follows it), read-only; checked every 30 s.
let themeCache = { value: 'dark', at: 0 }
async function themeOf($: Engine, root: string): Promise<string> {
  if (Date.now() - themeCache.at < 30000) return themeCache.value
  let value = 'dark'
  try {
    const home = /^\/Users\/[^/]+/.exec(root)?.[0] ?? ''
    const settings = await $.fs.read(`${home}/Library/Application Support/Code/User/settings.json`)
    const follow = /"window\.autoDetectColorScheme"\s*:\s*true/.test(settings)
    if (follow) {
      const os = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 3000 })
      value = os.exitCode === 0 && /dark/i.test(os.stdout) ? 'dark' : 'light'
    } else {
      const name = /"workbench\.colorTheme"\s*:\s*"([^"]+)"/.exec(settings)?.[1] ?? 'Dark'
      value = /light|solarized light|quiet/i.test(name) && !/dark/i.test(name) ? 'light' : /dark|black|night|dimmed|monokai|dracula|high contrast/i.test(name) ? 'dark' : 'light'
    }
  } catch {
    value = 'dark'
  }
  themeCache = { value, at: Date.now() }
  return value
}

// Words of the pane. Gate keys, task ids, step names and glossary words are not translated.
const WORDS = {
  en: {
    needsYou: 'NEEDS YOU',
    answers: 'Answers',
    answerInChat: 'Answer in the chat: the operator shows the card.',
    questions: (n: number) => `${n} questions, the first:`,
    work: 'work',
    left: 'left ≈',
    calls: 'calls',
    noUpdate: 'no update for',
    longCommand: '(a long command or a hang)',
    stopped: 'the driver looks stopped',
    tasks: (d: number, n: number) => `${d} of ${n} tasks`,
    planTasks: 'Plan tasks',
    specRedone: (n: number) => `spec redone ${n}×`,
    head: ['#', 'Size', 'What it does', 'Model', 'Phase', 'Time', 'Cost', 'Diff'],
    done: 'done',
    attempt: 'attempt',
    denial: (n: number) => `${n} denied`,
    findings: 'Findings',
    retry: (id: string, n: number) => `${id} attempt ${n}`,
    denied: (n: number) => `${n} permission denials`,
    costly: (id: string, x: number) => `${id} costs ${x.toFixed(1)}× the median`,
    noRun: 'No driver run in .claude/tmp/runs yet.',
    toast: 'The driver needs you:',
  },
  ru: {
    needsYou: 'ЖДЁТ ТЕБЯ',
    answers: 'Ответы',
    answerInChat: 'Ответь в чате: карточку покажет оператор.',
    questions: (n: number) => `${n} вопросов, первый:`,
    work: 'работы',
    left: 'осталось ≈',
    calls: 'вызовов',
    noUpdate: 'нет обновлений',
    longCommand: '(долгая команда или зависание)',
    stopped: 'драйвер, похоже, остановлен',
    tasks: (d: number, n: number) => `${d} из ${n} задач`,
    planTasks: 'Задачи плана',
    specRedone: (n: number) => `spec переделан ${n}×`,
    head: ['#', 'Размер', 'Что делает', 'Модель', 'Фаза', 'Время', 'Цена', 'Дифф'],
    done: 'готово',
    attempt: 'попытка',
    denial: (n: number) => `${n} отказ${n === 1 ? '' : n < 5 ? 'а' : 'ов'}`,
    findings: 'Главное',
    retry: (id: string, n: number) => `${id} попытка ${n}`,
    denied: (n: number) => `${n} отказ${n === 1 ? '' : n < 5 ? 'а' : 'ов'} в правах`,
    costly: (id: string, x: number) => `${id} дороже медианы в ${x.toFixed(1)} раза`,
    noRun: 'Прогонов драйвера в .claude/tmp/runs пока нет.',
    toast: 'Драйвер ждёт тебя:',
  },
} as const
type Words = (typeof WORDS)['en'] | (typeof WORDS)['ru']
const wordsOf = (lang: string): Words => (lang === 'ru' ? WORDS.ru : WORDS.en)

type Json = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

function short(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const money = (usd: number): string => (usd > 0 ? `$${usd.toFixed(2)}` : '')

function modelOf(argv: unknown): string {
  const text = Array.isArray(argv) ? argv.map(String).join(' ') : str(argv)
  const m = /--model'?,?\s*'?([a-z0-9.-]+)/.exec(text)
  const e = /--effort'?,?\s*'?([a-z]+)/.exec(text)
  const model = m?.[1] ?? ''
  const effort = e?.[1] ?? ''
  return model && effort ? `${model} · ${effort}` : model
}

/** Action kind from a progress.log line ("· Read …"): icon and color. */
function kindOf(line: string): { icon: string; color: string } {
  const tool = /·\s*(\w+)/.exec(line)?.[1] ?? ''
  if (tool === 'Read') return { icon: '◇ read ', color: 'subtle' }
  if (tool === 'Edit' || tool === 'Write') return { icon: '✎ edit ', color: 'diffAdded' }
  if (tool === 'Bash') return { icon: '▷ run  ', color: 'warning' }
  if (tool === 'Grep' || tool === 'Glob') return { icon: '⌕ find ', color: 'suggestion' }
  return { icon: `· ${tool.toLowerCase().slice(0, 5).padEnd(5)}`, color: 'subtle' }
}

/** JSON of a file, or null when it is missing or half-written. */
async function readJson($: Engine, path: string): Promise<Json | null> {
  try {
    return obj(JSON.parse(await $.fs.read(path)))
  } catch {
    return null
  }
}

// A commit never changes, so its "+N −M" is read once.
const diffCache = new Map<string, string>()
async function diffOf($: Engine, sha: string): Promise<string> {
  if (!sha) return ''
  const known = diffCache.get(sha)
  if (known !== undefined) return known
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'show', '--shortstat', '--format=', sha], {
      cwd: GIT_CWD || ROOT || undefined,
      timeoutMs: 5000,
    })
    const plus = /(\d+) insertion/.exec(stdout)?.[1] ?? '0'
    const minus = /(\d+) deletion/.exec(stdout)?.[1] ?? '0'
    const text = exitCode === 0 ? `+${plus} −${minus}` : ''
    diffCache.set(sha, text)
    return text
  } catch {
    return ''
  }
}

function gateOf(run: Json, steps: StepRow[], w: Words): Gate | null {
  if (str(run.status) !== 'waiting') return null
  const card = obj(run.card)
  const prompts = arr(card.prompts).map(obj)
  const first = prompts[0] ?? {}
  const keys = arr(first.answers)
    .map(obj)
    .map(a => `${str(a.key) || 'Enter'} — ${str(a.label)}`)
  const open = [...steps].reverse().find(s => s.step.startsWith('gate:') && !s.done)
  return {
    gate: str(card.gate) ? `gate:${str(card.gate)}` : (open?.step ?? str(run.next)),
    title: str(card.title),
    question: prompts.length > 1 ? `${w.questions(prompts.length)} ${str(first.text)}` : str(first.text),
    answers: keys.join(' · '),
    waitSec: open?.sec ?? 0,
  }
}

const callCache = new Map<string, Call>()
type Call = { n: number; role: string; cost: number; model: string; turns: number; denials: string[]; status: string; report: string }

async function readCalls($: Engine, dir: string): Promise<Call[]> {
  let names: string[] = []
  try {
    names = (await $.fs.list(`${dir}/calls`)).map(f => f.name).filter(n => /^\d+-\w+\.json$/.test(n))
  } catch {
    return []
  }
  names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
  const calls: Call[] = []
  for (const n of names) {
    // A call file is written once, when the call ends: read it once (38 files were 4.6 MB a tick on effort1).
    const key = `${dir}/calls/${n}`
    const known = callCache.get(key)
    if (known) {
      calls.push(known)
      continue
    }
    const read = await readJson($, key)
    // Half-written: skip it this tick, read it whole next time.
    if (read === null) continue
    const d = read
    const result = obj(d.result)
    const denials = arr(result.permission_denials).map(raw => {
      const x = obj(raw)
      const input = obj(x.tool_input)
      return `${str(x.tool_name)} ${str(input.command) || str(input.file_path)}`.trim()
    })
    const so = obj(result.structured_output)
    // implement reports `status` + `report`; review reports `spec`, `quality`, `verifyProves` and `findings`.
    const findings = arr(so.findings).map(f => {
      const x = obj(f)
      return `${str(x.severity) || '·'}: ${str(x.text) || str(x.message) || str(x.issue) || JSON.stringify(x)}`
    })
    const report = str(so.report) || str(so.summary) || findings.join('\n') || str(result.result)
    const call: Call = {
      status: str(so.status) || [str(so.spec), str(so.quality)].filter(Boolean).join(' · '),
      report: report.slice(0, 6000),
      n: parseInt(n, 10),
      turns: num(result.num_turns),
      role: n.replace(/^\d+-/, '').replace(/\.json$/, ''),
      cost: num(result.total_cost_usd),
      model: modelOf(d.argv),
      denials,
    }
    callCache.set(key, call)
    calls.push(call)
  }
  return calls
}

/** The k-th call of a role belongs to the k-th step of that role (clarify, spec, plan, implement:T, review:T). */
function stepOfCalls(steps: StepRow[], calls: Call[]): Map<number, string> {
  const byRole = new Map<string, string[]>()
  for (const s of steps) {
    const role = s.step.split(':')[0] ?? ''
    if (s.step.startsWith('gate:') || ['checks', 'commit', 'base-check'].includes(role)) continue
    const list = byRole.get(role) ?? []
    list.push(s.step)
    byRole.set(role, list)
  }
  const used = new Map<string, number>()
  const out = new Map<number, string>()
  calls.forEach((c, i) => {
    const k = used.get(c.role) ?? 0
    const step = byRole.get(c.role)?.[k]
    used.set(c.role, k + 1)
    if (step) out.set(i, step)
  })
  return out
}


// Eval tries run `run quick` in a temp copy. A live one holds `.claude/tmp/runs/lock`; find it from the
// driver processes' working folders (old test leftovers have no lock).
let evalAt = 0
let evalDir = ''
async function liveEvalDir($: Engine): Promise<string> {
  if (Date.now() - evalAt < 4000) return evalDir
  evalAt = Date.now()
  evalDir = ''
  try {
    const { stdout } = await $.process.run(
      ['sh', '-c', 'for p in $(pgrep -f "bin/cli.mjs run"); do lsof -a -p $p -d cwd -Fn 2>/dev/null | grep "^n"; done'],
      { timeoutMs: 5000 },
    )
    for (const line of stdout.split('\n')) {
      const dir = line.slice(1).trim()
      if (dir.includes('agent-stack-eval-') && (await $.fs.exists(`${dir}/.claude/tmp/runs/lock`))) {
        evalDir = dir
        break
      }
    }
  } catch {
    evalDir = ''
  }
  return evalDir
}

// The eval task whose description the run has (evals/tasks/<id>/task.json), read once.
let evalTasks: Map<string, string> | null = null
async function evalTaskOf($: Engine, root: string, description: string): Promise<string> {
  if (!evalTasks) {
    evalTasks = new Map()
    try {
      for (const e of await $.fs.list(`${root}/evals/tasks`)) {
        if (e.kind !== 'dir') continue
        const t = await readJson($, `${root}/evals/tasks/${e.name}/task.json`)
        if (t) evalTasks.set(str(t.description), e.name)
      }
    } catch {
      evalTasks = new Map()
    }
  }
  return evalTasks.get(description) ?? ''
}

async function load($: Engine, last: Snap | null): Promise<Snap | null> {
  const repo = await rootOf($)
  const live = await liveEvalDir($)
  // A live eval try wins over the repo's last run; its gates.json and plan live in the temp copy.
  const root = live || repo
  const RUNS = `${root}/.claude/tmp/runs`
  GIT_CWD = root
  const gates = (await readJson($, `${repo}/.claude/gates.json`)) ?? {}
  const lang = str(obj(gates.language).chat) || 'en'
  const w = wordsOf(lang)
  if (!(await $.fs.exists(RUNS))) return null
  const dirs = (await $.fs.list(RUNS)).filter(d => d.kind === 'dir' && d.name.startsWith('r-'))
  const id = dirs.map(d => d.name).sort().at(-1)
  if (!id) return null
  const dir = `${RUNS}/${id}`
  const run = await readJson($, `${dir}/run.json`)
  // A half-written run.json: keep the last good frame (Backlog.md reconcile idea).
  if (run === null) return last && last.runId === id ? last : null
  const now = (await readJson($, `${dir}/now.json`)) ?? {}
  const stage = str(run.stage)
  const plan = stage ? ((await readJson($, `${root}/.claude/tmp/${stage}/tasks.json`)) ?? {}) : {}
  const nowMs = Date.now()

  const steps: StepRow[] = arr(run.steps).map(raw => {
    const s = obj(raw)
    const start = Date.parse(str(s.start))
    const end = s.end ? Date.parse(str(s.end)) : nowMs
    return { step: str(s.step), sec: (end - start) / 1000, done: Boolean(s.end) }
  })
  // The driver writes a step into run.json when it ends; the running one is only in now.json. Add it as open.
  const nowStep = str(now.step)
  const nowSince = Date.parse(str(now.since))
  const lastStep = steps[steps.length - 1]
  if (nowStep && Number.isFinite(nowSince) && str(run.status) === 'running' && !(lastStep && lastStep.step === nowStep && !lastStep.done)) {
    steps.push({ step: nowStep, sec: (nowMs - nowSince) / 1000, done: false })
  }
  const workSec = steps.filter(s => !s.step.startsWith('gate:')).reduce((a, s) => a + s.sec, 0)

  const calls = await readCalls($, dir)
  const callStep = stepOfCalls(steps, calls)
  const costByTask = new Map<string, number>()
  const denialsByTask = new Map<string, string[]>()
  const preCost: Record<string, number> = {}
  const modelByTask = new Map<string, string>()
  calls.forEach((c, i) => {
    const step = callStep.get(i) ?? c.role
    const [role, task] = step.split(':')
    if (task) {
      costByTask.set(task, (costByTask.get(task) ?? 0) + c.cost)
      denialsByTask.set(task, [...(denialsByTask.get(task) ?? []), ...c.denials])
      if (role === 'implement' && c.model) modelByTask.set(task, c.model)
    } else {
      preCost[role ?? c.role] = (preCost[role ?? c.role] ?? 0) + c.cost
    }
  })

  const callRows: CallRow[] = calls.map((c, i) => ({
    n: c.n,
    step: callStep.get(i) ?? c.role,
    cost: c.cost,
    model: c.model,
    turns: c.turns,
    denials: c.denials,
    status: c.status,
    report: c.report,
  }))

  const state = new Map(arr(run.tasks).map(raw => [str(obj(raw).id), obj(raw)] as const))
  const tasks: TaskRow[] = []
  const planTasks = arr(plan.tasks).length > 0 ? arr(plan.tasks) : arr(run.tasks).map(x => ({ id: str(obj(x).id), tier: '', desc: str(run.description), ac: [] }))
  for (const raw of planTasks) {
    const t = obj(raw)
    const tid = str(t.id)
    const st = state.get(tid) ?? {}
    const commit = str(st.commit)
    tasks.push({
      id: tid,
      ac: arr(t.ac).map(str),
      tier: str(t.tier),
      desc: str(t.desc),
      done: commit !== '',
      attempts: num(st.attempts),
      checksFailed: arr(st.checks).some(c => obj(c).skipped !== true && num(obj(c).exit) !== 0),
      feedback: str(st.lastFeedback).slice(0, 8000),
      notes: arr(st.notes).map(x => (typeof x === 'string' ? x : str(obj(x).text) || JSON.stringify(x))),
      // A call record exists only after the call ends; until then the planned model, from gates.json → routing.
      model: modelByTask.get(tid) ?? str(obj(obj(gates.routing)[str(t.tier)])[str(t.complexity)]).replace('·', ' · '),
      cost: costByTask.get(tid) ?? 0,
      denials: denialsByTask.get(tid) ?? [],
      commit,
      diff: await diffOf($, commit),
    })
  }

  let actions: string[] = []
  let ageSec = 0
  try {
    const log = `${dir}/progress.log`
    const st = await $.fs.stat(log)
    ageSec = (nowMs - st.mtimeMs) / 1000
    const offset = Math.max(0, st.size - 4096)
    const tail = await $.fs.read(log, { offset, length: st.size - offset })
    const current = str(now.step) || str(run.next)
    actions = tail
      .split('\n')
      .map(l => l.split('\t'))
      .filter(c => (c[1] ?? '') === current && (c[2] ?? '').trim().startsWith('·'))
      .map(c => c[2] ?? '')
      .slice(-6)
  } catch {
    actions = []
  }

  // Checks: the commands the driver runs (verify, then gates.json commands), their typical time, the last results.
  const commands = obj(gates.commands)
  const checkCmds = [stage ? '.claude/bin/verify <task>' : '', str(commands.test), str(commands.lint)].filter(c => c !== '')
  const checkSecs: number[] = []
  for (const d of dirs.map(x => x.name).sort().slice(-8)) {
    const other = d === id ? run : await readJson($, `${RUNS}/${d}/run.json`)
    for (const raw of arr(other?.steps)) {
      const x = obj(raw)
      if (/^checks:/.test(str(x.step)) && x.end) checkSecs.push((Date.parse(str(x.end)) - Date.parse(str(x.start))) / 1000)
    }
  }
  const slow = checkSecs.filter(x => x > 20).sort((a, b) => a - b)
  const checkTypicalSec = slow.length > 0 ? (slow[Math.floor((slow.length - 1) / 2)] ?? 0) : 0
  const stepTask = (str(now.step) || str(run.next)).split(':')[1] ?? ''
  const checkResults = arr(obj(state.get(stepTask) ?? (tasks[0] ? state.get(tasks[0].id) : undefined)).checks).map(raw => {
    const x = obj(raw)
    return { cmd: str(x.cmd), exit: num(x.exit), skipped: x.skipped === true }
  })

  // Findings, worst first (ThinkRail /insights idea).
  const findings: string[] = []
  for (const t of tasks) if (t.attempts > 1) findings.push(w.retry(t.id, t.attempts))
  const denied = tasks.reduce((a, t) => a + t.denials.length, 0)
  if (denied > 0) findings.push(w.denied(denied))
  const costs = tasks.filter(t => t.done && t.cost > 0).map(t => t.cost).sort((a, b) => a - b)
  const median = costs.length > 0 ? (costs[Math.floor((costs.length - 1) / 2)] ?? 0) : 0
  if (median > 0) {
    for (const t of tasks) if (t.cost > 3 * median) findings.push(w.costly(t.id, t.cost / median))
  }
  const specRuns = steps.filter(r => r.step === 'spec').length
  if (specRuns > 1) findings.push(w.specRedone(specRuns - 1))

  const step = str(now.step) || str(run.next)
  const since = Date.parse(str(now.since))
  const current = step.startsWith('implement:') ? (modelByTask.get(step.slice('implement:'.length)) ?? '') : ''
  return {
    lang,
    theme: await themeOf($, root),
    callRows,
    runId: id,
    description: str(run.description),
    evalTask: live ? (await evalTaskOf($, repo, str(run.description))) || 'eval' : '',
    checkCmds,
    quickReviewLines: num(obj(gates.run).quickReviewLines) || 120,
    checkTypicalSec,
    checkResults,
    nowLast: str(now.last),
    stage: stage || '',
    mode: str(run.mode),
    status: str(run.status),
    step,
    stepSec: Number.isFinite(since) ? (nowMs - since) / 1000 : 0,
    model: current,
    workSec,
    cost: num(run.costUsd),
    costUnknown: num(run.costUnknownCalls),
    preCost,
    calls: num(run.calls),
    estimateSec: num(run.estimateSec),
    ageSec,
    steps,
    tasks,
    actions,
    gate: gateOf(run, steps, w),
    findings,
  }
}

const SPIN = ['◐', '◓', '◑', '◒']

export const register: Register = on => {
  let lastStatus = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'run-panel', description: 'Show the latest agent-stack run in a pane' })
    await $.command.register({ name: 'run-view', description: 'Open the run dashboard in the VS Code integrated browser' })
    // Dashboard for the VS Code integrated browser: a fixed template plus a data file (sources/run-panel/README).
    try {
      const root = await rootOf($)
      const template = await $.fs.read(`${$.plugin.root}/assets/run-view.html`)
      const html = `${root}/${VIEW_HTML}`
      const current = (await $.fs.exists(html)) ? await $.fs.read(html) : ''
      if (current !== template) await $.fs.write(html, template)
    } catch (err) {
      $.ui.log(`run-panel: template: ${String(err)}`)
    }
    const tick = async (): Promise<void> => {
      try {
        const prev = await read($, snap)
        const s = await load($, prev)
        await update($, snap, () => s)
        if (s) {
          await $.fs.write(`${await rootOf($)}/${VIEW_DATA}`, `window.RUN = ${JSON.stringify(s)};\nwindow.RUN_WRITTEN_AT = ${Date.now()};\n`)
        }
        if (!s) return $.ui.status(undefined)
        const w = wordsOf(s.lang)
        // Toast once when the driver starts waiting for the human (ccmanager status hooks idea).
        if (s.status === 'waiting' && lastStatus !== 'waiting' && lastStatus !== '') {
          $.ui.toast(`${w.toast} ${s.gate?.gate ?? 'gate'}`)
        }
        lastStatus = s.status
        const done = s.tasks.filter(t => t.done).length
        if (s.status === 'waiting') {
          $.ui.status(`⏸ ${w.needsYou} · ${s.stage} · ${s.gate?.gate ?? ''}`)
        } else if (s.status === 'running') {
          $.ui.status(
            `${s.stage} · ${done}/${s.tasks.length} · ${s.step}${s.model ? ` · ${s.model}` : ''} · $${s.cost.toFixed(2)}`,
          )
        } else {
          $.ui.status(undefined)
        }
      } catch (err) {
        $.ui.log(`run-panel: ${String(err)}`)
      }
    }
    // Poll by state: running 2 s, waiting at a gate 5 s, finished or stopped 15 s, no run 30 s.
    const every = (status: string): number =>
      status === 'running' ? 2000 : status === 'waiting' ? 5000 : status === '' ? 30000 : 15000
    let lastAt = 0
    let busy = false
    void tick().then(() => (lastAt = Date.now()))
    $.clock.every(1000, () => {
      if (busy || Date.now() - lastAt < every(lastStatus)) return
      busy = true
      void tick().finally(() => {
        lastAt = Date.now()
        busy = false
      })
    })
    void $.ui.open({ id: PANE, title: 'Driver run' })
    return next(e)
  })

  // One command: hand the dashboard file to VS Code; since 1.134 a local .html opens in the integrated browser.
  on('command.run', { command: 'run-view' }, async $ => {
    const path = `${await rootOf($)}/${VIEW_HTML}`
    const { exitCode, stderr } = await $.process.run(['open', '-a', 'Visual Studio Code', path], { timeoutMs: 10000 })
    return {
      text:
        exitCode === 0
          ? `Opened ${VIEW_HTML} in VS Code. If it shows as text: right-click the tab → Open in Integrated Browser.`
          : `Could not open: ${stderr.trim()}. Open file://${path} with "Browser: Open Integrated Browser".`,
    }
  })

  on('command.run', { command: 'run-panel' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Driver run', focus: true })
    return { text: opened.isPlaced ? 'Run panel opened.' : `Run panel waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Progress } = $.ui.resolve(e)
    const s = await read($, snap)
    if (!s) return <Text dimColor>{WORDS.en.noRun}</Text>
    const w = wordsOf(s.lang)

    const spin = SPIN[Math.floor(Date.now() / 2000) % SPIN.length] ?? '◐'
    const done = s.tasks.filter(t => t.done).length
    const pre = s.steps.filter(r => !/^(implement|checks|review|commit):/.test(r.step))
    const specRuns = s.steps.filter(r => r.step === 'spec').length
    const stepsOf = (id: string): StepRow[] => s.steps.filter(r => r.step.endsWith(`:${id}`))
    const running = s.status === 'running'
    const stale = running && s.ageSec > STALE_SEC
    const dead = running && s.ageSec > DEAD_SEC
    const statusColor = running
      ? dead
        ? 'error'
        : 'claude'
      : s.status === 'waiting'
        ? 'warning'
        : s.status === 'finished'
          ? 'success'
          : 'error'
    const statusMark = running ? spin : s.status === 'waiting' ? '⏸' : s.status === 'finished' ? '●' : '✗'
    const left = s.estimateSec > 0 ? Math.max(0, s.estimateSec - s.workSec) : 0
    const cost = `$${s.cost.toFixed(2)}${s.costUnknown > 0 ? ` + ? (${s.costUnknown})` : ''}`
    const [hId, hSize, hWhat, hModel, hPhase, hTime, hCost, hDiff] = w.head

    return (
      <Box flexDirection="column">
        {s.gate && (
          <Box flexDirection="column" backgroundColor="warning" paddingX={1}>
            <Text bold color="inverseText">
              {`⏸ ${w.needsYou} · ${s.gate.gate} · ${mmss(s.gate.waitSec)}${s.gate.title ? ` · ${s.gate.title}` : ''}`}
            </Text>
            {s.gate.question !== '' && <Text color="inverseText">{short(s.gate.question, 160)}</Text>}
            {s.gate.answers !== '' && <Text color="inverseText">{`${w.answers}: ${s.gate.answers}`}</Text>}
            <Text color="inverseText">{w.answerInChat}</Text>
          </Box>
        )}
        <Text bold>
          {`${s.stage} · ${s.mode} · `}
          <Text color={statusColor}>{`${statusMark} ${s.status}`}</Text>
          {` · ${mmss(s.workSec)} ${w.work}${left > 0 ? ` · ${w.left} ${mmss(left)}` : ''} · ${cost} · ${s.calls} ${w.calls}`}
        </Text>
        {stale && (
          <Text color={dead ? 'error' : 'warning'}>
            {dead ? `✗ ${w.noUpdate} ${mmss(s.ageSec)}: ${w.stopped}` : `! ${w.noUpdate} ${mmss(s.ageSec)} ${w.longCommand}`}
          </Text>
        )}
        {s.findings.length > 0 && (
          <Text color="error">{`⚑ ${w.findings}: ${s.findings.join(' · ')}`}</Text>
        )}
        {s.tasks.length > 0 && (
          <Progress label={w.planTasks} value={done} max={s.tasks.length} valueText={w.tasks(done, s.tasks.length)} color="success" />
        )}
        <Text dimColor>
          {pre
            .map(r => {
              const c = r.step.startsWith('gate:') ? '' : money(s.preCost[r.step] ?? 0)
              return `${r.done ? '✓' : '▶'} ${r.step} ${mmss(r.sec)}${c ? ` ${c}` : ''}`
            })
            .join('   ') + (specRuns > 1 ? `   (${w.specRedone(specRuns - 1)})` : '')}
        </Text>
        <Text> </Text>
        <Text bold>
          {`  ${(hId ?? '').padEnd(4)} ${(hSize ?? '').padEnd(6)}  ${(hWhat ?? '').padEnd(46)} ${(hModel ?? '').padEnd(15)} ${(hPhase ?? '').padEnd(9)} ${(hTime ?? '').padEnd(6)} ${(hCost ?? '').padEnd(6)} ${hDiff ?? ''}`}
        </Text>
        {s.tasks.map(t => {
          const rows = stepsOf(t.id)
          const sec = rows.reduce((a, r) => a + r.sec, 0)
          const active = s.step.endsWith(`:${t.id}`)
          const phase = active ? (s.step.split(':')[0] ?? '') : t.done ? w.done : ''
          const retried = t.attempts > 1
          const mark = t.done ? '●' : active ? spin : '○'
          const color = retried && !t.done ? 'error' : t.done ? 'success' : active ? 'claude' : 'inactive'
          const line = `${mark} ${t.id.padEnd(4)} ${t.tier.padEnd(6)}  ${short(t.desc, 46).padEnd(46)} ${(t.model || '—').padEnd(15)} ${phase.padEnd(9)} ${(rows.length > 0 ? mmss(sec) : '').padEnd(6)} ${money(t.cost).padEnd(6)} ${t.diff}`
          return (
            <Text>
              <Text color={color} bold={active}>
                {line}
              </Text>
              {retried && <Text color="error">{`  ↻ ${w.attempt} ${t.attempts}`}</Text>}
              {t.denials.length > 0 && <Text color="error">{`  ⚠ ${w.denial(t.denials.length)}`}</Text>}
            </Text>
          )
        })}
        {s.tasks
          .filter(t => t.denials.length > 0)
          .map(t => (
            <Text color="error" dimColor>{`    ${t.id} ⚠ ${short(t.denials.join(' | '), 110)}`}</Text>
          ))}
        <Text> </Text>
        {running && <Text bold>{`${spin} ${s.step} ${mmss(s.stepSec)}${s.model ? ` · ${s.model}` : ''}`}</Text>}
        {s.actions.map(a => {
          const k = kindOf(a)
          return (
            <Text>
              <Text color={k.color}>{k.icon}</Text>
              <Text dimColor>{short(a.replace(/^\s*·\s*\w+\s*/, ''), 100)}</Text>
            </Text>
          )
        })}
      </Box>
    )
  })
}
