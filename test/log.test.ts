import assert from "node:assert/strict";
import { test } from "bun:test";
import { eventText, textOf } from "../src/content.ts";
import { EventLog } from "../src/log.ts";
import { recall } from "../src/recall.ts";
import { resetFixtures, SessionBuilder } from "./fixtures.ts";

test("seq is monotonic and stable across appends", () => {
  resetFixtures();
  const b = new SessionBuilder().user("a").assistant("b");
  const log = new EventLog();
  assert.equal(log.sync(b.entries), false);
  assert.deepEqual(log.all().map((e) => e.seq), [0, 1]);
  b.user("c");
  assert.equal(log.sync(b.entries), false);
  assert.equal(log.lastSeq, 2);
  assert.equal(log.seqOf("e2"), 2);
  assert.equal(log.epoch, 0);
});

test("a diverged branch bumps the epoch and renumbers", () => {
  resetFixtures();
  const b = new SessionBuilder().user("a").assistant("b").user("c");
  const log = new EventLog();
  log.sync(b.entries);
  const other = new SessionBuilder().user("a").assistant("b").user("different");
  const branch = [b.entries[0], b.entries[1], other.entries[2]];
  assert.equal(log.sync(branch), true);
  assert.equal(log.epoch, 1);
  assert.equal(log.get(2)?.id, other.entries[2].id);
  assert.equal(log.seqOf("e2"), undefined);
});

test("compaction and custom_message entries become context messages; custom entries do not", () => {
  resetFixtures();
  const b = new SessionBuilder().user("a").custom("x", { k: 1 }).compaction("summary text", "e0");
  const log = new EventLog();
  log.sync(b.entries);
  assert.equal(log.get(1)?.message, undefined);
  assert.equal(log.get(2)?.message?.role, "compactionSummary");
  assert.equal(log.get(2)?.message?.summary, "summary text");
  assert.equal(log.messageEvents().length, 2);
});

test("context_edit omits or replaces the model-visible message and keeps the raw one for recall", () => {
  resetFixtures();
  const b = new SessionBuilder().user("a").assistant("reply text", [{ name: "bash", args: { command: "ls" }, result: "big output" }]);
  b.contextEdit("e2", { content: [{ type: "text", text: "collapsed" }] }).contextEdit("e1", null);
  const log = new EventLog();
  log.sync(b.entries);
  assert.equal(log.get(1)?.message, undefined);
  assert.equal(log.get(1)?.rawMessage?.role, "assistant");
  assert.equal(textOf(log.get(2)?.message?.content), "collapsed");
  assert.equal(textOf(log.get(2)?.rawMessage?.content), "big output");
  assert.equal(eventText(log.get(2)!), "big output");
  assert.equal(log.get(3)?.message, undefined);
  assert.deepEqual(log.messageEvents().map((e) => e.seq), [0, 2]);
  assert.deepEqual(recall(log, { mode: "keyword", query: "big output" }).hits.map((h) => h.seq), [2]);
  assert.deepEqual(recall(log, { mode: "keyword", query: "reply" }).hits.map((h) => h.seq), [1]);
});
