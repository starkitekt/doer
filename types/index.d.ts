// SPDX-License-Identifier: MIT
// Copyright (c) 2026 starkitekt. Doer: live-checklist mod, https://github.com/starkitekt/doer
// Keep this notice in all copies and derived works (MIT License, see LICENSE).

export type Status = 'done' | 'active' | 'pending' | 'wait'
// model: who runs the step. startedAt / startTok: clock and token meter when it started.
// tokens / ms: what it took, set once it is done.
export type Item = {
  text: string
  status: Status
  model?: string
  startedAt?: number
  startTok?: number
  tokens?: number
  ms?: number
  // How the problem in text gets solved, in plain words, shown under the step.
  fix?: string
}
// at / tokAt: clock and token meter at the last update, the start for a step done without being active.
// source: what drew it; only the mod's own set tool does.
// source: what drew it; 'set' is Claude's set tool, 'auto' is the mod itself at prompt submit.
export type List = { title: string; items: Item[]; at?: number; tokAt?: number; source?: 'set' | 'auto' }
// Model tiers, relative: low < mid < high (today Haiku, Sonnet, Opus or Fable).
export type Tier = 'low' | 'mid' | 'high'
// One subagent the router placed: what it was for, the tier it got, and why (given: the caller named a
// model; rule: agent type or wording; classified: the small model judged it; learned: moved up after misses;
// default: nothing else applied; config: one of your overrides; retry: a failed helper run again one tier up).
// The rest is filled in when the subagent ends: kind (its agent type), agentId, how it ended (empty: it answered
// with nothing), and its own new tokens and milliseconds. Entries logged before these existed lack them.
export type SpawnOutcome = 'running' | 'ok' | 'empty' | 'aborted' | 'error' | 'refused'
export type Spawn = {
  description: string
  tier: Tier
  model: string
  why: 'given' | 'rule' | 'classified' | 'learned' | 'default' | 'config' | 'retry'
  kind?: string
  agentId?: string
  outcome?: SpawnOutcome
  tokens?: number
  ms?: number
}
// One prompt in the log kept across sessions in the mod's store: what was asked, where (inside a git repo or
// not), the tier it was judged to be, the subagents placed, the numbers (new tokens, ms) and how it ended.
export type Entry = {
  id: string
  at: number
  text: string
  where: 'repo' | 'local'
  tier?: Tier
  spawns: Spawn[]
  startTok: number
  tokens: number
  ms: number
  outcome: 'running' | 'ok' | 'aborted' | 'error' | 'refused'
}
// tokens: new tokens across every model response this session (input, cache writes, output).
// model: the model that last answered on the main thread.
export type Meter = { tokens: number; model: string }
// The git chip: the most urgent state of the session's repo, read when a turn ends.
// tone: 'alert' (conflicts, checks failing), 'ok' (clean), 'quiet' (everything else).
export type Git = { label: string; tone: 'alert' | 'ok' | 'quiet' }
// The auto-sync tally from ~/.claude/autosync.count: pushes that went up, ones that failed, and whether the last one failed.
export type Sync = { pushed: number; failed: number; lastFailed: boolean }
// A long job's progress from ~/.claude/progress.count ("<done> <total>"): shown as a fill bar on the active step.
export type Progress = { done: number; total: number; est?: boolean }
// The model each subagent of this session runs on, by agent id, noted when it spawns.
export type AgentModels = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'live-checklist': {
      list: List | null
      isOpen: boolean
      meter: Meter
      git: Git | null
      sync: Sync | null
      progress: Progress | null
      agentModels: AgentModels
      run: Entry | null
    }
  }
}
