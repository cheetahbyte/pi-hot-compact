import { findTailCut, snapToCutPoint } from "../tail.ts";
import { tokensForText } from "../tokens.ts";
import type {
  CompiledContext,
  CompileOptions,
  ContextCompiler,
  ContextSnapshot,
  DeterministicSections,
  SessionEvent,
  SnapshotInput,
} from "../types.ts";
import { NothingToCompactError } from "../types.ts";
import { compileDeterministic, renderSections, type DeterministicOptions } from "./deterministic.ts";
import { compileSemantic, type CompleteFn, type SemanticOptions } from "./semantic.ts";

export interface HybridOptions {
  deterministic: Partial<DeterministicOptions>;
  semantic: Partial<SemanticOptions>;
  /** LLM completion for the semantic layer; undefined disables it. */
  complete?: CompleteFn;
  /** Upper bound for the rendered checkpoint. Semantic text is dropped first, then the brief transcript shrinks. */
  maxCheckpointTokens: number;
  now?: () => number;
  newId?: () => string;
}

let counter = 0;
const defaultId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * Hybrid compiler: deterministic sections recomputed from raw history plus an
 * optional LLM semantic checkpoint over the span leaving the tail.
 */
export class HybridCompiler implements ContextCompiler {
  readonly name = "hybrid";
  private opts: HybridOptions;

  constructor(options: Partial<HybridOptions> = {}) {
    this.opts = {
      deterministic: {},
      semantic: {},
      maxCheckpointTokens: 12_000,
      ...options,
    };
  }

  setComplete(fn: CompleteFn | undefined): void {
    this.opts.complete = fn;
  }

  snapshot(input: SnapshotInput): ContextSnapshot {
    const events = input.events.slice();
    const last = events[events.length - 1];
    if (!last) throw new NothingToCompactError("empty log");
    return {
      id: (this.opts.newId ?? defaultId)(),
      epoch: input.epoch,
      throughSeq: last.seq,
      throughEntryId: last.id,
      events,
      base: input.base,
      tailTokens: input.tailTokens,
      createdAt: (this.opts.now ?? Date.now)(),
    };
  }

  private plan(snapshot: ContextSnapshot, options: CompileOptions): { firstKeptSeq: number; region: SessionEvent[]; firstKeptEntryId: string } {
    let firstKeptSeq: number;
    if (options.firstKeptSeq !== undefined) firstKeptSeq = snapToCutPoint(snapshot.events, options.firstKeptSeq);
    else {
      const cut = findTailCut(snapshot.events, snapshot.tailTokens);
      if (!cut) throw new NothingToCompactError("everything fits in the tail");
      firstKeptSeq = cut.firstKeptSeq;
    }
    const region = snapshot.events.filter((e) => e.seq < firstKeptSeq && e.message);
    if (region.length === 0) throw new NothingToCompactError("no events before the cut");
    const base = snapshot.base?.compiled;
    // Compacting less than the base generation would grow the context; treat as nothing to do.
    if (base && firstKeptSeq <= base.firstKeptSeq && options.firstKeptSeq === undefined) throw new NothingToCompactError("cut is not past the active generation");
    const kept = snapshot.events.find((e) => e.seq === firstKeptSeq);
    return { firstKeptSeq, region, firstKeptEntryId: kept?.id ?? "" };
  }

  compileSync(snapshot: ContextSnapshot, options: CompileOptions = {}): CompiledContext {
    const { firstKeptSeq, region, firstKeptEntryId } = this.plan(snapshot, options);
    const sections = compileDeterministic(region, this.opts.deterministic);
    // Carry the previous semantic checkpoint forward untouched; it still describes a prefix of the region.
    const semantic = snapshot.base?.compiled.semantic;
    return this.assemble(snapshot, sections, semantic, firstKeptSeq, firstKeptEntryId);
  }

  async compile(snapshot: ContextSnapshot, options: CompileOptions = {}): Promise<CompiledContext> {
    const { firstKeptSeq, region, firstKeptEntryId } = this.plan(snapshot, options);
    const sections = compileDeterministic(region, this.opts.deterministic);
    let semantic = snapshot.base?.compiled.semantic;
    if (!options.deterministicOnly && this.opts.complete) {
      const base = snapshot.base?.compiled;
      const spanStart = base ? base.firstKeptSeq : 0;
      const span = region.filter((e) => e.seq >= spanStart);
      const previous = base?.semantic ?? (base?.foreign ? base.checkpoint : undefined);
      semantic = await compileSemantic(span, previous, this.opts.complete, this.opts.semantic, options.signal);
    }
    return this.assemble(snapshot, sections, semantic, firstKeptSeq, firstKeptEntryId);
  }

  private assemble(snapshot: ContextSnapshot, sections: DeterministicSections, semantic: string | undefined, firstKeptSeq: number, firstKeptEntryId: string): CompiledContext {
    const build = (sec: DeterministicSections, sem: string | undefined) => renderCheckpoint(sec, sem, snapshot.throughSeq, firstKeptSeq);
    let text = build(sections, semantic);
    let sem = semantic;
    if (tokensForText(text) > this.opts.maxCheckpointTokens && sem) {
      sem = undefined;
      text = build(sections, sem);
    }
    let sec = sections;
    while (tokensForText(text) > this.opts.maxCheckpointTokens && sec.briefTranscript.length > 1) {
      const drop = Math.max(1, Math.floor(sec.briefTranscript.length / 4));
      sec = { ...sec, briefTranscript: [`… trimmed to fit the checkpoint budget (use context_recall)`, ...sec.briefTranscript.slice(drop + 1)] };
      text = build(sec, sem);
    }
    return {
      checkpoint: text,
      firstKeptSeq,
      firstKeptEntryId,
      throughSeq: snapshot.throughSeq,
      throughEntryId: snapshot.throughEntryId,
      sections: sec,
      semantic: sem,
      estimatedTokens: tokensForText(text),
      compiler: this.name,
    };
  }
}

export function renderCheckpoint(sections: DeterministicSections, semantic: string | undefined, throughSeq: number, firstKeptSeq: number): string {
  const head = `Earlier history of this session (events #0–#${firstKeptSeq - 1}) was compacted into this checkpoint. Events from #${firstKeptSeq} on follow verbatim. The full raw history is intact: call context_recall to retrieve anything omitted here (keyword, regex, event://N, tool call, file, or range lookup). Tool outputs shown as "collapsed" are recoverable the same way.`;
  const parts = [head, renderSections(sections)];
  if (semantic) parts.push(`[Semantic Checkpoint] (model-written, auxiliary; the sections above and the raw history are authoritative)\n${semantic}`);
  void throughSeq;
  return parts.join("\n\n");
}
