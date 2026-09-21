import type { EntryLike, Msg, SessionEvent } from "./types.ts";

/**
 * Immutable, append-only view of the current session branch.
 *
 * Every entry on the branch gets a monotonically increasing seq. If the branch
 * prefix changes underneath us (tree navigation, fork), the log restarts with a
 * new epoch so that every generation and job built on the old numbering is
 * recognisably stale.
 */
export class EventLog {
  private events: SessionEvent[] = [];
  private seqById = new Map<string, number>();
  private epochValue = 0;

  get epoch(): number {
    return this.epochValue;
  }

  get lastSeq(): number {
    return this.events.length - 1;
  }

  get size(): number {
    return this.events.length;
  }

  /** Reconcile with the current branch. Returns true when the epoch changed. */
  sync(entries: EntryLike[]): boolean {
    let common = 0;
    const n = Math.min(entries.length, this.events.length);
    while (common < n && entries[common].id === this.events[common].id) common++;
    const diverged = common < this.events.length;
    if (diverged) {
      this.events = [];
      this.seqById = new Map();
      this.epochValue++;
      common = 0;
    }
    for (let i = common; i < entries.length; i++) this.append(entries[i]);
    return diverged;
  }

  private append(entry: EntryLike): void {
    const seq = this.events.length;
    const ts = Date.parse(entry.timestamp);
    const raw = entryMessage(entry);
    const ev: SessionEvent = {
      seq,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: Number.isFinite(ts) ? ts : 0,
      type: entry.type,
      message: raw,
      rawMessage: raw,
      entry,
    };
    this.events.push(ev);
    this.seqById.set(entry.id, seq);
    if (entry.type === "context_edit" && entry.targetId) this.applyEdit(entry.targetId, entry.replacement ?? null);
  }

  // Latest edit on the branch wins (entries arrive in branch order); the raw message stays for recall.
  private applyEdit(targetId: string, replacement: EntryLike["replacement"]): void {
    const seq = this.seqById.get(targetId);
    if (seq === undefined) return;
    const target = this.events[seq];
    if (!target.rawMessage) return;
    target.message = replacement ? { ...target.rawMessage, content: replacement.content } : undefined;
  }

  get(seq: number): SessionEvent | undefined {
    return this.events[seq];
  }

  seqOf(entryId: string): number | undefined {
    return this.seqById.get(entryId);
  }

  all(): SessionEvent[] {
    return this.events.slice();
  }

  /** Events with fromSeq <= seq <= toSeq. */
  range(fromSeq: number, toSeq: number): SessionEvent[] {
    const from = Math.max(0, fromSeq);
    const to = Math.min(this.events.length - 1, toSeq);
    return from > to ? [] : this.events.slice(from, to + 1);
  }

  /** Events strictly after seq. */
  after(seq: number): SessionEvent[] {
    return this.events.slice(seq + 1);
  }

  /** Events that carry a context-visible message. */
  messageEvents(fromSeq = 0, toSeq = this.lastSeq): SessionEvent[] {
    return this.range(fromSeq, toSeq).filter((e) => e.message !== undefined);
  }
}

/** Map a session entry to the message the model would see, mirroring pi's context building. */
export function entryMessage(entry: EntryLike): Msg | undefined {
  const ts = Date.parse(entry.timestamp);
  const timestamp = Number.isFinite(ts) ? ts : 0;
  switch (entry.type) {
    case "message":
      return entry.message;
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp,
      };
    case "compaction":
      return { role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp };
    case "branch_summary":
      return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp };
    default:
      return undefined;
  }
}
