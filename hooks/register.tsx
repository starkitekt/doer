// SPDX-License-Identifier: MIT
// Copyright (c) 2026 starkitekt. Doer: live-checklist mod, https://github.com/starkitekt/doer
// Keep this notice in all copies and derived works (MIT License, see LICENSE).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentModels, Entry, Git, Item, List, Meter, Progress, Spawn, Status, Sync, Tier } from '../types'

const list = atom({ plugin: 'live-checklist', key: 'list' } as const, null)
const isOpen = atom({ plugin: 'live-checklist', key: 'isOpen' } as const, true)
const meter = atom({ plugin: 'live-checklist', key: 'meter' } as const, { tokens: 0, model: '' } as Meter)
const git = atom({ plugin: 'live-checklist', key: 'git' } as const, null as Git | null)
const sync = atom({ plugin: 'live-checklist', key: 'sync' } as const, null as Sync | null)
const progress = atom({ plugin: 'live-checklist', key: 'progress' } as const, null as Progress | null)
const agentModels = atom({ plugin: 'live-checklist', key: 'agentModels' } as const, {} as AgentModels)
const run = atom({ plugin: 'live-checklist', key: 'run' } as const, null as Entry | null)

// The repo's one most urgent state, in this order: conflicts, checks failing, checks running,
// unpushed commits, changed files, no remote, else clean. 'No repo' outside a git repo. Read-only: it runs
// git status and, once the last commit is pushed, gh for its CI runs (skipped if gh is missing).
type Run = (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string }>
const readGit = async (run: Run): Promise<Git | null> => {
  const st = await run(['git', 'status', '--porcelain=v2', '--branch'], 5000)
  if (st.exitCode !== 0) return { label: 'No repo', tone: 'quiet' }
  let branch = ''
  let sha = ''
  let ahead = 0
  let hasUpstream = false
  let changed = 0
  let conflicts = 0
  for (const line of st.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) sha = line.slice(13).trim()
    else if (line.startsWith('# branch.upstream ')) hasUpstream = true
    else if (line.startsWith('# branch.ab ')) ahead = Math.abs(parseInt(line.slice(12), 10)) || 0
    else if (line.startsWith('u ')) conflicts++
    else if (/^[12?] /.test(line)) changed++
  }
  const where = branch === '(detached)' || !branch ? sha.slice(0, 7) || 'git' : branch
  const say = (state: string, tone: Git['tone']): Git => ({ label: `${where} · ${state}`, tone })
  if (conflicts) return say('Conflicts', 'alert')
  // CI only knows commits that are pushed.
  if (hasUpstream && ahead === 0 && /^[0-9a-f]{40}$/.test(sha)) {
    try {
      const ci = await run(['gh', 'run', 'list', '--commit', sha, '--json', 'status,conclusion', '--limit', '30'], 8000)
      if (ci.exitCode === 0) {
        const runs = JSON.parse(ci.stdout) as { status?: string; conclusion?: string }[]
        if (runs.some(r => r.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion ?? '')))
          return say('Checks failing', 'alert')
        if (runs.some(r => r.status !== 'completed')) return say('Checks running', 'quiet')
      }
    } catch {
      // No gh, not signed in, or no network: the chip goes on without CI.
    }
  }
  if (ahead) return say(`${ahead} unpushed`, 'quiet')
  if (changed) return say(`${changed} changed`, 'quiet')
  // A repo with no remote has nowhere to push to: say so instead of 'clean'.
  if (!hasUpstream) {
    const rm = await run(['git', 'remote'], 5000).catch(() => undefined)
    if (rm?.exitCode === 0 && !rm.stdout.trim()) return say('no remote', 'quiet')
  }
  return say('clean', 'ok')
}

// 'claude-opus-5-5' -> 'Opus'. Anything unrecognised is kept, cut to 8 characters.
const shortModel = (m: string) => {
  const hit = /opus|sonnet|haiku|fable/i.exec(m)
  if (hit) return hit[0].charAt(0).toUpperCase() + hit[0].slice(1).toLowerCase()
  return m.trim().slice(0, 8)
}
const fmtTok = (n: number) =>
  n < 1000 ? String(n) : n < 1e6 ? `${+(n / 1e3).toFixed(1)}k` : `${+(n / 1e6).toFixed(1)}M`
const fmtTime = (ms: number) => {
  const m = ms / 60000
  return m < 1 ? '<1m' : m < 60 ? `${Math.round(m)}m` : `${+(m / 60).toFixed(1)}h`
}
const stats = (i: Item) =>
  i.status === 'done' && i.tokens !== undefined && i.ms !== undefined ? `${fmtTok(i.tokens)} T / ${fmtTime(i.ms)}` : ''
// The whole list so far: time and tokens of every done step added up. Empty until one is done.
const runTotal = (items: Item[]) => {
  const done = items.filter(i => i.status === 'done' && i.tokens !== undefined && i.ms !== undefined)
  if (!done.length) return ''
  const sum = (f: (i: Item) => number) => done.reduce((n, i) => n + f(i), 0)
  return `${fmtTime(sum(i => i.ms ?? 0))} · ${fmtTok(sum(i => i.tokens ?? 0))} T`
}

const STATUSES: Status[] = ['done', 'active', 'pending', 'wait']
// A string (or finite number) as one trimmed line, capped; anything else is ''.
const oneLine = (v: unknown, max: number) =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : ''

// The band explains: each row is a problem the person would notice, and under it the fix in plain words.
// It is its own layer, never a copy of a task list.
const WORDING = [
  'Draw it with your first tool call of any multi-step task, in the same message, and update it as each step starts or finishes; do not skip it because another task list is shown. Each step is a problem and its fix. text: the problem as the person would notice it, in plain everyday words, under 8 words',
  "(e.g. 'Login sometimes fails'). fix: how it gets solved, one plain sentence anyone could follow, under 16 words",
  "(e.g. 'Retry the sign-in once before showing an error'). No code names, file names, tool names or jargon in either.",
  'Never copy steps from any other task list or plan into it: that list says what you do; this one explains what is wrong and how it gets fixed.',
].join(' ')

const DESCRIPTION = [
  'Shows the person a problem-and-fix explainer above their prompt. Call it at the start of every multi-step task,',
  'and again whenever a step starts or finishes, sending the whole list each time.',
  WORDING,
  'title: the overall problem in 3-6 plain words. status: done, active (being worked on now), pending, or wait (waiting on the person).',
  'model: which model runs the step (Opus, Sonnet, Haiku); left out, the session model. Tokens and time are measured for you.',
  'Send an empty items list to clear it.',
].join(' ')

