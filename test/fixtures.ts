import type { ContentBlock, EntryLike, Msg } from "../src/types.ts";

let ts = Date.parse("2026-09-19T10:00:00Z");
let n = 0;

export function resetFixtures(): void {
  ts = Date.parse("2026-09-19T10:00:00Z");
  n = 0;
}

function entry(message: Msg, prev: EntryLike | null): EntryLike {
  ts += 1000;
  const id = `e${n++}`;
  return { type: "message", id, parentId: prev?.id ?? null, timestamp: new Date(ts).toISOString(), message: { ...message, timestamp: ts } };
}

export class SessionBuilder {
  entries: EntryLike[] = [];
  private calls = 0;

  private last(): EntryLike | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  user(text: string): this {
    this.entries.push(entry({ role: "user", content: text }, this.last()));
    return this;
  }

  assistant(text: string, tools: { name: string; args: Record<string, unknown>; result: string; isError?: boolean }[] = []): this {
    const content: Msg["content"] = [];
    if (text) content.push({ type: "text", text });
    const ids: string[] = [];
    for (const t of tools) {
      const id = `call_${this.calls++}`;
      ids.push(id);
      content.push({ type: "toolCall", id, name: t.name, arguments: t.args });
    }
    this.entries.push(entry({ role: "assistant", content, stopReason: tools.length ? "toolUse" : "stop", provider: "test", model: "test-model", usage: {} }, this.last()));
    tools.forEach((t, i) => {
      this.entries.push(entry({ role: "toolResult", toolCallId: ids[i], toolName: t.name, content: [{ type: "text", text: t.result }], isError: t.isError ?? false }, this.last()));
    });
    return this;
  }

  custom(customType: string, data: unknown): this {
    ts += 1000;
    this.entries.push({ type: "custom", id: `e${n++}`, parentId: this.last()?.id ?? null, timestamp: new Date(ts).toISOString(), customType, data });
    return this;
  }

  contextEdit(targetId: string, replacement: { content: string | ContentBlock[] } | null): this {
    ts += 1000;
    this.entries.push({ type: "context_edit", id: `e${n++}`, parentId: this.last()?.id ?? null, timestamp: new Date(ts).toISOString(), targetId, replacement });
    return this;
  }

  /** What pi appends for a compaction draft. `null` keeps nothing before the entry (retain-none). */
  compaction(summary: string, firstKeptEntryId: string | null, details?: unknown): this {
    ts += 1000;
    const id = `e${n++}`;
    this.entries.push({ type: "compaction", id, parentId: this.last()?.id ?? null, timestamp: new Date(ts).toISOString(), summary, firstKeptEntryId: firstKeptEntryId ?? id, tokensBefore: 1, details });
    return this;
  }

  /** Messages as pi would hand them to the context event (message entries only). */
  messages(fromIndex = 0): Msg[] {
    return this.entries.slice(fromIndex).filter((e) => e.type === "message").map((e) => structuredClone(e.message!));
  }
}

/** A session with `turns` user turns, each with one assistant tool call producing `outputChars` of output. */
export function bigSession(turns: number, outputChars = 2000): SessionBuilder {
  const b = new SessionBuilder();
  b.user("implement the hot compaction spec for the pi harness. never use em dashes.");
  b.assistant("Reading the spec first.", [{ name: "read", args: { path: "spec.md" }, result: "# Spec\n".padEnd(outputChars, "x") }]);
  for (let i = 1; i < turns; i++) {
    b.user(`turn ${i}: please fix the bug in module${i}`);
    b.assistant(`Working on module${i}.`, [
      { name: "bash", args: { command: `npm test -- module${i}` }, result: `run ${i}\n`.padEnd(outputChars, `${i} `) },
      { name: "edit", args: { path: `src/module${i}.ts`, old: "a", new: "b" }, result: "ok" },
    ]);
    b.assistant(`Done with module${i}.`);
  }
  return b;
}
