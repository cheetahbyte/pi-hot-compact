import { estimateMessageTokens } from "./tokens.ts";
import type { SessionEvent } from "./types.ts";

const CUTTABLE_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

export function isCutPoint(ev: SessionEvent): boolean {
  return ev.message !== undefined && CUTTABLE_ROLES.has(ev.message.role);
}

export interface TailCut {
  firstKeptSeq: number;
  tailTokens: number;
  atUserBoundary: boolean;
}

/**
 * Pick the first event kept verbatim so that the tail holds roughly `tailTokens`.
 *
 * Walks back from the newest event accumulating estimated tokens. The cut never
 * lands on a tool result (results stay with their call) and prefers the start
 * of a user turn when that costs at most `userBoundarySlack` extra of the budget.
 * Returns null when every message fits inside the tail.
 */
export function findTailCut(events: SessionEvent[], tailTokens: number, userBoundarySlack = 0.5): TailCut | null {
  const msgIdx: number[] = [];
  for (let i = 0; i < events.length; i++) if (events[i].message) msgIdx.push(i);
  if (msgIdx.length === 0) return null;

  let acc = 0;
  let cut = -1;
  for (let k = msgIdx.length - 1; k >= 0; k--) {
    const ev = events[msgIdx[k]];
    acc += estimateMessageTokens(ev.message!);
    if (acc >= tailTokens) {
      cut = k;
      break;
    }
  }
  if (cut <= 0) return null;

  // Never cut at a tool result: move back to the assistant that issued it.
  while (cut > 0 && !isCutPoint(events[msgIdx[cut]])) cut--;
  if (cut <= 0) return null;

  // Prefer a user turn boundary when it is cheap enough.
  let atUser = events[msgIdx[cut]].message!.role === "user";
  if (!atUser) {
    let extra = 0;
    for (let k = cut - 1; k >= 0; k--) {
      extra += estimateMessageTokens(events[msgIdx[k]].message!);
      if (extra > tailTokens * userBoundarySlack) break;
      if (events[msgIdx[k]].message!.role === "user") {
        cut = k;
        acc += extra;
        atUser = true;
        break;
      }
    }
  }
  if (cut <= 0) return null;
  return { firstKeptSeq: events[msgIdx[cut]].seq, tailTokens: acc, atUserBoundary: atUser };
}

/** Snap an arbitrary seq forward to the nearest valid cut point (or back to an assistant for orphaned tool results). */
export function snapToCutPoint(events: SessionEvent[], seq: number): number {
  const idx = events.findIndex((e) => e.seq === seq);
  if (idx < 0) return seq;
  for (let i = idx; i >= 0; i--) {
    if (!events[i].message) continue;
    if (isCutPoint(events[i])) return events[i].seq;
  }
  return events[0]?.seq ?? seq;
}
