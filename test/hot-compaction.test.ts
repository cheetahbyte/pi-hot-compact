import assert from "node:assert/strict";
import { test } from "bun:test";
import { HybridCompiler } from "../src/compilers/hybrid.ts";
import { SEMANTIC_SECTIONS } from "../src/compilers/semantic.ts";
import { compactionDetails, generationFromLog, HotCompactionManager } from "../src/hot-compaction.ts";
import { EventLog } from "../src/log.ts";
import type { CompiledContext, SessionEvent } from "../src/types.ts";
import { bigSession, resetFixtures, type SessionBuilder } from "./fixtures.ts";

const fakeCheckpoint = SEMANTIC_SECTIONS.map((s) => `[${s}]\n- item`).join("\n");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { complete?: (p: string, s?: AbortSignal) => Promise<string> } = {}) {
  resetFixtures();
  let now = 1_000_000;
  const compiler = new HybridCompiler({ complete: opts.complete, maxCheckpointTokens: 4000, deterministic: { briefTokens: 800 } });
  const manager = new HotCompactionManager(compiler, { tailTokens: 1500, cooldownMs: 0, minDeltaTokens: 0, jobTimeoutMs: 5000 }, { now: () => now });
  return { compiler, manager, advance: (ms: number) => (now += ms) };
}

/** What pi does with a compaction draft returned from a boundary handler. */
function commit(session: SessionBuilder, manager: HotCompactionManager, compiled: CompiledContext, source: "hot" | "emergency" = "hot"): void {
  session.compaction(compiled.checkpoint, compiled.firstKeptEntryId, compactionDetails(compiled, source));
  manager.syncBranch(session.entries);
}

test("hot compaction: snapshot, continue, commit at the next boundary, delta kept verbatim", async () => {
  const gate = deferred<string>();
  const { manager } = setup({ complete: () => gate.promise });
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  assert.equal(manager.maybeStart({ percent: 75, tokens: 0, contextWindow: 1 }), null);
  const job = manager.currentJob!;
  assert.equal(job.status, "running");
  const snapshotThrough = job.snapshotThroughSeq;
  assert.equal(snapshotThrough, session.entries.length - 1);

  // Agent keeps working while the job runs.
  session.user("delta turn A").assistant("delta reply A", [{ name: "bash", args: { command: "ls" }, result: "a b c" }]);
  session.user("delta turn B");
  manager.syncBranch(session.entries);
  assert.equal(manager.takeReady(), null, "not ready yet: nothing handed out");
  assert.equal(manager.active?.id, undefined);

  gate.resolve(fakeCheckpoint);
  await tick();
  assert.equal(manager.currentJob?.status, "ready");
  const ready = manager.takeReady()!;
  assert.ok(ready);
  assert.equal(ready.mode, "hot");
  assert.equal(ready.compiled.throughSeq, snapshotThrough);
  assert.ok(ready.compiled.firstKeptSeq <= snapshotThrough);
  assert.ok(ready.compiled.semantic?.includes("[Current Work]"));
  assert.ok(ready.compiled.checkpoint.includes("[Session Goal]"));
  assert.equal(manager.currentJob, null);
  assert.equal(manager.active?.id, undefined, "nothing is active until pi commits the entry");

  commit(session, manager, ready.compiled);
  const gen = manager.active!;
  assert.equal(gen.source, "hot");
  assert.equal(gen.id, session.entries.at(-1)!.id);
  assert.equal(gen.compiled.firstKeptSeq, ready.compiled.firstKeptSeq);
  assert.equal(gen.compiled.throughSeq, snapshotThrough);
  assert.equal(gen.compiled.semantic, ready.compiled.semantic);
  assert.equal(gen.compiled.checkpoint, ready.compiled.checkpoint);
  // Every event from the kept boundary on, including the delta, is still in the log untouched.
  const kept = manager.log.messageEvents(gen.compiled.firstKeptSeq);
  assert.equal(kept.at(-2)?.message?.content, "delta turn B");
  assert.equal(kept.at(-1)?.message?.role, "compactionSummary");
});

test("a job made stale by a compaction pi wrote meanwhile is discarded, never applied", async () => {
  const gate = deferred<string>();
  const { manager } = setup({ complete: () => gate.promise });
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  manager.start("hot");
  session.compaction("native summary", session.entries[4].id);
  manager.syncBranch(session.entries);
  assert.equal(manager.active?.source, "foreign");
  assert.equal(manager.active?.compiled.foreign, true);
  assert.equal(manager.active?.compiled.checkpoint, "native summary");
  assert.equal(manager.currentJob, null, "a new generation cancels the running job");
  gate.resolve(fakeCheckpoint);
  await tick();
  assert.equal(manager.takeReady(), null);
  assert.equal(manager.active?.id, session.entries.at(-1)!.id);
});

test("a ready job whose base generation changed is stale", async () => {
  const gate = deferred<string>();
  const { manager } = setup({ complete: () => gate.promise });
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  manager.start("hot");
  gate.resolve(fakeCheckpoint);
  await tick();
  assert.equal(manager.currentJob?.status, "ready");
  session.compaction("native summary", session.entries[4].id);
  manager.syncBranch(session.entries);
  assert.equal(manager.takeReady(), null);
  assert.equal(manager.history.at(-1)?.status, "stale");
});

test("a branch change invalidates the generation and the job", () => {
  const { manager } = setup();
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  const ready = manager.emergency()!;
  commit(session, manager, ready.compiled, "emergency");
  assert.equal(manager.active?.source, "emergency");
  manager.start("hot");
  const forked = session.entries.slice(0, 5);
  manager.syncBranch(forked);
  assert.equal(manager.active?.id, undefined);
  assert.equal(manager.currentJob, null);
  assert.equal(manager.log.epoch, 1);
});

