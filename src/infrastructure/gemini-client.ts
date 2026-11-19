/**
 * Zero-dependency HTTPS client for Google Gemini 3.8 (Summarization + Native TTS).
 * Cliente HTTPS sin dependencias para Google Gemini 3.8 (Resumen contextual + Voz nativa TTS).
 */
import { buildSummarizationPrompt, sanitizeSpokenScript } from "../domain/prompts.js";
import {
  FALLBACK_TTS_MODEL,
  type GeminiVoice,
  type NarrationMode,
  type ParsedTranscript,
  type ProjectContext,
  type SummarizerPort,
  type TtsPort,
} from "../domain/types.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const SUMMARY_TIMEOUT_MS = 22_000;
const TTS_TIMEOUT_MS = 48_000;
const VERIFY_TIMEOUT_MS = 10_000;

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
  const timer = setTimeout(() => controller.abort(new Error("Tiempo de espera agotado con Gemini API")), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function mapGeminiHttpError(status: number, body?: GeminiResponseJson): GeminiHttpError {
  const detail = body?.error?.message ?? "";
  if (status === 400 && detail.toLowerCase().includes("api key")) {
    return new GeminiHttpError(status, "La API key de Google AI Studio no es válida. Revísala en Ajustes.");
  }
  if (status === 401 || status === 403) {
    return new GeminiHttpError(status, "API key rechazada o sin permisos para Gemini. Verifica tu clave en Google AI Studio.");
  }
  if (status === 429) {
    return new GeminiHttpError(status, "Límite gratuito de solicitudes de Gemini alcanzado (429). Espera unos segundos.");
  }
  return new GeminiHttpError(status, `Error de Gemini API (${status})${detail ? `: ${detail}` : ""}`);
}

export class GeminiClient implements SummarizerPort, TtsPort {
  private async postGenerateContent(params: {
    readonly apiKey: string;
    readonly model: string;
    readonly payload: Record<string, unknown>;
    readonly timeoutMs: number;
    readonly parentSignal: AbortSignal;
  }): Promise<GeminiResponseJson> {
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(params.model)}:generateContent`;
    const { signal, cleanup } = linkTimeoutSignal(params.parentSignal, params.timeoutMs);

    try {
      // Pass API key strictly via HTTPS header, never URL query string (OWASP A02).
      // Envía la API key solo por cabecera HTTPS, nunca en query params.
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

  public async summarize(input: {
    readonly apiKey: string;
    readonly model: string;
    readonly mode: NarrationMode;
    readonly projectContext: ProjectContext;
    readonly transcript: ParsedTranscript;
    readonly signal: AbortSignal;
  }): Promise<string> {
    const { systemInstruction, userContent } = buildSummarizationPrompt({
      mode: input.mode,
      projectContext: input.projectContext,
      transcript: input.transcript,
    });

    const json = await this.postGenerateContent({
      apiKey: input.apiKey,
      model: input.model,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      parentSignal: input.signal,
      payload: {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 768,
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

  public async synthesize(input: {
    readonly apiKey: string;
    readonly model: string;
    readonly voiceName: GeminiVoice;
    readonly text: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly audio: Buffer; readonly mimeType: string }> {
    const payload: Record<string, unknown> = {
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
    };

    let json: GeminiResponseJson;
    try {
      json = await this.postGenerateContent({
        apiKey: input.apiKey,
        model: input.model,
        timeoutMs: TTS_TIMEOUT_MS,
        parentSignal: input.signal,
        payload,
      });
    } catch (err) {
      // Automatic fallback to Gemini 3.8 Flash-Lite TTS on 404 or 429 quota pressure.
      // Respaldo automático a Gemini 3.8 Flash-Lite TTS ante 404 o cuota 429.
      if (
        err instanceof GeminiHttpError &&
        (err.status === 404 || err.status === 429) &&
        input.model !== FALLBACK_TTS_MODEL
      ) {
        json = await this.postGenerateContent({
          apiKey: input.apiKey,
          model: FALLBACK_TTS_MODEL,
          timeoutMs: TTS_TIMEOUT_MS,
          parentSignal: input.signal,
          payload,
        });
      } else {
        throw err;
      }
    }

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

  public async verifyKey(apiKey: string, model: string, signal: AbortSignal): Promise<boolean> {
    const trimmed = apiKey.trim();
    if (trimmed.length < 20) return false;
    await this.postGenerateContent({
      apiKey: trimmed,
      model,
      timeoutMs: VERIFY_TIMEOUT_MS,
      parentSignal: signal,
      payload: {
        contents: [{ parts: [{ text: "OK" }] }],
        generationConfig: { maxOutputTokens: 8, temperature: 0 },
      },
    });
    return true;
  }
}
