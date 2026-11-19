/**
 * Non-blocking Antigravity Stop lifecycle hook.
 * Reads stdin JSON, forwards it to the local Gravoz sidecar, and always emits {"decision":"allow"}.
 * Hook Stop no bloqueante de Antigravity: reenvía el payload al sidecar local y siempre permite continuar.
 */
import type { StopHookPayload } from "../domain/types.js";
import { SidecarClient } from "../infrastructure/sidecar-client.js";

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
      const client = new SidecarClient();
      await client.request("POST", "/api/events/stop", payload, 1_500);
    }
  } catch {
    // Never fail or stall the Antigravity agent loop on audio hook errors (POLA).
  } finally {
    process.stdout.write('{"decision":"allow"}\n');
  }
}

void main();
