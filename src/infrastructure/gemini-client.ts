/**
 * Zero-dependency HTTPS client for Google Gemini (Fast Summarization + Native 3.8 TTS)
 * with instant multi-model fallback on 503/429/404 for low-latency narration.
 * Cliente HTTPS sin dependencias para Google Gemini con respaldo instantáneo multi-modelo.
 */
import { buildGoldfishPrompt, buildSummarizationPrompt, sanitizeSpokenScript } from "../domain/prompts.js";
import {
  FALLBACK_SUMMARY_MODELS,
  FALLBACK_TTS_MODELS,
  maskApiKey,
  type GeminiVoice,
  type GravozConfig,
  type KeyQuotaStatus,
  type ModelQuotaStatus,
  type NarrationLanguage,
  type NarrationMode,
  type ParsedTranscript,
  type ProjectContext,
  type QuotaHealthState,
  type QuotaSnapshot,
  type SummarizerPort,
  type TtsPort,
} from "../domain/types.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const SUMMARY_TIMEOUT_MS = 18_000;
const TTS_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 10_000;
const COOLDOWN_429_MS = 10 * 60_000; // 10 min sticky skip on quota-exhausted model
const COOLDOWN_503_MS = 90_000; // 90s sticky skip on overloaded model

interface GeminiResponseJson {
  readonly candidates?: ReadonlyArray<{
    readonly content?: {
      readonly parts?: ReadonlyArray<{
        readonly text?: string;
        readonly inlineData?: {
          readonly mimeType?: string;
          readonly data?: string;
        };
      }>;
    };
  }>;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly status?: string;
  };
}