test("compile failure is recorded, does not throw, and retries later", async () => {
  let calls = 0;
  const { manager, advance } = setup({
    complete: async () => {
      calls++;
      if (calls === 1) throw new Error("model down");
      return fakeCheckpoint;
    },
  });
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  manager.start("hot");
  await tick();
  assert.equal(manager.currentJob?.status, "failed");
  assert.equal(manager.currentJob?.error, "model down");
  assert.equal(manager.takeReady(), null);
  advance(1);
  assert.equal(manager.maybeStart({ percent: 80, tokens: 0, contextWindow: 1 }), null);
  await tick();
  assert.ok(manager.takeReady());
  assert.equal(calls, 2);
});

test("invalid semantic output is rejected and the job fails cleanly", async () => {
  const { manager } = setup({ complete: async () => "Sure! Here is the answer to your question." });
  manager.syncBranch(bigSession(10, 1200).entries);
  manager.start("hot");
  await tick();
  assert.equal(manager.currentJob?.status, "failed");
  assert.match(manager.currentJob?.error ?? "", /validation/);
});

test("timeout aborts the semantic call and the agent continues", async () => {
  const { manager } = setup({
    complete: (_p, signal) =>
      new Promise((_res, rej) => {
        signal?.addEventListener("abort", () => rej(signal.reason));
      }),
  });
  manager.config.jobTimeoutMs = 5;
  manager.syncBranch(bigSession(10, 1200).entries);
  manager.start("hot");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(manager.currentJob?.status, "failed");
  assert.match(manager.currentJob?.error ?? "", /timeout/);
});

test("emergency compiles deterministically and hands the result out immediately", () => {
  const { manager } = setup();
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  const ready = manager.emergency()!;
  assert.ok(ready);
  assert.equal(ready.mode, "emergency");
  assert.equal(ready.compiled.semantic, undefined);
  assert.equal(manager.active?.id, undefined);
  commit(session, manager, ready.compiled, "emergency");
  assert.equal(manager.active?.compiled.checkpoint, ready.compiled.checkpoint);
});

test("generations chain: the next job starts from the active generation and advances the boundary", async () => {
  const { manager } = setup({ complete: async () => fakeCheckpoint });
  const session = bigSession(8, 1200);
  manager.syncBranch(session.entries);
  manager.start("hot");
  await tick();
  commit(session, manager, manager.takeReady()!.compiled);
  const g1 = manager.active!;
  for (let i = 0; i < 6; i++) session.user(`more ${i}`).assistant(`reply ${i}`, [{ name: "bash", args: { command: "x" }, result: "y".repeat(1200) }]);
  manager.syncBranch(session.entries);
  manager.start("hot");
  assert.equal(manager.currentJob?.baseGeneration, g1.id);
  await tick();
  commit(session, manager, manager.takeReady()!.compiled);
  const g2 = manager.active!;
  assert.notEqual(g2.id, g1.id);
  assert.ok(g2.compiled.firstKeptSeq > g1.compiled.firstKeptSeq);
});

test("nothing to compact when the session fits in the tail", async () => {
  const { manager } = setup({ complete: async () => fakeCheckpoint });
  manager.syncBranch(bigSession(2, 100).entries);
  manager.start("hot");
  await tick();
  assert.equal(manager.currentJob?.status, "failed");
  assert.match(manager.currentJob?.error ?? "", /tail/);
  assert.equal(manager.takeReady(), null);
});

test("a fresh manager derives the generation from the branch (restart, resume, fork)", async () => {
  const { manager } = setup({ complete: async () => fakeCheckpoint });
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  manager.start("hot");
  await tick();
  commit(session, manager, manager.takeReady()!.compiled);
  const gen = manager.active!;
  const fresh = new HotCompactionManager(new HybridCompiler(), { tailTokens: 1500 });
  fresh.syncBranch(session.entries);
  assert.equal(fresh.active?.id, gen.id);
  assert.equal(fresh.active?.source, "hot");
  assert.equal(fresh.active?.compiled.firstKeptSeq, gen.compiled.firstKeptSeq);
  assert.equal(fresh.active?.compiled.throughSeq, gen.compiled.throughSeq);
  assert.equal(fresh.active?.compiled.checkpoint, gen.compiled.checkpoint);
  assert.equal(fresh.active?.compiled.semantic, gen.compiled.semantic);
});

test("a retain-none compaction keeps nothing before itself", () => {
  resetFixtures();
  const session = bigSession(3, 100);
  session.compaction("all summarised", null);
  const log = new EventLog();
  log.sync(session.entries);
  const gen = generationFromLog(log)!;
  assert.ok(gen);
  assert.equal(gen.source, "foreign");
  assert.equal(gen.compiled.firstKeptSeq, log.lastSeq);
  assert.equal(gen.compiled.throughSeq, log.lastSeq);
});

test("compileAt honours pi's boundary for native compaction", () => {
  const { manager } = setup();
  const session = bigSession(6, 500);
  manager.syncBranch(session.entries);
  const target = session.entries[7];
  const compiled = manager.compileAt(target.id)!;
  assert.ok(compiled);
  assert.equal(compiled.firstKeptEntryId, target.id);
  assert.ok(compiled.checkpoint.includes("[Brief Transcript]"));
  const seqs = manager.log.all().filter((e: SessionEvent) => e.seq < compiled.firstKeptSeq && e.message).map((e) => e.seq);
  assert.ok(seqs.length > 0);
});
