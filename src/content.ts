import type { ContentBlock, Msg, SessionEvent, ToolCallBlock } from "./types.ts";

export const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);

export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export const nonEmptyLines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

export function textOf(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

export function toolCallsOf(m: Msg): ToolCallBlock[] {
  if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
  return m.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
}

export function hasToolCalls(m: Msg): boolean {
  return toolCallsOf(m).length > 0;
}

/** Short one-line rendering of a tool call's arguments, e.g. bash("npm test"). */
export function formatToolCall(tc: ToolCallBlock, maxArgChars = 120): string {
  const args = tc.arguments ?? {};
  const primary = firstStringArg(args);
  if (primary !== undefined) return `${tc.name}(${JSON.stringify(clip(oneLine(primary), maxArgChars))})`;
  let json = "";
  try {
    json = JSON.stringify(args);
  } catch {
    json = "{…}";
  }
  return `${tc.name}(${clip(json, maxArgChars)})`;
}

const PRIMARY_ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "name"];

export function firstStringArg(args: Record<string, unknown>): string | undefined {
  for (const k of PRIMARY_ARG_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const v of Object.values(args)) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

/** Full searchable text of an event, used by recall and the brief transcript. */
export function eventText(ev: SessionEvent): string {
  const m = ev.rawMessage ?? ev.message;
  if (!m) {
    if (ev.type === "custom") return `[custom entry ${ev.entry.customType ?? ""}]`;
    return `[${ev.type}]`;
  }
  switch (m.role) {
    case "user":
    case "custom":
      return textOf(m.content);
    case "assistant": {
      const parts: string[] = [];
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "text") parts.push(b.text);
          else if (b.type === "toolCall") parts.push(`[tool call] ${formatToolCall(b, 4000)}`);
        }
      }
      if (m.errorMessage) parts.push(`[error] ${m.errorMessage}`);
      return parts.join("\n");
    }
    case "toolResult":
      return textOf(m.content);
    case "bashExecution":
      return `$ ${m.command ?? ""}\n${m.output ?? ""}`;
    case "compactionSummary":
    case "branchSummary":
      return m.summary ?? "";
    default:
      return textOf(m.content);
  }
}

export function roleLabel(ev: SessionEvent): string {
  const m = ev.rawMessage ?? ev.message;
  if (!m) return ev.type;
  if (m.role === "toolResult") return `tool:${m.toolName ?? "?"}`;
  if (m.role === "custom") return `custom:${m.customType ?? "?"}`;
  return m.role;
}

export function isoTime(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
