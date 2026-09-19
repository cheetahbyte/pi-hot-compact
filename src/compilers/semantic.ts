import { clip, formatToolCall, oneLine, textOf, toolCallsOf } from "../content.ts";
import type { SessionEvent } from "../types.ts";

/**
 * Semantic checkpoint: an LLM pass over the span of raw history that is
 * leaving the verbatim tail. Auxiliary only; the deterministic sections and the
 * raw log stay authoritative, and the prompt says so.
 */

export type CompleteFn = (prompt: string, signal?: AbortSignal) => Promise<string>;

export interface SemanticOptions {
  /** Character budget for the serialized span. Oldest events are dropped first. */
  maxInputChars: number;
  toolResultChars: number;
}

export const DEFAULT_SEMANTIC: SemanticOptions = { maxInputChars: 160_000, toolResultChars: 1500 };

export const SEMANTIC_SECTIONS = [
  "Architecture Decisions",
  "Important Constraints",
  "Current Hypotheses",
  "Decisions And Rationale",
  "Known Failures",
  "Unresolved Questions",
  "Current Work",
  "Next Steps",
  "Critical Context",
];

export function serializeSpan(events: SessionEvent[], opts: SemanticOptions): { text: string; dropped: number } {
  const lines: string[] = [];
  for (const ev of events) {
    const m = ev.message;
    if (!m) continue;
    switch (m.role) {
      case "user":
        lines.push(`[#${ev.seq} User]: ${textOf(m.content)}`);
        break;
      case "assistant": {
        const text = textOf(m.content).trim();
        if (text) lines.push(`[#${ev.seq} Assistant]: ${text}`);
        const calls = toolCallsOf(m);
        if (calls.length) lines.push(`[#${ev.seq} Assistant tool calls]: ${calls.map((c) => formatToolCall(c, 300)).join("; ")}`);
        if (m.errorMessage) lines.push(`[#${ev.seq} Assistant error]: ${m.errorMessage}`);
        break;
      }
      case "toolResult":
        lines.push(`[#${ev.seq} Tool result ${m.toolName ?? ""}${m.isError ? " (error)" : ""}]: ${clip(textOf(m.content), opts.toolResultChars)}`);
        break;
      case "bashExecution":
        lines.push(`[#${ev.seq} User bash]: $ ${m.command ?? ""}\n${clip(m.output ?? "", opts.toolResultChars)}`);
        break;
      case "custom":
        lines.push(`[#${ev.seq} Extension message]: ${clip(textOf(m.content), opts.toolResultChars)}`);
        break;
      case "compactionSummary":
      case "branchSummary":
        lines.push(`[#${ev.seq} Earlier summary]: ${m.summary ?? ""}`);
        break;
    }
  }
  let dropped = 0;
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  while (lines.length > 1 && total > opts.maxInputChars) {
    total -= lines[0].length + 1;
    lines.shift();
    dropped++;
  }
  const head = dropped ? `[… ${dropped} earlier lines omitted for budget …]\n` : "";
  return { text: head + lines.join("\n"), dropped };
}

export function buildSemanticPrompt(spanText: string, previous: string | undefined, fromSeq: number, toSeq: number): string {
  const sections = SEMANTIC_SECTIONS.map((s) => `[${s}]`).join("\n");
  const prev = previous ? `\n\nA previous checkpoint exists. Update it with the new span; keep still-valid items, drop superseded ones, never re-add anything the new events contradict:\n<previous_checkpoint>\n${previous}\n</previous_checkpoint>` : "";
  return `You are a context checkpoint writer for a coding agent session. Below is a span of raw session history (events #${fromSeq} to #${toSeq}). Produce a checkpoint that captures what a mechanical extractor would miss: reasoning, decisions, hypotheses, failures, and open questions.

Rules:
- Do NOT continue the conversation or answer anything in it. Output only the checkpoint.
- Only state what the events support. Never invent files, commands, results, or decisions. If unsure, omit.
- Cite event numbers like (#123) so details can be recalled later.
- Be concrete and terse. Empty sections are fine: write "- (none)".
- Use exactly these section headers, in this order:
${sections}${prev}

<span>
${spanText}
</span>`;
}

export async function compileSemantic(
  events: SessionEvent[],
  previous: string | undefined,
  complete: CompleteFn,
  options: Partial<SemanticOptions> = {},
  signal?: AbortSignal,
): Promise<string> {
  const opts = { ...DEFAULT_SEMANTIC, ...options };
  const msgEvents = events.filter((e) => e.message);
  if (msgEvents.length === 0) return previous ?? "";
  const { text } = serializeSpan(msgEvents, opts);
  const prompt = buildSemanticPrompt(text, previous, msgEvents[0].seq, msgEvents[msgEvents.length - 1].seq);
  const out = (await complete(prompt, signal)).trim();
  if (!validateSemantic(out)) throw new Error("semantic checkpoint failed validation");
  return out;
}

/** Reject empty or clearly off-format output so a bad summary never lands in context. */
export function validateSemantic(text: string): boolean {
  if (!text || text.length < 20) return false;
  if (text.length > 60_000) return false;
  const hits = SEMANTIC_SECTIONS.filter((s) => text.includes(`[${s}]`)).length;
  return hits >= 4;
}

export function summarizeForLog(text: string): string {
  return clip(oneLine(text), 120);
}
