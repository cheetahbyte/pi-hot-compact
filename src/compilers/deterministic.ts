import { clip, formatToolCall, nonEmptyLines, oneLine, textOf, toolCallsOf } from "../content.ts";
import { tokensForText } from "../tokens.ts";
import type { DeterministicSections, Msg, SessionEvent } from "../types.ts";

/**
 * VCC-style deterministic layer: structured state extracted mechanically from
 * the raw event log, no LLM involved. Recomputed from event 0 on every
 * generation, so it never drifts through summary-of-summary chains.
 */

export interface DeterministicOptions {
  /** Token budget for the brief transcript section. */
  briefTokens: number;
  maxFiles: number;
}

export const DEFAULT_DETERMINISTIC: DeterministicOptions = { briefTokens: 3500, maxFiles: 40 };

const SCOPE_CHANGE_RE = /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do)\b/i;
const TASK_RE = /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;
const NOISE_RE = /^(ok|okay|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|y|n|k|continue|proceed)\s*[.!?]*$/i;
const NON_GOAL_RE = /^\s*[[│├└─╭╰]|```|^\s*(function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])/;

const PREF_RES = [
  /\bprefer(?:s|red|ring)?\s+\w/i,
  /\bdon'?t want\b/i,
  /\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
  /\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
  /\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
  /\bno (?:comments|emojis|em dashes)\b/i,
];

const COMMIT_MSG_RE = /git\s+commit[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/;

interface Turn {
  user: SessionEvent;
  steps: SessionEvent[];
}

const isPreferenceLine = (t: string) => PREF_RES.some((r) => r.test(t));
const isSubstantiveGoal = (t: string) => t.length > 5 && !NOISE_RE.test(t) && !NON_GOAL_RE.test(t) && !isPreferenceLine(t);

export function extractGoals(userTexts: string[]): string[] {
  const goals: string[] = [];
  let scopeChange: string[] | null = null;
  for (const text of userTexts) {
    const lines = nonEmptyLines(text)
      .filter(isSubstantiveGoal)
      .map((l) => clip(l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim(), 200));
    if (lines.length === 0) continue;
    if (goals.length === 0) {
      goals.push(...lines.slice(0, 5));
      continue;
    }
    const lead = text.slice(0, 200);
    if (SCOPE_CHANGE_RE.test(lead)) scopeChange = lines.slice(0, 3).map((l) => clip(l, 200));
    else if (TASK_RE.test(lead) && lines[0].length > 15) scopeChange = lines.slice(0, 2).map((l) => clip(l, 200));
  }
  if (scopeChange?.length) goals.push("[Scope change]", ...scopeChange);
  return goals.slice(0, 8);
}

export function extractPreferences(userTexts: string[], goals: string[]): string[] {
  const out: string[] = [];
  const seen = new Set(goals.map((g) => g.toLowerCase()));
  for (const text of userTexts) {
    for (const line of nonEmptyLines(text)) {
      if (line.length < 5 || line.length > 200 || line.endsWith("?")) continue;
      if (!PREF_RES.some((r) => r.test(line))) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clip(line, 200));
      break;
    }
  }
  return out.slice(0, 10);
}

interface FileOps {
  read: Set<string>;
  modified: Set<string>;
}

function pathArg(args: Record<string, unknown>): string | undefined {
  for (const k of ["path", "file_path", "filePath", "file"]) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function recordFileOps(tc: { name: string; arguments: Record<string, unknown> }, ops: FileOps): void {
  const p = pathArg(tc.arguments ?? {});
  if (!p) return;
  if (/^(read|cat|view|ls|grep|find|glob|search)/i.test(tc.name)) ops.read.add(p);
  else if (/^(write|edit|multi_edit|create|patch|apply)/i.test(tc.name)) ops.modified.add(p);
}

export function extractCommits(events: SessionEvent[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const m = events[i].message;
    if (!m) continue;
    const cmds: { cmd: string; id?: string }[] = [];
    if (m.role === "assistant") for (const tc of toolCallsOf(m)) if (tc.name === "bash" && typeof tc.arguments?.command === "string") cmds.push({ cmd: tc.arguments.command, id: tc.id });
    if (m.role === "bashExecution" && m.command) cmds.push({ cmd: m.command });
    for (const { cmd, id } of cmds) {
      if (!/\bgit\s+commit\b/.test(cmd)) continue;
      const mm = cmd.match(COMMIT_MSG_RE);
      if (!mm) continue;
      const msg = (mm[1] ?? mm[2] ?? "").replace(/\\"/g, '"').split(/\\n|\n/)[0].trim();
      if (!msg) continue;
      let hash: string | undefined;
      let resultText = m.role === "bashExecution" ? (m.output ?? "") : "";
      if (id) {
        for (let j = i + 1; j < Math.min(events.length, i + 6); j++) {
          const r = events[j].message;
          if (r?.role === "toolResult" && r.toolCallId === id) {
            resultText = textOf(r.content);
            break;
          }
        }
      }
      const b = resultText.match(/\[\S+\s+(?:\(root-commit\)\s+)?([0-9a-f]{7,12})\]/);
      if (b) hash = b[1];
      const line = `${hash ? `${hash}: ` : ""}${clip(msg, 120)}`;
      if (!out.includes(line)) out.push(line);
    }
  }
  return out.slice(-10);
}

function groupTurns(events: SessionEvent[]): { pre: SessionEvent[]; turns: Turn[] } {
  const pre: SessionEvent[] = [];
  const turns: Turn[] = [];
  for (const ev of events) {
    if (!ev.message) continue;
    if (ev.message.role === "user") turns.push({ user: ev, steps: [] });
    else if (turns.length === 0) pre.push(ev);
    else turns[turns.length - 1].steps.push(ev);
  }
  return { pre, turns };
}

function resultSummary(r: Msg): string {
  const text = textOf(r.content);
  const lines = text.split("\n").length;
  const first = oneLine(text).slice(0, 80);
  const status = r.isError ? "error" : "ok";
  return `${status}, ${text.length} chars/${lines} lines${first ? `: ${first}` : ""}`;
}

function briefTurn(turn: Turn): string[] {
  const lines: string[] = [];
  lines.push(`#${turn.user.seq} user: ${clip(oneLine(textOf(turn.user.message!.content)), 220)}`);
  const results = new Map<string, SessionEvent>();
  for (const s of turn.steps) if (s.message?.role === "toolResult" && s.message.toolCallId) results.set(s.message.toolCallId, s);
  for (const s of turn.steps) {
    const m = s.message!;
    if (m.role === "assistant") {
      const text = oneLine(textOf(m.content));
      const calls = toolCallsOf(m).map((tc) => {
        const r = results.get(tc.id);
        const rs = r ? ` → ${resultSummary(r.message!)} (event://${r.seq})` : "";
        return `${formatToolCall(tc, 80)}${rs}`;
      });
      const parts: string[] = [];
      if (text) parts.push(clip(text, 240));
      if (calls.length) parts.push(calls.join("; "));
      if (m.errorMessage) parts.push(`[error: ${clip(oneLine(m.errorMessage), 120)}]`);
      if (parts.length) lines.push(`#${s.seq} assistant: ${parts.join(" | ")}`);
    } else if (m.role === "bashExecution") {
      lines.push(`#${s.seq} bash: $ ${clip(oneLine(m.command ?? ""), 100)} → exit ${m.exitCode ?? "?"} (event://${s.seq})`);
    } else if (m.role === "custom" && m.display !== false) {
      lines.push(`#${s.seq} ${m.customType ?? "custom"}: ${clip(oneLine(textOf(m.content)), 160)}`);
    }
  }
  return lines;
}

