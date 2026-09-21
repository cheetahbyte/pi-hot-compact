import { clip, eventText, isoTime, oneLine, roleLabel, toolCallsOf } from "./content.ts";
import type { EventLog } from "./log.ts";
import type { SessionEvent } from "./types.ts";

export type RecallMode = "keyword" | "regex" | "event" | "tool" | "file" | "range";

export interface RecallQuery {
  mode: RecallMode;
  query?: string;
  fromSeq?: number;
  toSeq?: number;
  limit?: number;
  /** Chars of full content returned per event (event mode and tool mode). */
  maxChars?: number;
  offset?: number;
}

export interface RecallHit {
  seq: number;
  role: string;
  time: string;
  excerpt: string;
}

export interface RecallResult {
  mode: RecallMode;
  total: number;
  hits: RecallHit[];
  text: string;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_CHARS = 8000;

export function parseSeq(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(?:event:\/\/|#)?(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

function excerptAround(text: string, index: number, width = 160): string {
  const start = Math.max(0, index - Math.floor(width / 2));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? "…" : ""}${oneLine(text.slice(start, end))}${end < text.length ? "…" : ""}`;
}

function matchesAll(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let first = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i < 0) return -1;
    if (first < 0 || i < first) first = i;
  }
  return first;
}

function hit(ev: SessionEvent, excerpt: string): RecallHit {
  return { seq: ev.seq, role: roleLabel(ev), time: isoTime(ev.timestamp), excerpt };
}

export function recall(log: EventLog, q: RecallQuery): RecallResult {
  const limit = q.limit ?? DEFAULT_LIMIT;
  const maxChars = q.maxChars ?? DEFAULT_MAX_CHARS;
  const offset = q.offset ?? 0;
  const from = q.fromSeq ?? 0;
  const to = q.toSeq ?? log.lastSeq;
  const scope = log.range(from, to);
  let hits: RecallHit[] = [];
  let total = 0;

  switch (q.mode) {
    case "event": {
      const seq = parseSeq(q.query);
      const ev = seq === undefined ? undefined : log.get(seq);
      if (!ev) return { mode: q.mode, total: 0, hits: [], text: `No event ${q.query ?? ""} (log has #0–#${log.lastSeq}).` };
      const full = eventText(ev);
      const slice = full.slice(offset, offset + maxChars);
      const more = offset + maxChars < full.length ? `\n[… ${full.length - offset - maxChars} more chars; call again with offset=${offset + maxChars}]` : "";
      const details = ev.rawMessage?.role === "toolResult" ? ` toolCallId=${ev.rawMessage.toolCallId}` : "";
      return { mode: q.mode, total: 1, hits: [hit(ev, clip(oneLine(full), 160))], text: `event://${ev.seq} [${roleLabel(ev)}] ${isoTime(ev.timestamp)}${details}\n${slice}${more}` };
    }
    case "range": {
      total = scope.filter((e) => e.rawMessage).length;
      const page = scope.filter((e) => e.rawMessage).slice(offset, offset + limit);
      hits = page.map((ev) => hit(ev, clip(oneLine(eventText(ev)), 200)));
      break;
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(q.query ?? "", "i");
      } catch (err) {
        return { mode: q.mode, total: 0, hits: [], text: `Invalid regex: ${String(err)}` };
      }
      const all: RecallHit[] = [];
      for (const ev of scope) {
        if (!ev.rawMessage) continue;
        const text = eventText(ev);
        const m = re.exec(text);
        if (m) all.push(hit(ev, excerptAround(text, m.index)));
      }
      total = all.length;
      hits = all.slice(offset, offset + limit);
      break;
    }
    case "keyword": {
      const terms = (q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const all: RecallHit[] = [];
      for (const ev of scope) {
        if (!ev.rawMessage) continue;
        const text = eventText(ev);
        const i = terms.length ? matchesAll(text, terms) : 0;
        if (i >= 0) all.push(hit(ev, excerptAround(text, i)));
      }
      total = all.length;
      hits = all.slice(offset, offset + limit);
      break;
    }
    case "tool": {
      const needle = (q.query ?? "").toLowerCase();
      const all: RecallHit[] = [];
      const results = new Map<string, SessionEvent>();
      for (const ev of scope) if (ev.rawMessage?.role === "toolResult" && ev.rawMessage.toolCallId) results.set(ev.rawMessage.toolCallId, ev);
      for (const ev of scope) {
        if (ev.rawMessage?.role !== "assistant") continue;
        for (const tc of toolCallsOf(ev.rawMessage)) {
          let args = "";
          try {
            args = JSON.stringify(tc.arguments);
          } catch {
            args = "";
          }
          const hay = `${tc.name} ${args}`.toLowerCase();
          if (needle && !hay.includes(needle)) continue;
          const r = results.get(tc.id);
          const rtext = r ? eventText(r) : "";
          const summary = r ? `${r.rawMessage!.isError ? "error" : "ok"}, ${rtext.length} chars → event://${r.seq}: ${clip(oneLine(rtext), 120)}` : "no result";
          all.push(hit(ev, `${tc.name}(${clip(args, 160)}) → ${summary}`));
        }
      }
      total = all.length;
      hits = all.slice(offset, offset + limit);
      break;
    }
    case "file": {
      const needle = (q.query ?? "").toLowerCase();
      const all: RecallHit[] = [];
      for (const ev of scope) {
        if (!ev.rawMessage) continue;
        let matched = false;
        if (ev.rawMessage.role === "assistant") {
          for (const tc of toolCallsOf(ev.rawMessage)) {
            let args = "";
            try {
              args = JSON.stringify(tc.arguments).toLowerCase();
            } catch {
              args = "";
            }
            if (args.includes(needle)) {
              all.push(hit(ev, `${tc.name}(${clip(args, 160)})`));
              matched = true;
              break;
            }
          }
        }
        if (matched) continue;
        const text = eventText(ev);
        const i = text.toLowerCase().indexOf(needle);
        if (i >= 0) all.push(hit(ev, excerptAround(text, i)));
      }
      total = all.length;
      hits = all.slice(offset, offset + limit);
      break;
    }
  }

  const header = `${q.mode} recall${q.query ? ` "${clip(q.query, 80)}"` : ""}: ${total} match${total === 1 ? "" : "es"} in #${from}–#${to}${total > hits.length ? ` (showing ${offset + 1}–${offset + hits.length}; offset=${offset + hits.length} for more)` : ""}`;
  const lines = hits.map((h) => `event://${h.seq} [${h.role}] ${h.time} ${h.excerpt}`);
  const footer = hits.length ? "\nUse mode=event with the event number to read any entry in full." : "";
  return { mode: q.mode, total, hits, text: [header, ...lines].join("\n") + footer };
}
