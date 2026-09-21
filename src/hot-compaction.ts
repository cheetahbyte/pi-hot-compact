import { EventLog } from "./log.ts";
import { estimateMessagesTokens, tokensForText } from "./tokens.ts";
import type { CompactionJob, CompiledContext, ContextCompiler, ContextGeneration, DeterministicSections, EntryLike, HotCompactDetails } from "./types.ts";
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

export interface ManagerHooks {
  log?: (line: string) => void;
  /** Called after any job or generation state change. */
  onChange?: () => void;
  now?: () => number;
  newId?: () => string;
}

export interface UsageSample {
  percent: number | null;
  tokens: number | null;
  contextWindow: number;
}

/** A compiled result the caller commits as a compaction entry at the next boundary. */
export interface ReadyResult {
  jobId: string;
  mode: "hot" | "emergency";
  compiled: CompiledContext;
}

let idCounter = 0;
const defaultId = () => `g${Date.now().toString(36)}${(idCounter++).toString(36)}`;

const EMPTY_SECTIONS: DeterministicSections = { sessionGoal: [], filesAndChanges: [], commits: [], outstandingContext: [], userPreferences: [], briefTranscript: [], omittedTurns: 0 };

export function isHotCompactDetails(d: unknown): d is HotCompactDetails {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { hotCompact?: unknown; sections?: { briefTranscript?: unknown }; throughEntryId?: unknown };
  return o.hotCompact === true && Array.isArray(o.sections?.briefTranscript) && typeof o.throughEntryId === "string";
}

/** Details this extension stores on every compaction entry it produces. */
export function compactionDetails(compiled: CompiledContext, source: HotCompactDetails["source"]): HotCompactDetails {
  return { hotCompact: true, source, compiler: compiled.compiler, sections: compiled.sections, semantic: compiled.semantic, throughEntryId: compiled.throughEntryId };
}

/**
 * Read the active generation back from the latest compaction entry on the branch.
 * pi owns persistence, restore, fork and tree handling; nothing is stored elsewhere.
 */
export function generationFromLog(log: EventLog): ContextGeneration | null {
  const events = log.all();
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "compaction") continue;
    const entry = ev.entry;
    const keptId = entry.firstKeptEntryId ?? "";
    const firstKeptSeq = keptId === ev.id ? ev.seq : log.seqOf(keptId);
    if (firstKeptSeq === undefined) return null;
    const summary = entry.summary ?? "";
    const d = entry.details;
    const ours = isHotCompactDetails(d);
    const throughEntryId = ours ? d.throughEntryId : ev.id;
    const throughSeq = log.seqOf(throughEntryId) ?? ev.seq;
    return {
      id: ev.id,
      epoch: log.epoch,
      createdAt: ev.timestamp,
      source: ours ? d.source : "foreign",
      compiled: {
        checkpoint: summary,
        firstKeptSeq,
        firstKeptEntryId: keptId,
        throughSeq,
        throughEntryId,
        sections: ours ? d.sections : EMPTY_SECTIONS,
        semantic: ours ? d.semantic : undefined,
        estimatedTokens: tokensForText(summary),
        compiler: ours ? d.compiler : "foreign",
        foreign: !ours,
      },
    };
  }
  return null;
}

/**
 * Owns the event log and the background job. The active generation is derived
 * from the branch on every sync.
 *
 * Invariants enforced here:
 *  - the log is append-only per epoch; a branch change bumps the epoch
 *  - a job records its snapshot boundary and base generation
 *  - takeReady() hands a result out only when the job is still consistent with
 *    the log and the active generation; stale results are discarded
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
  private changed(): void {
    try {
      this.hooks.onChange?.();
    } catch {
      /* observers must not break compaction */
    }
  }

  /** Sync with the current branch and re-derive the active generation from it. */
  syncBranch(entries: EntryLike[]): void {
    const diverged = this.log.sync(entries);
    if (diverged) {
      this.debug(`branch diverged; epoch ${this.log.epoch}`);
      this.cancelJob("branch changed");
    }
    const gen = generationFromLog(this.log);
    if (gen?.id === this.activeGen?.id && gen?.epoch === this.activeGen?.epoch) return;
    this.activeGen = gen;
    if (gen) {
      this.lastFinishedAt = this.now();
      if (this.job && this.job.baseGeneration !== gen.id) this.cancelJob("generation changed");
    }
    this.debug(gen ? `active generation ${gen.id} (${gen.source}, kept from #${gen.compiled.firstKeptSeq})` : "no active generation");
    this.changed();
  }

  reset(): void {
    this.cancelJob("reset");
    this.activeGen = null;
    this.log.sync([]);
    this.failures = 0;
    this.lastFinishedAt = 0;
    this.history = [];
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
    this.changed();
    this.compiler
      .compile(snapshot, { signal, deterministicOnly: mode === "emergency" })
      .then((compiled) => {
        if (this.job !== job) return;
        job.compiled = compiled;
        job.status = "ready";
        job.finishedAt = this.now();
        this.debug(`job ${job.id} ready (kept from #${compiled.firstKeptSeq}, ~${compiled.estimatedTokens} tokens)`);
        this.changed();
      })
      .catch((err: unknown) => {
        if (this.job !== job) return;
        job.status = "failed";
        job.finishedAt = this.now();
        job.error = err instanceof Error ? err.message : String(err);
        this.lastFinishedAt = this.now();
        if (err instanceof NothingToCompactError) job.noop = true;
        else this.failures++;
        this.debug(`job ${job.id} failed: ${job.error}`);
        this.changed();
      })
      .finally(() => clearTimeout(timer));
    return job;
  }

  /** Deterministic compile right now (no LLM) for the hard threshold. The caller commits the result. */
  emergency(): ReadyResult | null {
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
        status: "applied",
        mode: "emergency",
        startedAt: this.now(),
        finishedAt: this.now(),
        compiled,
      };
      this.history.push(job);
      if (this.history.length > 20) this.history.shift();
      this.lastFinishedAt = this.now();
      this.changed();
      return { jobId: job.id, mode: "emergency", compiled };
    } catch (err) {
      if (!(err instanceof NothingToCompactError)) this.debug(`emergency compile failed: ${String(err)}`);
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
   * Hand out a ready job's result for the caller to commit as a compaction entry,
   * if the job is still consistent with the log. Stale results are discarded, never applied.
   */
  takeReady(): ReadyResult | null {
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
    job.status = "applied";
    this.failures = 0;
    this.finishJob(job);
    this.debug(`job ${job.id} handed out (kept from #${job.compiled.firstKeptSeq}, through #${job.compiled.throughSeq})`);
    return { jobId: job.id, mode: job.mode, compiled: job.compiled };
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
    this.changed();
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
