/**
 * Unit and integration test suite for Gravoz (using built-in node:test).
 * Suite de pruebas unitarias y de integración para Gravoz (usando node:test nativo).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NarrationService } from "../src/application/narration-service.js";
import { buildSummarizationPrompt, sanitizeSpokenScript } from "../src/domain/prompts.js";
import {
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_TTS_MODEL,
  maskApiKey,
  type AudioPlayerPort,
  type SummarizerPort,
  type TtsPort,
  type UiEvent,
} from "../src/domain/types.js";
import { ConfigStore } from "../src/infrastructure/config-store.js";
import { ContextCollector } from "../src/infrastructure/context-collector.js";
import { isPathWithinRoot } from "../src/infrastructure/paths.js";
import { StopEventWatcher, writeStopEvent } from "../src/infrastructure/stop-event-bus.js";
import { TranscriptParser } from "../src/infrastructure/transcript-parser.js";
import { ensureWavBuffer, parsePcmMimeType } from "../src/infrastructure/wav-encoder.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("WavEncoder", () => {
  it("wraps 24kHz 16-bit mono PCM in a valid RIFF/WAVE header", () => {
    const pcm = Buffer.alloc(48000);
    const { wav, durationSec } = ensureWavBuffer(pcm, "audio/L16;codec=pcm;rate=24000");

    assert.equal(wav.length, 44 + pcm.length);
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(durationSec, 1);
  });

  it("parses custom sample rate and channel count from MIME type", () => {
    const fmt = parsePcmMimeType("audio/L16;codec=pcm;rate=16000;channels=2");
    assert.deepEqual(fmt, { sampleRate: 16000, channels: 2, bitsPerSample: 16 });
  });

  it("passes existing WAV buffers through unchanged", () => {
    const pcm = Buffer.alloc(4800);
    const first = ensureWavBuffer(pcm, "audio/L16;codec=pcm;rate=24000");
    const second = ensureWavBuffer(first.wav, "audio/wav");
    assert.equal(second.wav.length, first.wav.length);
  });

  it("rejects unsupported MIME types", () => {
    assert.throws(
      () => ensureWavBuffer(Buffer.from("not-audio"), "audio/ogg"),
      /Unsupported Gemini audio MIME type/,
    );
  });
});

describe("Prompts & Security Hygiene", () => {
  it("separates untrusted project/transcript content with explicit delimiters", () => {
    const built = buildSummarizationPrompt({
      mode: "al-grano",
      projectContext: { projectName: "gravoz", summary: "Extensión de voz", recentArtifacts: "" },
      transcript: {
        lastUserPrompt: "Crea un plan",
        recentHistory: "",
        latestAssistantResponse: "Aquí está el plan completo.",
      },
    });
    assert.match(built.systemInstruction, /AL GRANO/);
    assert.match(built.userContent, /<<<UNTRUSTED_LATEST_ANTIGRAVITY_RESPONSE>>>/);
  });

  it("strips markdown syntax and masks API keys safely", () => {
    const raw = "## **Plan** con `codigo` y [enlace](https://example.com) ```ts\nconst x = 1;\n```";
    const clean = sanitizeSpokenScript(raw, "al-grano");
    assert.ok(!clean.includes("**"));
    assert.ok(!clean.includes("```"));
    assert.equal(maskApiKey("AIzaSyDUMMYKEY1234567890"), "AIza••••7890");
    assert.equal(maskApiKey(""), "");
  });

  it("blocks path traversal outside root", () => {
    const root = makeTempDir("gravoz-root-");
    const outside = makeTempDir("gravoz-out-");
    const insideFile = join(root, "ok.txt");
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(insideFile, "ok");
    writeFileSync(outsideFile, "secret");

    assert.equal(isPathWithinRoot(insideFile, root), true);
    assert.equal(isPathWithinRoot(outsideFile, root), false);
  });
});

describe("ConfigStore, Model Migration & TranscriptParser", () => {
  it("migrates retired gemini-2.5 models automatically to gemini-3.8 defaults", () => {
    const stateDir = makeTempDir("gravoz-mig-");
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({
        apiKey: "AIzaSyLegacyKey1234",
        summaryModel: "gemini-2.5-flash",
        ttsModel: "gemini-2.5-flash-preview-tts",
      }),
    );

    const store = new ConfigStore(stateDir);
    const loaded = store.load();
    assert.equal(loaded.summaryModel, DEFAULT_SUMMARY_MODEL);
    assert.equal(loaded.ttsModel, DEFAULT_TTS_MODEL);
  });

  it("parses JSONL transcripts while ignoring malformed trailing lines", () => {
    const ws = makeTempDir("gravoz-ws-");
    const transcriptPath = join(ws, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>Explícame el plan</USER_REQUEST>" }),
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "Hemos implementado la extensión nativa." }),
      "{corrupted-flushing-line",
    ].join("\n");
    writeFileSync(transcriptPath, lines, "utf8");

    const parser = new TranscriptParser();
    const parsed = parser.parse({ transcriptPath, workspacePaths: [ws] });
    assert.ok(parsed);
    assert.equal(parsed.lastUserPrompt, "Explícame el plan");
    assert.equal(parsed.latestAssistantResponse, "Hemos implementado la extensión nativa.");
  });
});

describe("StopEventBus & NarrationService Integration", () => {
  it("delivers atomic Stop events with zero TCP ports and narrates end-to-end", async () => {
    const stateDir = makeTempDir("gravoz-bus-");
    const store = new ConfigStore(stateDir);
    store.update({ apiKey: "AIzaSyNativeKey1234", mode: "normal", autoPlay: true });

    const events: UiEvent[] = [];
    let playedCount = 0;

    const summarizer: SummarizerPort = {
      async summarize({ mode }) {
        return `Resumen nativo en modo ${mode}.`;
      },
    };
    const tts: TtsPort = {
      async synthesize() {
        return { audio: Buffer.alloc(9600), mimeType: "audio/L16;codec=pcm;rate=24000" };
      },
      async verifyKey() {
        return true;
      },
    };
    const osPlayer: AudioPlayerPort = {
      async playWav() {
        playedCount += 1;
      },
      stop() {},
    };

    const service = new NarrationService({
      configStore: store,
      contextCollector: new ContextCollector(),
      transcriptParser: new TranscriptParser(),
      summarizer,
      tts,
      osPlayer,
      hasActiveWebview: () => false,
      emit: (e) => events.push(e),
    });

    // 1. Direct narration produces WAV base64 and triggers headless OS player when webview is closed
    const entry = await service.narrateText({ text: "Plan completado", mode: "al-grano" });
    assert.match(entry.script, /al-grano/);
    assert.equal(playedCount, 1);

    const narEvent = events.find((e) => e.type === "narration");
    assert.ok(narEvent?.audioBase64);
    const decoded = Buffer.from(narEvent.audioBase64, "base64");
    assert.equal(decoded.subarray(0, 4).toString("ascii"), "RIFF");

    // 2. Stop hook skips USER_CANCELED
    assert.equal(service.handleStopHook({ terminationReason: "USER_CANCELED" }).accepted, false);

    // 3. Atomic StopEventBus delivers payload cleanly to watcher
    const received = await new Promise<string>((resolve) => {
      const watcher = new StopEventWatcher(stateDir);
      watcher.start((payload) => {
        watcher.stop();
        resolve(payload.terminationReason ?? "");
      });
      writeStopEvent({ terminationReason: "NO_TOOL_CALL" }, stateDir);
    });
    assert.equal(received, "NO_TOOL_CALL");
  });
});
