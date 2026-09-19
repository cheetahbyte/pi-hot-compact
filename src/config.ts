import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HotCompactionConfig } from "./hot-compaction.ts";
import { DEFAULT_HOT_CONFIG } from "./hot-compaction.ts";

export interface HotCompactSettings extends HotCompactionConfig {
  enabled: boolean;
  /** Run the LLM semantic checkpoint layer. */
  semantic: boolean;
  /** "provider/modelId" for the semantic layer; null uses the session model. */
  semanticModel: string | null;
  semanticMaxTokens: number;
  maxCheckpointTokens: number;
  briefTranscriptTokens: number;
  collapseToolOutputChars: number;
  collapseKeepRecentTurns: number;
  /** Serve pi's own /compact, threshold and overflow compaction with the deterministic compiler. */
  handleNativeCompaction: boolean;
  debug: boolean;
}

export const DEFAULT_SETTINGS: HotCompactSettings = {
  ...DEFAULT_HOT_CONFIG,
  enabled: true,
  semantic: true,
  semanticModel: null,
  semanticMaxTokens: 4000,
  maxCheckpointTokens: 12_000,
  briefTranscriptTokens: 3500,
  collapseToolOutputChars: 4000,
  collapseKeepRecentTurns: 2,
  handleNativeCompaction: true,
  debug: false,
};

export const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "hot-compact.json");
export const projectSettingsPath = (cwd: string): string => join(cwd, ".pi", "hot-compact.json");

function readJson(path: string): Partial<HotCompactSettings> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Partial<HotCompactSettings>) : {};
  } catch {
    return {};
  }
}

/** Defaults, then global file, then project file. Unknown keys are ignored. */
export function loadSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): HotCompactSettings {
  const global = readJson(env.PI_HOT_COMPACT_CONFIG ?? GLOBAL_SETTINGS_PATH);
  const project = readJson(projectSettingsPath(cwd));
  const merged: HotCompactSettings = { ...DEFAULT_SETTINGS };
  for (const src of [global, project]) {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof HotCompactSettings)[]) {
      const v = src[key];
      if (v !== undefined && typeof v === typeof DEFAULT_SETTINGS[key]) (merged as unknown as Record<string, unknown>)[key] = v;
      else if (key === "semanticModel" && (v === null || typeof v === "string")) merged.semanticModel = v;
    }
  }
  return merged;
}
