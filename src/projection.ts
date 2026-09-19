import { textOf } from "./content.ts";
import type { EventLog } from "./log.ts";
import type { CompiledContext, Context, Msg, ReconcileOptions, SessionEvent } from "./types.ts";

export const CHECKPOINT_CUSTOM_TYPE = "hot-compact-checkpoint";

/** Identity key used to align live context messages with logged events. */
export function messageKey(m: Msg): string {
  if (m.role === "toolResult") return `t:${m.toolCallId ?? ""}`;
  return `${m.role}:${m.timestamp ?? ""}`;
}

/**
 * Align the messages pi is about to send with the event log. Both lists are in
 * order and the context is a subsequence of the log, so a single forward walk
 * suffices. Messages not yet in the log (or not matchable) get a provisional
 * seq past the end and are always kept verbatim.
 */
export function alignMessages(messages: Msg[], log: EventLog): SessionEvent[] {
  const events = log.all();
  const out: SessionEvent[] = [];
  let p = 0;
  let provisional = log.lastSeq + 1;
  for (const m of messages) {
    const key = messageKey(m);
    let found = -1;
    for (let i = p; i < events.length; i++) {
      const em = events[i].message;
      if (em && messageKey(em) === key) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      out.push({ ...events[found], message: m });
      p = found + 1;
    } else {
      out.push({ seq: provisional++, id: "", parentId: null, timestamp: m.timestamp ?? 0, type: "pending", message: m, entry: { type: "pending", id: "", parentId: null, timestamp: "" } });
    }
  }
  return out;
}

export function checkpointMessage(compiled: CompiledContext, generationId: string, timestamp: number): Msg {
  return {
    role: "custom",
    customType: CHECKPOINT_CUSTOM_TYPE,
    content: compiled.checkpoint,
    display: false,
    details: { generationId, firstKeptSeq: compiled.firstKeptSeq, throughSeq: compiled.throughSeq },
    timestamp,
  };
}

/**
 * Build the model-visible context: checkpoint + every event from the verbatim
 * boundary on (tail and delta alike, exact), with old oversized tool outputs
 * collapsed to a reference the model can recall.
 */
export function reconcileDelta(compiled: CompiledContext, delta: SessionEvent[], opts: ReconcileOptions, generationId = "", timestamp = 0): Context {
  const kept = delta.filter((e) => e.seq >= compiled.firstKeptSeq && e.message);
  const dropped = delta.length - kept.length;
  const messages: Msg[] = [];
  let collapsed = 0;
  if (!compiled.native) messages.push(checkpointMessage(compiled, generationId, timestamp || (kept[0]?.timestamp ?? 0)));

  // Tool outputs in the last N user turns stay verbatim; older ones collapse.
  let recentStart = kept.length;
  let turns = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].message!.role === "user") {
      turns++;
      recentStart = i;
      if (turns >= opts.collapseKeepRecentTurns) break;
    }
  }
  if (turns < opts.collapseKeepRecentTurns) recentStart = 0;

  for (let i = 0; i < kept.length; i++) {
    const ev = kept[i];
    const m = ev.message!;
    if (i < recentStart && opts.collapseToolOutputChars > 0 && m.role === "toolResult" && ev.type !== "pending") {
      const text = textOf(m.content);
      if (text.length > opts.collapseToolOutputChars) {
        messages.push(collapseToolResult(m, text, ev.seq));
        collapsed++;
        continue;
      }
    }
    messages.push(m);
  }
  return { messages, generationId: generationId || null, droppedEvents: dropped, collapsedToolOutputs: collapsed };
}

export function collapseToolResult(m: Msg, text: string, seq: number): Msg {
  const lines = text.split("\n").length;
  const head = text.slice(0, 400).trimEnd();
  const tail = text.slice(-200).trimStart();
  const body = `[tool output collapsed: ${m.toolName ?? "tool"}${m.isError ? ", error" : ""}, ${text.length} chars, ${lines} lines. Full output: context_recall mode=event query=${seq} (event://${seq})]\n${head}\n…\n${tail}`;
  return { ...m, content: [{ type: "text", text: body }], details: undefined };
}
