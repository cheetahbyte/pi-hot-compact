import { textOf } from "./content.ts";
import type { EventLog } from "./log.ts";
import type { CollapseOptions, CollapsePlan, Msg } from "./types.ts";

/**
 * Tool results that left the most recent `collapseKeepRecentTurns` user turns and exceed
 * `collapseToolOutputChars` become context_edit replacements. Only events the model still
 * sees (seq >= firstKeptSeq) that were not edited yet are candidates.
 */
export function planCollapses(log: EventLog, firstKeptSeq: number, opts: CollapseOptions): CollapsePlan[] {
  if (opts.collapseToolOutputChars <= 0) return [];
  const kept = log.messageEvents(firstKeptSeq);
  let recentStart = kept.length;
  let turns = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].message!.role === "user") {
      turns++;
      recentStart = i;
      if (turns >= opts.collapseKeepRecentTurns) break;
    }
  }
  if (turns < opts.collapseKeepRecentTurns) return [];
  const out: CollapsePlan[] = [];
  for (let i = 0; i < recentStart; i++) {
    const ev = kept[i];
    const m = ev.message!;
    if (m.role !== "toolResult" || ev.message !== ev.rawMessage) continue;
    const text = textOf(m.content);
    if (text.length <= opts.collapseToolOutputChars) continue;
    out.push({ seq: ev.seq, targetId: ev.id, text: collapseToolResult(m, text, ev.seq) });
  }
  return out;
}

export function collapseToolResult(m: Msg, text: string, seq: number): string {
  const lines = text.split("\n").length;
  const head = text.slice(0, 400).trimEnd();
  const tail = text.slice(-200).trimStart();
  return `[tool output collapsed: ${m.toolName ?? "tool"}${m.isError ? ", error" : ""}, ${text.length} chars, ${lines} lines. Full output: context_recall mode=event query=${seq} (event://${seq})]\n${head}\n…\n${tail}`;
}
