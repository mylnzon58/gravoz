/**
 * Main sidecar daemon entrypoint launched by Antigravity (`sidecars/player/sidecar.json`).
 * Punto de entrada principal del sidecar lanzado por Antigravity.
 */
import { NarrationService } from "../application/narration-service.js";
import { ConfigStore } from "../infrastructure/config-store.js";
import { ContextCollector } from "../infrastructure/context-collector.js";
import { GeminiClient } from "../infrastructure/gemini-client.js";
import { OsAudioPlayer } from "../infrastructure/os-audio-player.js";
import { TranscriptParser } from "../infrastructure/transcript-parser.js";
import { GravozHttpServer } from "./http-server.js";

async function main(): Promise<void> {
  const configStore = new ConfigStore();
  const httpServer = new GravozHttpServer();
  const gemini = new GeminiClient();
  const osPlayer = new OsAudioPlayer();

  const service = new NarrationService({
    configStore,
    contextCollector: new ContextCollector(),
    transcriptParser: new TranscriptParser(),
    summarizer: gemini,
    tts: gemini,
    osPlayer,
    hasUiSubscribers: () => httpServer.hasUiSubscribers(),
    broadcast: (event) => httpServer.broadcast(event),
  });

  httpServer.attachService(service);

  const envPortRaw = process.env["ANTIGRAVITY_SIDECAR_WEB_PORT"] ?? process.env["GRAVOZ_PORT"];
  const requestedPort = envPortRaw ? Number.parseInt(envPortRaw, 10) : 0;
  const safePort = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
    ? requestedPort
    : 0;

  const boundPort = await httpServer.listen(safePort);
  configStore.writeRuntime({
    pid: process.pid,
    port: boundPort,
    token: httpServer.getToken(),
    startedAt: new Date().toISOString(),
  });

  const shutdown = async (): Promise<void> => {
    osPlayer.stop();
    configStore.removeRuntime();
    await httpServer.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("exit", () => configStore.removeRuntime());
}

void main().catch((err) => {
  process.stderr.write(`Gravoz sidecar error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
