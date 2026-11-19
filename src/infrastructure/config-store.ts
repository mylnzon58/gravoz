/**
 * Atomic, permission-hardened store for Gravoz configuration and sidecar runtime state.
 * Almacén atómico y seguro para la configuración de Gravoz y el estado runtime del sidecar.
 */
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  isGeminiVoice,
  isNarrationMode,
  type GravozConfig,
  type RuntimeDescriptor,
} from "../domain/types.js";
import { ensurePrivateDir, resolveStateDir } from "./paths.js";

const CONFIG_FILE = "config.json";
const RUNTIME_FILE = "runtime.json";

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

function sanitizeModelId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  // Restrict to safe model identifier characters (OWASP A03).
  // Restringe a caracteres seguros de identificador de modelo.
  return /^[a-zA-Z0-9._-]{3,80}$/.test(trimmed) ? trimmed : fallback;
}

export class ConfigStore {
  private readonly stateDir: string;
  private readonly configPath: string;
  private readonly runtimePath: string;

  constructor(stateDir: string = resolveStateDir()) {
    this.stateDir = ensurePrivateDir(stateDir);
    this.configPath = join(this.stateDir, CONFIG_FILE);
    this.runtimePath = join(this.stateDir, RUNTIME_FILE);
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
        summaryModel: sanitizeModelId(rec["summaryModel"], DEFAULT_CONFIG.summaryModel),
        ttsModel: sanitizeModelId(rec["ttsModel"], DEFAULT_CONFIG.ttsModel),
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
      summaryModel: sanitizeModelId(patch.summaryModel, current.summaryModel),
      ttsModel: sanitizeModelId(patch.ttsModel, current.ttsModel),
    };

    ensurePrivateDir(this.stateDir);
    writeFileAtomicPrivate(this.configPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  public writeRuntime(descriptor: RuntimeDescriptor): void {
    ensurePrivateDir(this.stateDir);
    writeFileAtomicPrivate(this.runtimePath, `${JSON.stringify(descriptor)}\n`);
  }

  public readRuntime(): RuntimeDescriptor | null {
    if (!existsSync(this.runtimePath)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.runtimePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return null;
      const rec = parsed as Record<string, unknown>;
      if (
        typeof rec["pid"] !== "number" ||
        typeof rec["port"] !== "number" ||
        typeof rec["token"] !== "string" ||
        typeof rec["startedAt"] !== "string"
      ) {
        return null;
      }
      return {
        pid: rec["pid"],
        port: rec["port"],
        token: rec["token"],
        startedAt: rec["startedAt"],
      };
    } catch {
      return null;
    }
  }

  public removeRuntime(): void {
    try {
      if (existsSync(this.runtimePath)) {
        unlinkSync(this.runtimePath);
      }
    } catch {
      // Ignore cleanup race on shutdown.
    }
  }
}
