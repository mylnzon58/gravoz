/**
 * Core orchestration service for Gravoz: context-aware summarization, Gemini 3.8 TTS,
 * cancellation safety (AbortController + monotonic jobId), and bounded replay history.
 * Servicio orquestador principal de Gravoz con cancelación segura e historial acotado.
 */
import { randomUUID } from "node:crypto";
import {
  toPublicConfig,
  type AudioPlayerPort,
  type GravozConfig,
  type NarrationEntry,
  type NarrationMode,
  type NarrationPhase,
  type ParsedTranscript,
  type ProjectContext,
  type PublicConfig,
  type StopHookPayload,
  type SummarizerPort,
  type TtsPort,
  type UiEvent,
} from "../domain/types.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { ContextCollector } from "../infrastructure/context-collector.js";
import type { TranscriptParser } from "../infrastructure/transcript-parser.js";
import { ensureWavBuffer } from "../infrastructure/wav-encoder.js";

const MAX_HISTORY_ITEMS = 10;

interface StoredNarration {
  readonly entry: NarrationEntry;
  readonly wav: Buffer;
}

export interface NarrationServiceDeps {
  readonly configStore: ConfigStore;
  readonly contextCollector: ContextCollector;
  readonly transcriptParser: TranscriptParser;
  readonly summarizer: SummarizerPort;
  readonly tts: TtsPort;
  readonly osPlayer: AudioPlayerPort;
  readonly hasActiveWebview: () => boolean;
  readonly emit: (event: UiEvent) => void;
}

export class NarrationService {
  private readonly deps: NarrationServiceDeps;
  private readonly history: StoredNarration[] = [];
  private activeAbort: AbortController | null = null;
  private currentJobId = 0;
  private phase: NarrationPhase = "idle";
  private lastMessage = "";

  constructor(deps: NarrationServiceDeps) {
    this.deps = deps;
  }

  public getPublicConfig(): PublicConfig {
    return toPublicConfig(this.deps.configStore.load());
  }

  public updateConfig(patch: Partial<GravozConfig>): PublicConfig {
    const updated = this.deps.configStore.update(patch);
    const pub = toPublicConfig(updated);
    this.deps.emit({ type: "config", config: pub });
    return pub;
  }