export function buildBriefTranscript(events: SessionEvent[], budgetTokens: number): { lines: string[]; omitted: number } {
  const { turns } = groupTurns(events);
  const rendered = turns.map(briefTurn);
  const out: string[][] = [];
  let used = 0;
  let omitted = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const cost = tokensForText(rendered[i].join("\n"));
    if (used + cost > budgetTokens && out.length > 0) {
      omitted = i + 1;
      break;
    }
    out.unshift(rendered[i]);
    used += cost;
  }
  const lines = out.flat();
  if (omitted > 0) lines.unshift(`… ${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted (events #${events[0]?.seq ?? 0}–#${turns[omitted - 1]?.steps.at(-1)?.seq ?? turns[omitted - 1]?.user.seq}; use context_recall)`);
  return { lines, omitted };
}

function outstanding(events: SessionEvent[]): string[] {
  const out: string[] = [];
  let lastAssistant: SessionEvent | undefined;
  const errors: string[] = [];
  for (const ev of events) {
    const m = ev.message;
    if (!m) continue;
    if (m.role === "assistant" && textOf(m.content).trim()) lastAssistant = ev;
    if (m.role === "toolResult" && m.isError) errors.push(`#${ev.seq} ${m.toolName ?? "tool"}: ${clip(oneLine(textOf(m.content)), 140)}`);
    if (m.role === "assistant" && m.stopReason === "error") errors.push(`#${ev.seq} assistant error: ${clip(oneLine(m.errorMessage ?? ""), 140)}`);
  }
  if (lastAssistant) {
    const text = oneLine(textOf(lastAssistant.message!.content));
    out.push(`Last assistant message before checkpoint (#${lastAssistant.seq}): ${clip(text.slice(-700), 700)}`);
  }
  for (const e of errors.slice(-5)) out.push(`Error: ${e}`);
  return out;
}

