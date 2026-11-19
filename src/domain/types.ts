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
  "Zephyr",
  "Puck",
  "Aoede",
  "Fenrir",
  "Leda",
] as const;

export type GeminiVoice = (typeof GEMINI_VOICES)[number];

export const DEFAULT_SUMMARY_MODEL = "gemini-3.8-flash";
export const DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts";
export const FALLBACK_TTS_MODEL = "gemini-3.8-flash-lite-tts";

export interface GravozConfig {
  readonly apiKey: string;
  readonly mode: NarrationMode;
  readonly autoPlay: boolean;
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
  readonly mode: NarrationMode;
  readonly autoPlay: boolean;
  readonly headlessFallback: boolean;
  readonly voiceName: GeminiVoice;
  readonly playbackRate: number;
  readonly summaryModel: string;
  readonly ttsModel: string;
}

export const DEFAULT_CONFIG: GravozConfig = {
  apiKey: "",
  mode: "normal",
  autoPlay: true,
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
}

export interface ParsedTranscript {
  readonly lastUserPrompt: string;
  readonly recentHistory: string;
  readonly latestAssistantResponse: string;
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

export interface UiEvent {
  readonly type: "status" | "narration" | "config" | "error";
  readonly phase?: NarrationPhase;
  readonly message?: string;
  readonly entry?: NarrationEntry;
  readonly audioBase64?: string;
  readonly config?: PublicConfig;
  readonly autoPlay?: boolean;
}

/** Narrow ports for dependency inversion and deterministic testing. */
/** Puertos estrechos para inversión de dependencias y pruebas deterministas. */
export interface SummarizerPort {
  summarize(input: {
    readonly apiKey: string;
    readonly model: string;
    readonly mode: NarrationMode;
    readonly projectContext: ProjectContext;
    readonly transcript: ParsedTranscript;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

export interface TtsPort {
  synthesize(input: {
    readonly apiKey: string;
    readonly model: string;
    readonly voiceName: GeminiVoice;
    readonly text: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly audio: Buffer; readonly mimeType: string }>;
  verifyKey(apiKey: string, model: string, signal: AbortSignal): Promise<boolean>;
}

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

/** Masks an API key keeping only prefix and last 4 chars (OWASP A02). */
/** Enmascara una API key mostrando solo el prefijo y los últimos 4 caracteres. */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function toPublicConfig(config: GravozConfig): PublicConfig {
  return {
    hasApiKey: config.apiKey.trim().length > 0,
    maskedApiKey: maskApiKey(config.apiKey),
    mode: config.mode,
    autoPlay: config.autoPlay,
    headlessFallback: config.headlessFallback,
    voiceName: config.voiceName,
    playbackRate: config.playbackRate,
    summaryModel: config.summaryModel,
    ttsModel: config.ttsModel,
  };
}
