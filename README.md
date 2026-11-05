# Doer

A problem-and-fix explainer that floats above the Claude Code prompt. Each row is a problem you would notice, with a plain line under it on how it gets fixed, ticked off as Claude works. It is its own layer: it never copies the app's task list, which says what Claude is doing.

- **Done:** green disc with a tick, green text, and the tokens and time the step took at the right
- **In progress:** slowly turning dotted ring, marked *in progress* in serif italics
- **Not started:** filled light grey circle
- The header and the steps not yet done use the app's own text colour, so they match the chat
- Each row starts with the model that runs the step, so the steps line up in one column
- Circles sit on the text baseline

Rows use the app's own font at your interface size. It works on light and dark themes and sits straight on the app's tray above the prompt, with no card or border of its own.

## Git chip

When the session runs inside a git repository, the right end of the header shows the branch and its most urgent state, one at a time. It is read only, so it never commits, pushes or merges.

| Shows | When | Colour |
|---|---|---|
| `Conflicts` | a merge or rebase has unresolved files | red |
| `Checks failing` | a CI run on the last pushed commit failed | red |
| `Checks running` | CI on the last pushed commit is still going | grey |
| `2 unpushed` | commits not yet on the remote branch | grey |
| `5 changed` | files changed or added but not committed | grey |
| `no remote` | the repository has no remote to push to | grey |
| `clean` | none of the above | green |
| `No repo` | the session is not inside a git repository | grey |

The chip refreshes when a session starts and when each turn ends, in the background, so it never slows Claude down. CI states need the [GitHub CLI](https://cli.github.com) (`gh`) signed in; without it the chip skips them.

## Sync counter

If a script of yours syncs a repository on its own (a Stop hook that commits and pushes, say), it can write `<pushed> <failed> <ok|fail>` to `~/.claude/autosync.count`. The header then shows `4 pushed · 1 failed` at the right, red when the last sync failed. Without that file there is no counter.

The step that is running shows a pixel-art fill bar (21 blocks) with a pixel hourglass whose sand falls top to bottom before it turns over, and a percentage, in place of the words "in progress"; the dotted ring beside it stays. The bar covers the whole task: finished steps divided by all steps. A long job (a render, a batch) can also write `<done> <total> <project folder>` to `~/.claude/progress.count` to add its share inside the running step, so the bar moves smoothly. The folder is optional; with it, only sessions inside that folder use the file. It is read every few seconds and ignored once it is 15 minutes old; the bar then falls back to steps alone and never disappears. In the terminal it shows the percentage as text.

## Run total and context gauge

Once a step is done, the header shows the run so far at the right: `14m · 84k T`, the time and tokens of every done step added up. Beside it, `Context 64%` is how full the session's context window is. It is grey, turns amber from 75% and red from 85%, so you see auto-compact coming.

## Problem and fix

Every row is a problem, in plain words as you would notice it, and under it a dim line with its fix, `Fix: …`, which reads `Fixed: …` once the step is done. No code names, file names or jargon in either.

| Problem | Fix |
|---|---|
| `Finished steps don't show as done` | `Tick a step off the moment its work ends` |
| `The app can't find your repo` | `Look for the project folder one level up` |
| `Not sure the fix works` | `Try it the way you would use it` |

The mod adds this to Claude's system prompt whenever it can draw the band, and tells it never to copy steps from the app's task list. An active step with no fix shows what a running subagent on its model is on, as `Agent: …`.

## Model orchestration

Subagents are placed on a tier instead of all running on one model. Tiers are relative: **low** (Haiku), **mid** (Sonnet), **high** (Opus or Fable), set by alias so they follow the latest model of each kind. For each spawn, in order:

1. A model the caller named is kept.
2. **Your pins** (see Settings): a helper whose agent type or description contains a pinned word goes to that tier, final, with no rules, judgement or learning after it. High beats mid beats low.
3. **Rules:** by agent type (`Explore` low; `Plan`, `code-review`, `security-review` high), then by the description's wording (*find, list, read, rename* low; *plan, review, audit, debug, refactor, security* high).
4. **Judgement:** otherwise the small model rates the task easy, medium or hard (8 s limit).
5. If that fails, the prompt's own tier, else mid.
6. **Learning:** each subagent is scored on its own when it ends: *failed* is an error, a refusal or an empty answer (a user's abort counts for nothing). If the last 8 scored subagents at a tier, of the same kind of work once that kind has 3, mostly failed (half or more), the tier moves up one. Prompts logged before subagents were scored fall back to how the whole prompt ended.

A tier equal to the parent's is left as inherit. The header shows where this prompt's subagents went, `Haiku 2 · Opus 1`. A failure in any step lets the spawn run as asked.

**Rerun on failure.** When a helper the router placed ends *failed* (error, refusal, empty answer), it is run once more one tier up, told what went wrong, with `Retry: ` ahead of its description. Not for aborts, helpers whose model the caller named, forks, teammates, the top tier or a rerun itself; at most 3 a prompt. A rerun that works is handed back as the helper's text, which the engine shows beneath the first answer; whether the parent reads it in place of the first is not confirmed. Logged with reason `retry`.

## /routing

Type `/routing` for how each tier and kind of helper has done (last 8 scored: ok count, tokens, total), whether reruns are on, and your pins.

## Settings

Under the plugin's config rows (per project when set in project-scope `pluginConfigs`):

| Field | Does |
|---|---|
| `retry` | rerun failed helpers one tier up (default on) |
| `alwaysLow`, `alwaysMid`, `alwaysHigh` | comma-separated words; a helper whose agent type or description contains one is pinned to that tier |

## Prompt log

Every prompt is logged across sessions in the mod's store under `prompts` (latest 200): the prompt (160 characters), `where` it ran (`repo` or `local`), its tier, the subagents placed with the reason for each and, once they end, their kind, outcome, tokens and time, the tokens and milliseconds it took, and how it ended (`ok`, `aborted`, `error`, `refused`). It is stored on your machine only. Delete the `prompts` key to clear it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install live-checklist --marketplace starkitekt/doer
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

From a shell:

```bash
claude plugin install live-checklist --marketplace starkitekt/doer
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `starkitekt/doer`, then **Add plugin**.

## Use

The mod gives Claude a tool, `set`. Claude calls it with a title and a list of steps, each a problem (`text`), its `fix` and a status (`done`, `active`, `pending` or `wait`), whenever a step starts or finishes. Titles, problems and fixes are kept to one line; a step with no text is skipped, and a blank title reads `Tasks`.

The band does not wait for `set`: every prompt draws it at once (a title from the prompt and one open row), so it shows in every chat. When Claude calls `set` its list takes over; a prompt sent while a step is running keeps that list. Slash commands never draw it. The app's own task list never fills it. When a turn ends, the step still running is ticked off with its tokens and time. Run `claude plugin test .` for the test suite in `tests/`. To make it a habit, add a line like this to your `CLAUDE.md`:

> For every multi-step task, explain each problem and its fix with the live-checklist tool, and update it at each step.

## License

MIT © 2026 [starkitekt](https://github.com/starkitekt). You are free to use, change and share it. Keep the copyright notice in `LICENSE` and in the source headers.