export function compileDeterministic(events: SessionEvent[], options: Partial<DeterministicOptions> = {}): DeterministicSections {
  const opts = { ...DEFAULT_DETERMINISTIC, ...options };
  const userTexts: string[] = [];
  const ops: FileOps = { read: new Set(), modified: new Set() };
  for (const ev of events) {
    const m = ev.message;
    if (!m) continue;
    if (m.role === "user") userTexts.push(textOf(m.content));
    if (m.role === "assistant") for (const tc of toolCallsOf(m)) recordFileOps(tc, ops);
  }
  for (const p of ops.modified) ops.read.delete(p);
  const sessionGoal = extractGoals(userTexts);
  const userPreferences = extractPreferences(userTexts, sessionGoal);
  const filesAndChanges: string[] = [];
  if (ops.modified.size) filesAndChanges.push(`modified: ${[...ops.modified].slice(-opts.maxFiles).join(", ")}`);
  if (ops.read.size) filesAndChanges.push(`read: ${[...ops.read].slice(-opts.maxFiles).join(", ")}`);
  const brief = buildBriefTranscript(events, opts.briefTokens);
  return {
    sessionGoal,
    filesAndChanges,
    commits: extractCommits(events),
    outstandingContext: outstanding(events),
    userPreferences,
    briefTranscript: brief.lines,
    omittedTurns: brief.omitted,
  };
}

export function renderSections(s: DeterministicSections): string {
  const block = (title: string, lines: string[]) => (lines.length ? `[${title}]\n${lines.map((l) => (l.startsWith("#") || l.startsWith("…") ? l : `- ${l}`)).join("\n")}` : `[${title}]\n- (none)`);
  return [
    block("Session Goal", s.sessionGoal),
    block("Files And Changes", s.filesAndChanges),
    block("Commits", s.commits),
    block("Outstanding Context", s.outstandingContext),
    block("User Preferences", s.userPreferences),
    `[Brief Transcript]\n${s.briefTranscript.join("\n") || "(empty)"}`,
  ].join("\n\n");
}
