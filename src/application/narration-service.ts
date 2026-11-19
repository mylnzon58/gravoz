/**
 * Core orchestration service for Gravoz: context-aware summarization, Gemini 3.8 TTS,
 * cancellation safety (AbortController + monotonic jobId), and bounded replay history.
 * Servicio orquestador principal de Gravoz con cancelación segura e historial acotado.
 */
import { createHash, randomUUID } from "node:crypto";
import { sanitizeSpokenScript } from "../domain/prompts.js";
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
import { hasGlobalAudioPid } from "../infrastructure/os-audio-player.js";
import {
  findLatestAntigravityTranscript,
  type TranscriptParser,
} from "../infrastructure/transcript-parser.js";
import { ensureWavBuffer } from "../infrastructure/wav-encoder.js";

const MAX_HISTORY_ITEMS = 10;
const MIN_GOLDFISH_INPUT_CHARS = 160;
const GREETING_COOLDOWN_MS = 45 * 60_000; // Only allow a greeting after 45+ minutes of silence
const STREAM_SPLIT_MIN_CHARS = 210; // Split long scripts into lead sentence + remainder buffer

/** Splits a long script into [firstSentence, remainder] so audio starts in ~2s while the rest buffers. */
/** Divide un guion largo en [primeraOración, resto] para empezar a sonar en ~2s mientras carga el resto. */
function splitLeadSentence(script: string): { readonly lead: string; readonly rest: string } {
  if (script.length < STREAM_SPLIT_MIN_CHARS) {
    return { lead: script, rest: "" };
  }
  const match = /^(.{45,200}?[.!?])\s+([\s\S]+)$/.exec(script);
  if (!match || !match[1] || !match[2] || match[2].trim().length < 40) {
    return { lead: script, rest: "" };
  }
  return { lead: match[1].trim(), rest: match[2].trim() };
}

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
  private lastStopPayload: StopHookPayload | null = null;
  private activeAbort: AbortController | null = null;
  private currentJobId = 0;
  private phase: NarrationPhase = "idle";
  private lastMessage = "";
  private playingOsAudio = false;
  private playingWebviewAudio = false;
  private lastNarratedAt = 0;

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

  public isBusy(): boolean {
    return (
      this.phase === "collecting" ||
      this.phase === "summarizing" ||
      this.phase === "synthesizing"
    );
  }

  public hasLastTurn(): boolean {
    return this.lastStopPayload !== null;
  }

  public getQuotaSnapshot(): ReturnType<NonNullable<TtsPort["getQuotaSnapshot"]>> | null {
    return this.deps.tts.getQuotaSnapshot
      ? this.deps.tts.getQuotaSnapshot(this.deps.configStore.load())
      : null;
  }

  public getStatus(): {
    readonly phase: NarrationPhase;
    readonly message: string;
    readonly config: PublicConfig;
    readonly history: readonly NarrationEntry[];
    readonly hasLastTurn: boolean;
    readonly quota: ReturnType<NonNullable<TtsPort["getQuotaSnapshot"]>> | null;
  } {
    return {
      phase: this.phase,
      message: this.lastMessage,
      config: this.getPublicConfig(),
      history: this.history.map((item) => item.entry),
      hasLastTurn: this.lastStopPayload !== null,
      quota: this.getQuotaSnapshot(),
    };
  }

  public getAudioBase64(id: string): string | null {
    const found = this.history.find((item) => item.entry.id === id);
    if (found && found.wav.length > 0) return found.wav.toString("base64");
    const fromDisk = this.deps.configStore.getCachedWav(id);
    return fromDisk ? fromDisk.toString("base64") : null;
  }

  public isPlaying(): boolean {
    return this.playingOsAudio || this.playingWebviewAudio || hasGlobalAudioPid();
  }

  public setWebviewPlaying(playing: boolean): void {
    this.playingWebviewAudio = playing;
  }

  public stopPlayback(): void {
    this.cancelInFlight();
    this.playingOsAudio = false;
    this.playingWebviewAudio = false;
    this.deps.osPlayer.stop();
    this.emitStatus("idle", "Reproducción detenida.");
  }

  /** Handles Antigravity Stop hook events asynchronously without blocking the agent. */
  /** Procesa eventos del hook Stop de Antigravity sin bloquear al agente. */
  public handleStopHook(payload: StopHookPayload): { readonly accepted: boolean; readonly reason?: string } {
    if (payload.continuationActive === true) {
      return { accepted: false, reason: "continuation_active" };
    }
    // Wait until all background tasks are done and the chat is truly ready for a new user prompt.
    // Espera a que terminen todas las tareas en segundo plano antes de narrar.
    if (payload.fullyIdle === false) {
      return { accepted: false, reason: "background_tasks_running" };
    }
    if (payload.terminationReason && payload.terminationReason !== "NO_TOOL_CALL") {
      return { accepted: false, reason: `skipped_${payload.terminationReason}` };
    }

    // Always capture the latest completed turn so Manual mode can play it in 1 click.
    // Guarda siempre el último turno completado para que el modo Manual pueda reproducirlo en 1 clic.
    if (payload.transcriptPath) {
      this.lastStopPayload = payload;
    }

    const config = this.deps.configStore.load();
    if (!config.apiKey) {
      return { accepted: false, reason: "no_api_key" };
    }
    if (!config.autoPlay) {
      this.emitStatus("idle", "Nueva respuesta lista (modo Manual).");
      return { accepted: false, reason: "autoplay_disabled" };
    }

    return this.triggerStopPayload(payload, config);
  }

  /** Narrates the latest captured Antigravity chat response on demand. */
  /** Narra bajo demanda la última respuesta del chat de Antigravity. */
  public narrateLastTurn(workspacePaths: readonly string[] = []): {
    readonly accepted: boolean;
    readonly reason?: string;
  } {
    const config = this.deps.configStore.load();
    if (!config.apiKey) {
      return { accepted: false, reason: "no_api_key" };
    }
    const payload = this.resolveLatestPayload(workspacePaths);
    if (!payload) {
      return { accepted: false, reason: "no_captured_turn" };
    }
    return this.triggerStopPayload(payload, config, false);
  }

  /** Called by the live transcript watcher when Antigravity writes a new chat response. */
  /** Invocado por el observador de transcripciones cuando Antigravity termina una nueva respuesta. */
  public handleLiveTranscriptUpdate(
    transcriptPath: string,
    artifactDirectoryPath: string,
    workspacePaths: readonly string[],
  ): { readonly accepted: boolean; readonly reason?: string } {
    const payload: StopHookPayload = {
      transcriptPath,
      artifactDirectoryPath,
      workspacePaths,
      terminationReason: "NO_TOOL_CALL",
    };
    this.lastStopPayload = payload;

    const config = this.deps.configStore.load();
    if (!config.apiKey) return { accepted: false, reason: "no_api_key" };
    if (!config.autoPlay) {
      this.emitStatus("idle", "Nueva respuesta lista (modo Manual).");
      return { accepted: false, reason: "autoplay_disabled" };
    }
    return this.triggerStopPayload(payload, config, true);
  }

  private resolveLatestPayload(workspacePaths: readonly string[]): StopHookPayload | null {
    if (this.lastStopPayload) return this.lastStopPayload;
    const latest = findLatestAntigravityTranscript(workspacePaths);
    if (!latest) return null;
    return {
      transcriptPath: latest.transcriptPath,
      artifactDirectoryPath: latest.artifactDirectoryPath,
      workspacePaths,
      terminationReason: "NO_TOOL_CALL",
    };
  }

  private triggerStopPayload(
    payload: StopHookPayload,
    config: GravozConfig,
    deduplicate = true,
  ): { readonly accepted: boolean; readonly reason?: string } {
    const transcript = this.deps.transcriptParser.parse({
      ...(payload.transcriptPath !== undefined ? { transcriptPath: payload.transcriptPath } : {}),
      ...(payload.workspacePaths !== undefined ? { workspacePaths: payload.workspacePaths } : {}),
      ...(payload.lastUserInput !== undefined ? { fallbackUserPrompt: payload.lastUserInput } : {}),
    });

    if (!transcript) {
      return { accepted: false, reason: "empty_transcript" };
    }

    // Never auto-narrate mid-turn while Antigravity is still running tools.
    // Nunca narra automáticamente a mitad de turno mientras Antigravity sigue ejecutando herramientas.
    if (deduplicate && transcript.isTurnComplete === false) {
      return { accepted: false, reason: "turn_in_progress" };
    }

    // Fingerprint ONLY the normalized response text so StopHook + live poller + multiple windows
    // always produce the exact same hash and never cut off or replay an active narration.
    const normalizedResponse = transcript.latestAssistantResponse.replace(/\s+/g, " ").trim();
    const wordCount = normalizedResponse.split(/\s+/).filter(Boolean).length;
    if (deduplicate && (wordCount < 10 || normalizedResponse.length < 45)) {
      return { accepted: false, reason: "short_response_skipped" };
    }

    const fingerprint = createHash("sha256").update(normalizedResponse).digest("hex");

    if (deduplicate) {
      if (!this.deps.configStore.tryClaimFingerprint(fingerprint)) {
        return { accepted: false, reason: "already_narrated" };
      }
    } else {
      this.deps.configStore.recordNarratedFingerprint(fingerprint);
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

    const result = await this.runNarrationJob({
      config,
      mode,
      projectContext,
      transcript,
      triggerAutoPlay: input.autoPlay ?? true,
    });
    if (result.kind === "error") {
      throw new Error(result.message);
    }
    if (result.kind === "cancelled") {
      throw new Error("Narración reemplazada por una nueva solicitud.");
    }
    return result.entry;
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
  }): Promise<
    | { readonly kind: "ok"; readonly entry: NarrationEntry }
    | { readonly kind: "cancelled" }
    | { readonly kind: "error"; readonly message: string }
  > {
    this.cancelInFlight();
    this.deps.osPlayer.stop();

    const jobId = ++this.currentJobId;
    const controller = new AbortController();
    this.activeAbort = controller;

    try {
      const memoryKey = params.projectContext.projectName;
      const memoryNotes = this.deps.configStore.loadElephantMemory(memoryKey);
      const enrichedContext: ProjectContext =
        memoryNotes.length > 0
          ? { ...params.projectContext, elephantMemory: memoryNotes.join("\n") }
          : params.projectContext;

      // Quota-saving fast path: only for ultra-short messages already in the target language.
      // Never skip the LLM if the text looks like English when Spanish is configured.
      const rawLatest = params.transcript.latestAssistantResponse.trim();
      const looksLikeEnglish = /\b(the|and|with|error|failed|could not|please|file|directory)\b/i.test(rawLatest);
      const canSkipSummarizer =
        params.mode !== "tecnico" &&
        rawLatest.length <= 130 &&
        !rawLatest.includes("```") &&
        !rawLatest.includes("|---") &&
        (params.config.language === "en" || !looksLikeEnglish);

      const runGoldfish =
        !canSkipSummarizer &&
        Boolean(this.deps.summarizer.critique) &&
        params.config.goldfishReview === true &&
        params.mode !== "al-grano" &&
        rawLatest.length >= MIN_GOLDFISH_INPUT_CHARS;

      let baseScript: string;
      let goldfishNote = "";

      if (canSkipSummarizer) {
        baseScript = sanitizeSpokenScript(rawLatest, params.mode);
      } else {
        this.emitStatus(
          "summarizing",
          runGoldfish ? `Analizando Elephant + Goldfish (${params.mode})…` : `Resumiendo (${params.mode})…`,
        );

        [baseScript, goldfishNote] = await Promise.all([
          this.deps.summarizer.summarize({
            apiKey: params.config.apiKey,
            backupApiKeys: params.config.backupApiKeys,
            model: params.config.summaryModel,
            language: params.config.language,
            mode: params.mode,
            projectContext: enrichedContext,
            transcript: params.transcript,
            signal: controller.signal,
          }),
          runGoldfish && this.deps.summarizer.critique
            ? this.deps.summarizer
                .critique({
                  apiKey: params.config.apiKey,
                  backupApiKeys: params.config.backupApiKeys,
                  model: params.config.summaryModel,
                  language: params.config.language,
                  latestResponse: rawLatest,
                  signal: controller.signal,
                })
                .catch(() => "")
            : Promise.resolve(""),
        ]);
      }

      const now = Date.now();
      const allowGreeting = this.lastNarratedAt === 0 || now - this.lastNarratedAt >= GREETING_COOLDOWN_MS;
      this.lastNarratedAt = now;
      const cleanedBase = sanitizeSpokenScript(baseScript, params.mode, allowGreeting);

      const blindSpotPrefix =
        params.config.language === "en" ? "Blind spot to check:" : "Punto ciego a revisar:";
      const script = goldfishNote ? `${cleanedBase} ${blindSpotPrefix} ${goldfishNote}` : cleanedBase;

      // Persist per-project Elephant memory so multi-window / reloads never lose context.
      this.deps.configStore.appendElephantMemory(memoryKey, `- ${baseScript.slice(0, 180)}`);

      if (jobId !== this.currentJobId) return { kind: "cancelled" };

      const useOsAudio = params.triggerAutoPlay && params.config.headlessFallback;
      const audioCacheKey = createHash("sha256")
        .update(`${params.config.voiceName}:${script}`)
        .digest("hex");

      const cachedWav = this.deps.configStore.getCachedWav(audioCacheKey);
      let wav: Buffer;
      let durationSec: number;
      let alreadyPlayedLead = false;

      if (cachedWav) {
        wav = cachedWav;
        durationSec = Math.max(1, Math.round(Math.max(0, wav.length - 44) / 48000));
      } else {
        this.emitStatus("synthesizing", `Generando voz (${params.config.voiceName})…`);
        const { lead, rest } = useOsAudio ? splitLeadSentence(script) : { lead: script, rest: "" };

        try {
          const restPromise = rest
            ? this.deps.tts
                .synthesize({
                  apiKey: params.config.apiKey,
                  backupApiKeys: params.config.backupApiKeys,
                  model: params.config.ttsModel,
                  voiceName: params.config.voiceName,
                  text: rest,
                  signal: controller.signal,
                })
                .catch(() => null)
            : Promise.resolve(null);

          const leadTts = await this.deps.tts.synthesize({
            apiKey: params.config.apiKey,
            backupApiKeys: params.config.backupApiKeys,
            model: params.config.ttsModel,
            voiceName: params.config.voiceName,
            text: lead,
            signal: controller.signal,
          });

          if (jobId !== this.currentJobId) return { kind: "cancelled" };

          const leadWav = ensureWavBuffer(leadTts.audio, leadTts.mimeType);

          if (rest && useOsAudio) {
            // Start speaking the first sentence IMMEDIATELY while the rest buffers in parallel!
            alreadyPlayedLead = true;
            this.playingOsAudio = true;
            this.emitStatus("ready", "Reproduciendo…");
            const leadPlayPromise = this.deps.osPlayer.playWav(leadWav.wav).catch(() => {});
            const [restTts] = await Promise.all([restPromise, leadPlayPromise]);

            if (jobId !== this.currentJobId) return { kind: "cancelled" };

            if (restTts) {
              const restWav = ensureWavBuffer(restTts.audio, restTts.mimeType);
              await this.deps.osPlayer.playWav(restWav.wav).catch(() => {});
              const combinedPcm = Buffer.concat([
                leadWav.wav.subarray(44),
                restWav.wav.subarray(44),
              ]);
              const combined = ensureWavBuffer(combinedPcm, "audio/L16;codec=pcm;rate=24000");
              wav = combined.wav;
              durationSec = combined.durationSec;
            } else {
              wav = leadWav.wav;
              durationSec = leadWav.durationSec;
            }
            this.playingOsAudio = false;
            this.emitStatus("ready", "Listo.");
          } else {
            wav = leadWav.wav;
            durationSec = leadWav.durationSec;
          }

          this.deps.configStore.setCachedWav(audioCacheKey, wav);
        } catch (ttsErr) {
          throw ttsErr;
        }
      }

      if (jobId !== this.currentJobId) return { kind: "cancelled" };

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
      this.lastMessage = "Listo.";

      const quota = this.getQuotaSnapshot();
      this.deps.emit({
        type: "narration",
        phase: "ready",
        entry,
        audioBase64: wav.toString("base64"),
        ...(quota ? { quota } : {}),
        autoPlay: params.triggerAutoPlay && !useOsAudio,
      });

      if (useOsAudio && !alreadyPlayedLead) {
        this.playingOsAudio = true;
        this.emitStatus("ready", "Reproduciendo…");
        this.deps.osPlayer
          .playWav(wav)
          .catch(() => {
            // Silently ignore headless audio errors when no audio device is available.
          })
          .finally(() => {
            this.playingOsAudio = false;
            this.emitStatus("ready", "Listo.");
          });
      }

      return { kind: "ok", entry };
    } catch (err) {
      if (jobId !== this.currentJobId || controller.signal.aborted) {
        return { kind: "cancelled" };
      }
      const message = err instanceof Error ? err.message : "Error inesperado al narrar.";
      this.phase = "error";
      this.lastMessage = message;
      this.deps.emit({ type: "error", phase: "error", message });
      return { kind: "error", message };
    } finally {
      if (this.activeAbort === controller) {
        this.activeAbort = null;
      }
    }
  }
}
