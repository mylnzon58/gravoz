/**
 * Atomic, permission-hardened store for Gravoz user configuration.
 * Almacén atómico y seguro para la configuración local de Gravoz.
 */
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_TTS_MODEL,
  isGeminiVoice,
  isNarrationLanguage,
  isNarrationMode,
  type GravozConfig,
} from "../domain/types.js";
import { ensurePrivateDir, resolveStateDir } from "./paths.js";

const CONFIG_FILE = "config.json";
const DEDUP_FILE = "narrated-hashes.json";
const ELEPHANT_FILE = "elephant-memory.json";
const AUDIO_CACHE_DIR = "audio-cache";
const MAX_AUDIO_CACHE_FILES = 15;
const MAX_BACKUP_KEYS = 3;
const MAX_DEDUP_ENTRIES = 60;
const MAX_ELEPHANT_PROJECTS = 12;
const MAX_ELEPHANT_NOTES_PER_PROJECT = 5;

function sanitizeBackupKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length >= 12 && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
      if (out.length >= MAX_BACKUP_KEYS) break;
    }
  }
  return out;
}
const RETIRED_SUMMARY_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-3.8-flash",
  "gemini-3.8-flash-lite",
]);
const RETIRED_TTS_MODELS = new Set([
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
  "gemini-3.8-flash-tts",
]);

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
  private readonly dedupPath: string;
  private readonly elephantPath: string;

  constructor(stateDir: string = resolveStateDir()) {
    this.stateDir = ensurePrivateDir(stateDir);
    this.configPath = join(this.stateDir, CONFIG_FILE);
    this.dedupPath = join(this.stateDir, DEDUP_FILE);
    this.elephantPath = join(this.stateDir, ELEPHANT_FILE);
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
        backupApiKeys: sanitizeBackupKeys(rec["backupApiKeys"]),
        language: isNarrationLanguage(rec["language"]) ? rec["language"] : DEFAULT_CONFIG.language,
        mode: isNarrationMode(rec["mode"]) ? rec["mode"] : DEFAULT_CONFIG.mode,
        autoPlay: typeof rec["autoPlay"] === "boolean" ? rec["autoPlay"] : DEFAULT_CONFIG.autoPlay,
        goldfishReview:
          typeof rec["goldfishReview"] === "boolean"
            ? rec["goldfishReview"]
            : DEFAULT_CONFIG.goldfishReview,
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
      backupApiKeys:
        patch.backupApiKeys !== undefined
          ? sanitizeBackupKeys(patch.backupApiKeys)
          : current.backupApiKeys,
      language: isNarrationLanguage(patch.language) ? patch.language : current.language,
      mode: isNarrationMode(patch.mode) ? patch.mode : current.mode,
      autoPlay: typeof patch.autoPlay === "boolean" ? patch.autoPlay : current.autoPlay,
      goldfishReview:
        typeof patch.goldfishReview === "boolean" ? patch.goldfishReview : current.goldfishReview,
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

  /** Cross-window persistent dedup: returns true if this fingerprint was already narrated. */
  /** Deduplicación persistente entre ventanas: devuelve true si ya fue narrado. */
  public hasNarratedFingerprint(fingerprint: string): boolean {
    return this.readDedupList().includes(fingerprint);
  }

  /**
   * Atomically claims a fingerprint across all open IDE windows using O_CREAT | O_EXCL.
   * Returns true only for the single window that wins the claim.
   * Reclama atómicamente una huella entre todas las ventanas del IDE (solo una ventana gana).
   */
  public tryClaimFingerprint(fingerprint: string): boolean {
    if (this.hasNarratedFingerprint(fingerprint)) return false;
    const lockPath = join(this.stateDir, `claim-${fingerprint.slice(0, 16)}.lock`);
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch {
      return false;
    }
    this.recordNarratedFingerprint(fingerprint);
    // Clean up lock file asynchronously after 10s so ~/.gravoz stays spotless.
    setTimeout(() => {
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore already-removed lock.
      }
    }, 10_000).unref();
    return true;
  }

  public recordNarratedFingerprint(fingerprint: string): void {
    const list = this.readDedupList().filter((item) => item !== fingerprint);
    list.push(fingerprint);
    const trimmed = list.slice(-MAX_DEDUP_ENTRIES);
    ensurePrivateDir(this.stateDir);
    writeFileAtomicPrivate(this.dedupPath, `${JSON.stringify(trimmed)}\n`);
  }

  /** Persistent per-project Elephant memory shared cleanly across IDE reloads/windows. */
  /** Memoria Elephant persistente por proyecto, compartida entre recargas y ventanas del IDE. */
  public loadElephantMemory(projectKey: string): readonly string[] {
    const all = this.readElephantMap();
    return all[projectKey] ?? [];
  }

  public appendElephantMemory(projectKey: string, note: string): void {
    const all = this.readElephantMap();
    const prev = all[projectKey] ?? [];
    const next = [...prev, note].slice(-MAX_ELEPHANT_NOTES_PER_PROJECT);
    delete all[projectKey];
    all[projectKey] = next;

    const keys = Object.keys(all);
    while (keys.length > MAX_ELEPHANT_PROJECTS) {
      const oldest = keys.shift();
      if (oldest) delete all[oldest];
    }

    ensurePrivateDir(this.stateDir);
    writeFileAtomicPrivate(this.elephantPath, `${JSON.stringify(all, null, 2)}\n`);
  }

  /** Persistent disk WAV cache (~/.gravoz/audio-cache) for 0ms instant replay across reloads. */
  /** Caché persistente de WAV en disco para reproducción instantánea (0ms) sin gastar tokens. */
  public getCachedWav(cacheKey: string): Buffer | null {
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
    const filePath = join(this.stateDir, AUDIO_CACHE_DIR, `${safeKey}.wav`);
    if (!existsSync(filePath)) return null;
    try {
      return readFileSync(filePath);
    } catch {
      return null;
    }
  }

  public setCachedWav(cacheKey: string, wav: Buffer): void {
    try {
      const cacheDir = ensurePrivateDir(join(this.stateDir, AUDIO_CACHE_DIR));
      const safeKey = cacheKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
      const filePath = join(cacheDir, `${safeKey}.wav`);
      writeFileSync(filePath, wav, { mode: 0o600 });

      const files = readdirSync(cacheDir)
        .filter((f) => f.endsWith(".wav"))
        .map((f) => {
          const full = join(cacheDir, f);
          return { full, mtimeMs: statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const old of files.slice(MAX_AUDIO_CACHE_FILES)) {
        try {
          unlinkSync(old.full);
        } catch {
          // Ignore concurrent unlink.
        }
      }
    } catch {
      // Cache write is non-fatal.
    }
  }

  private readDedupList(): string[] {
    if (!existsSync(this.dedupPath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.dedupPath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private readElephantMap(): Record<string, string[]> {
    if (!existsSync(this.elephantPath)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.elephantPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          out[k] = v.filter((item): item is string => typeof item === "string");
        }
      }
      return out;
    } catch {
      return {};
    }
  }
}
