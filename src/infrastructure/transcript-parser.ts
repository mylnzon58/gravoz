/**
 * Tail-reading, resilient parser for Antigravity JSONL transcripts.
 * Lector incremental por cola y tolerante a fallos para transcripciones JSONL de Antigravity.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedTranscript } from "../domain/types.js";
import { isAllowedAntigravityPath } from "./paths.js";

const ANTIGRAVITY_BRAIN_ROOTS = [
  join(homedir(), ".gemini", "antigravity", "brain"),
  join(homedir(), ".gemini", "antigravity-ide", "brain"),
  join(homedir(), ".gemini", "antigravity-cli", "brain"),
];

function transcriptMatchesWorkspace(filePath: string, workspaceRoot: string): boolean {
  try {
    const size = statSync(filePath).size;
    if (size <= 0) return false;
    const headLen = Math.min(size, 48 * 1024);
    const headBuf = Buffer.alloc(headLen);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, headBuf, 0, headLen, 0);
      const headText = headBuf.toString("utf8");
      if (
        headText.includes(`- ${workspaceRoot}\n`) ||
        headText.includes(`- ${workspaceRoot}\\n`) ||
        headText.includes(`Command Working Directory: ${workspaceRoot}`) ||
        headText.includes(`"file://${workspaceRoot}"`)
      ) {
        return true;
      }
      return headText.includes(workspaceRoot);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Finds the most recently modified Antigravity chat transcript that belongs to `workspacePaths`.
 * Encuentra la transcripción de chat más reciente que pertenece exclusivamente a este workspace.
 */
export function findLatestAntigravityTranscript(
  workspacePaths: readonly string[] = [],
): {
  readonly transcriptPath: string;
  readonly artifactDirectoryPath: string;
  readonly mtimeMs: number;
} | null {
  const primaryWorkspace = workspacePaths[0]?.trim() ?? "";
  let latest: {
    readonly transcriptPath: string;
    readonly artifactDirectoryPath: string;
    readonly mtimeMs: number;
  } | null = null;

  for (const brainRoot of ANTIGRAVITY_BRAIN_ROOTS) {
    if (!existsSync(brainRoot)) continue;
    let convDirs: string[];
    try {
      convDirs = readdirSync(brainRoot);
    } catch {
      continue;
    }
    for (const convId of convDirs) {
      const convDir = join(brainRoot, convId);
      const transcriptPath = join(convDir, ".system_generated", "logs", "transcript.jsonl");
      if (!existsSync(transcriptPath)) continue;
      try {
        const mtimeMs = statSync(transcriptPath).mtimeMs;
        if (latest && mtimeMs <= latest.mtimeMs) continue;
        if (primaryWorkspace && !transcriptMatchesWorkspace(transcriptPath, primaryWorkspace)) {
          continue;
        }
        latest = { transcriptPath, artifactDirectoryPath: convDir, mtimeMs };
      } catch {
        // Ignore transient stat error.
      }
    }
  }
  return latest;
}

const TAIL_BYTES = 128 * 1024; // 128 KB sliding tail window
const MAX_HISTORY_CHARS = 1_600;
const MAX_LATEST_CHARS = 4_500;

interface TranscriptRow {
  readonly step_index?: number;
  readonly type?: string;
  readonly source?: string;
  readonly content?: string;
  readonly status?: string;
  readonly tool_calls?: readonly unknown[];
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
    const turns: Array<{
      readonly role: "usuario" | "antigravity";
      readonly text: string;
      readonly stepIndex?: number;
    }> = [];
    let lastValidRow: TranscriptRow | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as TranscriptRow;
        lastValidRow = row;
        const content = typeof row.content === "string" ? cleanTurnText(row.content) : "";
        if (!content) continue;

        const hasToolCalls = Array.isArray(row.tool_calls) && row.tool_calls.length > 0;
        const isPlannerResponse =
          row.type === "PLANNER_RESPONSE" ||
          (row.type === undefined && row.source === "MODEL");

        if (row.type === "USER_INPUT" || row.source === "USER_EXPLICIT") {
          turns.push({ role: "usuario", text: content });
        } else if (isPlannerResponse && !hasToolCalls) {
          turns.push({
            role: "antigravity",
            text: content,
            ...(typeof row.step_index === "number" ? { stepIndex: row.step_index } : {}),
          });
        }
      } catch {
        // Ignore malformed or still-flushing JSONL lines safely.
      }
    }

    let latestAssistantResponse = "";
    let latestStepIndex: number | undefined;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (turn && turn.role === "antigravity" && turn.text.length > 0) {
        latestAssistantResponse = turn.text.slice(0, MAX_LATEST_CHARS);
        latestStepIndex = turn.stepIndex;
        break;
      }
    }

    if (!latestAssistantResponse) {
      return null;
    }

    // A turn is complete only when the final JSONL step is a finished PLANNER_RESPONSE
    // with non-empty text and no pending tool calls (never an intermediate GENERIC tool output).
    const lastHasToolCalls =
      Array.isArray(lastValidRow?.tool_calls) && lastValidRow.tool_calls.length > 0;
    const lastContent =
      typeof lastValidRow?.content === "string" ? cleanTurnText(lastValidRow.content) : "";
    const lastIsPlannerResponse = Boolean(
      lastValidRow &&
        (lastValidRow.type === "PLANNER_RESPONSE" ||
          (lastValidRow.type === undefined && lastValidRow.source === "MODEL")),
    );
    const isTurnComplete = Boolean(
      lastValidRow &&
        lastIsPlannerResponse &&
        lastContent.length > 0 &&
        (lastValidRow.status === undefined || lastValidRow.status === "DONE") &&
        !lastHasToolCalls,
    );

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
      ...(latestStepIndex !== undefined ? { latestStepIndex } : {}),
      isTurnComplete,
    };
  }
}