const PROMPT_SECTION = {
  id: 'live-checklist:explainer',
  text: `# Problem and fix explainer\nThe live-checklist set tool draws a band above the prompt that explains the work to the person. ${WORDING}`,
  scope: 'session',
} as const
const SET_TOOL = 'mcp__live-checklist__set'

// Colours per theme. Text and green sit as light as they can while still at least 5:1:
// light on the app's grey tray (#F0F0EF), dark on #1F1E1D, #262624 and #30302E.
// The header and task text use the app's own 'text' colour, so they match the chat in every theme;
// grey is for the model column, stats and notes. ring: the active spinner. open: the to-do circles, one solid grey in every theme (1.6:1 on the tray, so it reads without competing with text).
// 'mid' is for a theme the band cannot tell; its green is the best balance for both (3.85:1).
type Palette = { accent: string; tick: string; grey: string; ring: string; open: string; fill: string; ink: string }
const PALETTES: Record<'light' | 'dark' | 'mid', Palette> = {
  light: { accent: '#127338', tick: '#FFFFFF', grey: '#62656B', ring: '#5F6672', open: '#BEC1C7', fill: '#BEC1C7', ink: '#62656B' },
  dark: { accent: '#2DB65F', tick: '#1F1E1D', grey: '#9F9FA3', ring: '#80808A', open: '#BEC1C7', fill: '#BEC1C7', ink: '#9F9FA3' },
  mid: { accent: '#1F934A', tick: '#FFFFFF', grey: '#8A9099', ring: '#8A9099', open: '#BEC1C7', fill: '#BEC1C7', ink: '#8A9099' },
}

// Rows are the app's own Text, so they take the person's interface font and size (body is 14 px
// at 100%, on a 20 px line with its baseline at 16). Circles are 0.72 of that: 10.08 px across,
// drawn in a 12 x 20 box the row centres on the line, bottom edge on the baseline.
// Svg sizes are CSS pixels, so they follow the app's zoom with the text.
const BOX = 12
const LINE = 20
const BASE = 16
const D = 10.08
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${BOX}" height="${LINE}" viewBox="0 0 ${BOX} ${LINE}"><g transform="translate(0 ${BASE - D / 2 - BOX / 2})">${body}</g></svg>`

// done: green disc with a tick. active: four grey arcs turning once every 6 s over a 10% green fill
// (r 4.48, circumference 28.15 = 4 x 7.04). pending / wait: a plain filled circle.
const glyphs = (p: Palette): Record<Status, string> => {
  const c = BOX / 2
  const clear = svg(`<circle cx="${c}" cy="${c}" r="${D / 2 - 0.5}" fill="${p.fill}" stroke="${p.open}" stroke-width="1"/>`)
  return {
    done: svg(`<circle cx="${c}" cy="${c}" r="${D / 2}" fill="${p.accent}"/><path d="M3.72 6.12l1.56 1.56 3-3.16" fill="none" stroke="${p.tick}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`),
    active: svg(`<circle cx="${c}" cy="${c}" r="${D / 2}" fill="${p.accent}" fill-opacity="0.1"/><circle cx="${c}" cy="${c}" r="4.48" fill="none" stroke="${p.ring}" stroke-width="1.2" stroke-dasharray="4.1 2.94" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="6s" repeatCount="indefinite"/></circle>`),
    pending: clear,
    wait: clear,
  }
}
const GLYPHS = { light: glyphs(PALETTES.light), dark: glyphs(PALETTES.dark), mid: glyphs(PALETTES.mid) }

// The active step shows a pixel fill bar for the whole task (finished steps plus the running step's share): a pixel
// hourglass whose sand falls from the top bulb to the bottom (then it turns over), 21 blocks, and the number.
// 18 + 6 + 84 + 6 + 34 = 148 px.
const BAR_W = 148
const FULL_MS = 5000 // how long a finished task keeps its full bar
const TRACK_X = 24
const SEGS = 21
const PX = 2
const GLASS = ['#########', '.#.....#.', '..#...#..', '...#.#...', '....#....', '...#.#...', '..#...#..', '.#.....#.', '#########']
// Sand rows [row, first col, last col] in the bulbs; the top drains from its surface down, the bottom fills from its floor up.
const SAND_TOP: [number, number, number][] = [[1, 2, 6], [2, 3, 5], [3, 4, 4]]
const SAND_BOT: [number, number, number][] = [[7, 2, 6], [6, 3, 5], [5, 4, 4]]
const px = (c: number, r: number, w: number, fill: string) => `<rect x="${c * PX}" y="${r * PX + 1}" width="${w * PX}" height="${PX}" fill="${fill}"/>`
const fade = (on: boolean, t: number) =>
  `<animate attributeName="opacity" calcMode="discrete" values="${on ? '1;0;0' : '0;1;1'}" keyTimes="0;${t};1" dur="4s" repeatCount="indefinite"/>`
const bar = (p: Palette, pct: number) => {
  const glass = GLASS.flatMap((row, r) => [...row].flatMap((ch, c) => (ch === '#' ? [px(c, r, 1, p.ring)] : []))).join('')
  const top = SAND_TOP.map(([r, a, b], i) => `<g>${px(a, r, b - a + 1, p.accent)}${fade(true, 0.3 + i * 0.22)}</g>`).join('')
  const bot = SAND_BOT.map(([r, a, b], i) => `<g opacity="0">${px(a, r, b - a + 1, p.accent)}${fade(false, 0.3 + i * 0.22)}</g>`).join('')
  const stream = `<g>${px(4, 4, 1, p.accent)}<animate attributeName="opacity" calcMode="discrete" values="1;0;1;0;1;0" keyTimes="0;0.15;0.3;0.45;0.6;0.78" dur="4s" repeatCount="indefinite"/></g>`
  const turn = `<animateTransform attributeName="transform" type="rotate" calcMode="discrete" values="0 9 10;90 9 10;180 9 10" keyTimes="0;0.88;0.94" dur="4s" repeatCount="indefinite"/>`
  const lit = Math.min(SEGS, Math.max(pct > 0 ? 1 : 0, Math.round((SEGS * pct) / 100)))
  const blocks = Array.from({ length: SEGS }, (_, i) => {
    const x = TRACK_X + i * 4
    return `<rect x="${x}" y="7" width="3" height="6" fill="${i < lit ? p.accent : p.fill}"${i < lit ? '' : ' fill-opacity="0.55"'}/>`
  }).join('')
  const next = lit < SEGS
    ? `<rect x="${TRACK_X + lit * 4}" y="7" width="3" height="6" fill="${p.accent}" opacity="0"><animate attributeName="opacity" calcMode="discrete" values="0;1" keyTimes="0;0.5" dur="1s" repeatCount="indefinite"/></rect>`
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${LINE}" viewBox="0 0 ${BAR_W} ${LINE}" shape-rendering="crispEdges">` +
    `<g>${glass}${top}${bot}${stream}${turn}</g>${blocks}${next}` +
    `<text x="${TRACK_X + SEGS * 4 + 6}" y="${BASE - 1}" font-family="ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace" font-size="12" fill="${p.grey}">${pct}%</text></svg>`
  )
}

