/**
 * Native Antigravity IDE / VS Code WebviewViewProvider styled with native --vscode-* theme tokens.
 * Proveedor nativo de panel lateral en Antigravity IDE / VS Code usando tokens --vscode-*.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { NarrationService } from "../application/narration-service.js";
import { isGeminiVoice, isNarrationMode, type GravozConfig, type UiEvent } from "../domain/types.js";

export class GravozViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "gravoz.playerView";

  private view: vscode.WebviewView | undefined;
  private readonly service: NarrationService;
  private readonly onConfigChanged: () => void;

  constructor(service: NarrationService, onConfigChanged: () => void) {
    this.service = service;
    this.onConfigChanged = onConfigChanged;
  }

  public isVisible(): boolean {
    return Boolean(this.view?.visible);
  }

  public postEvent(event: UiEvent): void {
    void this.view?.webview.postMessage(event);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      void this.handleMessage(raw);
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) return;
    const msg = raw as Record<string, unknown>;
    const type = typeof msg["type"] === "string" ? msg["type"] : "";

    if (type === "init") {
      const status = this.service.getStatus();
      const firstId = status.history[0]?.id;
      const firstAudio = firstId ? this.service.getAudioBase64(firstId) : null;
      void this.view?.webview.postMessage({
        type: "snapshot",
        ...status,
        firstAudioBase64: firstAudio,
      });
      return;
    }

    if (type === "verifyAndSaveKey") {
      const apiKey = typeof msg["apiKey"] === "string" ? msg["apiKey"].trim() : "";
      const check = await this.service.verifyApiKey(apiKey);
      if (!check.valid) {
        void this.view?.webview.postMessage({
          type: "keyResult",
          ok: false,
          error: check.error || "API key rechazada por Google AI Studio.",
        });
        return;
      }
      const config = this.service.updateConfig({ apiKey });
      this.onConfigChanged();
      void this.view?.webview.postMessage({
        type: "keyResult",
        ok: true,
        config,
      });
      return;
    }

    if (type === "updateConfig") {
      const patch: Partial<GravozConfig> = {
        ...(isNarrationMode(msg["mode"]) ? { mode: msg["mode"] } : {}),
        ...(typeof msg["autoPlay"] === "boolean" ? { autoPlay: msg["autoPlay"] } : {}),
        ...(isGeminiVoice(msg["voiceName"]) ? { voiceName: msg["voiceName"] } : {}),
        ...(typeof msg["playbackRate"] === "number" ? { playbackRate: msg["playbackRate"] } : {}),
      };
      this.service.updateConfig(patch);
      this.onConfigChanged();
      return;
    }

    if (type === "narrateManual") {
      const text = typeof msg["text"] === "string" ? msg["text"].trim() : "";
      if (!text) return;
      try {
        await this.service.narrateText({ text, autoPlay: true });
      } catch (err) {
        this.postEvent({
          type: "error",
          phase: "error",
          message: err instanceof Error ? err.message : "Error al narrar.",
        });
      }
      return;
    }

    if (type === "renarrate") {
      const id = typeof msg["id"] === "string" ? msg["id"] : "";
      const mode = isNarrationMode(msg["mode"]) ? msg["mode"] : undefined;
      if (!id || !mode) return;
      try {
        await this.service.renarrate(id, mode);
      } catch (err) {
        this.postEvent({
          type: "error",
          phase: "error",
          message: err instanceof Error ? err.message : "Error al re-narrar.",
        });
      }
      return;
    }

    if (type === "loadHistoryItem") {
      const id = typeof msg["id"] === "string" ? msg["id"] : "";
      const status = this.service.getStatus();
      const entry = status.history.find((h) => h.id === id);
      const audioBase64 = id ? this.service.getAudioBase64(id) : null;
      if (entry && audioBase64) {
        this.postEvent({
          type: "narration",
          phase: "ready",
          entry,
          audioBase64,
          autoPlay: true,
        });
      }
      return;
    }

    if (type === "stop") {
      this.service.stopPlayback();
      return;
    }

    if (type === "openExternal") {
      void vscode.env.openExternal(vscode.Uri.parse("https://aistudio.google.com/apikey"));
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");
    const csp = [
      "default-src 'none'",
      "media-src data: blob:",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.45;
    }
    .stack { display: flex; flex-direction: column; gap: 10px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
      border-radius: 6px;
      padding: 10px;
    }
    .hidden { display: none !important; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 0 8px; }
    .phase { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); display: inline-block; }
    .dot-ready { background: var(--vscode-testing-iconPassed, #34d399); }
    .dot-busy { background: var(--vscode-editorWarning-foreground, #fbbf24); }
    .dot-error { background: var(--vscode-errorForeground, #f87171); }
    .segments {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4px;
      background: var(--vscode-input-background);
      padding: 3px;
      border-radius: 6px;
      margin-bottom: 10px;
    }
    button {
      font: inherit;
      cursor: pointer;
      border-radius: 4px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 5px 8px;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .seg { background: transparent; border: none; color: var(--vscode-descriptionForeground); font-size: 12px; padding: 5px 4px; }
    .seg.active, .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
    }
    .btn-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    input[type="password"], textarea, select {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 6px 8px;
      font: inherit;
    }
    select { width: auto; }
    ol.steps { margin: 0 0 8px; padding-left: 18px; font-size: 12px; }
    ol.steps li { margin-bottom: 4px; }
    .link-btn { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); text-decoration: underline; font-size: 12px; }
    .feedback { font-size: 12px; margin: 6px 0 0; min-height: 16px; }
    .feedback.ok { color: var(--vscode-testing-iconPassed, #34d399); }
    .feedback.err { color: var(--vscode-errorForeground, #f87171); }
    .transport { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .play-btn { width: 32px; height: 32px; border-radius: 50%; padding: 0; flex-shrink: 0; }
    .progress { flex: 1; min-width: 0; }
    .progress input[type="range"] { width: 100%; margin: 0; }
    .times { display: flex; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .chips { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
    .chip { font-size: 11px; padding: 2px 7px; border-radius: 999px; }
    details summary { cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .script-body { margin: 6px 0 0; font-size: 12px; white-space: pre-wrap; }
    ul.history { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
    .h-item { width: 100%; text-align: left; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
    .h-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .h-preview { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <div class="stack">
    <div class="row">
      <div class="row" style="gap:6px">
        <span id="dot" class="dot"></span>
        <span id="phase" class="phase">Iniciando…</span>
      </div>
      <button id="btn-settings" type="button" title="API Key de Google AI Studio">API Key</button>
    </div>

    <section id="setup-card" class="card hidden">
      <p class="muted">Conecta tu clave gratuita de Google AI Studio (Gemini 3.8 Flash + TTS). Se guarda solo en local (0600).</p>
      <ol class="steps">
        <li>Abre <button id="btn-open-aistudio" class="link-btn" type="button">aistudio.google.com/apikey</button></li>
        <li>Pulsa <strong>Create API key</strong> y cópiala.</li>
        <li>Pégala aquí abajo y verifica.</li>
      </ol>
      <div class="stack" style="gap:6px">
        <input id="api-key-input" type="password" placeholder="AIzaSy..." autocomplete="off" />
        <button id="btn-save-key" class="btn-primary" type="button">Verificar y guardar</button>
      </div>
      <p id="setup-feedback" class="feedback"></p>
    </section>

    <section class="card">
      <div class="segments" role="radiogroup" aria-label="Nivel de detalle">
        <button class="seg" data-mode="al-grano" type="button">Al grano</button>
        <button class="seg active" data-mode="normal" type="button">Normal</button>
        <button class="seg" data-mode="tecnico" type="button">Técnico</button>
      </div>
      <div class="row" style="margin-bottom:8px">
        <label for="toggle-autoplay" style="font-size:12px;cursor:pointer">Auto-reproducir al terminar</label>
        <input id="toggle-autoplay" type="checkbox" />
      </div>
      <div class="row">
        <label class="row" style="gap:6px;font-size:12px">
          <span>Voz</span>
          <select id="select-voice">
            <option value="Kore">Kore</option>
            <option value="Zephyr">Zephyr</option>
            <option value="Puck">Puck</option>
            <option value="Aoede">Aoede</option>
            <option value="Fenrir">Fenrir</option>
            <option value="Leda">Leda</option>
          </select>
        </label>
        <button id="btn-speed" type="button">1.0x</button>
      </div>
    </section>

    <section class="card">
      <div class="row">
        <strong id="now-project" style="font-size:12px">Sin narración aún</strong>
        <span id="now-mode" class="phase">—</span>
      </div>
      <div class="transport">
        <button id="btn-play" class="btn-primary play-btn" type="button" disabled>▶</button>
        <div class="progress">
          <input id="seek-bar" type="range" min="0" max="100" value="0" step="0.1" disabled />
          <div class="times">
            <span id="t-cur">0:00</span>
            <span id="t-tot">0:00</span>
          </div>
        </div>
        <button id="btn-stop" type="button" title="Detener">■</button>
      </div>
      <div id="renarrate-bar" class="chips hidden">
        <span class="phase">Re-narrar:</span>
        <button class="chip" data-renarrate="al-grano" type="button">Al grano</button>
        <button class="chip" data-renarrate="normal" type="button">Normal</button>
        <button class="chip" data-renarrate="tecnico" type="button">Técnico</button>
      </div>
      <details>
        <summary>Ver guion narrado</summary>
        <p id="script-text" class="script-body">Cuando Antigravity termine una respuesta o plan, el guion aparecerá aquí.</p>
      </details>
      <audio id="audio-el" preload="auto"></audio>
    </section>

    <details class="card">
      <summary>Probar texto manualmente</summary>
      <textarea id="manual-text" rows="3" style="margin:6px 0" placeholder="Pega cualquier texto o plan..."></textarea>
      <button id="btn-manual" class="btn-primary" type="button">Narrar</button>
    </details>

    <section class="card">
      <div class="row">
        <strong style="font-size:12px">Recientes</strong>
        <span id="h-count" class="phase">0</span>
      </div>
      <ul id="h-list" class="history">
        <li class="phase">Aún no hay narraciones en esta sesión.</li>
      </ul>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const SPEEDS = [1.0, 1.25, 1.5, 0.85];
    const MODE_LABELS = { "al-grano": "Al grano", normal: "Normal", tecnico: "Técnico" };

    const $ = (id) => document.getElementById(id);
    const segs = Array.from(document.querySelectorAll(".seg"));
    const renBtns = Array.from(document.querySelectorAll("[data-renarrate]"));
    const audio = $("audio-el");

    let state = { config: null, history: [], currentId: null, speedIdx: 0 };

    function fmt(sec) {
      if (!Number.isFinite(sec) || sec < 0) return "0:00";
      return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
    }

    function setPhase(phase, message) {
      $("phase").textContent = message || phase;
      const dot = $("dot");
      dot.className = "dot";
      if (phase === "ready") dot.classList.add("dot-ready");
      else if (phase === "error") dot.classList.add("dot-error");
      else if (phase === "summarizing" || phase === "synthesizing" || phase === "collecting") dot.classList.add("dot-busy");
    }

    function renderConfig(cfg) {
      state.config = cfg;
      $("setup-card").classList.toggle("hidden", cfg.hasApiKey);
      $("toggle-autoplay").checked = Boolean(cfg.autoPlay);
      $("select-voice").value = cfg.voiceName || "Kore";
      for (const s of segs) s.classList.toggle("active", s.dataset.mode === cfg.mode);
      const rate = cfg.playbackRate || 1.0;
      const idx = SPEEDS.indexOf(rate);
      state.speedIdx = idx >= 0 ? idx : 0;
      $("btn-speed").textContent = rate.toFixed(rate % 1 === 0 ? 1 : 2) + "x";
      audio.playbackRate = rate;
    }

    function loadEntry(entry, audioBase64, autoPlay) {
      state.currentId = entry.id;
      $("now-project").textContent = entry.projectName || "Antigravity";
      $("now-mode").textContent = MODE_LABELS[entry.mode] || entry.mode;
      $("script-text").textContent = entry.script || "";
      $("renarrate-bar").classList.remove("hidden");
      $("btn-play").disabled = false;
      $("seek-bar").disabled = false;
      if (audioBase64) {
        audio.src = "data:audio/wav;base64," + audioBase64;
        audio.playbackRate = state.config ? state.config.playbackRate || 1.0 : 1.0;
        if (autoPlay) {
          audio.play().catch(() => setPhase("ready", "Pulsa ▶ para escuchar"));
        }
      }
    }

    function renderHistory(items) {
      state.history = items;
      $("h-count").textContent = String(items.length);
      const list = $("h-list");
      list.textContent = "";
      if (!items.length) {
        const li = document.createElement("li");
        li.className = "phase";
        li.textContent = "Aún no hay narraciones en esta sesión.";
        list.appendChild(li);
        return;
      }
      for (const item of items) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "h-item";
        const meta = document.createElement("div");
        meta.className = "h-meta";
        const l = document.createElement("span");
        l.textContent = (MODE_LABELS[item.mode] || item.mode) + " / " + item.voiceName;
        const r = document.createElement("span");
        r.textContent = item.durationEstimateSec + "s";
        meta.append(l, r);
        const prev = document.createElement("div");
        prev.className = "h-preview";
        prev.textContent = item.script;
        btn.append(meta, prev);
        btn.addEventListener("click", () => vscode.postMessage({ type: "loadHistoryItem", id: item.id }));
        li.appendChild(btn);
        list.appendChild(li);
      }
    }

    $("btn-settings").addEventListener("click", () => $("setup-card").classList.toggle("hidden"));
    $("btn-open-aistudio").addEventListener("click", () => vscode.postMessage({ type: "openExternal" }));

    $("btn-save-key").addEventListener("click", () => {
      const apiKey = $("api-key-input").value.trim();
      if (!apiKey) {
        $("setup-feedback").textContent = "Pega tu clave primero.";
        $("setup-feedback").className = "feedback err";
        return;
      }
      $("btn-save-key").disabled = true;
      $("setup-feedback").textContent = "Verificando con Gemini 3.8…";
      $("setup-feedback").className = "feedback";
      vscode.postMessage({ type: "verifyAndSaveKey", apiKey });
    });

    for (const s of segs) {
      s.addEventListener("click", () => vscode.postMessage({ type: "updateConfig", mode: s.dataset.mode }));
    }
    $("toggle-autoplay").addEventListener("change", () =>
      vscode.postMessage({ type: "updateConfig", autoPlay: $("toggle-autoplay").checked })
    );
    $("select-voice").addEventListener("change", () =>
      vscode.postMessage({ type: "updateConfig", voiceName: $("select-voice").value })
    );
    $("btn-speed").addEventListener("click", () => {
      state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
      vscode.postMessage({ type: "updateConfig", playbackRate: SPEEDS[state.speedIdx] });
    });

    $("btn-play").addEventListener("click", () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
    $("btn-stop").addEventListener("click", () => {
      audio.pause();
      audio.currentTime = 0;
      vscode.postMessage({ type: "stop" });
    });
    audio.addEventListener("play", () => ($("btn-play").textContent = "⏸"));
    audio.addEventListener("pause", () => ($("btn-play").textContent = "▶"));
    audio.addEventListener("timeupdate", () => {
      const dur = audio.duration || 0;
      $("t-cur").textContent = fmt(audio.currentTime);
      $("t-tot").textContent = fmt(dur);
      if (dur > 0) $("seek-bar").value = String((audio.currentTime / dur) * 100);
    });
    $("seek-bar").addEventListener("input", () => {
      const dur = audio.duration || 0;
      if (dur > 0) audio.currentTime = (Number($("seek-bar").value) / 100) * dur;
    });

    for (const b of renBtns) {
      b.addEventListener("click", () => {
        if (state.currentId) vscode.postMessage({ type: "renarrate", id: state.currentId, mode: b.dataset.renarrate });
      });
    }

    $("btn-manual").addEventListener("click", () => {
      const text = $("manual-text").value.trim();
      if (text) vscode.postMessage({ type: "narrateManual", text });
    });

    window.addEventListener("message", (evt) => {
      const msg = evt.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "snapshot") {
        renderConfig(msg.config);
        renderHistory(msg.history || []);
        setPhase(msg.phase || "idle", msg.message || (msg.config.hasApiKey ? "Listo" : "Configura tu API key"));
        if (msg.history && msg.history.length > 0 && msg.firstAudioBase64) {
          loadEntry(msg.history[0], msg.firstAudioBase64, false);
        }
      } else if (msg.type === "keyResult") {
        $("btn-save-key").disabled = false;
        if (msg.ok) {
          $("api-key-input").value = "";
          $("setup-feedback").textContent = "Clave verificada y guardada.";
          $("setup-feedback").className = "feedback ok";
          renderConfig(msg.config);
          setPhase("ready", "Conectado");
        } else {
          $("setup-feedback").textContent = msg.error || "Clave inválida.";
          $("setup-feedback").className = "feedback err";
        }
      } else if (msg.type === "config" && msg.config) {
        renderConfig(msg.config);
      } else if (msg.type === "status") {
        setPhase(msg.phase || "idle", msg.message || "");
      } else if (msg.type === "narration" && msg.entry) {
        setPhase("ready", "Listo");
        const next = [msg.entry, ...state.history.filter((h) => h.id !== msg.entry.id)].slice(0, 10);
        renderHistory(next);
        loadEntry(msg.entry, msg.audioBase64, Boolean(msg.autoPlay));
      } else if (msg.type === "error") {
        setPhase("error", msg.message || "Error");
      }
    });

    vscode.postMessage({ type: "init" });
  </script>
</body>
</html>`;
  }
}
