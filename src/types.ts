/**
 * Core types for the context compiler and hot compaction.
 * Kept structural (no pi imports) so the core runs and tests without the harness.
 */

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ImageBlock {
  type: "image";
  data?: string;
  mimeType?: string;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;

/** Loose message shape matching pi's AgentMessage union. */
export interface Msg {
  role: string;
  timestamp?: number;
  content?: string | ContentBlock[];
  // toolResult
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  // assistant
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
  // bashExecution
  command?: string;
  output?: string;
  exitCode?: number;
  excludeFromContext?: boolean;
  // custom
  customType?: string;
  display?: boolean;
  // summaries
  summary?: string;
  tokensBefore?: number;
  [key: string]: unknown;
}

/** Minimal shape of a pi session entry that the event log consumes. */
export interface EntryLike {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: Msg;
  customType?: string;
  content?: string | ContentBlock[];
  display?: boolean;
  details?: unknown;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  fromId?: string;
  data?: unknown;
  // context_edit
  targetId?: string;
  replacement?: { content: string | ContentBlock[] } | null;
  [key: string]: unknown;
}

/** One event in the immutable log: a session entry with a monotonically increasing seq. */
export interface SessionEvent {
  seq: number;
  id: string;
  parentId: string | null;
  timestamp: number;
  type: string;
  /** Model-visible message after context edits; undefined when the entry carries none or was omitted. */
  message?: Msg;
  /** Message as stored in the entry, before context edits. Recall reads this. */
  rawMessage?: Msg;
  entry: EntryLike;
}

export interface DeterministicSections {
  sessionGoal: string[];
  filesAndChanges: string[];
  commits: string[];
  outstandingContext: string[];
  userPreferences: string[];
  briefTranscript: string[];
  /** Turns dropped from the brief transcript to fit the budget. */
  omittedTurns: number;
}

export interface ContextSnapshot {
  id: string;
  epoch: number;
  throughSeq: number;
  throughEntryId: string;
  /** All events with seq <= throughSeq. */
  events: SessionEvent[];
  /** Active generation at snapshot time, if any. */
  base: ContextGeneration | null;
  tailTokens: number;
  createdAt: number;
}

export interface CompiledContext {
  /** Text stored as the compaction summary in place of the compacted prefix. */
  checkpoint: string;
  /** First event kept verbatim. Everything before it is represented by the checkpoint. */
  firstKeptSeq: number;
  firstKeptEntryId: string;
  throughSeq: number;
  throughEntryId: string;
  sections: DeterministicSections;
  semantic?: string;
  estimatedTokens: number;
  compiler: string;
  /** True when the summary was not written by this extension (pi's own or another extension's compaction). */
  foreign?: boolean;
}

export type GenerationSource = "hot" | "emergency" | "native" | "foreign";

/** The active generation: whatever the latest compaction entry on the branch says. */
export interface ContextGeneration {
  /** Id of the compaction entry that carries this generation. */
  id: string;
  epoch: number;
  compiled: CompiledContext;
  createdAt: number;
  source: GenerationSource;
}

/** Stored in CompactionEntry.details by this extension. */
export interface HotCompactDetails {
  hotCompact: true;
  source: "hot" | "emergency" | "native";
  compiler: string;
  sections: DeterministicSections;
  semantic?: string;
  /** Last event in the compile snapshot, so the next semantic span starts after it. */
  throughEntryId: string;
}

export type JobStatus = "running" | "ready" | "stale" | "failed" | "applied";

export interface CompactionJob {
  id: string;
  epoch: number;
  snapshotThroughSeq: number;
  snapshotThroughEntryId: string;
  baseGeneration: string | null;
  status: JobStatus;
  mode: "hot" | "emergency";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** Failed only because there was nothing to compact; not an error condition. */
  noop?: boolean;
  compiled?: CompiledContext;
}

export interface SnapshotInput {
  events: SessionEvent[];
  epoch: number;
  base: ContextGeneration | null;
  tailTokens: number;
}

export interface CompileOptions {
  signal?: AbortSignal;
  /** Skip the LLM layer (emergency and synchronous paths). */
  deterministicOnly?: boolean;
  /** Force the verbatim boundary (used when pi picks the cut point). */
  firstKeptSeq?: number;
}

export interface CollapseOptions {
  /** Collapse tool outputs longer than this many chars (0 disables). */
  collapseToolOutputChars: number;
  /** Tool outputs inside the most recent N user turns are never collapsed. */
  collapseKeepRecentTurns: number;
}

/** A tool result to replace through a context_edit entry. */
export interface CollapsePlan {
  seq: number;
  targetId: string;
  text: string;
}

export interface ContextCompiler {
  readonly name: string;
  snapshot(input: SnapshotInput): ContextSnapshot;
  compile(snapshot: ContextSnapshot, options?: CompileOptions): Promise<CompiledContext>;
  /** Synchronous, deterministic-only compile for emergency and native-compaction paths. */
  compileSync(snapshot: ContextSnapshot, options?: CompileOptions): CompiledContext;
}

export class NothingToCompactError extends Error {
  constructor(message = "nothing to compact") {
    super(message);
    this.name = "NothingToCompactError";
  }
}
