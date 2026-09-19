import assert from "node:assert/strict";
import { test } from "bun:test";
import { EventLog } from "../src/log.ts";
import { alignMessages, CHECKPOINT_CUSTOM_TYPE, reconcileDelta } from "../src/projection.ts";
import type { CompiledContext } from "../src/types.ts";
import { bigSession, resetFixtures } from "./fixtures.ts";

const compiledAt = (firstKeptSeq: number, native = false): CompiledContext => ({
  checkpoint: "CHECKPOINT",
  firstKeptSeq,
  firstKeptEntryId: `e${firstKeptSeq}`,
  throughSeq: 999,
  throughEntryId: "x",
  sections: { sessionGoal: [], filesAndChanges: [], commits: [], outstandingContext: [], userPreferences: [], briefTranscript: [], omittedTurns: 0 },
  estimatedTokens: 3,
  compiler: "test",
  native,
});

test("alignMessages maps live messages to log seqs and keeps unknown messages as pending", () => {
  resetFixtures();
  const session = bigSession(4, 300);
  const log = new EventLog();
  log.sync(session.entries);
  const msgs = session.messages();
  msgs.push({ role: "user", content: "not yet persisted", timestamp: 1 });
  const aligned = alignMessages(msgs, log);
  assert.deepEqual(aligned.slice(0, -1).map((e) => e.seq), session.entries.map((_, i) => i));
  const pending = aligned[aligned.length - 1];
  assert.equal(pending.type, "pending");
  assert.equal(pending.seq, log.lastSeq + 1);
});

test("alignMessages works when pi already trimmed the context (subsequence of the log)", () => {
  resetFixtures();
  const session = bigSession(4, 300);
  const log = new EventLog();
  log.sync(session.entries);
  const aligned = alignMessages(session.messages(6), log);
  assert.equal(aligned[0].seq, 6);
  assert.equal(aligned.every((e) => e.type === "message"), true);
});

test("reconcile drops events before the boundary, injects the checkpoint, collapses old big tool outputs only", () => {
  resetFixtures();
  const session = bigSession(6, 3000);
  const log = new EventLog();
  log.sync(session.entries);
  const aligned = alignMessages(session.messages(), log);
  const firstKept = log.all().filter((e) => e.message?.role === "user")[2].seq;
  const ctx = reconcileDelta(compiledAt(firstKept), aligned, { collapseToolOutputChars: 1000, collapseKeepRecentTurns: 2 }, "gen1");
  assert.equal(ctx.messages[0].customType, CHECKPOINT_CUSTOM_TYPE);
  assert.equal(ctx.messages[0].display, false);
  assert.equal(ctx.droppedEvents, firstKept);
  assert.equal(ctx.messages.length, 1 + aligned.length - firstKept);
  const results = ctx.messages.filter((m) => m.role === "toolResult");
  const collapsed = results.filter((m) => String((m.content as { text: string }[])[0].text).includes("[tool output collapsed"));
  // 4 user turns kept (turns 2..5): tool outputs in the oldest 2 collapse, the last 2 turns stay verbatim.
  assert.equal(ctx.collapsedToolOutputs, collapsed.length);
  assert.equal(collapsed.length, 2);
  assert.ok(collapsed.every((m) => /event:\/\/\d+/.test(String((m.content as { text: string }[])[0].text))));
  for (const m of results.slice(-2)) assert.ok(!String((m.content as { text: string }[])[0].text).includes("collapsed"));
  assert.equal(results.every((m) => m.toolCallId), true);
});

test("native generations do not inject a second checkpoint", () => {
  resetFixtures();
  const session = bigSession(3, 100);
  const log = new EventLog();
  log.sync(session.entries);
  const aligned = alignMessages(session.messages(), log);
  const ctx = reconcileDelta(compiledAt(2, true), aligned, { collapseToolOutputChars: 0, collapseKeepRecentTurns: 2 });
  assert.notEqual(ctx.messages[0].role, "custom");
  assert.equal(ctx.messages.length, aligned.length - 2);
});