const ALT: Record<Status, string> = { done: 'Done', active: 'In progress', pending: 'Not started', wait: 'Waiting on you' }
const TEXT_MARK: Record<Status, string> = { done: '✓', active: '◌', pending: '○', wait: '○' }

// Re-read the git chip in the background, one read at a time, so a turn never waits on git or gh.
// A request that arrives mid-read is not dropped: it queues one more read, so the chip never stays
// on a state from before the latest change. A read that hangs is abandoned after 20 s, so the chip
// can never lock up for the rest of the session.
let reading = false
let again = false
function refreshGit($: EngineInterface) {
  if (reading) {
    again = true
    return
  }
  reading = true
  const run: Run = (argv, timeoutMs) => $.process.run(argv, { timeoutMs })
  const cap = $.clock.sleep(20000).then(() => undefined)
  void Promise.race([readGit(run).catch(() => null), cap])
    .then(g => (g === undefined ? undefined : update($, git, () => g)))
    .catch(() => undefined)
    .finally(() => {
      reading = false
      if (again) {
        again = false
        refreshGit($)
      }
    })
}

// The sync counter: an auto-sync script writes "<pushed> <failed> <ok|fail>" to
// ~/.claude/autosync.count. Checked every few seconds (a stat, read only when it changed),
// since the script runs after the turn ends. No file, no counter.
let syncPath = ''
let syncSeen = -1
let syncTimer: { cancel: () => void } | undefined
async function refreshSync($: EngineInterface) {
  if (!syncPath) {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (!home) return
    syncPath = `${home}/.claude/autosync.count`
  }
  const st = await $.fs.stat(syncPath).catch(() => undefined)
  const mtime = st?.mtimeMs ?? 0
  if (mtime === syncSeen) return
  syncSeen = mtime
  let s: Sync | null = null
  if (st) {
    const [a = '', b = '', c] = String(await $.fs.read(syncPath)).trim().split(/\s+/)
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) s = { pushed: Number(a), failed: Number(b), lastFailed: c === 'fail' }
  }
  await update($, sync, () => s)
}

// The progress file: a long job writes "<done> <total>" to ~/.claude/progress.count. Checked with
// the sync counter; ignored once it is 15 minutes old, so a finished job's number never lingers.
let progPath = ''
let progSeen = ''
async function refreshProgress($: EngineInterface) {
  if (!progPath) {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (!home) return
    progPath = `${home}/.claude/progress.count`
  }
  const st = await $.fs.stat(progPath).catch(() => undefined)
  let p: Progress | null = null
  if (st && (await $.clock.now()) - st.mtimeMs <= 15 * 60_000) {
    const [a = '', b = ''] = String(await $.fs.read(progPath)).trim().split(/\s+/)
    const done = Number(a)
    const total = Number(b)
    if (/^\d+$/.test(a) && /^\d+$/.test(b) && total > 0) p = { done: Math.min(done, total), total }
  }
  const key = p ? `${p.done}/${p.total}` : ''
  if (key === progSeen) return
  progSeen = key
  await update($, progress, () => p)
}

// Build and store the band's list from a set call. Each step keeps its model, fix and
// timing from the last update where it is the same step. Returns the list, or null when it is empty.
async function applyList($: EngineInterface, rawTitle: unknown, raw: unknown[], source: List['source']): Promise<List | null> {
  const now = await $.clock.now()
  const m = (await read($, meter)) ?? { tokens: 0, model: '' }
  const prev = await read($, list)
  const before = prev?.items ?? []
  const title = oneLine(rawTitle, 120) || 'Tasks'
  // Steps with no usable text are dropped, so a bad payload never draws a blank row.
  const clean = raw
    .filter((i): i is { text: unknown; status: unknown; model?: unknown; fix?: unknown } => typeof i === 'object' && i !== null)
    .map(i => ({ ...i, text: oneLine(i.text, 200) }))
    .filter(i => i.text)
  const texts = new Set(clean.map(i => i.text))
  const used = new Set<number>()
  // The same step from the last update, each one claimed once: same text at the same place, else
  // the same text anywhere, else (same list, renamed step) whatever sat at that place, if its text is gone.
  const claim = (text: string, n: number) => {
    const free = (k: number) => k >= 0 && k < before.length && !used.has(k)
    let k = free(n) && before[n]?.text === text ? n : before.findIndex((b, j) => free(j) && b.text === text)
    if (k < 0 && prev?.title === title && free(n) && !texts.has(before[n]?.text ?? '')) k = n
    // The mod's own opening row (drawn at prompt submit) hands its clock and tokens to Claude's first step.
    if (k < 0 && prev?.source === 'auto' && n === 0 && free(0)) k = 0
    if (k < 0) return undefined
    used.add(k)
    return before[k]
  }
  const items: Item[] = clean.map((i, n) => {
      const text = i.text
      const status: Status = (STATUSES as unknown[]).includes(i.status) ? (i.status as Status) : 'pending'
      const was = claim(text, n)
      const asked = typeof i.model === 'string' && i.model.trim() ? shortModel(i.model) : undefined
      const item: Item = { text, status, model: asked ?? was?.model ?? (m.model ? shortModel(m.model) : undefined) }
      const fix = oneLine(i.fix, 160) || (was?.text === text ? was.fix : undefined)
      if (fix) item.fix = fix
      if (was?.startedAt !== undefined) {
        item.startedAt = was.startedAt
        item.startTok = was.startTok
      }
      if (status === 'active' && item.startedAt === undefined) {
        item.startedAt = now
        item.startTok = m.tokens
      }
      if (status === 'done') {
        if (was?.status === 'done' && was.tokens !== undefined) {
          item.tokens = was.tokens
          item.ms = was.ms
        } else {
          const from = item.startedAt ?? prev?.at ?? now
          const fromTok = item.startTok ?? prev?.tokAt ?? m.tokens
          item.tokens = Math.max(0, m.tokens - fromTok)
          item.ms = Math.max(0, now - from)
        }
      }
      return item
    })
  const next: List | null = items.length ? { title, items, at: now, tokAt: m.tokens, source } : null
  await update($, list, () => next)
  // When the last step finishes, the bar shows full for a few seconds before it goes: redraw once it is over.
  if (next && next.items.every(i => i.status === 'done')) {
    void $.clock
      .sleep(FULL_MS)
      .then(async () => {
        const cur = await read($, list)
        if (cur && cur.at === next.at) await update($, list, l => (l ? { ...l } : l))
      })
      .catch(() => undefined)
  }
  return next
}

