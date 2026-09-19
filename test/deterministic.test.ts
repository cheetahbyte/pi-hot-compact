import assert from "node:assert/strict";
import { test } from "bun:test";
import { compileDeterministic, renderSections } from "../src/compilers/deterministic.ts";
import { EventLog } from "../src/log.ts";
import { resetFixtures, SessionBuilder } from "./fixtures.ts";

test("extracts goal, files, commits, preferences, errors and a referenced brief transcript", () => {
  resetFixtures();
  const b = new SessionBuilder()
    .user("Implement the hot compaction spec for the pi harness.\nAlways use node:test for tests.")
    .assistant("Reading.", [{ name: "read", args: { path: "spec.md" }, result: "# spec" }])
    .assistant("Editing.", [
      { name: "edit", args: { path: "src/log.ts", old: "a", new: "b" }, result: "ok" },
      { name: "bash", args: { command: "npm test" }, result: "3 failures", isError: true },
    ])
    .assistant("Committing.", [{ name: "bash", args: { command: 'git commit -m "feat: event log"' }, result: "[main abc1234] feat: event log\n 1 file changed" }])
    .user("actually, switch to a hybrid compiler instead")
    .assistant("Switching to the hybrid compiler now.");
  const log = new EventLog();
  log.sync(b.entries);
  const s = compileDeterministic(log.all(), { briefTokens: 4000 });

  assert.equal(s.sessionGoal[0], "Implement the hot compaction spec for the pi harness.");
  assert.ok(s.sessionGoal.includes("[Scope change]"));
  assert.ok(s.filesAndChanges.some((l) => l.startsWith("modified: src/log.ts")));
  assert.ok(s.filesAndChanges.some((l) => l.startsWith("read: spec.md")));
  assert.deepEqual(s.commits, ["abc1234: feat: event log"]);
  assert.ok(s.userPreferences.some((p) => p.includes("Always use node:test")));
  assert.ok(s.outstandingContext.some((l) => l.includes("Error:") && l.includes("3 failures")));
  assert.ok(s.outstandingContext[0].includes("Switching to the hybrid compiler now."));
  const brief = s.briefTranscript.join("\n");
  assert.ok(brief.includes("#0 user:"));
  assert.ok(/bash\("npm test"\) → error, 10 chars\/1 lines: 3 failures \(event:\/\/\d+\)/.test(brief));
  assert.equal(s.omittedTurns, 0);

  const text = renderSections(s);
  for (const h of ["[Session Goal]", "[Files And Changes]", "[Commits]", "[Outstanding Context]", "[User Preferences]", "[Brief Transcript]"]) assert.ok(text.includes(h), h);
});

test("a long single-line request is clipped into the goal, not dropped", () => {
  resetFixtures();
  const b = new SessionBuilder().user(`Do these steps strictly one at a time: ${"step ".repeat(60)}`);
  const log = new EventLog();
  log.sync(b.entries);
  const s = compileDeterministic(log.all());
  assert.equal(s.sessionGoal.length, 1);
  assert.ok(s.sessionGoal[0].startsWith("Do these steps strictly"));
  assert.ok(s.sessionGoal[0].length <= 200);
});

test("brief transcript drops the oldest turns to fit its budget and says so", () => {
  resetFixtures();
  const b = new SessionBuilder();
  for (let i = 0; i < 30; i++) b.user(`turn ${i} ${"words ".repeat(40)}`).assistant(`reply ${i} ${"words ".repeat(40)}`);
  const log = new EventLog();
  log.sync(b.entries);
  const s = compileDeterministic(log.all(), { briefTokens: 400 });
  assert.ok(s.omittedTurns > 0);
  assert.ok(s.briefTranscript[0].startsWith("… "));
  assert.ok(s.briefTranscript.some((l) => l.includes("turn 29")));
});
