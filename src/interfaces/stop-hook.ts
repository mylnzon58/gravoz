/**
 * Non-blocking Antigravity Stop lifecycle hook (zero TCP ports, <10ms execution).
 * Reads stdin JSON, writes an atomic event file for the IDE extension, and emits {"decision":"allow"}.
 * Hook Stop no bloqueante: escribe el evento atómicamente para la extensión del IDE y libera al agente.
 */
import type { StopHookPayload } from "../domain/types.js";
import { writeStopEvent } from "../infrastructure/stop-event-bus.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    if (raw) {
      const payload = JSON.parse(raw) as StopHookPayload;
      writeStopEvent(payload);
    }
  } catch {
    // Never fail or stall the Antigravity agent loop on hook errors (POLA).
  } finally {
    process.stdout.write('{"decision":"allow"}\n');
  }
}

void main();