class GeminiHttpError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function linkTimeoutSignal(parent: AbortSignal, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error("Tiempo de espera agotado con Gemini API")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function isFallbackStatus(status: number): boolean {
  return status === 404 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function mapGeminiHttpError(status: number, body?: GeminiResponseJson): GeminiHttpError {
  const detail = body?.error?.message ?? "";
  if (status === 400 && detail.toLowerCase().includes("api key")) {
    return new GeminiHttpError(status, "La API key de Google AI Studio no es válida.");
  }
  if (status === 401 || status === 403) {
    return new GeminiHttpError(status, "API key rechazada o sin permisos para Gemini.");
  }
  if (status === 429) {
    return new GeminiHttpError(status, "Límite gratuito de solicitudes alcanzado (429). Espera unos segundos.");
  }
  if (status === 503) {
    return new GeminiHttpError(status, "Gemini tiene alta demanda temporal (503). Intenta de nuevo en unos segundos.");
  }
  return new GeminiHttpError(status, `Error de Gemini API (${status})${detail ? `: ${detail}` : ""}`);
}

interface CooldownEntry {
  readonly until: number;
  readonly state: QuotaHealthState;
}

export class GeminiClient implements SummarizerPort, TtsPort {
  // Smart circuit-breaker + lightweight daily quota/health telemetry per API key and model.
  private readonly cooldowns = new Map<string, CooldownEntry>();
  private readonly keyCalls = new Map<string, number>();
  private readonly modelCalls = new Map<string, number>();
  private readonly invalidKeys = new Set<string>();
  private statsDate = new Date().toISOString().slice(0, 10);
  private activeSummaryModel = "";
  private activeTtsModel = "";
  private lastSwitchNotice = "";

  private ensureToday(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.statsDate) {
      this.statsDate = today;
      this.keyCalls.clear();
      this.modelCalls.clear();
      this.cooldowns.clear();
      this.lastSwitchNotice = "";
    }
  }

  private keyId(apiKey: string): string {
    return apiKey.trim().slice(-8);
  }

  private cooldownKey(apiKey: string, model: string): string {
    return `${this.keyId(apiKey)}:${model}`;
  }

  private getCooldown(apiKey: string, model: string): CooldownEntry | null {
    const entry = this.cooldowns.get(this.cooldownKey(apiKey, model));
    if (!entry) return null;
    if (Date.now() >= entry.until) {
      this.cooldowns.delete(this.cooldownKey(apiKey, model));
      return null;
    }
    return entry;
  }

  private isCoolingDown(apiKey: string, model: string): boolean {
    return this.getCooldown(apiKey, model) !== null;
  }

  private markCooldown(apiKey: string, model: string, status: number): void {
    const state: QuotaHealthState = status === 429 ? "cooldown_429" : "cooldown_503";
    const ms = status === 429 ? COOLDOWN_429_MS : COOLDOWN_503_MS;
    this.cooldowns.set(this.cooldownKey(apiKey, model), { until: Date.now() + ms, state });
  }

  public getQuotaSnapshot(config: GravozConfig): QuotaSnapshot {
    this.ensureToday();
    const allKeys = [
      { label: "Principal", raw: config.apiKey.trim() },
      ...config.backupApiKeys.map((k, i) => ({ label: `Respaldo ${i + 1}`, raw: k.trim() })),
    ].filter((k) => k.raw.length > 0);

    const summaryModels = [
      config.summaryModel,
      ...FALLBACK_SUMMARY_MODELS.filter((m) => m !== config.summaryModel),
    ];
    const ttsModels = [
      config.ttsModel,
      ...FALLBACK_TTS_MODELS.filter((m) => m !== config.ttsModel),
    ];

    const keys: KeyQuotaStatus[] = allKeys.map((item) => {
      const id = this.keyId(item.raw);
      if (this.invalidKeys.has(id)) {
        return {
          label: item.label,
          maskedKey: maskApiKey(item.raw),
          callsToday: this.keyCalls.get(id) ?? 0,
          state: "invalid",
          cooldownSec: 0,
        };
      }
      // Key is cooling only if ALL TTS models on this key are currently cooling.
      const ttsCooldowns = ttsModels.map((m) => this.getCooldown(item.raw, m));
      const allCooling = ttsCooldowns.length > 0 && ttsCooldowns.every((c) => c !== null);
      const minRemaining = allCooling
        ? Math.max(
            0,
            Math.round((Math.min(...ttsCooldowns.map((c) => c!.until)) - Date.now()) / 1000),
          )
        : 0;
      return {
        label: item.label,
        maskedKey: maskApiKey(item.raw),
        callsToday: this.keyCalls.get(id) ?? 0,
        state: allCooling ? ttsCooldowns[0]!.state : "ok",
        cooldownSec: minRemaining,
      };
    });

    const summarizeModelState = (model: string): { state: QuotaHealthState; cooldownSec: number } => {
      const primary = allKeys[0]?.raw;
      if (!primary) return { state: "ok", cooldownSec: 0 };
      const cd = this.getCooldown(primary, model);
      if (!cd) return { state: "ok", cooldownSec: 0 };
      return {
        state: cd.state,
        cooldownSec: Math.max(0, Math.round((cd.until - Date.now()) / 1000)),
      };
    };

    const models: ModelQuotaStatus[] = [
      ...summaryModels.map((model) => ({
        model,
        kind: "summary" as const,
        callsToday: this.modelCalls.get(model) ?? 0,
        ...summarizeModelState(model),
      })),
      ...ttsModels.map((model) => ({
        model,
        kind: "tts" as const,
        callsToday: this.modelCalls.get(model) ?? 0,
        ...summarizeModelState(model),
      })),
    ];

    return {
      date: this.statsDate,
      activeSummaryModel: this.activeSummaryModel || config.summaryModel,
      activeTtsModel: this.activeTtsModel || config.ttsModel,
      lastSwitchNotice: this.lastSwitchNotice,
      keys,
      models,
    };
  }

  private async postOnce(params: {
    readonly apiKey: string;
    readonly model: string;
    readonly payload: Record<string, unknown>;
    readonly timeoutMs: number;
    readonly parentSignal: AbortSignal;
  }): Promise<GeminiResponseJson> {
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(params.model)}:generateContent`;
    const { signal, cleanup } = linkTimeoutSignal(params.parentSignal, params.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": params.apiKey,
        },
        body: JSON.stringify(params.payload),
        signal,
      });

      const json = (await res.json().catch(() => ({}))) as GeminiResponseJson;
      if (!res.ok) {
        throw mapGeminiHttpError(res.status, json);
      }
      return json;
    } finally {
      cleanup();
    }
  }

  /** Tries each configured API key (primary + backups) and model fallbacks seamlessly. */
  /** Intenta cada API key configurada (principal + respaldos) y modelos de respaldo sin fricción. */
  private async postWithFallback(params: {
    readonly apiKey: string;
    readonly backupApiKeys?: readonly string[];
    readonly kind: "summary" | "tts";
    readonly primaryModel: string;
    readonly fallbackModels: readonly string[];
    readonly payload: Record<string, unknown>;
    readonly timeoutMs: number;
    readonly parentSignal: AbortSignal;
  }): Promise<GeminiResponseJson> {
    this.ensureToday();
    const keys = [
      params.apiKey.trim(),
      ...(params.backupApiKeys ?? []).map((k) => k.trim()),
    ].filter((k, idx, arr) => k.length > 0 && arr.indexOf(k) === idx);

    const models = [
      params.primaryModel,
      ...params.fallbackModels.filter((m) => m !== params.primaryModel),
    ];

    let lastErr: unknown;
    // Try healthy (non-cooling) pairs first; if all are in cooldown, probe them anyway.
    for (const ignoreCooldown of [false, true]) {
      for (let keyIdx = 0; keyIdx < keys.length; keyIdx += 1) {
        const key = keys[keyIdx]!;
        for (const model of models) {
          if (!ignoreCooldown && this.isCoolingDown(key, model)) continue;
          if (params.parentSignal.aborted) {
            throw params.parentSignal.reason ?? new Error("Aborted");
          }
          try {
            const result = await this.postOnce({
              apiKey: key,
              model,
              payload: params.payload,
              timeoutMs: params.timeoutMs,
              parentSignal: params.parentSignal,
            });
            const kid = this.keyId(key);
            this.invalidKeys.delete(kid);
            this.keyCalls.set(kid, (this.keyCalls.get(kid) ?? 0) + 1);
            this.modelCalls.set(model, (this.modelCalls.get(model) ?? 0) + 1);

            if (params.kind === "summary") this.activeSummaryModel = model;
            else this.activeTtsModel = model;

            if (model !== params.primaryModel || keyIdx > 0) {
              const keyLabel = keyIdx === 0 ? "Principal" : `Respaldo ${keyIdx}`;
              this.lastSwitchNotice = `Cambio automático → ${model} (${keyLabel})`;
            } else {
              this.lastSwitchNotice = "";
            }
            return result;
          } catch (err) {
            lastErr = err;
            if (err instanceof GeminiHttpError) {
              if (err.status === 401 || err.status === 403) {
                this.invalidKeys.add(this.keyId(key));
                break;
              }
              if (err.status === 429 || err.status === 503) {
                this.markCooldown(key, model, err.status);
              }
              if (isFallbackStatus(err.status)) {
                continue;
              }
            }
            throw err;
          }
        }
      }
    }
    throw lastErr;
  }

  public async summarize(input: {
    readonly apiKey: string;
    readonly backupApiKeys?: readonly string[];
    readonly model: string;
    readonly language: NarrationLanguage;
    readonly mode: NarrationMode;
    readonly projectContext: ProjectContext;
    readonly transcript: ParsedTranscript;
    readonly signal: AbortSignal;
  }): Promise<string> {
    const { systemInstruction, userContent } = buildSummarizationPrompt({
      mode: input.mode,
      language: input.language,
      projectContext: input.projectContext,
      transcript: input.transcript,
    });

    const json = await this.postWithFallback({
      apiKey: input.apiKey,
      ...(input.backupApiKeys !== undefined ? { backupApiKeys: input.backupApiKeys } : {}),
      kind: "summary",
      primaryModel: input.model,
      fallbackModels: FALLBACK_SUMMARY_MODELS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      parentSignal: input.signal,
      payload: {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 512,
        },
      },
    });

    const rawText =
      json.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join(" ")
        .trim() ?? "";

    if (rawText.length === 0) {
      throw new Error("Gemini no devolvió texto de resumen para narrar.");
    }

    return sanitizeSpokenScript(rawText, input.mode);
  }

  /** Stateless Goldfish fresh-eyes critique (zero conversation history). */
  /** Crítica Goldfish sin historial previo (ojos frescos sobre el plan/respuesta). */
  public async critique(input: {
    readonly apiKey: string;
    readonly backupApiKeys?: readonly string[];
    readonly model: string;
    readonly language: NarrationLanguage;
    readonly latestResponse: string;
    readonly signal: AbortSignal;
  }): Promise<string> {
    const { systemInstruction, userContent } = buildGoldfishPrompt(
      input.latestResponse,
      input.language,
    );
    const json = await this.postWithFallback({
      apiKey: input.apiKey,
      ...(input.backupApiKeys !== undefined ? { backupApiKeys: input.backupApiKeys } : {}),
      kind: "summary",
      primaryModel: input.model,
      fallbackModels: FALLBACK_SUMMARY_MODELS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      parentSignal: input.signal,
      payload: {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 120,
        },
      },
    });

    const raw =
      json.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join(" ")
        .trim() ?? "";

    if (!raw || /^none\.?$/i.test(raw)) return "";
    return sanitizeSpokenScript(raw, "al-grano");
  }

  public async synthesize(input: {
    readonly apiKey: string;
    readonly backupApiKeys?: readonly string[];
    readonly model: string;
    readonly voiceName: GeminiVoice;
    readonly text: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly audio: Buffer; readonly mimeType: string }> {
    const json = await this.postWithFallback({
      apiKey: input.apiKey,
      ...(input.backupApiKeys !== undefined ? { backupApiKeys: input.backupApiKeys } : {}),
      kind: "tts",
      primaryModel: input.model,
      fallbackModels: FALLBACK_TTS_MODELS,
      timeoutMs: TTS_TIMEOUT_MS,
      parentSignal: input.signal,
      payload: {
        contents: [{ parts: [{ text: input.text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: input.voiceName,
              },
            },
          },
        },
      },
    });

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const audioPart = parts.find((part) => part.inlineData?.data);
    const base64Data = audioPart?.inlineData?.data;
    const mimeType = audioPart?.inlineData?.mimeType ?? "audio/L16;codec=pcm;rate=24000";

    if (!base64Data) {
      throw new Error("Gemini TTS no devolvió audio en la respuesta.");
    }

    return {
      audio: Buffer.from(base64Data, "base64"),
      mimeType,
    };
  }

  /** Verifies the API key via lightweight GET /v1beta/models (zero inference latency). */
  /** Verifica la API key usando GET /v1beta/models (instantáneo, sin inferencia). */
  public async verifyKey(apiKey: string, _model: string, parentSignal: AbortSignal): Promise<boolean> {
    const trimmed = apiKey.trim();
    if (trimmed.length < 20) return false;

    const { signal, cleanup } = linkTimeoutSignal(parentSignal, VERIFY_TIMEOUT_MS);
    try {
      const res = await fetch(`${GEMINI_API_BASE}?pageSize=1`, {
        method: "GET",
        headers: {
          "x-goog-api-key": trimmed,
        },
        signal,
      });
      const json = (await res.json().catch(() => ({}))) as GeminiResponseJson;
      if (!res.ok) {
        throw mapGeminiHttpError(res.status, json);
      }
      return true;
    } finally {
      cleanup();
    }
  }
}
