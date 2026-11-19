/**
 * Zero-dependency JSON-RPC 2.0 Stdio MCP server exposing Gravoz voice controls to Antigravity.
 * Servidor MCP Stdio sin dependencias que expone los controles de voz de Gravoz a Antigravity.
 */
import { createInterface } from "node:readline";
import { GEMINI_VOICES, NARRATION_MODES } from "../domain/types.js";
import { SidecarClient } from "../infrastructure/sidecar-client.js";

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "gravoz_narrate",
    description:
      "Narra un texto, plan o respuesta de Antigravity en español con voz nativa de Gemini en modo al-grano, normal o tecnico.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Texto o resumen de la respuesta a narrar." },
        mode: { type: "string", enum: [...NARRATION_MODES], description: "Nivel de profundidad." },
        projectName: { type: "string", description: "Nombre del proyecto actual (opcional)." },
      },
      required: ["text"],
    },
  },
  {
    name: "gravoz_set_config",
    description: "Actualiza el modo de narración, reproducción automática o voz Gemini de Gravoz.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: [...NARRATION_MODES] },
        autoPlay: { type: "boolean" },
        voiceName: { type: "string", enum: [...GEMINI_VOICES] },
      },
    },
  },
  {
    name: "gravoz_status",
    description: "Consulta el estado actual de Gravoz (configuración, modo activo e historial).",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

const client = new SidecarClient();

function writeResponse(id: string | number | null | undefined, result: unknown): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id: string | number | null | undefined, code: number, message: string): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function toolText(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === "gravoz_status") {
    const status = await client.request<Record<string, unknown>>("GET", "/api/status", undefined, 2_000);
    if (!status) {
      return toolText(
        "El panel sidecar de Gravoz no está activo todavía. Ábrelo desde el panel lateral de Antigravity.",
        true,
      );
    }
    return toolText(JSON.stringify(status, null, 2));
  }

  if (name === "gravoz_set_config") {
    const res = await client.request<Record<string, unknown>>("POST", "/api/config", args, 2_000);
    if (!res) {
      return toolText("No se pudo contactar al sidecar local de Gravoz.", true);
    }
    return toolText(`Configuración de Gravoz actualizada: ${JSON.stringify(res["config"])}`);
  }

  if (name === "gravoz_narrate") {
    const res = await client.request<Record<string, unknown>>("POST", "/api/narrate", args, 60_000);
    if (!res) {
      return toolText(
        "No se pudo narrar. Verifica que el sidecar de Gravoz esté activo y tenga tu API key de Google AI Studio.",
        true,
      );
    }
    return toolText(`Narración generada y enviada al reproductor Gravoz.`);
  }

  return toolText(`Herramienta desconocida: ${name}`, true);
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  if (req.method === "initialize") {
    writeResponse(req.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "gravoz-voice", version: "1.0.0" },
    });
    return;
  }

  if (req.method === "notifications/initialized") {
    return;
  }

  if (req.method === "tools/list") {
    writeResponse(req.id, { tools: TOOLS });
    return;
  }

  if (req.method === "tools/call") {
    const name = typeof req.params?.["name"] === "string" ? req.params["name"] : "";
    const args =
      typeof req.params?.["arguments"] === "object" && req.params["arguments"] !== null
        ? (req.params["arguments"] as Record<string, unknown>)
        : {};
    const result = await handleToolCall(name, args);
    writeResponse(req.id, result);
    return;
  }

  writeError(req.id, -32601, `Method not found: ${req.method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed) as JsonRpcRequest;
    void handleRequest(parsed);
  } catch {
    // Ignore malformed JSON-RPC lines.
  }
});
