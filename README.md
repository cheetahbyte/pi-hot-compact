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
compaction entry + context_edit entries, appended at pi's turn boundaries
        │
        ▼
Model-visible context = pi's projection: [checkpoint] + kept entries, edits applied
```

## Install

```bash
pi install npm:pi-hot-compact
```

Or install from GitHub:

```bash
pi install git:github.com/cheetahbyte/pi-hot-compact
```

For a local checkout:

```
pi -e /path/to/pi-hot-compact/index.ts
```

Requires pi 0.87 or newer (before 1.0). If `@sting8k/pi-vcc` or another extension also answers `session_before_compact`, set `handleNativeCompaction` to `false` here or uninstall the other one; pi takes the first non-empty answer.

## How it works

1. **Event log.** At every turn boundary the extension syncs the current branch into an append-only log. Each entry gets a monotonically increasing `seq`. pi's `context_edit` entries are applied to the model-visible message while the raw message stays available for recall. Tree navigation or a fork bumps an epoch, which invalidates everything built on the old numbering.
2. **Trigger.** When context usage passes `startPercent` (default 70), a job snapshots the log through its last event and compiles in the background. The agent does not wait.
3. **Compile.** The hybrid compiler picks a verbatim boundary (`tailTokens`, never inside a tool call, preferring a user-turn start) and builds a checkpoint for everything before it:
   - a deterministic layer recomputed from raw history every time: `[Session Goal]`, `[Files And Changes]`, `[Commits]`, `[Outstanding Context]`, `[User Preferences]`, `[Brief Transcript]` with `event://N` references;
   - an optional semantic layer: the session model summarises only the span that is leaving the tail, given the previous checkpoint, into `[Architecture Decisions]`, `[Known Failures]`, `[Next Steps]` and so on. Output is validated; a bad answer fails the job instead of landing in context.
4. **Commit.** At the next `turn_end` or `agent_before_settle` boundary (between model and tool iterations) the job is checked against the live log: same epoch, same base generation, snapshot and kept boundaries still on the branch, boundary moved forward. If any check fails the result is discarded and a new job runs later. Otherwise the extension returns a `compaction` entry draft with the checkpoint as summary and the sections and semantic text in `details`. pi appends it, rebuilds the context from it, computes `tokensBefore`, and handles resume, fork and `/tree` for it. The active generation is always re-read from the latest compaction entry on the branch.
5. **Collapse.** At the same boundaries, tool outputs older than `collapseKeepRecentTurns` and longer than `collapseToolOutputChars` become `context_edit` entries whose replacement is `metadata + head/tail + event://N`. pi applies them to future requests; the raw output stays in the session file.
6. **Fallbacks.** Above `hardPercent` (default 90) with no job ready, a deterministic-only generation is compiled synchronously at the boundary and committed the same way. pi's own threshold, overflow and `/compact` paths are served by the same deterministic compiler at pi's chosen boundary, so the last-resort compaction never calls an LLM.

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

`/hot-compact` with `status` (default), `now` (start a job), `emergency` (ask pi to compact now, served deterministically), `retry` (reset the failure counter), `on`, `off`.

## Status line and pi-footer

The extension publishes `ctx.ui.setStatus("hot-compact", …)` for pi's own footer and, for [pi-footer](https://github.com/wobondar/pi-footer), the following `Pi Event Value` widget ids via `pi.events`:

| widget id | value |
|-----------|-------|
| `hot_compact` | `● #812+ compacting…` (verbatim boundary plus job state; `◌ Off` when disabled; cleared while idle with no generation). Trim 2 in pi-footer to drop the symbol. |
| `hot_compact_gen` | `hot #812+`, `emergency #…`, `native #…`, `foreign #…` (a compaction this extension did not write); cleared when there is no generation |
| `hot_compact_job` | `compacting…`, `ready`, `failed`, or cleared |
| `hot_compact_checkpoint` | checkpoint size, e.g. `4.2k` |

Values are emitted on session start, after a reload, and whenever they change; nothing is published while idle with no generation. Add a `Pi Event Value` widget with one of the ids above to the footer line and hide `hot-compact` in pi-footer's `Pi extensions` menu, otherwise pi-footer shows the `ctx.ui.setStatus` value in its separate extension status row.

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
}
```

`HotCompactionManager` in `src/hot-compaction.ts` is compiler-agnostic and carries the job and staleness logic; the active generation is derived from the branch. `HybridCompiler` in `src/compilers/hybrid.ts` is the default. `planCollapses` in `src/projection.ts` turns old tool outputs into `context_edit` drafts. The core has no pi imports, so it runs and tests standalone.

## Development

```
bun install
bun test
bun run typecheck
```

## Publish to npm

You need Bun installed to run the publishing checks and an npm account with permission to publish `pi-hot-compact`.

1. For subsequent releases, update `version` in `package.json`. Each published version must be unique.
2. Inspect the package contents:

   ```bash
   npm pack --dry-run
   ```

   The package includes `index.ts`, `src/`, `package.json`, `README.md`, and `LICENSE`. Pi loads the TypeScript directly; no build step is required.
3. Sign in to npm:

   ```bash
   npm login
   ```

4. Publish the package:

   ```bash
   npm publish
   ```

   The `prepublishOnly` script runs tests and type checking before publishing. Publishing stops if either check fails. Complete any authentication or two-factor verification npm requests.

The `pi-package` keyword makes the published package discoverable by the [pi package gallery](https://pi.dev/packages). No image or video is required.

## Acknowledgments

Inspired by [pi-vcc](https://github.com/sting8k/pi-vcc) by [sting8k](https://github.com/sting8k).

## Invariants

- Session history is append-only; compaction only adds `compaction` and `context_edit` entries, both written by pi from drafts returned at turn boundaries.
- Snapshot boundaries are explicit (`throughSeq` / `throughEntryId`); the delta starts right after and stays verbatim.
- Results are committed only at `turn_end` / `agent_before_settle` and only for a job whose base generation is still the latest compaction on the branch.
- The active generation is whatever the latest compaction entry on the branch says; stale results are discarded, never applied.
- Deterministic sections are recomputed from event 0, so there is no summary-of-summary drift; the semantic layer always sees raw events plus the previous checkpoint.
- Recall reads pre-edit content, so collapsed or omitted messages remain retrievable.
