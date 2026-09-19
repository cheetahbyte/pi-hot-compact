import assert from "node:assert/strict";
import { test } from "node:test";
import { HybridCompiler } from "../src/compilers/hybrid.ts";
import { SEMANTIC_SECTIONS } from "../src/compilers/semantic.ts";
import { HotCompactionManager, type PersistedGeneration } from "../src/hot-compaction.ts";
import { alignMessages } from "../src/projection.ts";
import type { SessionEvent } from "../src/types.ts";
import { bigSession, resetFixtures } from "./fixtures.ts";

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
  const persisted: PersistedGeneration[] = [];
  let now = 1_000_000;
  const compiler = new HybridCompiler({ complete: opts.complete, maxCheckpointTokens: 4000, deterministic: { briefTokens: 800 } });
  const manager = new HotCompactionManager(compiler, { tailTokens: 1500, cooldownMs: 0, minDeltaTokens: 0, jobTimeoutMs: 5000 }, { persist: (g) => persisted.push(g), now: () => now });
  return { compiler, manager, persisted, advance: (ms: number) => (now += ms) };
}

test("hot compaction: snapshot, continue, reconcile delta exactly, atomic swap", async () => {
  const gate = deferred<string>();
  const { compiler, manager, persisted } = setup({ complete: () => gate.promise });
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
  assert.equal(manager.trySwap(), null, "not ready yet: nothing swapped");
  assert.equal(manager.active, null);

  gate.resolve(fakeCheckpoint);
  await tick();
  assert.equal(manager.currentJob?.status, "ready");
  const gen = manager.trySwap()!;
  assert.ok(gen);
  assert.equal(gen.source, "hot");
  assert.equal(gen.compiled.throughSeq, snapshotThrough);
  assert.ok(gen.compiled.semantic?.includes("[Current Work]"));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].throughEntryId, session.entries[snapshotThrough].id);

  // Model-visible context: checkpoint + every event from the boundary, including the delta, no loss, no duplicates.
  const aligned = alignMessages(session.messages(), manager.log);
  const ctx = compiler.reconcile(gen.compiled, aligned, undefined, gen.id);
  const first = ctx.messages[0];
  assert.equal(first.role, "custom");
  assert.ok(String(first.content).includes("[Session Goal]"));
  const seqs = aligned.filter((e) => e.seq >= gen.compiled.firstKeptSeq).map((e) => e.seq);
  const expected = manager.log.messageEvents(gen.compiled.firstKeptSeq).map((e) => e.seq);
  assert.deepEqual(seqs, expected);
  assert.equal(ctx.messages.length, 1 + expected.length);
  assert.equal(new Set(seqs).size, seqs.length);
  const lastMsg = ctx.messages[ctx.messages.length - 1];
  assert.equal(lastMsg.content, "delta turn B");
  assert.ok(ctx.droppedEvents > 0);
});

test("a stale job (base generation changed) is discarded, never applied", async () => {
  const gate = deferred<string>();
  const { manager } = setup({ complete: () => gate.promise });
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  manager.start("hot");
  // Meanwhile pi ran a native compaction, which becomes the active generation.
  session.compaction("native summary", session.entries[4].id);
  manager.syncBranch(session.entries);
  const native = manager.adoptNative({ id: session.entries.at(-1)!.id, summary: "native summary", firstKeptEntryId: session.entries[4].id });
  assert.ok(native?.compiled.native);
  assert.equal(manager.currentJob, null, "native compaction cancels the running job");
  gate.resolve(fakeCheckpoint);
  await tick();
  assert.equal(manager.trySwap(), null);
  assert.equal(manager.active?.id, native!.id);
});

test("a branch change invalidates the generation and the job", async () => {
  const { manager } = setup();
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  manager.start("emergency");
  await tick();
  assert.ok(manager.trySwap());
  const forked = session.entries.slice(0, 5);
  manager.syncBranch(forked);
  assert.equal(manager.active, null);
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
  assert.equal(manager.trySwap(), null);
  advance(1);
  assert.equal(manager.maybeStart({ percent: 80, tokens: 0, contextWindow: 1 }), null);
  await tick();
  assert.ok(manager.trySwap());
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

test("emergency compiles deterministically and swaps immediately", () => {
  const { manager } = setup();
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  const gen = manager.emergency();
  assert.ok(gen);
  assert.equal(gen.source, "emergency");
  assert.equal(gen.compiled.semantic, undefined);
  assert.equal(manager.active?.id, gen.id);
});

test("generations chain: the next job starts from the active generation and advances the boundary", async () => {
  const { manager } = setup({ complete: async () => fakeCheckpoint });
  const session = bigSession(8, 1200);
  manager.syncBranch(session.entries);
  manager.start("hot");
  await tick();
  const g1 = manager.trySwap()!;
  for (let i = 0; i < 6; i++) session.user(`more ${i}`).assistant(`reply ${i}`, [{ name: "bash", args: { command: "x" }, result: "y".repeat(1200) }]);
  manager.syncBranch(session.entries);
  manager.start("hot");
  await tick();
  const g2 = manager.trySwap()!;
  assert.equal(g2.baseGenerationId, g1.id);
  assert.ok(g2.compiled.firstKeptSeq > g1.compiled.firstKeptSeq);
});

test("nothing to compact when the session fits in the tail", async () => {
  const { manager } = setup({ complete: async () => fakeCheckpoint });
  manager.syncBranch(bigSession(2, 100).entries);
  manager.start("hot");
  await tick();
  assert.equal(manager.currentJob?.status, "failed");
  assert.match(manager.currentJob?.error ?? "", /tail/);
  assert.equal(manager.trySwap(), null);
});

test("restore picks up a persisted generation whose boundaries are on the branch", async () => {
  const { manager, persisted } = setup({ complete: async () => fakeCheckpoint });
  const session = bigSession(10, 1200);
  manager.syncBranch(session.entries);
  manager.start("hot");
  await tick();
  const gen = manager.trySwap()!;
  const fresh = new HotCompactionManager(new HybridCompiler(), { tailTokens: 1500 });
  fresh.syncBranch(session.entries);
  const restored = fresh.restore(persisted)!;
  assert.equal(restored.id, gen.id);
  assert.equal(restored.compiled.firstKeptSeq, gen.compiled.firstKeptSeq);
  assert.equal(restored.compiled.checkpoint, gen.compiled.checkpoint);
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
