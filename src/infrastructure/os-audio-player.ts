/**
 * Cross-platform headless WAV audio player using execFile (zero shell injection risk).
 * Reproductor WAV nativo multiplataforma usando execFile (sin interpolación de shell).
 */
import { execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioPlayerPort } from "../domain/types.js";

interface PlayerCandidate {
  readonly bin: string;
  readonly args: (wavPath: string) => readonly string[];
}

function getPlatformPlayers(): readonly PlayerCandidate[] {
  if (process.platform === "darwin") {
    return [{ bin: "afplay", args: (p) => [p] }];
  }
  if (process.platform === "win32") {
    // Pass WAV path via argument/env-free safe single-quoted literal after strict path check.
    // Pasa la ruta WAV de forma segura en Windows ocultando la ventana de PowerShell.
    return [
      {
        bin: "powershell.exe",
        args: (p) => [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          `$p = New-Object System.Media.SoundPlayer('${p.replace(/'/g, "''")}'); $p.PlaySync(); $p.Dispose()`,
        ],
      },
    ];
  }
  // Linux: prefer PulseAudio/PipeWire (paplay), fallback to ALSA (aplay).
  return [
    { bin: "paplay", args: (p) => [p] },
    { bin: "aplay", args: (p) => ["-q", p] },
  ];
}

function unlinkWithRetry(filePath: string, retries = 4): void {
  try {
    unlinkSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === "EBUSY" || code === "EPERM") && retries > 0) {
      setTimeout(() => unlinkWithRetry(filePath, retries - 1), 120).unref();
    }
  }
}

export class OsAudioPlayer implements AudioPlayerPort {
  private activeChild: ChildProcess | null = null;
  private activeTempFile: string | null = null;

  constructor() {
    const cleanup = (): void => this.stop();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }

  public stop(): void {
    if (this.activeChild) {
      try {
        this.activeChild.kill("SIGTERM");
      } catch {
        // Process already exited.
      }
      this.activeChild = null;
    }
    if (this.activeTempFile) {
      const toRemove = this.activeTempFile;
      this.activeTempFile = null;
      unlinkWithRetry(toRemove);
    }
  }

  public async playWav(wavBuffer: Buffer): Promise<void> {
    this.stop();

    const tempPath = join(tmpdir(), `gravoz-${process.pid}-${randomBytes(6).toString("hex")}.wav`);
    writeFileSync(tempPath, wavBuffer, { mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(tempPath, 0o600);
    }
    this.activeTempFile = tempPath;

    const candidates = getPlatformPlayers();
    let lastError: Error | null = null;

    for (const candidate of candidates) {
      try {
        await this.spawnCandidate(candidate, tempPath);
        this.cleanupIfCurrent(tempPath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        lastError = err instanceof Error ? err : new Error(String(err));
        // If binary is missing (ENOENT), try the next OS fallback player.
        if (code === "ENOENT") continue;
        break;
      }
    }

    this.cleanupIfCurrent(tempPath);
    if (lastError) {
      throw lastError;
    }
  }

  private spawnCandidate(candidate: PlayerCandidate, wavPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = execFile(candidate.bin, [...candidate.args(wavPath)], { windowsHide: true }, (err) => {
        if (this.activeChild === child) {
          this.activeChild = null;
        }
        if (err && !child.killed) {
          reject(err);
        } else {
          resolve();
        }
      });
      this.activeChild = child;
    });
  }

  private cleanupIfCurrent(tempPath: string): void {
    if (this.activeTempFile === tempPath) {
      this.activeTempFile = null;
    }
    unlinkWithRetry(tempPath);
  }
}
