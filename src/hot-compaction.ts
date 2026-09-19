import { EventLog } from "./log.ts";
import { estimateMessagesTokens } from "./tokens.ts";
import type { CompactionJob, CompiledContext, ContextCompiler, ContextGeneration, EntryLike } from "./types.ts";
import { NothingToCompactError } from "./types.ts";

export interface HotCompactionConfig {
  /** Start a background job at this context usage (percent of the window). */
  startPercent: number;
  /** Above this usage, compile deterministically right now if no job is ready. */
  hardPercent: number;
  tailTokens: number;
  /** Minimum estimated tokens of new events since the active generation before another job starts. */
  minDeltaTokens: number;
  cooldownMs: number;
  jobTimeoutMs: number;
  maxRetries: number;
}

export const DEFAULT_HOT_CONFIG: HotCompactionConfig = {
  startPercent: 70,
  hardPercent: 90,
  tailTokens: 16_000,
  minDeltaTokens: 6_000,
  cooldownMs: 30_000,
  jobTimeoutMs: 120_000,
  maxRetries: 3,
};

export interface PersistedGeneration {
  id: string;
  baseGenerationId: string | null;
  firstKeptEntryId: string;
  throughEntryId: string;
  compiled: Omit<CompiledContext, "firstKeptSeq" | "throughSeq">;
  createdAt: number;
  source: ContextGeneration["source"];
}

export interface ManagerHooks {
  persist?: (gen: PersistedGeneration) => void;
  log?: (line: string) => void;
  now?: () => number;
  newId?: () => string;
}

export interface UsageSample {
  percent: number | null;
  tokens: number | null;
  contextWindow: number;
}

