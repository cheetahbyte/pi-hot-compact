import assert from "node:assert/strict";
import { test } from "bun:test";
import { EventLog } from "../src/log.ts";
import { findTailCut, snapToCutPoint } from "../src/tail.ts";
import { bigSession, resetFixtures } from "./fixtures.ts";

test("cut never lands on a tool result and prefers a user boundary", () => {
  resetFixtures();
  const log = new EventLog();
  log.sync(bigSession(8, 1200).entries);
  const cut = findTailCut(log.all(), 1500);
  assert.ok(cut);
  const ev = log.get(cut.firstKeptSeq)!;
  assert.notEqual(ev.message?.role, "toolResult");
  assert.equal(ev.message?.role, "user");
  assert.ok(cut.tailTokens >= 1500);
  assert.ok(cut.firstKeptSeq > 0 && cut.firstKeptSeq < log.lastSeq);
});

test("returns null when everything fits in the tail", () => {
  resetFixtures();
  const log = new EventLog();
  log.sync(bigSession(2, 100).entries);
  assert.equal(findTailCut(log.all(), 100_000), null);
});

test("snapToCutPoint moves a tool result boundary back to its assistant call", () => {
  resetFixtures();
  const log = new EventLog();
  log.sync(bigSession(3, 100).entries);
  const toolResult = log.all().find((e) => e.message?.role === "toolResult")!;
  const snapped = snapToCutPoint(log.all(), toolResult.seq);
  assert.equal(log.get(snapped)?.message?.role, "assistant");
  assert.ok(snapped < toolResult.seq);
});
