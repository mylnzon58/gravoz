/**
 * Core domain types and narrow port contracts for Gravoz.
 * Tipos de dominio principales y contratos de puertos (DIP) para Gravoz.
 */

export type NarrationMode = "al-grano" | "normal" | "tecnico";

export const NARRATION_MODES: readonly NarrationMode[] = [
  "al-grano",
  "normal",
  "tecnico",
] as const;

export const GEMINI_VOICES = [
  "Kore",
  "Aoede",
  "Zephyr",
  "Leda",
  "Charon",
  "Orus",
  "Puck",
  "Fenrir",
] as const;

export type GeminiVoice = (typeof GEMINI_VOICES)[number];

export const DEFAULT_SUMMARY_MODEL = "gemini-flash-lite-latest";
export const FALLBACK_SUMMARY_MODELS: readonly string[] = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
];
export const DEFAULT_TTS_MODEL = "gemini-3.8-flash-lite-tts";
export const FALLBACK_TTS_MODELS: readonly string[] = [
  "gemini-3.8-flash-tts",
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
];

export type NarrationLanguage = "es" | "en";

export const NARRATION_LANGUAGES: readonly NarrationLanguage[] = ["es", "en"] as const;

export function isNarrationLanguage(value: unknown): value is NarrationLanguage {
  return value === "es" || value === "en";
}

export interface GravozConfig {
  readonly apiKey: string;
  readonly backupApiKeys: readonly string[];
  readonly language: NarrationLanguage;
  readonly mode: NarrationMode;
  readonly autoPlay: boolean;
  readonly goldfishReview: boolean;
  readonly headlessFallback: boolean;
  readonly voiceName: GeminiVoice;
  readonly playbackRate: number;
  readonly summaryModel: string;
  readonly ttsModel: string;
}

/** Public view of configuration with the API key masked for UI responses. */
/** Vista pública de configuración con la API key enmascarada para la UI. */
export interface PublicConfig {
  readonly hasApiKey: boolean;
  readonly maskedApiKey: string;
  readonly backupKeyCount: number;
  readonly maskedBackupKeys: readonly string[];
  readonly language: NarrationLanguage;
  readonly mode: NarrationMode;
  readonly autoPlay: boolean;
  readonly goldfishReview: boolean;
  readonly headlessFallback: boolean;
  readonly voiceName: GeminiVoice;
  readonly playbackRate: number;
  readonly summaryModel: string;
  readonly ttsModel: string;
}

export const DEFAULT_CONFIG: GravozConfig = {
  apiKey: "",
  backupApiKeys: [],
  language: "es",
  mode: "normal",
  autoPlay: true,
  goldfishReview: false,
  headlessFallback: true,
  voiceName: "Kore",
  playbackRate: 1.0,
  summaryModel: DEFAULT_SUMMARY_MODEL,
  ttsModel: DEFAULT_TTS_MODEL,
};

export interface StopHookPayload {
  readonly conversationId?: string;
  readonly workspacePaths?: readonly string[];
  readonly transcriptPath?: string;
  readonly artifactDirectoryPath?: string;
  readonly lastUserInput?: string;
  readonly terminationReason?: string;
  readonly fullyIdle?: boolean;
  readonly continuationActive?: boolean;
  readonly cwd?: string;
}

export interface ProjectContext {
  readonly projectName: string;
  readonly summary: string;
  readonly recentArtifacts: string;
  readonly elephantMemory?: string;
}

export interface ParsedTranscript {
  readonly lastUserPrompt: string;
  readonly recentHistory: string;
  readonly latestAssistantResponse: string;
  readonly latestStepIndex?: number;
  readonly isTurnComplete?: boolean;
}

export type NarrationPhase =
  | "idle"
  | "collecting"
  | "summarizing"
  | "synthesizing"
  | "ready"
  | "error";

export interface NarrationEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly mode: NarrationMode;
  readonly voiceName: GeminiVoice;
  readonly projectName: string;
  readonly script: string;
  readonly sourceText: string;
  readonly contextSummary: string;
  readonly audioByteLength: number;
  readonly durationEstimateSec: number;
}

