/**
 * Tail-reading, resilient parser for Antigravity JSONL transcripts.
 * Lector incremental por cola y tolerante a fallos para transcripciones JSONL de Antigravity.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { ParsedTranscript } from "../domain/types.js";
import { isAllowedAntigravityPath } from "./paths.js";

const TAIL_BYTES = 256 * 1024; // 256 KB sliding tail window
const MAX_HISTORY_CHARS = 3_500;
const MAX_LATEST_CHARS = 8_000;

interface TranscriptRow {
  readonly type?: string;
  readonly source?: string;
  readonly content?: string;
  readonly status?: string;
}

/** Reads only the last `maxBytes` of a file to keep memory bounded on huge sessions. */
/** Lee solo los últimos `maxBytes` de un archivo para acotar memoria en sesiones largas. */
function readFileTail(filePath: string, maxBytes: number): string {
  const size = statSync(filePath).size;
  if (size <= 0) return "";

  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  // Drop partial first line when starting mid-file.
  // Descarta la primera línea parcial si empezamos en medio del archivo.
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  return text;
}

function cleanTurnText(raw: string): string {
  return raw
    .replace(/<\/?USER_REQUEST>/g, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, "")
    .trim();
}

export class TranscriptParser {
  public parse(params: {
    readonly transcriptPath?: string;
    readonly workspacePaths?: readonly string[];
    readonly fallbackUserPrompt?: string;
  }): ParsedTranscript | null {
    const { transcriptPath, workspacePaths = [], fallbackUserPrompt = "" } = params;

    if (!transcriptPath || !existsSync(transcriptPath)) {
      return null;
    }
    if (!isAllowedAntigravityPath(transcriptPath, workspacePaths)) {
      return null;
    }

    const tail = readFileTail(transcriptPath, TAIL_BYTES);
    if (!tail.trim()) return null;

    const lines = tail.split(/\r?\n/);
    const turns: Array<{ readonly role: "usuario" | "antigravity"; readonly text: string }> = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as TranscriptRow;
        const content = typeof row.content === "string" ? cleanTurnText(row.content) : "";
        if (!content) continue;

        if (row.type === "USER_INPUT" || row.source === "USER_EXPLICIT") {
          turns.push({ role: "usuario", text: content });
        } else if (row.type === "PLANNER_RESPONSE" || row.source === "MODEL") {
          turns.push({ role: "antigravity", text: content });
        }
      } catch {
        // Ignore malformed or still-flushing JSONL lines safely.
      }
    }

    let latestAssistantResponse = "";
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (turn && turn.role === "antigravity" && turn.text.length > 0) {
        latestAssistantResponse = turn.text.slice(0, MAX_LATEST_CHARS);
        break;
      }
    }

    if (!latestAssistantResponse) {
      return null;
    }

    let lastUserPrompt = fallbackUserPrompt.trim();
    if (!lastUserPrompt) {
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        if (turn && turn.role === "usuario") {
          lastUserPrompt = turn.text.slice(0, 800);
          break;
        }
      }
    }

    const historySlice = turns
      .slice(-8, -1)
      .map((t) => `${t.role === "usuario" ? "Usuario" : "Antigravity"}: ${t.text.slice(0, 450)}`)
      .join("\n")
      .slice(-MAX_HISTORY_CHARS);

    return {
      lastUserPrompt,
      recentHistory: historySlice,
      latestAssistantResponse,
    };
  }
}
