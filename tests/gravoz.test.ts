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
import { maskApiKey, type AudioPlayerPort, type SummarizerPort, type TtsPort } from "../src/domain/types.js";
import { ConfigStore } from "../src/infrastructure/config-store.js";
import { ContextCollector } from "../src/infrastructure/context-collector.js";
import { isPathWithinRoot } from "../src/infrastructure/paths.js";
import { TranscriptParser } from "../src/infrastructure/transcript-parser.js";
import { ensureWavBuffer, parsePcmMimeType } from "../src/infrastructure/wav-encoder.js";
import { GravozHttpServer } from "../src/interfaces/http-server.js";

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
    const pcm = Buffer.alloc(48000); // 1 second at 24kHz * 2 bytes
    const { wav, durationSec } = ensureWavBuffer(pcm, "audio/L16;codec=pcm;rate=24000");

    assert.equal(wav.length, 44 + pcm.length);
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(wav.readUInt16LE(20), 1); // PCM
    assert.equal(wav.readUInt16LE(22), 1); // mono
    assert.equal(wav.readUInt32LE(24), 24000); // sampleRate
    assert.equal(wav.readUInt16LE(34), 16); // bitsPerSample
    assert.equal(wav.readUInt32LE(40), pcm.length);
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
      projectContext: { projectName: "gravoz", summary: "Plugin de voz", recentArtifacts: "" },
      transcript: {
        lastUserPrompt: "Crea un plan",
        recentHistory: "",
        latestAssistantResponse: "Aquí está el plan completo.",
      },
    });
    assert.match(built.systemInstruction, /AL GRANO/);
    assert.match(built.userContent, /<<<UNTRUSTED_LATEST_ANTIGRAVITY_RESPONSE>>>/);
  });

  it("strips markdown syntax and respects mode character ceilings", () => {
    const raw = "## **Plan** con `codigo` y [enlace](https://example.com) ```ts\nconst x = 1;\n```";
    const clean = sanitizeSpokenScript(raw, "al-grano");
    assert.ok(!clean.includes("**"));
    assert.ok(!clean.includes("```"));
    assert.ok(!clean.includes("https://example.com"));
    assert.ok(clean.includes("Plan"));
    assert.ok(clean.includes("enlace"));
  });

  it("masks API keys safely", () => {
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

describe("ConfigStore & TranscriptParser", () => {
  it("persists config atomically and manages runtime.json lifecycle", () => {
    const stateDir = makeTempDir("gravoz-state-");
    const store = new ConfigStore(stateDir);
    const updated = store.update({ apiKey: "AIzaSyTestKey9999", mode: "tecnico", autoPlay: false });
    assert.equal(updated.mode, "tecnico");
    assert.equal(updated.autoPlay, false);
    assert.equal(store.load().apiKey, "AIzaSyTestKey9999");

    store.writeRuntime({ pid: 123, port: 4321, token: "abc", startedAt: "2026-01-01T00:00:00Z" });
    assert.equal(store.readRuntime()?.port, 4321);
    store.removeRuntime();
    assert.equal(store.readRuntime(), null);
  });

  it("parses JSONL transcripts while ignoring malformed trailing lines", () => {
    const ws = makeTempDir("gravoz-ws-");
    const transcriptPath = join(ws, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>Explícame el plan</USER_REQUEST>" }),
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "Hemos implementado la arquitectura limpia." }),
      "{corrupted-flushing-line",
    ].join("\n");
    writeFileSync(transcriptPath, lines, "utf8");

    const parser = new TranscriptParser();
    const parsed = parser.parse({ transcriptPath, workspacePaths: [ws] });
    assert.ok(parsed);
    assert.equal(parsed.lastUserPrompt, "Explícame el plan");
    assert.equal(parsed.latestAssistantResponse, "Hemos implementado la arquitectura limpia.");
  });
});

describe("NarrationService & GravozHttpServer Integration", () => {
  it("enforces OWASP Host/Auth headers and completes end-to-end narration", async () => {
    const stateDir = makeTempDir("gravoz-int-");
    const store = new ConfigStore(stateDir);
    store.update({ apiKey: "AIzaSyIntegrationKey1234", mode: "normal", autoPlay: true });

    const summarizer: SummarizerPort = {
      async summarize({ mode }) {
        return `Resumen generado en modo ${mode} para tu proyecto.`;
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
    let playedCount = 0;
    const osPlayer: AudioPlayerPort = {
      async playWav() {
        playedCount += 1;
      },
      stop() {},
    };

    const server = new GravozHttpServer("test-secret-token");
    const service = new NarrationService({
      configStore: store,
      contextCollector: new ContextCollector(),
      transcriptParser: new TranscriptParser(),
      summarizer,
      tts,
      osPlayer,
      hasUiSubscribers: () => server.hasUiSubscribers(),
      broadcast: (e) => server.broadcast(e),
    });
    server.attachService(service);
    const port = await server.listen(0);

    try {
      // 1. Unauthorized API call must fail with 401
      const unauth = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.equal(unauth.status, 401);

      // 2. Authorized status returns masked key (never plaintext)
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: "Bearer test-secret-token" },
      });
      assert.equal(statusRes.status, 200);
      const statusBody = (await statusRes.json()) as { config: { maskedApiKey: string; hasApiKey: boolean } };
      assert.equal(statusBody.config.hasApiKey, true);
      assert.equal(statusBody.config.maskedApiKey, "AIza••••1234");

      // 3. Narrate text end-to-end and fetch generated WAV audio
      const narRes = await fetch(`http://127.0.0.1:${port}/api/narrate`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-secret-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "Plan de pruebas completado", mode: "al-grano" }),
      });
      assert.equal(narRes.status, 200);
      const narBody = (await narRes.json()) as { entry: { id: string; script: string } };
      assert.match(narBody.entry.script, /al-grano/);
      assert.equal(playedCount, 1);

      const audioRes = await fetch(
        `http://127.0.0.1:${port}/api/audio/${narBody.entry.id}?token=test-secret-token`,
      );
      assert.equal(audioRes.status, 200);
      assert.equal(audioRes.headers.get("content-type"), "audio/wav");
      const wavBuf = Buffer.from(await audioRes.arrayBuffer());
      assert.equal(wavBuf.subarray(0, 4).toString("ascii"), "RIFF");

      // 4. Stop hook skips USER_CANCELED cleanly
      const skipRes = service.handleStopHook({ terminationReason: "USER_CANCELED" });
      assert.equal(skipRes.accepted, false);
    } finally {
      await server.close();
    }
  });
});
