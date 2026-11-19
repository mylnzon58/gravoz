/**
 * Atomic, permission-hardened store for Gravoz user configuration.
 * Almacén atómico y seguro para la configuración local de Gravoz.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_TTS_MODEL,
  isGeminiVoice,
  isNarrationMode,
  type GravozConfig,
} from "../domain/types.js";
import { ensurePrivateDir, resolveStateDir } from "./paths.js";

const CONFIG_FILE = "config.json";
const RETIRED_SUMMARY_MODELS = new Set(["gemini-2.5-flash", "gemini-2.0-flash"]);
const RETIRED_TTS_MODELS = new Set(["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"]);

function writeFileAtomicPrivate(filePath: string, payload: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(tmpPath, 0o600);
  }
  renameSync(tmpPath, filePath);
}

function clampPlaybackRate(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(2.0, Math.max(0.75, Math.round(value * 100) / 100));
}

function sanitizeModelId(value: unknown, fallback: string, retired: ReadonlySet<string>): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (retired.has(trimmed)) return fallback;
  return /^[a-zA-Z0-9._-]{3,80}$/.test(trimmed) ? trimmed : fallback;
}

export class ConfigStore {
  private readonly stateDir: string;
  private readonly configPath: string;

  constructor(stateDir: string = resolveStateDir()) {
    this.stateDir = ensurePrivateDir(stateDir);
    this.configPath = join(this.stateDir, CONFIG_FILE);
  }

  public getStateDir(): string {
    return this.stateDir;
  }

  public load(): GravozConfig {
    if (!existsSync(this.configPath)) {
      return { ...DEFAULT_CONFIG };
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.configPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) {
        return { ...DEFAULT_CONFIG };
      }
      const rec = parsed as Record<string, unknown>;
      return {
        apiKey: typeof rec["apiKey"] === "string" ? rec["apiKey"].trim() : DEFAULT_CONFIG.apiKey,
        mode: isNarrationMode(rec["mode"]) ? rec["mode"] : DEFAULT_CONFIG.mode,
        autoPlay: typeof rec["autoPlay"] === "boolean" ? rec["autoPlay"] : DEFAULT_CONFIG.autoPlay,
        headlessFallback:
          typeof rec["headlessFallback"] === "boolean"
            ? rec["headlessFallback"]
            : DEFAULT_CONFIG.headlessFallback,
        voiceName: isGeminiVoice(rec["voiceName"]) ? rec["voiceName"] : DEFAULT_CONFIG.voiceName,
        playbackRate: clampPlaybackRate(rec["playbackRate"], DEFAULT_CONFIG.playbackRate),
        summaryModel: sanitizeModelId(rec["summaryModel"], DEFAULT_SUMMARY_MODEL, RETIRED_SUMMARY_MODELS),
        ttsModel: sanitizeModelId(rec["ttsModel"], DEFAULT_TTS_MODEL, RETIRED_TTS_MODELS),
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  public update(patch: Partial<GravozConfig>): GravozConfig {
    const current = this.load();
    const next: GravozConfig = {
      apiKey: typeof patch.apiKey === "string" ? patch.apiKey.trim() : current.apiKey,
      mode: isNarrationMode(patch.mode) ? patch.mode : current.mode,
      autoPlay: typeof patch.autoPlay === "boolean" ? patch.autoPlay : current.autoPlay,
      headlessFallback:
        typeof patch.headlessFallback === "boolean"
          ? patch.headlessFallback
          : current.headlessFallback,
      voiceName: isGeminiVoice(patch.voiceName) ? patch.voiceName : current.voiceName,
      playbackRate: clampPlaybackRate(patch.playbackRate, current.playbackRate),
      summaryModel: sanitizeModelId(patch.summaryModel, current.summaryModel, RETIRED_SUMMARY_MODELS),
      ttsModel: sanitizeModelId(patch.ttsModel, current.ttsModel, RETIRED_TTS_MODELS),
    };

    ensurePrivateDir(this.stateDir);
    writeFileAtomicPrivate(this.configPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
