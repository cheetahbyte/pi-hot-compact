import assert from "node:assert/strict";
import { test } from "bun:test";
import { EventLog } from "../src/log.ts";
import { planCollapses } from "../src/projection.ts";
import { bigSession, resetFixtures } from "./fixtures.ts";

const opts = { collapseToolOutputChars: 1000, collapseKeepRecentTurns: 2 };

test("planCollapses targets big tool outputs outside the recent turns and inside the kept range", () => {
  resetFixtures();
  const session = bigSession(6, 3000);
  const log = new EventLog();
  log.sync(session.entries);
  const users = log.all().filter((e) => e.message?.role === "user");
  const firstKept = users[2].seq;
  const plans = planCollapses(log, firstKept, opts);
  // Turns 2..5 are kept; the bash outputs of turns 2 and 3 collapse, turns 4 and 5 stay verbatim.
  assert.equal(plans.length, 2);
  assert.ok(plans.every((p) => p.seq >= firstKept && p.seq < users[4].seq));
  assert.ok(plans.every((p) => p.text.includes(`event://${p.seq}`)));
  assert.ok(plans.every((p) => p.text.startsWith("[tool output collapsed: bash")));
  assert.equal(log.get(plans[0].seq)?.id, plans[0].targetId);
});

test("planCollapses skips already edited results and does nothing below the turn threshold", () => {
  resetFixtures();
  const session = bigSession(6, 3000);
  const log = new EventLog();
  log.sync(session.entries);
  const users = log.all().filter((e) => e.message?.role === "user");
  const first = planCollapses(log, users[2].seq, opts);
  for (const p of first) session.contextEdit(p.targetId, { content: [{ type: "text", text: p.text }] });
  log.sync(session.entries);
  assert.deepEqual(planCollapses(log, users[2].seq, opts), []);
  assert.deepEqual(planCollapses(log, users[4].seq, opts), []);
  assert.deepEqual(planCollapses(log, 0, { ...opts, collapseToolOutputChars: 0 }), []);
});
