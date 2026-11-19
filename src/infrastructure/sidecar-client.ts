/**
 * Shared IPC client for communicating with the local Gravoz sidecar (DRY: used by Stop hook & MCP server).
 * Cliente IPC compartido para comunicarse con el sidecar local de Gravoz (usado por el hook Stop y el servidor MCP).
 */
import { ConfigStore } from "./config-store.js";

const DEFAULT_TIMEOUT_MS = 2_000;

export class SidecarClient {
  private readonly store: ConfigStore;

  constructor(store: ConfigStore = new ConfigStore()) {
    this.store = store;
  }

  public async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T | null> {
    const runtime = this.store.readRuntime();
    if (!runtime) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `http://127.0.0.1:${runtime.port}${path}`;
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