// ---- Orchestration: which model each subagent runs on, and the prompt log behind it. ----
// Tiers are relative (low < mid < high); an alias keeps them on the latest model of each kind.
const TIERS: Tier[] = ['low', 'mid', 'high']
const ALIAS: Record<Tier, string> = { low: 'haiku', mid: 'sonnet', high: 'opus' }
const LABEL_OF: Record<Tier, string> = { low: 'Haiku', mid: 'Sonnet', high: 'Opus' }
const tierOf = (model: string): Tier => {
  const k = /opus|fable/i.test(model) ? 'high' : /haiku/i.test(model) ? 'low' : 'mid'
  return k
}
// Rule 1: by agent type. Search-like helpers are cheap; planners and reviewers are not.
const TYPE_RULES: Record<string, Tier> = {
  Explore: 'low',
  'statusline-setup': 'low',
  'claude-code-guide': 'low',
  Plan: 'high',
  'code-review': 'high',
  'security-review': 'high',
}
// Rule 2: by what the description says. The costly words come first, so "search for security holes" goes up.
const WORD_RULES: [RegExp, Tier][] = [
  [/\b(architect\w*|design\w*|plan\w*|review\w*|audit\w*|debug\w*|diagnos\w*|root.?cause|security|migrat\w*|refactor\w*)\b/i, 'high'],
  [/\b(search\w*|find|grep|list|locate|read|fetch|rename|format\w*|lint\w*|copy|move|count|summari[sz]e)\b/i, 'low'],
]
const LABELS = ['easy', 'medium', 'hard'] as const
const FROM_LABEL: Record<string, Tier> = { easy: 'low', medium: 'mid', hard: 'high' }
const LOG_KEY = 'prompts'
const LOG_MAX = 200
const LEARN_WINDOW = 8
const LEARN_MIN = 3
const RETRY_PREFIX = 'Retry: '
const RETRY_MAX = 3 // reruns per prompt
const RETRY_WAIT_MS = 180000