export type QuotaHealthState = "ok" | "cooldown_429" | "cooldown_503" | "invalid";

export interface KeyQuotaStatus {
  readonly label: string;
  readonly maskedKey: string;
  readonly callsToday: number;
  readonly state: QuotaHealthState;
  readonly cooldownSec: number;
}

export interface ModelQuotaStatus {
  readonly model: string;
  readonly kind: "summary" | "tts";
  readonly callsToday: number;
  readonly state: QuotaHealthState;
  readonly cooldownSec: number;
}

export interface QuotaSnapshot {
  readonly date: string;
  readonly activeSummaryModel: string;
  readonly activeTtsModel: string;
  readonly lastSwitchNotice: string;
  readonly keys: readonly KeyQuotaStatus[];
  readonly models: readonly ModelQuotaStatus[];
}

export interface UiEvent {
  readonly type: "status" | "narration" | "config" | "error" | "quota";
  readonly phase?: NarrationPhase;
  readonly message?: string;
  readonly entry?: NarrationEntry;
  readonly audioBase64?: string;
  readonly config?: PublicConfig;
  readonly quota?: QuotaSnapshot;
  readonly autoPlay?: boolean;
}

/** Narrow ports for dependency inversion and deterministic testing. */
/** Puertos estrechos para inversión de dependencias y pruebas deterministas. */
export interface SummarizerPort {
  summarize(input: {
    readonly apiKey: string;
    readonly backupApiKeys?: readonly string[];
    readonly model: string;
    readonly language: NarrationLanguage;
    readonly mode: NarrationMode;
    readonly projectContext: ProjectContext;
    readonly transcript: ParsedTranscript;
    readonly signal: AbortSignal;
  }): Promise<string>;
  critique?(input: {
    readonly apiKey: string;
    readonly backupApiKeys?: readonly string[];
    readonly model: string;
    readonly language: NarrationLanguage;
    readonly latestResponse: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

export interface TtsPort {
  synthesize(input: {
    readonly apiKey: string;
    readonly backupApiKeys?: readonly string[];
    readonly model: string;
    readonly voiceName: GeminiVoice;
    readonly text: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly audio: Buffer; readonly mimeType: string }>;
  verifyKey(apiKey: string, model: string, signal: AbortSignal): Promise<boolean>;
  getQuotaSnapshot?(config: GravozConfig): QuotaSnapshot;
}

export const MALE_VOICES: ReadonlySet<GeminiVoice> = new Set([
  "Charon",
  "Orus",
  "Puck",
  "Fenrir",
]);

export interface AudioPlayerPort {
  playWav(wavBuffer: Buffer): Promise<void>;
  stop(): void;
}

export function isNarrationMode(value: unknown): value is NarrationMode {
  return typeof value === "string" && (NARRATION_MODES as readonly string[]).includes(value);
}

export function isGeminiVoice(value: unknown): value is GeminiVoice {
  return typeof value === "string" && (GEMINI_VOICES as readonly string[]).includes(value);
}

/** Masks an API key keeping only prefix and last 4 chars. */
/** Enmascara una API key mostrando solo el prefijo y los últimos 4 caracteres. */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function toPublicConfig(config: GravozConfig): PublicConfig {
  const backups = config.backupApiKeys.filter((k) => k.trim().length > 0);
  return {
    hasApiKey: config.apiKey.trim().length > 0 || backups.length > 0,
    maskedApiKey: maskApiKey(config.apiKey),
    backupKeyCount: backups.length,
    maskedBackupKeys: backups.map(maskApiKey),
    language: config.language,
    mode: config.mode,
    autoPlay: config.autoPlay,
    goldfishReview: config.goldfishReview,
    headlessFallback: config.headlessFallback,
    voiceName: config.voiceName,
    playbackRate: config.playbackRate,
    summaryModel: config.summaryModel,
    ttsModel: config.ttsModel,
  };
}
