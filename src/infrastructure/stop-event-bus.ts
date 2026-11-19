/**
 * Zero-port, atomic file-based IPC between Antigravity's Stop hook and the native IDE extension.
 * IPC atómico basado en archivos (sin puertos TCP) entre el hook Stop y la extensión nativa del IDE.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import type { StopHookPayload } from "../domain/types.js";
import { ensurePrivateDir, resolveStateDir } from "./paths.js";

const EVENT_FILE = "stop-event.json";

/** Atomically writes a Stop hook event for the IDE extension to consume. */
/** Escribe atómicamente un evento Stop para que la extensión del IDE lo consuma. */
export function writeStopEvent(
  payload: StopHookPayload,
  stateDir: string = resolveStateDir(),
): void {
  const dir = ensurePrivateDir(stateDir);
  const target = join(dir, EVENT_FILE);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(tmp, 0o600);
  }
  renameSync(tmp, target);
}

/** Watches the private state directory and invokes `onEvent` whenever Antigravity finishes a turn. */
/** Observa el directorio privado de estado e invoca `onEvent` cuando Antigravity termina un turno. */
export class StopEventWatcher {
  private readonly stateDir: string;
  private readonly eventPath: string;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(stateDir: string = resolveStateDir()) {
    this.stateDir = ensurePrivateDir(stateDir);
    this.eventPath = join(this.stateDir, EVENT_FILE);
  }

  public start(onEvent: (payload: StopHookPayload) => void): void {
    this.stop();
    // Consume any event written just before activation.
    this.consumeIfPresent(onEvent);

    this.watcher = watch(this.stateDir, (_eventType, filename) => {
      if (filename && filename !== EVENT_FILE) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.consumeIfPresent(onEvent);
      }, 60);
    });
  }

  public stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private consumeIfPresent(onEvent: (payload: StopHookPayload) => void): void {
    if (!existsSync(this.eventPath)) return;
    try {
      const raw = readFileSync(this.eventPath, "utf8").trim();
      unlinkSync(this.eventPath);
      if (!raw) return;
      const payload = JSON.parse(raw) as StopHookPayload;
      onEvent(payload);
    } catch {
      // Ignore transient rename race or malformed JSON.
    }
  }
}
