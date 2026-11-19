/**
 * OWASP-hardened local HTTP + SSE server for the Gravoz Auxiliary Pane UI and IPC.
 * Servidor HTTP + SSE local endurecido (OWASP) para la UI del panel lateral e IPC de Gravoz.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NarrationService } from "../application/narration-service.js";
import {
  isGeminiVoice,
  isNarrationMode,
  type GravozConfig,
  type SidecarEvent,
  type StopHookPayload,
} from "../domain/types.js";

const MAX_BODY_BYTES = 256 * 1024;
const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui");

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'",
};

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Payload exceeds maximum allowed size.");
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object body.");
  }
  return parsed as Record<string, unknown>;
}

export class GravozHttpServer {
  private readonly server: Server;
  private readonly token: string;
  private readonly sseClients = new Set<ServerResponse>();
  private service: NarrationService | null = null;
  private boundPort = 0;

  constructor(token: string = randomBytes(24).toString("hex")) {
    this.token = token;
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  public attachService(service: NarrationService): void {
    this.service = service;
  }

  public getToken(): string {
    return this.token;
  }

  public getPort(): number {
    return this.boundPort;
  }

  public hasUiSubscribers(): boolean {
    return this.sseClients.size > 0;
  }

  public broadcast(event: SidecarEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  public listen(port: number = 0): Promise<number> {
    return new Promise((resolveListen, rejectListen) => {
      this.server.once("error", rejectListen);
      this.server.listen(port, "127.0.0.1", () => {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          rejectListen(new Error("Failed to bind TCP port."));
          return;
        }
        this.boundPort = address.port;
        resolveListen(this.boundPort);
      });
    });
  }

  public close(): Promise<void> {
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // Ignore already-closed SSE connections.
      }
    }
    this.sseClients.clear();
    return new Promise((resolveClose) => {
      this.server.close(() => resolveClose());
    });
  }

  private isValidHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const allowed = new Set([`127.0.0.1:${this.boundPort}`, `localhost:${this.boundPort}`]);
    return allowed.has(hostHeader.toLowerCase());
  }

  private isValidOrigin(originHeader: string | undefined): boolean {
    if (!originHeader) return true;
    const allowed = new Set([
      `http://127.0.0.1:${this.boundPort}`,
      `http://localhost:${this.boundPort}`,
    ]);
    return allowed.has(originHeader.toLowerCase());
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      return safeEqual(auth.slice(7).trim(), this.token);
    }
    const queryToken = url.searchParams.get("token");
    if (queryToken) {
      return safeEqual(queryToken, this.token);
    }
    return false;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.service) {
      sendJson(res, 503, { error: "Service unavailable" });
      return;
    }

    // DNS-rebinding & localhost CSRF defense (OWASP A01/A05).
    if (!this.isValidHost(req.headers.host)) {
      sendJson(res, 403, { error: "Invalid Host header" });
      return;
    }
    if (!this.isValidOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: "Invalid Origin header" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.boundPort}`);
    const method = req.method ?? "GET";

    try {
      // Static Lean UX assets (same-origin UI panel)
      if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = readFileSync(resolve(UI_DIR, "index.html"), "utf8").replace(
          "__GRAVOZ_SESSION_TOKEN__",
          this.token,
        );
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
        });
        res.end(html);
        return;
      }

      if (method === "GET" && url.pathname === "/app.css") {
        const css = readFileSync(resolve(UI_DIR, "app.css"), "utf8");
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/css; charset=utf-8" });
        res.end(css);
        return;
      }

      if (method === "GET" && url.pathname === "/app.js") {
        const js = readFileSync(resolve(UI_DIR, "app.js"), "utf8");
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": "application/javascript; charset=utf-8",
        });
        res.end(js);
        return;
      }

      // All /api/* endpoints require per-session Bearer/query token authentication.
      if (url.pathname.startsWith("/api/")) {
        if (!this.isAuthorized(req, url)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        await this.handleApi(method, url, req, res);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      sendJson(res, 400, { error: message });
    }
  }

  private async handleApi(
    method: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const service = this.service!;

    if (method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      this.sseClients.add(res);
      req.on("close", () => {
        this.sseClients.delete(res);
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, service.getStatus());
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/api/audio/")) {
      const id = url.pathname.slice("/api/audio/".length);
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
        sendJson(res, 400, { error: "Invalid audio id" });
        return;
      }
      const wav = service.getAudioBuffer(id);
      if (!wav) {
        sendJson(res, 404, { error: "Audio not found" });
        return;
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "audio/wav",
        "Content-Length": wav.length,
      });
      res.end(wav);
      return;
    }

    if (method === "POST" && url.pathname === "/api/config") {
      const body = await readJsonBody(req);
      const patch: Partial<GravozConfig> = {
        ...(typeof body["apiKey"] === "string" ? { apiKey: body["apiKey"] } : {}),
        ...(isNarrationMode(body["mode"]) ? { mode: body["mode"] } : {}),
        ...(typeof body["autoPlay"] === "boolean" ? { autoPlay: body["autoPlay"] } : {}),
        ...(typeof body["headlessFallback"] === "boolean"
          ? { headlessFallback: body["headlessFallback"] }
          : {}),
        ...(isGeminiVoice(body["voiceName"]) ? { voiceName: body["voiceName"] } : {}),
        ...(typeof body["playbackRate"] === "number" ? { playbackRate: body["playbackRate"] } : {}),
        ...(typeof body["summaryModel"] === "string" ? { summaryModel: body["summaryModel"] } : {}),
        ...(typeof body["ttsModel"] === "string" ? { ttsModel: body["ttsModel"] } : {}),
      };
      sendJson(res, 200, { config: service.updateConfig(patch) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/verify-key") {
      const body = await readJsonBody(req);
      const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"] : "";
      const result = await service.verifyApiKey(apiKey);
      sendJson(res, 200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/api/events/stop") {
      const body = (await readJsonBody(req)) as StopHookPayload;
      const result = service.handleStopHook(body);
      sendJson(res, 202, result);
      return;
    }

    if (method === "POST" && url.pathname === "/api/narrate") {
      const body = await readJsonBody(req);
      const text = typeof body["text"] === "string" ? body["text"] : "";
      const mode = isNarrationMode(body["mode"]) ? body["mode"] : undefined;
      const projectName = typeof body["projectName"] === "string" ? body["projectName"] : undefined;
      const contextSummary =
        typeof body["contextSummary"] === "string" ? body["contextSummary"] : undefined;
      const autoPlay = typeof body["autoPlay"] === "boolean" ? body["autoPlay"] : true;
      const entry = await service.narrateText({
        text,
        ...(mode !== undefined ? { mode } : {}),
        ...(projectName !== undefined ? { projectName } : {}),
        ...(contextSummary !== undefined ? { contextSummary } : {}),
        autoPlay,
      });
      sendJson(res, 200, { entry });
      return;
    }

    if (method === "POST" && url.pathname === "/api/renarrate") {
      const body = await readJsonBody(req);
      const id = typeof body["id"] === "string" ? body["id"] : "";
      const mode = isNarrationMode(body["mode"]) ? body["mode"] : undefined;
      if (!id || !mode) {
        sendJson(res, 400, { error: "Both id and valid mode are required." });
        return;
      }
      const entry = await service.renarrate(id, mode);
      sendJson(res, 200, { entry });
      return;
    }

    if (method === "POST" && url.pathname === "/api/stop") {
      service.stopPlayback();
      sendJson(res, 200, { stopped: true });
      return;
    }

    sendJson(res, 404, { error: "Unknown API route" });
  }
}