// Your settings (the manifest's userConfig): whether failed helpers are rerun, and words that pin a tier.
// A word matches the agent type or the description, case-insensitively; high beats mid beats low.
type Config = { retry: boolean; pins: Record<Tier, string[]> }
const words = (v: unknown) => String(v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
let cfg: Config = { retry: true, pins: { low: [], mid: [], high: [] } }
const readConfig = (o: Readonly<Record<string, unknown>> | undefined): Config => ({
  retry: o?.retry !== false,
  pins: { low: words(o?.alwaysLow), mid: words(o?.alwaysMid), high: words(o?.alwaysHigh) },
})

const isEntry = (v: unknown): v is Entry => typeof v === 'object' && v !== null && typeof (v as Entry).id === 'string' && typeof (v as Entry).outcome === 'string'

// The log, oldest first. Whatever the store holds is checked, so a bad file never breaks routing.
async function readLog($: EngineInterface): Promise<Entry[]> {
  try {
    const v = await $.store.get(LOG_KEY)
    return Array.isArray(v) ? v.filter(isEntry) : []
  } catch {
    return []
  }
}

// Writes are queued one after another, so two quick updates never overwrite each other.
let logChain: Promise<unknown> = Promise.resolve()
function persist($: EngineInterface, entry: Entry) {
  logChain = logChain
    .then(async () => {
      const log = await readLog($)
      const at = log.findIndex(x => x.id === entry.id)
      if (at >= 0) log[at] = entry
      else log.push(entry)
      await $.store.set(LOG_KEY, log.slice(-LOG_MAX))
    })
    .catch(() => undefined)
}

// Learning: a tier whose last few subagents mostly failed is moved up one for the next ones. Each subagent is
// scored on its own (failed: error, refusal, or an empty answer; a user's abort says nothing about the model),
// by kind of work when that kind has enough samples, else across the tier. Prompts logged before subagents
// were scored are the fallback, judged by how the whole prompt ended.
const failed = (o: Spawn['outcome']) => o === 'error' || o === 'refused' || o === 'empty'
const rate = (xs: boolean[]) => xs.slice(-LEARN_WINDOW)
function escalate(tier: Tier, kind: string, log: Entry[]): Tier {
  const up = TIERS[TIERS.indexOf(tier) + 1]
  if (!up) return tier
  const scored = log
    .flatMap(x => (Array.isArray(x.spawns) ? x.spawns : []))
    .filter(s => s.tier === tier && s.outcome && s.outcome !== 'running' && s.outcome !== 'aborted')
  const ofKind = scored.filter(s => s.kind === kind)
  let seen = rate((ofKind.length >= LEARN_MIN ? ofKind : scored).map(s => failed(s.outcome)))
  if (seen.length < LEARN_MIN)
    seen = rate(log.filter(x => x.tier === tier && x.outcome !== 'running' && (x.spawns ?? []).every(s => !s.outcome)).map(x => x.outcome !== 'ok'))
  return seen.length >= LEARN_MIN && seen.filter(Boolean).length / seen.length >= 0.5 ? up : tier
}

// ---- Per subagent: its end is matched to its spawn by agent id. ----
// An agent's tokens add up as its responses arrive; its end (which can come before the spawn call returns,
// or after the prompt is over) is kept until it is matched.
const agentTok = new Map<string, number>()
const ended = new Map<string, Partial<Spawn>>()
const trimMap = <K, V>(m: Map<K, V>) => {
  if (m.size > 100) m.delete(m.keys().next().value as K)
}

// Patch the spawn that holds this agent id: in the running prompt, else in the log.
async function settle($: EngineInterface, agentId: string, patch: Partial<Spawn>) {
  const cur = await read($, run)
  if (cur?.spawns.some(s => s.agentId === agentId)) {
    const next = { ...cur, spawns: cur.spawns.map(s => (s.agentId === agentId ? { ...s, ...patch } : s)) }
    await update($, run, () => next)
    persist($, next)
    return
  }
  logChain = logChain
    .then(async () => {
      const log = await readLog($)
      const at = log.findIndex(x => Array.isArray(x.spawns) && x.spawns.some(s => s.agentId === agentId))
      if (at < 0) return
      log[at] = { ...log[at], spawns: log[at].spawns.map(s => (s.agentId === agentId ? { ...s, ...patch } : s)) }
      await $.store.set(LOG_KEY, log.slice(-LOG_MAX))
    })
    .catch(() => undefined)
}

// The spawn call returned an id: give it to the first spawn of that description that has none yet, and apply
// the agent's end if it already came.
async function attach($: EngineInterface, description: string, agentId: string) {
  const cur = await read($, run)
  if (!cur) return
  const at = cur.spawns.findIndex(s => s.description === description && !s.agentId)
  if (at < 0) return
  const early = ended.get(agentId)
  ended.delete(agentId)
  const next = { ...cur, spawns: cur.spawns.map((s, i) => (i === at ? { ...s, agentId, outcome: 'running' as const, ...early } : s)) }
  await update($, run, () => next)
  persist($, next)
}

const outcomeOf = (e: { reason: string; answer: string }): NonNullable<Spawn['outcome']> =>
  e.reason === 'answer' ? (e.answer.trim() ? 'ok' : 'empty') : e.reason === 'aborted' ? 'aborted' : e.reason === 'refusal' ? 'refused' : 'error'

// ---- Rerun: a helper on a lower tier that failed is run once more, one tier up, with a diagnosis. ----
// What each live helper was asked, kept until it ends; its end (the engine gives a subagent's answer only on
// its own turn.complete) is kept so a rerun that finishes early is still found.
type Asked = { prompt: string; description: string; kind: string; tier: Tier; why: Spawn['why'] }
const asked = new Map<string, Asked>()
const answers = new Map<string, { reason: string; answer: string }>()
const waiting = new Map<string, () => void>()
let retries = 0

function waitFor($: EngineInterface, id: string) {
  const have = answers.get(id)
  if (have) return Promise.resolve(have)
  return Promise.race([new Promise<void>(res => waiting.set(id, res)).then(() => answers.get(id)), $.clock.sleep(RETRY_WAIT_MS).then(() => undefined)]).finally(() => waiting.delete(id))
}

// Returns the rerun's answer when there was one and it worked; else undefined, and the first answer stands.
// Only for helpers the router placed (not ones the caller named a model for, forks, aborts, reruns, or the top tier),
// at most RETRY_MAX a prompt.
async function retry($: EngineInterface, agentId: string, e: { reason: string; answer: string }): Promise<string | undefined> {
  const was = asked.get(agentId)
  asked.delete(agentId)
  if (!was || !cfg.retry || retries >= RETRY_MAX) return
  if (was.why === 'given' || was.why === 'retry' || was.kind === 'fork' || was.kind === 'teammate') return
  const outcome = outcomeOf(e)
  if (!failed(outcome)) return
  const up = TIERS[TIERS.indexOf(was.tier) + 1]
  if (!up) return
  retries++
  const cause = outcome === 'empty' ? 'an empty answer' : outcome === 'refused' ? 'a refusal' : 'an error'
  const started = await $.agent.spawn({
    prompt: `A smaller model tried this and ended with ${cause}. Do the whole task again and answer in full.\n\n${was.prompt}`,
    description: RETRY_PREFIX + was.description,
    subagentType: was.kind,
    model: ALIAS[up],
  })
  if (started.deny || !started.agentId) return
  const got = await waitFor($, started.agentId)
  answers.delete(started.agentId)
  return got && !failed(outcomeOf(got)) ? got.answer : undefined
}

// A subagent's turn ended: how, how long, and what it cost.
async function agentEnded($: EngineInterface, agentId: string, e: { reason: string; answer: string; durationMs: number }) {
  const outcome = outcomeOf(e)
  const patch: Partial<Spawn> = { outcome, ms: Math.max(0, e.durationMs), tokens: agentTok.get(agentId) ?? 0 }
  agentTok.delete(agentId)
  const known = ((await read($, run))?.spawns ?? []).some(s => s.agentId === agentId)
  if (known) return settle($, agentId, patch)
  // Not in the running prompt: either its spawn call has not returned yet, or the prompt is over.
  ended.set(agentId, patch)
  trimMap(ended)
  return settle($, agentId, patch)
}

// The small model judges a text easy / medium / hard; cut off after 8 s so it never holds a spawn or a prompt.
async function judge($: EngineInterface, text: string): Promise<Tier | undefined> {
  try {
    const cap = $.clock.sleep(8000).then(() => undefined)
    const label = await Promise.race([$.model.classify(text.slice(0, 700), LABELS), cap])
    return label ? FROM_LABEL[label] : undefined
  } catch {
    return undefined
  }
}

// Where one subagent runs: the caller's own model if named, else rules, else the small model's judgement,
// else the prompt's tier, else mid. Rules and judgement are then checked against the log.
async function route($: EngineInterface, e: { subagentType: string; description: string; prompt: string; model?: string; parentModel: string }, promptTier: Tier | undefined) {
  if (e.model) return { tier: tierOf(e.model), model: undefined, why: e.description.startsWith(RETRY_PREFIX) ? ('retry' as const) : ('given' as const) }
  // Your pins are final: no rules, judgement or learning after them.
  const hay = `${e.subagentType} ${e.description}`.toLowerCase()
  const pinned = [...TIERS].reverse().find(t => cfg.pins[t].some(w => hay.includes(w)))
  if (pinned) return { tier: pinned, model: tierOf(e.parentModel) === pinned ? undefined : ALIAS[pinned], why: 'config' as const }
  let tier: Tier | undefined = TYPE_RULES[e.subagentType]
  let why: Spawn['why'] = 'rule'
  if (!tier) tier = WORD_RULES.find(([re]) => re.test(e.description))?.[1]
  if (!tier) {
    tier = await judge($, `${e.description}\n${e.prompt}`)
    why = 'classified'
  }
  if (!tier) {
    tier = promptTier ?? 'mid'
    why = 'default'
  }
  const lifted = escalate(tier, e.subagentType, await readLog($))
  if (lifted !== tier) {
    tier = lifted
    why = 'learned'
  }
  // The parent's own tier is what inherit gives, so there is nothing to rewrite.
  return { tier, model: tierOf(e.parentModel) === tier ? undefined : ALIAS[tier], why }
}

// A short title from the prompt: its first sentence, cut at 60.
const titleOf = (text: string) => {
  const first = oneLine(text.split(/[.!?\n]/).find(s => s.trim()) ?? text, 200)
  return first.length > 60 ? first.slice(0, 59).trimEnd() + '…' : first
}

// A prompt begins: it opens the log entry, draws the band if Claude has not got one going, and judges the
// prompt's tier in the background.
async function begin($: EngineInterface, text: string) {
  retries = 0
  const now = await $.clock.now()
  const m = (await read($, meter)) ?? { tokens: 0, model: '' }
  const g = await read($, git)
  const entry: Entry = {
    id: String(now),
    at: now,
    text: oneLine(text, 160),
    where: g && g.label !== 'No repo' ? 'repo' : 'local',
    spawns: [],
    startTok: m.tokens,
    tokens: 0,
    ms: 0,
    outcome: 'running',
  }
  await update($, run, () => entry)
  persist($, entry)
  // A step Claude is already running (a prompt sent mid-turn) keeps its own list.
  const prev = await read($, list)
  if (!(prev?.source === 'set' && prev.items.some(i => i.status === 'active'))) {
    await applyList($, titleOf(text), [{ text: 'Your request is still open', status: 'active' }], 'auto')
  }
  void judge($, text).then(async tier => {
    if (!tier) return
    const cur = await read($, run)
    if (cur?.id !== entry.id) return
    const next = { ...cur, tier: TIERS[Math.max(TIERS.indexOf(tier), cur.tier ? TIERS.indexOf(cur.tier) : 0)] }
    await update($, run, () => next)
    persist($, next)
  }).catch(() => undefined)
}

// The prompt ends: its numbers and outcome go to the log.
async function finish($: EngineInterface, reason: string) {
  const cur = await read($, run)
  if (!cur) return
  const now = await $.clock.now()
  const m = (await read($, meter)) ?? { tokens: 0, model: '' }
  const outcome: Entry['outcome'] = reason === 'answer' ? 'ok' : reason === 'aborted' ? 'aborted' : reason === 'refusal' ? 'refused' : 'error'
  const done: Entry = { ...cur, tokens: Math.max(0, m.tokens - cur.startTok), ms: Math.max(0, now - cur.at), outcome }
  await update($, run, () => null)
  persist($, done)
}

// A table of how each tier and kind of helper has done, from the log: the last LEARN_WINDOW scored ones.
function report(log: Entry[]): string {
  const scored = log.flatMap(x => (Array.isArray(x.spawns) ? x.spawns : [])).filter(s => s.outcome && s.outcome !== 'running' && s.outcome !== 'aborted')
  const row = (label: string, xs: Spawn[]) => {
    const recent = xs.slice(-LEARN_WINDOW)
    const ok = recent.filter(s => !failed(s.outcome)).length
    const tok = recent.reduce((n, s) => n + (s.tokens ?? 0), 0)
    return `${label.padEnd(18)} ${String(ok).padStart(2)}/${recent.length} ok · ${tok >= 1000 ? Math.round(tok / 1000) + 'k' : tok} tokens · ${xs.length} total`
  }
  const lines: string[] = []
  for (const t of TIERS) {
    const xs = scored.filter(s => s.tier === t)
    if (xs.length) lines.push(row(`${LABEL_OF[t]} (${t})`, xs))
  }
  const kinds = [...new Set(scored.map(s => s.kind).filter((k): k is string => !!k))]
  for (const k of kinds) {
    for (const t of TIERS) {
      const xs = scored.filter(s => s.kind === k && s.tier === t)
      if (xs.length) lines.push(row(`  ${k} · ${t}`, xs))
    }
  }
  const retried = scored.filter(s => s.why === 'retry').length
  const pins = TIERS.filter(t => cfg.pins[t].length).map(t => `${t}: ${cfg.pins[t].join(', ')}`)
  return [
    lines.length ? lines.join('\n') : 'No helpers scored yet.',
    `Reruns: ${cfg.retry ? 'on' : 'off'}${retried ? ` · ${retried} so far` : ''}`,
    `Pinned: ${pins.length ? pins.join(' · ') : 'none'}`,
  ].join('\n')
}

export const register: Register = (on, options) => {
  cfg = readConfig(options)
  // Every prompt: logged, and the band drawn from it, so the band never waits on Claude calling set.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!r.drop && !e.isMeta && !e.command && r.text.trim() && !r.text.trim().startsWith('/')) await begin($, r.text)
    } catch {
      // Bookkeeping only: the prompt itself is never touched.
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) {
      const id = e.agentId
      answers.set(id, { reason: e.reason, answer: e.answer })
      trimMap(answers)
      waiting.get(id)?.()
      try {
        await agentEnded($, id, e)
      } catch {
        // Bookkeeping only: the subagent's answer is never touched.
      }
      // A failed helper is run again one tier up; its answer, if it worked, is shown beneath the first.
      try {
        const again = await retry($, id, e)
        if (again !== undefined) return { ...r, text: again }
      } catch {
        // The first answer stands.
      }
    } else {
      try {
        await finish($, e.reason)
      } catch {
        // Bookkeeping only.
      }
      refreshGit($)
      // Whatever the turn was doing is over: a step left running (Claude did not send a last update,
      // or the app has no wrap_up) is ticked off, so the ring never spins on a finished turn.
      try {
        const prev = await read($, list)
        if (prev?.items.some(i => i.status === 'active'))
          await applyList($, prev.title, prev.items.map(i => ({ ...i, status: i.status === 'active' ? 'done' : i.status })), 'set')
      } catch {
        // Bookkeeping only: the turn's end is never touched.
      }
    }
    return r
  })

  on('session.start', async ($, e, next) => {
    refreshGit($)
    // A new session may have a new HOME, and must read the counter even if the file is unchanged.
    syncPath = ''
    syncSeen = -1
    progPath = ''
    progSeen = ''
    const checkSync = () => {
      void refreshSync($).catch(() => undefined)
      void refreshProgress($).catch(() => undefined)
    }
    checkSync()
    syncTimer?.cancel()
    syncTimer = $.clock.every(4000, checkSync)
    await $.command.register({ name: 'routing', description: 'How each model tier has done on helpers, and your overrides' }).catch(() => undefined)
    await $.tool.register({
      name: 'set',
      description: DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: "The overall problem, in plain words, 3-6 words (e.g. 'Checklist reads like jargon'). Not the person's prompt." },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: "The problem, as the person would notice it, under 8 plain words (e.g. 'Finished steps don't show as done')." },
                fix: { type: 'string', description: "How it gets solved, one plain sentence under 16 words, no jargon (e.g. 'Tick a step off the moment its work ends')." },
                status: { type: 'string', enum: STATUSES },
                model: { type: 'string', description: 'Opus, Sonnet or Haiku: the model that runs this step.' },
              },
              required: ['text', 'fix', 'status'],
            },
          },
        },
        required: ['items'],
      },
    })
    return next(e)
  })

  on('command.run', { command: 'routing' }, async $ => ({ text: report(await readLog($)) }))

  // Wherever Claude can draw the band, tell it what the band is for.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!e.tools.includes(SET_TOOL) || r.sections.some(s => s.id === PROMPT_SECTION.id)) return r
    return { ...r, sections: [...r.sections, PROMPT_SECTION] }
  })

  // Note the model each subagent starts on, so an active step with no fix can show what its agent is on.
  on('agent.spawn', async ($, e, next) => {
    // Place the subagent on a tier first; a failure here only means it runs as asked.
    let input = e
    let placed: { tier: Tier; why: Spawn['why'] } | undefined
    try {
      const cur = await read($, run)
      const d = await route($, e, cur?.tier)
      placed = { tier: d.tier, why: d.why }
      if (d.model) input = { ...e, model: d.model }
      if (cur) {
        const spawn: Spawn = { description: oneLine(e.description, 80), tier: d.tier, model: d.model ?? (e.model || e.parentModel), why: d.why, kind: e.subagentType }
        const upd: Entry = { ...cur, spawns: [...cur.spawns, spawn].slice(-20), tier: cur.tier && TIERS.indexOf(cur.tier) > TIERS.indexOf(d.tier) ? cur.tier : d.tier }
        await update($, run, () => upd)
        persist($, upd)
      }
    } catch {
      input = e
    }
    const r = await next(input)
    try {
      if (!r.deny && r.agentId && r.model) {
        const id = r.agentId
        const model = r.model
        asked.set(id, { prompt: input.prompt, description: e.description, kind: e.subagentType, tier: placed?.tier ?? tierOf(model), why: placed?.why ?? 'given' })
        trimMap(asked)
        // The latest 50 are plenty for the running ones, so a long session never piles them up.
        await update($, agentModels, a => Object.fromEntries([...Object.entries(a ?? {}).slice(-49), [id, model]]))
        await attach($, oneLine(e.description, 80), id)
      }
    } catch {
      // Bookkeeping only: a failure here never touches the spawn.
    }
    return r
  })

  // Count new tokens (uncached input, cache writes, output) of every response, subagents included.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r?.usage
    if (u) {
      const n = u.input_tokens + u.cache_creation_input_tokens + u.output_tokens
      if (e.agentId) {
        agentTok.set(e.agentId, (agentTok.get(e.agentId) ?? 0) + n)
        trimMap(agentTok)
      }
      await update($, meter, m => ({ tokens: (m?.tokens ?? 0) + n, model: e.agentId ? (m?.model ?? '') : u.model }))
    }
    return r
  })

  on('tool.call', { tool: SET_TOOL }, async ($, e) => {
    const input = e as unknown as { title?: unknown; items?: unknown }
    const next = await applyList($, input.title, Array.isArray(input.items) ? input.items : [], 'set')
    const done = next ? next.items.filter(i => i.status === 'done').length : 0
    return { result: next ? `Checklist shown: ${done}/${next.items.length} done.` : 'Checklist cleared.' }
  }).catch(() => ({ result: 'Checklist could not be updated.' }))

  // The turn's end (wrap_up) finishes the band's own running step. Nothing of the app's list is copied.
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const r = await next(e)
    try {
      const prev = await read($, list)
      if (prev?.items.some(i => i.status === 'active'))
        await applyList($, prev.title, prev.items.map(i => ({ ...i, status: i.status === 'active' ? 'done' : i.status })), 'set')
    } catch {
      // Bookkeeping only: wrap_up itself is never touched.
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, list)
    if (e.props.hasSurvey || l === null) {
      return next(e)
    }
    // isOpen is kept in state for later use; the band always shows the list.
    await read($, isOpen)
    const ui = $.ui.resolve(e) as unknown as Record<string, any>
    const { Box, Text } = ui
    const Svg = ui.Svg
    const graphic = e.surface !== 'terminal' && Svg !== undefined

    // Follow the person's theme setting: light-* or dark-*; anything else gets the middle palette.
    let mode: 'light' | 'dark' | 'mid' = 'mid'
    try {
      const theme = String((await $.config.list()).find(r => r.key === 'theme')?.value ?? '')
      mode = theme.startsWith('light') ? 'light' : theme.startsWith('dark') ? 'dark' : 'mid'
    } catch {
      mode = 'mid'
    }
    const P = PALETTES[mode]
    const G = GLYPHS[mode]
    // A row saved without a model (an older copy, or set before any response) shows the session's.
    const m = await read($, meter)
    const sessionModel = m?.model ? shortModel(m.model) : ''
    const g = await read($, git)
    const s = await read($, sync)
    const prog = await read($, progress)
    // Context gauge: grey, amber from 75%, red from 85% (auto-compact is near).
    const usage = await $.session.usage().catch(() => undefined)
    // Rounded first, so the colour matches the number shown; not a number, no gauge.
    const rawPct = usage?.context.percent
    const pct = typeof rawPct === 'number' && Number.isFinite(rawPct) ? Math.min(100, Math.max(0, Math.round(rawPct))) : undefined
    const total = runTotal(l.items)
    // Where this prompt's subagents went: "Haiku 2 · Opus 1".
    const placed = new Map<string, number>()
    for (const sp of (await read($, run))?.spawns ?? []) placed.set(shortModel(sp.model), (placed.get(shortModel(sp.model)) ?? 0) + 1)
    const routed = [...placed].map(([k, n]) => `${k} ${n}`).join(' · ')
    // The line under each step: its fix; an active step with none shows what a running subagent on
    // the step's model is on.
    const models = (await read($, agentModels)) ?? {}
    const live = l.items.some(i => i.status === 'active' && !i.fix)
      ? (await $.agent.list().catch(() => [])).filter(a => !a.parentId && ['pending', 'running', 'waiting'].includes(a.status))
      : []
    const explain = (i: Item) => {
      if (i.fix) return `${i.status === 'done' ? 'Fixed' : 'Fix'}: ${i.fix}`
      if (i.status !== 'active') return ''
      const model = i.model ?? sessionModel
      const d = live.find(a => models[a.id] && shortModel(models[a.id] ?? '') === model)?.description
      return d ? `Agent: ${d}` : ''
    }

    const done = l.items.filter(i => i.status === 'done')
    const rest = l.items.filter(i => i.status !== 'done')
    // Whole-task bar: finished steps plus the running step's share (from the job file, if fresh).
    const stepFrac = prog ? prog.done / prog.total : 0
    const progPct = Math.min(100, Math.round(((done.length + stepFrac) / Math.max(1, l.items.length)) * 100))
    // A task that has just finished keeps a full bar on its last step for a few seconds, then it goes.
    const justDone = l.items.length > 0 && done.length === l.items.length && (await $.clock.now()) - l.at < FULL_MS
    const lastItem = l.items[l.items.length - 1]
    const shownDone = done.slice(-3)
    const shownRest = rest.slice(0, 7)
    const hidden = rest.length - shownRest.length

    const glyph = (s: Status, k: string) =>
      graphic ? (
        s === 'active' ? (
          <Svg key={k} source={G[s]} alt={ALT[s]} width={BOX} height={LINE} isInteractive />
        ) : (
          <Svg key={k} source={G[s]} alt={ALT[s]} width={BOX} height={LINE} />
        )
      ) : (
        <Text key={k} color={s === 'done' ? P.accent : P.grey}>
          {TEXT_MARK[s]}
        </Text>
      )

    const note = (k: string, text: string) => (
      <Text key={k} size="footnote" color={P.grey}>
        {text}
      </Text>
    )

    // Each row: model column (fixed width, so every glyph and task starts at the same x),
    // glyph, task text, then tokens / time against the right edge once the step is done.
    const row = (i: Item, k: string) => {
      const isDone = i.status === 'done'
      const isNow = i.status === 'active'
      const took = stats(i)
      const why = explain(i)
      const line = (
        <Box key="l" flexDirection="row" alignItems="center" gap="sm">
          <Text key="t" color={isDone ? P.accent : 'text'} weight="regular" wrap="truncate-end">
            {i.text}
          </Text>
          {isNow || (justDone && i === lastItem) ? (
            graphic ? (
              <Svg key="w" source={bar(P, justDone ? 100 : progPct)} alt={`${justDone ? 100 : progPct}% done`} width={BAR_W} height={LINE} isInteractive />
            ) : (
              <Text key="w" color={P.grey} tabular>
                {`${justDone ? 100 : progPct}%`}
              </Text>
            )
          ) : null}
        </Box>
      )
      // With a fix line the row tops-aligns, so the model and glyph stay on the step's own line.
      return (
        <Box key={k} flexDirection="row" alignItems={why ? 'flex-start' : 'center'} gap="sm">
          <Box key={k + 'm'} width={7} flexShrink={0}>
            <Text key="m" size="footnote" weight="medium" color={P.grey} wrap="truncate-end">
              {i.model ?? sessionModel}
            </Text>
          </Box>
          {glyph(i.status, k + 'g')}
          <Box key={k + 'b'} flexGrow={1} flexShrink={1} flexDirection="column">
            {line}
            {why ? (
              <Text key="y" size="footnote" color={P.grey} wrap="truncate-end">
                {why}
              </Text>
            ) : null}
          </Box>
          {took ? (
            <Text key={k + 's'} size="footnote" color={P.grey} tabular>
              {took}
            </Text>
          ) : null}
        </Box>
      )
    }

    // No card or border of its own: the app's grey tray around the band is the frame.
    return (
      <Box flexDirection="column" rowGap={1} paddingX="md" paddingY="sm">
        <Box key="head" flexDirection="row" alignItems="center" gap="sm">
          <Box key="tb" flexGrow={1} flexShrink={1}>
            <Text key="title" weight="bold" color="text" wrap="truncate-end">
              {l.title}
            </Text>
          </Box>
          {routed ? (
            <Text key="routed" size="footnote" color={P.grey} wrap="truncate-end">
              {routed}
            </Text>
          ) : null}
          {total ? (
            <Text key="total" size="footnote" color={P.grey} tabular>
              {total}
            </Text>
          ) : null}
          {pct !== undefined ? (
            <Text key="ctx" size="footnote" color={pct >= 85 ? 'error' : pct >= 75 ? 'warning' : P.grey} tabular>
              {`Context ${pct}%`}
            </Text>
          ) : null}
          {g ? (
            <Text key="git" size="footnote" color={g.tone === 'alert' ? 'error' : g.tone === 'ok' ? P.accent : P.grey} wrap="truncate-end">
              {g.label}
            </Text>
          ) : null}
          {s ? (
            <Text key="sync" size="footnote" color={s.lastFailed ? 'error' : P.grey} tabular>
              {`${s.pushed} pushed · ${s.failed} failed`}
            </Text>
          ) : null}
        </Box>
        <Box key="rows" flexDirection="column" gap="xs">
          {done.length > shownDone.length ? note('earlier', `${done.length - shownDone.length} earlier done`) : null}
          {shownDone.map((i, n) => row(i, 'd' + n))}
          {shownRest.map((i, n) => row(i, 'r' + n))}
          {hidden > 0 ? note('more', `+${hidden} more`) : null}
        </Box>
      </Box>
    )
  })
}
