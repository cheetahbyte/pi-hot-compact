import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { HybridCompiler } from "./src/compilers/hybrid.ts";
import type { CompleteFn } from "./src/compilers/semantic.ts";
import { DEFAULT_SETTINGS, loadSettings, type HotCompactSettings } from "./src/config.ts";
import { HotCompactionManager, type PersistedGeneration } from "./src/hot-compaction.ts";
import { alignMessages } from "./src/projection.ts";
import { recall, type RecallMode } from "./src/recall.ts";
import type { CompiledContext, EntryLike, Msg } from "./src/types.ts";

const GENERATION_ENTRY = "hot-compact:generation";
const STATUS_KEY = "hot-compact";
// pi-footer "Pi Event Value" widget ids (https://github.com/wobondar/pi-footer#extension-integration)
const FOOTER_EVENT = "pi-footer:update-widget";
const FOOTER_WIDGETS = {
  state: "hot_compact",
  generation: "hot_compact_gen",
  job: "hot_compact_job",
  checkpoint: "hot_compact_checkpoint",
} as const;
const LOG_PATH = join(homedir(), ".pi", "agent", "hot-compact.log");
const RECALL_MODES: RecallMode[] = ["keyword", "regex", "event", "tool", "file", "range"];

export default function (pi: ExtensionAPI) {
  let settings: HotCompactSettings = { ...DEFAULT_SETTINGS };
  let compiler = new HybridCompiler();
  let manager = new HotCompactionManager(compiler);
  let pendingNative: CompiledContext | null = null;
  let lastUi: ExtensionContext["ui"] | null = null;

  const log = (line: string) => {
    if (!settings.debug) return;
    try {
      appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* ignore */
    }
  };

  const branch = (ctx: ExtensionContext): EntryLike[] => ctx.sessionManager.getBranch() as unknown as EntryLike[];

  const setup = (cwd: string) => {
    settings = loadSettings(cwd);
    compiler = new HybridCompiler({
      deterministic: { briefTokens: settings.briefTranscriptTokens },
      maxCheckpointTokens: settings.maxCheckpointTokens,
      reconcile: { collapseToolOutputChars: settings.collapseToolOutputChars, collapseKeepRecentTurns: settings.collapseKeepRecentTurns },
    });
    manager = new HotCompactionManager(
      compiler,
      {
        startPercent: settings.startPercent,
        hardPercent: settings.hardPercent,
        tailTokens: settings.tailTokens,
        minDeltaTokens: settings.minDeltaTokens,
        cooldownMs: settings.cooldownMs,
        jobTimeoutMs: settings.jobTimeoutMs,
        maxRetries: settings.maxRetries,
      },
      {
        log,
        onChange: publish,
        persist: (gen) => {
          try {
            pi.appendEntry(GENERATION_ENTRY, gen);
          } catch (err) {
            log(`persist failed: ${String(err)}`);
          }
        },
      },
    );
    manager.enabled = settings.enabled;
  };

  const footer = (widgetId: string, value: string | null) => {
    try {
      pi.events.emit(FOOTER_EVENT, { widgetId, value });
    } catch {
      /* no event bus */
    }
  };

  /** Publish state to pi's status line (ctx.ui.setStatus) and to pi-footer event widgets. */
  const publish = () => {
    const gen = manager.active;
    const job = manager.currentJob;
    if (!settings.enabled) {
      lastUi?.setStatus(STATUS_KEY, undefined);
      footer(FOOTER_WIDGETS.state, "◌ Off");
      footer(FOOTER_WIDGETS.generation, null);
      footer(FOOTER_WIDGETS.job, null);
      footer(FOOTER_WIDGETS.checkpoint, null);
      return;
    }
    const jobText = job?.status === "running" ? "compacting…" : job?.status === "ready" ? "ready" : job?.status === "failed" && !job.noop ? "failed" : "";
    const genText = gen ? `#${gen.compiled.firstKeptSeq}+` : "raw";
    const state = `● ${genText}${jobText ? ` ${jobText}` : ""}`;
    lastUi?.setStatus(STATUS_KEY, state);
    footer(FOOTER_WIDGETS.state, state);
    footer(FOOTER_WIDGETS.generation, gen ? `${gen.source} ${genText}` : "raw");
    footer(FOOTER_WIDGETS.job, jobText || null);
    footer(FOOTER_WIDGETS.checkpoint, gen ? `${Math.round(gen.compiled.estimatedTokens / 100) / 10}k` : null);
  };

  const status = (ctx: ExtensionContext) => {
    if (ctx.hasUI) lastUi = ctx.ui;
    publish();
  };

  const makeComplete = (ctx: ExtensionContext): CompleteFn | undefined => {
    if (!settings.semantic) return undefined;
    let model = ctx.model;
    if (settings.semanticModel) {
      const slash = settings.semanticModel.indexOf("/");
      const found = slash > 0 ? ctx.modelRegistry.find(settings.semanticModel.slice(0, slash), settings.semanticModel.slice(slash + 1)) : undefined;
      if (found) model = found;
      else log(`semantic model ${settings.semanticModel} not found; using session model`);
    }
    if (!model) return undefined;
    const registry = ctx.modelRegistry;
    const chosen = model;
    return async (prompt, signal) => {
      const response = await registry.complete(
        chosen,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        { maxTokens: settings.semanticMaxTokens, signal, cacheRetention: "none", sessionId: randomUUID() } as never,
      );
      if (response.stopReason === "error") throw new Error(response.errorMessage ?? "model error");
      if (response.stopReason === "length") throw new Error("semantic checkpoint hit the output limit");
      return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    };
  };

  const maybeStart = (ctx: ExtensionContext) => {
    const usage = ctx.getContextUsage();
    if (!usage) return;
    compiler.setComplete(makeComplete(ctx));
    const reason = manager.maybeStart({ percent: usage.percent, tokens: usage.tokens, contextWindow: usage.contextWindow });
    if (!reason) log(`job started at ${usage.percent?.toFixed(1)}%`);
  };

  const restore = (ctx: ExtensionContext) => {
    const entries = branch(ctx);
    manager.syncBranch(entries);
    const persisted: PersistedGeneration[] = [];
    let lastGenSeq = -1;
    let lastCompaction: { seq: number; entry: EntryLike } | null = null;
    entries.forEach((e, i) => {
      if (e.type === "custom" && e.customType === GENERATION_ENTRY && e.data) {
        persisted.push(e.data as PersistedGeneration);
        lastGenSeq = i;
      }
      if (e.type === "compaction") lastCompaction = { seq: i, entry: e };
    });
    const restored = manager.restore(persisted);
    const lc = lastCompaction as { seq: number; entry: EntryLike } | null;
    if (lc && (!restored || lc.seq > lastGenSeq)) {
      manager.adoptNative({ id: lc.entry.id, summary: lc.entry.summary ?? "", firstKeptEntryId: lc.entry.firstKeptEntryId ?? "" });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    setup(ctx.cwd);
    restore(ctx);
    log(`session start: ${manager.status()}`);
    status(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
    status(ctx);
  });

  pi.on("context", async (event, ctx) => {
    if (!settings.enabled) return;
    try {
      manager.syncBranch(branch(ctx));
      const usage = ctx.getContextUsage();
      let gen = manager.trySwap();
      if (!gen && usage?.percent != null && usage.percent >= settings.hardPercent) {
        gen = manager.emergency();
        if (gen) log(`emergency generation ${gen.id} at ${usage.percent.toFixed(1)}%`);
      }
      if (!gen) {
        maybeStart(ctx);
        gen = manager.active;
      }
      status(ctx);
      if (!gen) return;
      const aligned = alignMessages(event.messages as unknown as Msg[], manager.log);
      const out = compiler.reconcile(gen.compiled, aligned, undefined, gen.id);
      log(`context: gen ${gen.id}, ${out.messages.length} msgs, dropped ${out.droppedEvents}, collapsed ${out.collapsedToolOutputs}`);
      return { messages: out.messages as unknown as typeof event.messages };
    } catch (err) {
      log(`context handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!settings.enabled) return;
    manager.syncBranch(branch(ctx));
    maybeStart(ctx);
    status(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    pendingNative = null;
    if (!settings.enabled || !settings.handleNativeCompaction) return;
    try {
      manager.syncBranch(event.branchEntries as unknown as EntryLike[]);
      const compiled = manager.compileAt(event.preparation.firstKeptEntryId);
      if (!compiled) return;
      pendingNative = compiled;
      log(`native compaction (${event.reason}) served deterministically, kept from #${compiled.firstKeptSeq}`);
      return {
        compaction: {
          summary: compiled.checkpoint,
          firstKeptEntryId: compiled.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { hotCompact: true, sections: compiled.sections, semantic: compiled.semantic },
        },
      };
    } catch (err) {
      log(`session_before_compact error: ${String(err)}`);
      void ctx;
      return;
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    manager.syncBranch(branch(ctx));
    const entry = event.compactionEntry;
    manager.adoptNative({ id: entry.id, summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId }, pendingNative ?? undefined);
    pendingNative = null;
    status(ctx);
  });

  pi.on("session_compact_failed", async (event) => {
    pendingNative = null;
    log(`native compaction failed: ${event.errorMessage ?? (event.aborted ? "aborted" : "unknown")}`);
  });

  pi.registerTool({
    name: "context_recall",
    label: "Context Recall",
    description:
      "Search the full, uncompacted history of this session. Older conversation is replaced in your context by a checkpoint; anything it omits (tool outputs, exact messages, file contents that were read) is still stored and can be retrieved here. Modes: keyword (all terms, case-insensitive), regex, event (full content of one event by number, e.g. 842 or event://842; use offset for long outputs), tool (tool calls whose name or arguments contain the query, with their result event), file (events mentioning a path), range (list events from..to).",
    promptSnippet: "Recall details from compacted session history (keyword, regex, event number, tool call, file, or range)",
    promptGuidelines: [
      "Use context_recall when a checkpoint or a collapsed tool output refers to an event://N you need, or when a detail from earlier in the session is missing from the current context. Do not re-run commands just to recover output that context_recall can return.",
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: "keyword | regex | event | tool | file | range (default keyword)" })),
      query: Type.Optional(Type.String({ description: "Search terms, regex, event number, tool name/argument text, or file path" })),
      from: Type.Optional(Type.Number({ description: "First event number to search (default 0)" })),
      to: Type.Optional(Type.Number({ description: "Last event number to search (default latest)" })),
      limit: Type.Optional(Type.Number({ description: "Max hits (default 20)" })),
      offset: Type.Optional(Type.Number({ description: "Skip this many hits, or chars in event mode" })),
      maxChars: Type.Optional(Type.Number({ description: "Chars of content returned in event mode (default 8000)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      manager.syncBranch(branch(ctx));
      const mode = RECALL_MODES.includes(params.mode as RecallMode) ? (params.mode as RecallMode) : "keyword";
      const result = recall(manager.log, {
        mode,
        query: params.query,
        fromSeq: params.from,
        toSeq: params.to,
        limit: params.limit,
        offset: params.offset,
        maxChars: params.maxChars,
      });
      return { content: [{ type: "text", text: result.text }], details: { mode, total: result.total, hits: result.hits.length } };
    },
  });

  pi.registerCommand("hot-compact", {
    description: "Hot compaction: status | now | emergency | retry | on | off",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "now", "emergency", "retry", "on", "off"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim().split(/\s+/)[0] || "status";
      manager.syncBranch(branch(ctx));
      switch (cmd) {
        case "now": {
          compiler.setComplete(makeComplete(ctx));
          manager.clearFailures();
          const job = manager.start("hot");
          ctx.ui.notify(job ? `hot-compact: job ${job.id} started (through #${job.snapshotThroughSeq}); swaps in before the next model call once ready` : "hot-compact: nothing to compact", "info");
          break;
        }
        case "emergency": {
          const gen = manager.emergency();
          ctx.ui.notify(gen ? `hot-compact: deterministic generation ${gen.id} active (kept from #${gen.compiled.firstKeptSeq})` : "hot-compact: nothing to compact", gen ? "info" : "warning");
          break;
        }
        case "retry":
          manager.clearFailures();
          ctx.ui.notify("hot-compact: failure counter reset", "info");
          break;
        case "on":
          settings.enabled = true;
          manager.enabled = true;
          ctx.ui.notify("hot-compact: enabled", "info");
          break;
        case "off":
          settings.enabled = false;
          manager.enabled = false;
          ctx.ui.notify("hot-compact: disabled (raw context until re-enabled)", "info");
          break;
        default: {
          const usage = ctx.getContextUsage();
          const pct = usage?.percent != null ? `${usage.percent.toFixed(1)}% of ${usage.contextWindow}` : "usage unknown";
          ctx.ui.notify(`hot-compact: ${settings.enabled ? "on" : "off"} · ${pct} · start ${settings.startPercent}% hard ${settings.hardPercent}% · semantic ${settings.semantic ? "on" : "off"}\n${manager.status()}`, "info");
        }
      }
      status(ctx);
    },
  });

  pi.registerCommand("recall", {
    description: "Search raw session history: /recall [mode:]<query>",
    handler: async (args, ctx) => {
      manager.syncBranch(branch(ctx));
      const raw = (args ?? "").trim();
      const m = raw.match(/^(keyword|regex|event|tool|file|range):\s*(.*)$/);
      const mode = (m ? m[1] : "keyword") as RecallMode;
      const query = m ? m[2] : raw;
      const result = recall(manager.log, { mode, query, limit: 10, maxChars: 1500 });
      ctx.ui.notify(result.text, "info");
    },
  });
}