let idCounter = 0;
const defaultId = () => `g${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/**
 * Owns the event log, the active context generation and the background job.
 *
 * Invariants enforced here:
 *  - the log is append-only per epoch; a branch change bumps the epoch
 *  - a job records its snapshot boundary and base generation
 *  - only trySwap() changes the active generation, and only when the job is
 *    still consistent with the log and the active generation
 *  - failures never throw out of the manager; they are recorded and retried later
 */
export class HotCompactionManager {
  readonly log = new EventLog();
  config: HotCompactionConfig;
  private compiler: ContextCompiler;
  private hooks: ManagerHooks;
  private activeGen: ContextGeneration | null = null;
  private job: CompactionJob | null = null;
  private abort: AbortController | null = null;
  private lastFinishedAt = 0;
  private failures = 0;
  private enabledValue = true;
  history: CompactionJob[] = [];

  constructor(compiler: ContextCompiler, config: Partial<HotCompactionConfig> = {}, hooks: ManagerHooks = {}) {
    this.compiler = compiler;
    this.config = { ...DEFAULT_HOT_CONFIG, ...config };
    this.hooks = hooks;
  }

  get active(): ContextGeneration | null {
    return this.activeGen;
  }
  get currentJob(): CompactionJob | null {
    return this.job;
  }
  get enabled(): boolean {
    return this.enabledValue;
  }
  set enabled(v: boolean) {
    this.enabledValue = v;
    if (!v) this.cancelJob("disabled");
  }

  private now(): number {
    return (this.hooks.now ?? Date.now)();
  }
  private debug(line: string): void {
    this.hooks.log?.(line);
  }

  /** Sync with the current branch. A diverged branch invalidates the generation and any job. */
  syncBranch(entries: EntryLike[]): void {
    const diverged = this.log.sync(entries);
    if (diverged) {
      this.debug(`branch diverged; epoch ${this.log.epoch}`);
      this.activeGen = null;
      this.cancelJob("branch changed");
    }
  }

  reset(): void {
    this.cancelJob("reset");
    this.activeGen = null;
    this.log.sync([]);
    this.failures = 0;
    this.lastFinishedAt = 0;
    this.history = [];
  }

  /** Restore the newest persisted generation whose boundaries still exist on the branch. */
  restore(persisted: PersistedGeneration[]): ContextGeneration | null {
    for (let i = persisted.length - 1; i >= 0; i--) {
      const p = persisted[i];
      const firstKeptSeq = this.log.seqOf(p.firstKeptEntryId);
      const throughSeq = this.log.seqOf(p.throughEntryId);
      if (firstKeptSeq === undefined || throughSeq === undefined) continue;
      this.activeGen = {
        id: p.id,
        epoch: this.log.epoch,
        baseGenerationId: p.baseGenerationId,
        compiled: { ...p.compiled, firstKeptSeq, throughSeq },
        createdAt: p.createdAt,
        source: "restored",
      };
      this.debug(`restored generation ${p.id} (kept from #${firstKeptSeq})`);
      return this.activeGen;
    }
    return null;
  }

  /** Adopt a compaction entry pi wrote (native path). pi injects its summary itself. */
  adoptNative(entry: { id: string; summary: string; firstKeptEntryId: string }, compiled?: CompiledContext): ContextGeneration | null {
    const firstKeptSeq = this.log.seqOf(entry.firstKeptEntryId);
    const throughSeq = this.log.seqOf(entry.id);
    if (firstKeptSeq === undefined || throughSeq === undefined) return null;
    const base = compiled ?? {
      checkpoint: entry.summary,
      sections: { sessionGoal: [], filesAndChanges: [], commits: [], outstandingContext: [], userPreferences: [], briefTranscript: [], omittedTurns: 0 },
      estimatedTokens: Math.ceil(entry.summary.length / 4),
      compiler: "native",
      firstKeptEntryId: entry.firstKeptEntryId,
      throughEntryId: entry.id,
      firstKeptSeq,
      throughSeq,
    };
    this.cancelJob("native compaction");
    this.activeGen = {
      id: (this.hooks.newId ?? defaultId)(),
      epoch: this.log.epoch,
      baseGenerationId: this.activeGen?.id ?? null,
      compiled: { ...base, firstKeptSeq, throughSeq, native: true, firstKeptEntryId: entry.firstKeptEntryId, throughEntryId: entry.id },
      createdAt: this.now(),
      source: "native",
    };
    this.lastFinishedAt = this.now();
    return this.activeGen;
  }

  /** Estimated tokens of events newer than the active generation's snapshot. */
  deltaTokens(): number {
    const from = this.activeGen ? this.activeGen.compiled.throughSeq + 1 : 0;
    return estimateMessagesTokens(this.log.messageEvents(from).map((e) => e.message!));
  }

  /** Decide whether to start a job for the given usage. Returns the reason it did not, or null when started. */
  maybeStart(usage: UsageSample): string | null {
    if (!this.enabledValue) return "disabled";
    if (usage.percent === null) return "usage unknown";
    if (usage.percent < this.config.startPercent) return "below threshold";
    if (this.job?.status === "running") return "job running";
    if (this.job?.status === "ready") return "job ready";
    if (this.now() - this.lastFinishedAt < this.config.cooldownMs) return "cooldown";
    if (this.failures >= this.config.maxRetries) return "retries exhausted";
    if (this.activeGen && this.deltaTokens() < this.config.minDeltaTokens) return "not enough new material";
    this.start("hot");
    return null;
  }

  /** Snapshot the log and compile in the background. */
  start(mode: "hot" | "emergency" = "hot"): CompactionJob | null {
    if (this.job?.status === "running") return this.job;
    if (this.log.size === 0) return null;
    let snapshot;
    try {
      snapshot = this.compiler.snapshot({ events: this.log.all(), epoch: this.log.epoch, base: this.activeGen, tailTokens: this.config.tailTokens });
    } catch (err) {
      this.debug(`snapshot failed: ${String(err)}`);
      return null;
    }
    const job: CompactionJob = {
      id: (this.hooks.newId ?? defaultId)(),
      epoch: snapshot.epoch,
      snapshotThroughSeq: snapshot.throughSeq,
      snapshotThroughEntryId: snapshot.throughEntryId,
      baseGeneration: this.activeGen?.id ?? null,
      status: "running",
      mode,
      startedAt: this.now(),
    };
    this.job = job;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const timer = setTimeout(() => this.abort?.abort(new Error("timeout")), this.config.jobTimeoutMs);
    this.debug(`job ${job.id} started (through #${job.snapshotThroughSeq}, base ${job.baseGeneration ?? "none"}, ${mode})`);
    this.compiler
      .compile(snapshot, { signal, deterministicOnly: mode === "emergency" })
      .then((compiled) => {
        if (this.job !== job) return;
        job.compiled = compiled;
        job.status = "ready";
        job.finishedAt = this.now();
        this.debug(`job ${job.id} ready (kept from #${compiled.firstKeptSeq}, ~${compiled.estimatedTokens} tokens)`);
      })
      .catch((err: unknown) => {
        if (this.job !== job) return;
        job.status = "failed";
        job.finishedAt = this.now();
        job.error = err instanceof Error ? err.message : String(err);
        this.lastFinishedAt = this.now();
        if (!(err instanceof NothingToCompactError)) this.failures++;
        this.debug(`job ${job.id} failed: ${job.error}`);
      })
      .finally(() => clearTimeout(timer));
    return job;
  }

  /** Deterministic compile and swap right now (no LLM). Used above the hard threshold. */
  emergency(): ContextGeneration | null {
    this.cancelJob("emergency");
    try {
      const snapshot = this.compiler.snapshot({ events: this.log.all(), epoch: this.log.epoch, base: this.activeGen, tailTokens: this.config.tailTokens });
      const compiled = this.compiler.compileSync(snapshot, { deterministicOnly: true });
      const job: CompactionJob = {
        id: (this.hooks.newId ?? defaultId)(),
        epoch: snapshot.epoch,
        snapshotThroughSeq: snapshot.throughSeq,
        snapshotThroughEntryId: snapshot.throughEntryId,
        baseGeneration: this.activeGen?.id ?? null,
        status: "ready",
        mode: "emergency",
        startedAt: this.now(),
        finishedAt: this.now(),
        compiled,
      };
      this.job = job;
      return this.trySwap();
    } catch (err) {
      this.debug(`emergency compile failed: ${String(err)}`);
      return null;
    }
  }

  /** Compile synchronously with a caller-chosen boundary (pi's native compaction path). */
  compileAt(firstKeptEntryId: string): CompiledContext | null {
    const firstKeptSeq = this.log.seqOf(firstKeptEntryId);
    if (firstKeptSeq === undefined) return null;
    try {
      const snapshot = this.compiler.snapshot({ events: this.log.all(), epoch: this.log.epoch, base: this.activeGen, tailTokens: this.config.tailTokens });
      return this.compiler.compileSync(snapshot, { deterministicOnly: true, firstKeptSeq });
    } catch (err) {
      this.debug(`compileAt failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Apply a ready job if it is still consistent with the log. Called at a safe
   * boundary (before an LLM call). Stale results are discarded, never applied.
   */
  trySwap(): ContextGeneration | null {
    const job = this.job;
    if (!job || job.status !== "ready" || !job.compiled) return null;
    const reason = this.staleReason(job);
    if (reason) {
      job.status = "stale";
      job.error = reason;
      this.finishJob(job);
      this.debug(`job ${job.id} stale: ${reason}`);
      return null;
    }
    const gen: ContextGeneration = {
      id: (this.hooks.newId ?? defaultId)(),
      epoch: job.epoch,
      baseGenerationId: job.baseGeneration,
      compiled: job.compiled,
      createdAt: this.now(),
      source: job.mode === "emergency" ? "emergency" : "hot",
    };
    this.activeGen = gen;
    job.status = "applied";
    this.failures = 0;
    this.finishJob(job);
    const { firstKeptSeq: _f, throughSeq: _t, ...rest } = gen.compiled;
    this.hooks.persist?.({
      id: gen.id,
      baseGenerationId: gen.baseGenerationId,
      firstKeptEntryId: gen.compiled.firstKeptEntryId,
      throughEntryId: gen.compiled.throughEntryId,
      compiled: rest,
      createdAt: gen.createdAt,
      source: gen.source,
    });
    this.debug(`generation ${gen.id} active (kept from #${gen.compiled.firstKeptSeq}, through #${gen.compiled.throughSeq})`);
    return gen;
  }

  private staleReason(job: CompactionJob): string | null {
    if (job.epoch !== this.log.epoch) return "epoch changed";
    if ((this.activeGen?.id ?? null) !== job.baseGeneration) return "base generation changed";
    const through = this.log.get(job.snapshotThroughSeq);
    if (!through || through.id !== job.snapshotThroughEntryId) return "snapshot boundary no longer on branch";
    const c = job.compiled!;
    const kept = this.log.get(c.firstKeptSeq);
    if (!kept || kept.id !== c.firstKeptEntryId) return "kept boundary no longer on branch";
    if (this.activeGen && c.firstKeptSeq <= this.activeGen.compiled.firstKeptSeq) return "would not advance the boundary";
    return null;
  }

  private finishJob(job: CompactionJob): void {
    this.lastFinishedAt = this.now();
    this.history.push(job);
    if (this.history.length > 20) this.history.shift();
    if (this.job === job) {
      this.job = null;
      this.abort = null;
    }
  }

  cancelJob(reason: string): void {
    const job = this.job;
    if (!job) return;
    if (job.status === "running") this.abort?.abort(new Error(reason));
    job.status = job.status === "applied" ? "applied" : "stale";
    job.error = reason;
    this.finishJob(job);
  }

  /** Discard whatever is queued and allow a fresh job immediately. */
  clearFailures(): void {
    this.failures = 0;
    this.lastFinishedAt = 0;
  }

  status(): string {
    const gen = this.activeGen;
    const job = this.job;
    const parts: string[] = [];
    parts.push(gen ? `gen ${gen.id} (${gen.source}, kept from #${gen.compiled.firstKeptSeq}, ~${gen.compiled.estimatedTokens} tok checkpoint)` : "no generation");
    parts.push(job ? `job ${job.id} ${job.status} (through #${job.snapshotThroughSeq}${job.error ? `, ${job.error}` : ""})` : "no job");
    parts.push(`log #0–#${this.log.lastSeq} epoch ${this.log.epoch}`);
    if (this.failures) parts.push(`failures ${this.failures}/${this.config.maxRetries}`);
    return parts.join(" · ");
  }
}
