import assert from "node:assert/strict";
import { test } from "bun:test";
import { EventLog } from "../src/log.ts";
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
