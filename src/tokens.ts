import type { Msg } from "./types.ts";

export const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1200;

export const tokensForText = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export function messageChars(m: Msg): { chars: number; images: number } {
  let chars = 0;
  let images = 0;
  const add = (v: unknown) => {
    if (typeof v === "string") chars += v.length;
    else if (v !== undefined) {
      try {
        chars += JSON.stringify(v).length;
      } catch {
        /* ignore */
      }
    }
  };
  if (typeof m.content === "string") chars += m.content.length;
  else if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "thinking") chars += b.thinking.length;
      else if (b.type === "toolCall") add(b.arguments), (chars += b.name.length);
      else if (b.type === "image") images++;
    }
  }
  if (m.role === "bashExecution") chars += (m.command?.length ?? 0) + (m.output?.length ?? 0);
  if (typeof m.summary === "string") chars += m.summary.length;
  return { chars, images };
}

export function estimateMessageTokens(m: Msg): number {
  const { chars, images } = messageChars(m);
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

export function estimateMessagesTokens(messages: Msg[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}