  public async verifyApiKey(apiKey: string): Promise<{ readonly valid: boolean; readonly error?: string }> {
    const config = this.deps.configStore.load();
    const controller = new AbortController();
    try {
      const valid = await this.deps.tts.verifyKey(apiKey, config.summaryModel, controller.signal);
      return { valid };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "No se pudo validar la API key.",
      };
    }
  }

  public getStatus(): {
    readonly phase: NarrationPhase;
    readonly message: string;
    readonly config: PublicConfig;
    readonly history: readonly NarrationEntry[];
  } {
    return {
      phase: this.phase,
      message: this.lastMessage,
      config: this.getPublicConfig(),
      history: this.history.map((item) => item.entry),
    };
  }

  public getAudioBase64(id: string): string | null {
    const found = this.history.find((item) => item.entry.id === id);
    return found ? found.wav.toString("base64") : null;
  }

  public stopPlayback(): void {
    this.cancelInFlight();
    this.deps.osPlayer.stop();
    this.emitStatus("idle", "Reproducción detenida.");
  }

  /** Handles Antigravity Stop hook events asynchronously without blocking the agent. */
  /** Procesa eventos del hook Stop de Antigravity sin bloquear al agente. */
  public handleStopHook(payload: StopHookPayload): { readonly accepted: boolean; readonly reason?: string } {
    const config = this.deps.configStore.load();
    if (!config.apiKey) {
      return { accepted: false, reason: "no_api_key" };
    }
    if (!config.autoPlay) {
      return { accepted: false, reason: "autoplay_disabled" };
    }
    if (payload.continuationActive === true) {
      return { accepted: false, reason: "continuation_active" };
    }
    if (payload.terminationReason && payload.terminationReason !== "NO_TOOL_CALL") {
      return { accepted: false, reason: `skipped_${payload.terminationReason}` };
    }

    const transcript = this.deps.transcriptParser.parse({
      ...(payload.transcriptPath !== undefined ? { transcriptPath: payload.transcriptPath } : {}),
      ...(payload.workspacePaths !== undefined ? { workspacePaths: payload.workspacePaths } : {}),
      ...(payload.lastUserInput !== undefined ? { fallbackUserPrompt: payload.lastUserInput } : {}),
    });

    if (!transcript) {
      return { accepted: false, reason: "empty_transcript" };
    }

    const projectContext = this.deps.contextCollector.collect({
      ...(payload.workspacePaths !== undefined ? { workspacePaths: payload.workspacePaths } : {}),
      ...(payload.artifactDirectoryPath !== undefined
        ? { artifactDirectoryPath: payload.artifactDirectoryPath }
        : {}),
      ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
    });

    void this.runNarrationJob({
      config,
      mode: config.mode,
      projectContext,
      transcript,
      triggerAutoPlay: true,
    });

    return { accepted: true };
  }

  /** Narrates explicit text on demand (selected editor text or manual input). */
  /** Narra texto explícito bajo demanda (texto seleccionado en el editor o entrada manual). */
  public async narrateText(input: {
    readonly text: string;
    readonly mode?: NarrationMode;
    readonly projectName?: string;
    readonly contextSummary?: string;
    readonly autoPlay?: boolean;
  }): Promise<NarrationEntry> {
    const config = this.deps.configStore.load();
    if (!config.apiKey) {
      throw new Error("Configura primero tu API key gratuita de Google AI Studio en Gravoz.");
    }
    const cleanText = input.text.trim();
    if (!cleanText) {
      throw new Error("No hay texto para narrar.");
    }

    const mode = input.mode ?? config.mode;
    const projectContext: ProjectContext = {
      projectName: input.projectName?.trim() || "Proyecto Antigravity",
      summary: input.contextSummary?.trim() || "",
      recentArtifacts: "",
    };
    const transcript: ParsedTranscript = {
      lastUserPrompt: "",
      recentHistory: "",
      latestAssistantResponse: cleanText,
    };

    const entry = await this.runNarrationJob({
      config,
      mode,
      projectContext,
      transcript,
      triggerAutoPlay: input.autoPlay ?? true,
    });
    if (!entry) {
      throw new Error("La narración fue cancelada por una solicitud más reciente.");
    }
    return entry;
  }

  /** Re-narrates an existing history item in a different depth mode (Al grano / Normal / Técnico). */
  /** Vuelve a narrar un elemento del historial en otro nivel de profundidad. */
  public async renarrate(id: string, mode: NarrationMode): Promise<NarrationEntry> {
    const found = this.history.find((item) => item.entry.id === id);
    if (!found) {
      throw new Error("No se encontró esa narración en el historial reciente.");
    }
    return this.narrateText({
      text: found.entry.sourceText,
      mode,
      projectName: found.entry.projectName,
      contextSummary: found.entry.contextSummary,
      autoPlay: true,
    });
  }

  private cancelInFlight(): void {
    if (this.activeAbort) {
      this.activeAbort.abort(new Error("Superseded by newer narration job"));
      this.activeAbort = null;
    }
  }

  private emitStatus(phase: NarrationPhase, message: string): void {
    this.phase = phase;
    this.lastMessage = message;
    this.deps.emit({ type: "status", phase, message });
  }

  private async runNarrationJob(params: {
    readonly config: GravozConfig;
    readonly mode: NarrationMode;
    readonly projectContext: ProjectContext;
    readonly transcript: ParsedTranscript;
    readonly triggerAutoPlay: boolean;
  }): Promise<NarrationEntry | null> {
    this.cancelInFlight();
    this.deps.osPlayer.stop();

    const jobId = ++this.currentJobId;
    const controller = new AbortController();
    this.activeAbort = controller;

    try {
      this.emitStatus("summarizing", `Interpretando respuesta (${params.mode})…`);
      const script = await this.deps.summarizer.summarize({
        apiKey: params.config.apiKey,
        model: params.config.summaryModel,
        mode: params.mode,
        projectContext: params.projectContext,
        transcript: params.transcript,
        signal: controller.signal,
      });

      if (jobId !== this.currentJobId) return null;

      this.emitStatus("synthesizing", `Sintetizando voz Gemini (${params.config.voiceName})…`);
      const rawTts = await this.deps.tts.synthesize({
        apiKey: params.config.apiKey,
        model: params.config.ttsModel,
        voiceName: params.config.voiceName,
        text: script,
        signal: controller.signal,
      });

      if (jobId !== this.currentJobId) return null;

      const { wav, durationSec } = ensureWavBuffer(rawTts.audio, rawTts.mimeType);

      const entry: NarrationEntry = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        mode: params.mode,
        voiceName: params.config.voiceName,
        projectName: params.projectContext.projectName,
        script,
        sourceText: params.transcript.latestAssistantResponse,
        contextSummary: params.projectContext.summary,
        audioByteLength: wav.length,
        durationEstimateSec: durationSec,
      };

      this.history.unshift({ entry, wav });
      if (this.history.length > MAX_HISTORY_ITEMS) {
        this.history.pop();
      }

      this.phase = "ready";
      this.lastMessage = "Listo para reproducir.";
      this.deps.emit({
        type: "narration",
        phase: "ready",
        entry,
        audioBase64: wav.toString("base64"),
        autoPlay: params.triggerAutoPlay,
      });

      // Headless fallback: if the sidebar webview is hidden/closed, play via native OS audio.
      // Respaldo nativo: si el panel lateral está cerrado, reproduce mediante el reproductor del SO.
      if (
        params.triggerAutoPlay &&
        params.config.headlessFallback &&
        !this.deps.hasActiveWebview()
      ) {
        this.deps.osPlayer.playWav(wav).catch(() => {
          // Silently ignore headless audio errors when no audio device is available.
        });
      }

      return entry;
    } catch (err) {
      if (jobId !== this.currentJobId || controller.signal.aborted) {
        return null;
      }
      const message = err instanceof Error ? err.message : "Error inesperado al narrar.";
      this.phase = "error";
      this.lastMessage = message;
      this.deps.emit({ type: "error", phase: "error", message });
      return null;
    } finally {
      if (this.activeAbort === controller) {
        this.activeAbort = null;
      }
    }
  }
}
