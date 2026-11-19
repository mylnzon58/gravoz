/**
 * Pure TypeScript RIFF/WAVE encoder for Gemini raw PCM audio output.
 * Codificador RIFF/WAVE en TypeScript puro para la salida PCM cruda de Gemini.
 */

export interface PcmFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

const DEFAULT_PCM_FORMAT: PcmFormat = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
};

/** Parses MIME parameters such as `audio/L16;codec=pcm;rate=24000;channels=1`. */
/** Analiza parámetros MIME como `audio/L16;codec=pcm;rate=24000;channels=1`. */
export function parsePcmMimeType(mimeType: string): PcmFormat {
  const normalized = mimeType.toLowerCase();
  const rateMatch = /rate=(\d+)/.exec(normalized);
  const channelsMatch = /channels=(\d+)/.exec(normalized);
  const bitsMatch = /audio\/l(\d+)/.exec(normalized);

  const sampleRate = rateMatch?.[1] ? Number.parseInt(rateMatch[1], 10) : DEFAULT_PCM_FORMAT.sampleRate;
  const channels = channelsMatch?.[1] ? Number.parseInt(channelsMatch[1], 10) : DEFAULT_PCM_FORMAT.channels;
  const bitsPerSample = bitsMatch?.[1] ? Number.parseInt(bitsMatch[1], 10) : DEFAULT_PCM_FORMAT.bitsPerSample;

  return {
    sampleRate: sampleRate >= 8000 && sampleRate <= 96000 ? sampleRate : DEFAULT_PCM_FORMAT.sampleRate,
    channels: channels >= 1 && channels <= 2 ? channels : DEFAULT_PCM_FORMAT.channels,
    bitsPerSample: bitsPerSample === 8 || bitsPerSample === 16 || bitsPerSample === 24 ? bitsPerSample : 16,
  };
}

/**
 * Ensures the returned buffer is a standard WAV container ready for HTML5 Audio and OS players.
 * Garantiza un contenedor WAV estándar listo para HTML5 Audio y reproductores del sistema operativo.
 */
export function ensureWavBuffer(rawAudio: Buffer, mimeType: string): {
  readonly wav: Buffer;
  readonly durationSec: number;
} {
  const lower = mimeType.toLowerCase();
  const hasRiffHeader =
    rawAudio.length >= 12 &&
    rawAudio.subarray(0, 4).toString("ascii") === "RIFF" &&
    rawAudio.subarray(8, 12).toString("ascii") === "WAVE";

  if (lower.includes("audio/wav") || lower.includes("audio/x-wav") || hasRiffHeader) {
    const byteRate = rawAudio.length >= 32 ? rawAudio.readUInt32LE(28) : 48000;
    const dataBytes = Math.max(0, rawAudio.length - 44);
    const durationSec = byteRate > 0 ? Math.max(1, Math.round(dataBytes / byteRate)) : 1;
    return { wav: rawAudio, durationSec };
  }

  if (!lower.includes("pcm") && !lower.includes("audio/l16") && !lower.includes("audio/l8")) {
    throw new Error(`Unsupported Gemini audio MIME type: ${mimeType}`);
  }

  const fmt = parsePcmMimeType(mimeType);
  const blockAlign = fmt.channels * (fmt.bitsPerSample / 8);
  const byteRate = fmt.sampleRate * blockAlign;
  const dataSize = rawAudio.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // Linear PCM format tag
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  const wav = Buffer.concat([header, rawAudio]);
  const durationSec = byteRate > 0 ? Math.max(1, Math.round(dataSize / byteRate)) : 1;
  return { wav, durationSec };
}

