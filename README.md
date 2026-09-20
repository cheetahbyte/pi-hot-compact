# pi-hot-compact

Hot compaction and a pluggable context compiler for the [pi](https://github.com/earendil-works/pi-mono) coding agent.

The session log stays the source of truth. What the model sees is a compiled projection: a checkpoint of older history plus the recent conversation verbatim. Compaction runs in the background while the agent keeps working, then swaps in atomically at the next model call. Nothing in the session file is ever rewritten or deleted.

```
Immutable session log (pi JSONL, every entry gets a seq)
        │
        ├──────────────► context_recall tool / /recall
        │
        ▼
Context compiler (hybrid: deterministic sections + optional LLM checkpoint)
        │
        ▼
Model-visible context = [checkpoint] + verbatim events from the boundary on
```

## Install

```
pi install git:github.com/<you>/pi-hot-compact
```

or, for a local checkout:

```
pi -e /path/to/pi-hot-compact/index.ts
```

Requires pi 0.86 or newer (before 1.0). If `@sting8k/pi-vcc` or another extension also answers `session_before_compact`, set `handleNativeCompaction` to `false` here or uninstall the other one; pi takes the first non-empty answer.

## How it works

1. **Event log.** On every model call the extension syncs the current branch into an append-only log. Each entry gets a monotonically increasing `seq`. Tree navigation or a fork bumps an epoch, which invalidates everything built on the old numbering.
2. **Trigger.** When context usage passes `startPercent` (default 70), a job snapshots the log through its last event and compiles in the background. The agent does not wait.
3. **Compile.** The hybrid compiler picks a verbatim boundary (`tailTokens`, never inside a tool call, preferring a user-turn start) and builds a checkpoint for everything before it:
   - a deterministic layer recomputed from raw history every time: `[Session Goal]`, `[Files And Changes]`, `[Commits]`, `[Outstanding Context]`, `[User Preferences]`, `[Brief Transcript]` with `event://N` references;
   - an optional semantic layer: the session model summarises only the span that is leaving the tail, given the previous checkpoint, into `[Architecture Decisions]`, `[Known Failures]`, `[Next Steps]` and so on. Output is validated; a bad answer fails the job instead of landing in context.
4. **Swap.** At the next `context` event (between model and tool iterations) the job is checked against the live log: same epoch, same base generation, snapshot and kept boundaries still on the branch, boundary moved forward. If any check fails the result is discarded and a new job runs later. Otherwise the generation becomes active and is persisted as a `hot-compact:generation` custom entry so it survives restarts.
5. **Reconcile.** The projection drops events before the boundary, inserts the checkpoint, and keeps every later event exactly, including the delta produced while the job ran. Tool outputs older than `collapseKeepRecentTurns` and longer than `collapseToolOutputChars` become `metadata + head/tail + event://N`.
6. **Fallbacks.** Above `hardPercent` (default 90) with no job ready, a deterministic-only generation is compiled synchronously and swapped in. pi's own threshold, overflow and `/compact` paths are served by the same deterministic compiler at pi's chosen boundary, so the last-resort compaction never calls an LLM.

Failures (timeouts, model errors, invalid output, nothing to compact) are logged, counted, and retried after a cooldown. The agent never blocks or crashes on compaction.

## Recall

The `context_recall` tool searches the raw log, so the model can recover anything the checkpoint omitted:

| mode | query |
|------|-------|
| `keyword` | all terms, case-insensitive |
| `regex` | JavaScript regex |
| `event` | `842`, `#842` or `event://842`; `offset` and `maxChars` page long outputs |
| `tool` | tool name or argument text; each hit links to its result event |
| `file` | path substring in tool arguments or text |
| `range` | list events `from`..`to` |

`/recall [mode:]<query>` runs the same search for you in the TUI.

## Commands

`/hot-compact` with `status` (default), `now` (start a job), `emergency` (deterministic swap now), `retry` (reset the failure counter), `on`, `off`.

## Status line and pi-footer

The extension publishes `ctx.ui.setStatus("hot-compact", …)` for pi's own footer and, for [pi-footer](https://github.com/wobondar/pi-footer), the following `Pi Event Value` widget ids via `pi.events`:

| widget id | value |
|-----------|-------|
| `hot_compact` | `● #812+ compacting…` (verbatim boundary plus job state; `◌ Off` when disabled). Trim 2 in pi-footer to drop the symbol. |
| `hot_compact_gen` | `hot #812+`, `emergency #…`, `native #…`, `restored #…`, or `raw` |
| `hot_compact_job` | `compacting…`, `ready`, `failed`, or cleared |
| `hot_compact_checkpoint` | checkpoint size, e.g. `4.2k` |

Values are re-emitted on session start, on every state change, and after a reload. Add a `Pi Extension Status` widget with key `hot-compact`, or a `Pi Event Value` widget with one of the ids above.

## Configuration

`~/.pi/agent/hot-compact.json`, overridden by `<project>/.pi/hot-compact.json`. `PI_HOT_COMPACT_CONFIG` points at an alternative global file.

```json
{
  "enabled": true,
  "startPercent": 70,
  "hardPercent": 90,
  "tailTokens": 16000,
  "minDeltaTokens": 6000,
  "cooldownMs": 30000,
  "jobTimeoutMs": 120000,
  "maxRetries": 3,
  "semantic": true,
  "semanticModel": null,
  "semanticMaxTokens": 4000,
  "maxCheckpointTokens": 12000,
  "briefTranscriptTokens": 3500,
  "collapseToolOutputChars": 4000,
  "collapseKeepRecentTurns": 2,
  "handleNativeCompaction": true,
  "debug": false
}
```

`semanticModel` takes `"provider/modelId"`; `null` uses the session model. `debug: true` appends a trace to `~/.pi/agent/hot-compact.log`.

## Writing another compiler

`src/types.ts` defines `ContextCompiler`:

```ts
interface ContextCompiler {
  snapshot(input: SnapshotInput): ContextSnapshot;
  compile(snapshot: ContextSnapshot, options?: CompileOptions): Promise<CompiledContext>;
  compileSync(snapshot: ContextSnapshot, options?: CompileOptions): CompiledContext;
  reconcile(compiled: CompiledContext, delta: SessionEvent[], options?, generationId?): Context;
}
```

`HotCompactionManager` in `src/hot-compaction.ts` is compiler-agnostic and carries the job, generation and staleness logic. `HybridCompiler` in `src/compilers/hybrid.ts` is the default. The core has no pi imports, so it runs and tests standalone.

## Development

```
bun install
bun test
bun run typecheck
```

## Invariants

- Session history is append-only; compaction only adds custom entries.
- Snapshot boundaries are explicit (`throughSeq` / `throughEntryId`); the delta starts right after.
- Swaps happen only in the `context` handler and only for a job whose base generation is still active.
- One generation is active at a time; stale results are discarded, never applied.
- Deterministic sections are recomputed from event 0, so there is no summary-of-summary drift; the semantic layer always sees raw events plus the previous checkpoint.
