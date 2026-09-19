import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog } from "../src/log.ts";
import { parseSeq, recall } from "../src/recall.ts";
import { bigSession, resetFixtures } from "./fixtures.ts";

function logOf() {
  resetFixtures();
  const log = new EventLog();
  log.sync(bigSession(5, 500).entries);
  return log;
}

test("keyword search requires all terms and returns excerpts with event refs", () => {
  const r = recall(logOf(), { mode: "keyword", query: "module3 bug" });
  assert.equal(r.total, 1);
  assert.equal(r.hits[0].role, "user");
  assert.match(r.text, /event:\/\/\d+ \[user\]/);
});

test("regex search", () => {
  const r = recall(logOf(), { mode: "regex", query: "module[34]\\.ts" });
  assert.equal(r.total, 2);
});

test("event lookup returns full content with paging", () => {
  const log = logOf();
  const tr = log.all().find((e) => e.message?.role === "toolResult")!;
  const r1 = recall(log, { mode: "event", query: `event://${tr.seq}`, maxChars: 100 });
  assert.match(r1.text, /more chars; call again with offset=100/);
  const r2 = recall(log, { mode: "event", query: String(tr.seq), maxChars: 100, offset: 100 });
  assert.ok(!r2.text.includes("offset=100]"));
  assert.equal(recall(log, { mode: "event", query: "9999" }).total, 0);
});

test("tool lookup pairs calls with their result event", () => {
  const r = recall(logOf(), { mode: "tool", query: "npm test -- module2" });
  assert.equal(r.total, 1);
  assert.match(r.hits[0].excerpt, /bash\(.*\) → ok, \d+ chars → event:\/\/\d+/);
});

test("file lookup finds tool calls touching a path", () => {
  const r = recall(logOf(), { mode: "file", query: "src/module4.ts" });
  assert.ok(r.total >= 1);
  assert.match(r.hits[0].excerpt, /^edit\(/);
});

test("range lists message events with limit and offset", () => {
  const r = recall(logOf(), { mode: "range", fromSeq: 0, toSeq: 5, limit: 3, offset: 1 });
  assert.equal(r.total, 6);
  assert.deepEqual(r.hits.map((h) => h.seq), [1, 2, 3]);
});

test("parseSeq accepts plain, # and event:// forms", () => {
  assert.equal(parseSeq("42"), 42);
  assert.equal(parseSeq("#42"), 42);
  assert.equal(parseSeq("event://42"), 42);
  assert.equal(parseSeq("nope"), undefined);
});
