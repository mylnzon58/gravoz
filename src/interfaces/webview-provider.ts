/**
 * Native Antigravity IDE / VS Code WebviewViewProvider styled with native --vscode-* theme tokens.
 * Proveedor nativo de panel lateral en Antigravity IDE / VS Code usando tokens --vscode-*.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { NarrationService } from "../application/narration-service.js";
import {
  isGeminiVoice,
  isNarrationLanguage,
  isNarrationMode,
  type GravozConfig,
  type UiEvent,
} from "../domain/types.js";

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
      const backupRaw = Array.isArray(msg["backupApiKeys"]) ? msg["backupApiKeys"] : [];
      const backupApiKeys = backupRaw
        .filter((k): k is string => typeof k === "string")
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
        .slice(0, 3);

      const keyToVerify = apiKey || backupApiKeys[0] || "";
      const check = await this.service.verifyApiKey(keyToVerify);
      if (!check.valid) {
        void this.view?.webview.postMessage({
          type: "keyResult",
          ok: false,
          error: check.error || "API key rechazada por Google AI Studio.",
        });
        return;
      }
      const config = this.service.updateConfig({
        ...(apiKey ? { apiKey } : {}),
        backupApiKeys,
      });
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
        ...(isNarrationLanguage(msg["language"]) ? { language: msg["language"] } : {}),
        ...(isNarrationMode(msg["mode"]) ? { mode: msg["mode"] } : {}),
        ...(typeof msg["autoPlay"] === "boolean" ? { autoPlay: msg["autoPlay"] } : {}),
        ...(typeof msg["goldfishReview"] === "boolean"
          ? { goldfishReview: msg["goldfishReview"] }
          : {}),
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

    if (type === "narrateLastTurn") {
      const wsPaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const res = this.service.narrateLastTurn(wsPaths);
      if (!res.accepted) {
        this.postEvent({
          type: "error",
          phase: "error",
          message:
            res.reason === "no_api_key"
              ? "Configura tu API key primero."
              : "Aún no se capturó una respuesta de Antigravity en esta sesión.",
        });
      }
      return;
    }

    if (type === "playbackState") {
      this.service.setWebviewPlaying(Boolean(msg["playing"]));
      this.onConfigChanged();
      return;
    }

    if (type === "minimize") {
      void vscode.commands.executeCommand("workbench.action.closeSidebar");
      return;
    }

    if (type === "stop") {
      this.service.stopPlayback();
      return;
    }

    if (type === "openExternal") {
      const target = msg["target"] === "sponsor"
        ? "https://github.com/sponsors/mylnzon58"
        : msg["target"] === "repo"
          ? "https://github.com/mylnzon58/gravoz"
          : "https://aistudio.google.com/apikey";
      void vscode.env.openExternal(vscode.Uri.parse(target));
      return;
    }

    if (type === "copyScript") {
      const text = typeof msg["text"] === "string" ? msg["text"].trim() : "";
      if (text) {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.setStatusBarMessage("Gravoz: guion copiado al portapapeles", 3_000);
      }
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
    .stack { display: flex; flex-direction: column; gap: 10px; min-width: 210px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .row-nowrap { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
      border-radius: 6px;
      padding: 10px;
      overflow: hidden;
      min-width: 0;
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
    select { flex: 1; min-width: 0; max-width: 100%; text-overflow: ellipsis; }
    .voice-row { display: flex; align-items: center; gap: 6px; flex: 1 1 130px; min-width: 0; font-size: 12px; }
    .pills-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .project-title {
      font-size: 12px;
      flex: 1 1 70px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
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
    .chip { font-size: 11px; padding: 3px 8px; border-radius: 999px; white-space: nowrap; flex-shrink: 0; }
    details summary { cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .script-body { margin: 6px 0 0; font-size: 12px; white-space: pre-wrap; }
    ul.history { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
    .h-item { width: 100%; text-align: left; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
    .h-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .h-preview { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .notice { font-size: 11px; color: var(--vscode-editorWarning-foreground, #fbbf24); margin: 4px 0 0; }
    .q-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; font-size: 11.5px; }
    .q-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .q-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .q-badge { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
    .q-ok { color: var(--vscode-testing-iconPassed, #34d399); }
    .q-warn { color: var(--vscode-editorWarning-foreground, #fbbf24); }
    .q-err { color: var(--vscode-errorForeground, #f87171); }
  </style>
</head>
<body>
  <div class="stack">
    <div class="row">
      <div class="row" style="gap:6px">
        <span id="dot" class="dot"></span>
        <span id="phase" class="phase">Iniciando…</span>
      </div>
      <div class="row" style="gap:4px">
        <button id="btn-settings" type="button" title="API Key de Google AI Studio">API Key</button>
        <button id="btn-minimize" type="button" title="Minimizar panel (sigue funcionando en la barra inferior)">✕</button>
      </div>
    </div>

    <section id="setup-card" class="card hidden">
      <p class="muted">Conecta tu clave gratuita de Google AI Studio (Gemini 3.8 Flash + TTS). Se guarda solo en local (0600).</p>
      <ol class="steps">
        <li>Abre <button id="btn-open-aistudio" class="link-btn" type="button">aistudio.google.com/apikey</button></li>
        <li>Pulsa <strong>Create API key</strong> y cópiala.</li>
        <li>Pégala aquí abajo y verifica.</li>
      </ol>
      <div class="stack" style="gap:6px">
        <input id="api-key-input" type="password" placeholder="Clave principal (AIzaSy...)" autocomplete="off" />
        <details>
          <summary id="backup-summary">Claves de respaldo opcionales (hasta 3)</summary>
          <div class="stack" style="gap:5px; margin-top:6px">
            <input id="backup-key-1" type="password" placeholder="Respaldo 1 (opcional)" autocomplete="off" />
            <input id="backup-key-2" type="password" placeholder="Respaldo 2 (opcional)" autocomplete="off" />
            <input id="backup-key-3" type="password" placeholder="Respaldo 3 (opcional)" autocomplete="off" />
          </div>
        </details>
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
      <div class="segments" style="grid-template-columns: repeat(2, 1fr); margin-bottom: 6px" role="radiogroup" aria-label="Disparo de reproducción">
        <button id="btn-auto-on" class="seg active" type="button">Automático</button>
        <button id="btn-auto-off" class="seg" type="button">Manual</button>
      </div>
      <p id="auto-hint" class="muted" style="margin-bottom:8px">Narra solo cuando Antigravity termina una respuesta o plan.</p>
      <div class="row" style="gap:6px">
        <label class="voice-row">
          <span>Voz</span>
          <select id="select-voice">
            <optgroup label="Mujer">
              <option value="Kore">Kore · Firme</option>
              <option value="Aoede">Aoede · Natural</option>
              <option value="Zephyr">Zephyr · Clara</option>
              <option value="Leda">Leda · Joven</option>
            </optgroup>
            <optgroup label="Hombre">
              <option value="Charon">Charon · Profesional</option>
              <option value="Orus">Orus · Serena</option>
              <option value="Puck">Puck · Ágil</option>
              <option value="Fenrir">Fenrir · Enérgica</option>
            </optgroup>
          </select>
        </label>
        <div class="pills-row">
          <button id="btn-lang" class="chip" type="button" title="Idioma de narración (Español por defecto / Inglés opcional)">ES</button>
          <button id="btn-goldfish" class="chip" type="button" title="Sugerencia de punto ciego (desactivado por defecto)">Sugerencias: OFF</button>
          <button id="btn-speed" class="chip" type="button">1.0x</button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="row-nowrap">
        <strong id="now-project" class="project-title">Sin narración aún</strong>
        <button id="btn-last-turn" class="chip" type="button" title="Narrar última respuesta del chat de Antigravity">▶ Última</button>
        <span id="now-mode" class="phase" style="white-space:nowrap;flex-shrink:0">—</span>
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
      <div class="row-nowrap">
        <details style="flex:1;min-width:0">
          <summary>Ver guion narrado</summary>
          <p id="script-text" class="script-body">Cuando Antigravity termine una respuesta o plan, el guion aparecerá aquí.</p>
        </details>
        <button id="btn-copy-script" class="chip" type="button" title="Copiar guion narrado al portapapeles" style="align-self:flex-start">📋 Copiar</button>
      </div>
      <audio id="audio-el" preload="auto"></audio>
    </section>

    <details class="card">
      <summary id="quota-summary">Estado de APIs y modelos</summary>
      <p id="switch-notice" class="notice hidden"></p>
      <div id="quota-keys" class="q-list"></div>
      <div id="quota-models" class="q-list" style="border-top:1px solid var(--vscode-panel-border);padding-top:6px"></div>
    </details>

    <details class="card">
      <summary>Probar texto manualmente</summary>
      <textarea id="manual-text" rows="4" style="margin:6px 0">Hola, soy Gravoz, tu asistente de voz open source para Google Antigravity. Escucho cada respuesta y plan de tu proyecto y te lo explico en tres niveles: Al grano, Normal o Técnico, con voces naturales de Gemini, memoria de contexto y control directo desde la barra inferior.</textarea>
      <div class="row" style="gap:6px">
        <button id="btn-manual" class="btn-primary" type="button">Narrar</button>
        <button id="btn-clear-manual" type="button">Limpiar</button>
      </div>
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

    <div class="row" style="justify-content:center;gap:12px;padding:2px 0">
      <button id="btn-sponsor" class="link-btn" type="button" title="Patrocinar a @mylnzon58 en GitHub Sponsors" style="text-decoration:none">♥ GitHub Sponsors</button>
      <span class="phase">·</span>
      <button id="btn-repo" class="link-btn" type="button" title="Dejar estrella en GitHub" style="text-decoration:none">★ GitHub</button>
    </div>
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
    const DEMO_TEXT = {
      es: "Hola, soy Gravoz, tu asistente de voz open source para Google Antigravity. Escucho cada respuesta y plan de tu proyecto y te lo explico en tres niveles: Al grano, Normal o Técnico, con voces naturales de Gemini, memoria de contexto y control directo desde la barra inferior.",
      en: "Hi, I am Gravoz, your open-source voice assistant for Google Antigravity. I follow your project context and explain every plan or response in three depth modes: Brief, Normal, or Technical, using natural Gemini voices right from your IDE status bar."
    };
    let manualEdited = false;
    $("manual-text").addEventListener("input", () => { manualEdited = true; });

    function fmt(sec) {
      if (!Number.isFinite(sec) || sec < 0) return "0:00";
      return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
    }

    function setPhase(phase, message) {
      $("phase").textContent = message || phase;
      const dot = $("dot");
      dot.className = "dot";
      const busy = phase === "summarizing" || phase === "synthesizing" || phase === "collecting";
      if (phase === "ready") dot.classList.add("dot-ready");
      else if (phase === "error") dot.classList.add("dot-error");
      else if (busy) dot.classList.add("dot-busy");
      $("btn-manual").disabled = busy;
      $("btn-manual").textContent = busy ? "Generando…" : "Narrar";
      for (const b of renBtns) b.disabled = busy;
    }

    function renderConfig(cfg) {
      state.config = cfg;
      $("setup-card").classList.toggle("hidden", cfg.hasApiKey);
      $("backup-summary").textContent = cfg.backupKeyCount > 0
        ? "Claves de respaldo (" + cfg.backupKeyCount + " activas)"
        : "Claves de respaldo opcionales (hasta 3)";
      const isAuto = Boolean(cfg.autoPlay);
      $("btn-auto-on").classList.toggle("active", isAuto);
      $("btn-auto-off").classList.toggle("active", !isAuto);
      $("auto-hint").textContent = isAuto
        ? "Narra automáticamente al terminar cada respuesta o plan."
        : "Modo manual: pulsa Última respuesta cuando quieras escuchar.";
      $("select-voice").value = cfg.voiceName || "Kore";
      const lang = cfg.language === "en" ? "en" : "es";
      $("btn-lang").textContent = lang.toUpperCase();
      if (!manualEdited) $("manual-text").value = DEMO_TEXT[lang];
      const gf = Boolean(cfg.goldfishReview);
      $("btn-goldfish").textContent = gf ? "Sugerencias: ON" : "Sugerencias: OFF";
      $("btn-goldfish").classList.toggle("btn-primary", gf);
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

    function renderQuota(q) {
      if (!q) return;
      const notice = $("switch-notice");
      if (q.lastSwitchNotice) {
        notice.textContent = q.lastSwitchNotice;
        notice.classList.remove("hidden");
      } else {
        notice.classList.add("hidden");
      }
      const badgeText = (s, sec) => {
        if (s === "ok") return "● Activo";
        if (s === "cooldown_429") return "◐ Cuota 429 (" + Math.max(1, Math.ceil(sec / 60)) + "m)";
        if (s === "cooldown_503") return "◐ Saturado (" + sec + "s)";
        return "✕ Inválida";
      };
      const badgeCls = (s) => (s === "ok" ? "q-ok" : s === "invalid" ? "q-err" : "q-warn");

      const keysBox = $("quota-keys");
      keysBox.textContent = "";
      for (const k of q.keys || []) {
        const row = document.createElement("div");
        row.className = "q-row";
        const name = document.createElement("span");
        name.className = "q-name";
        name.textContent = k.label + " (" + k.maskedKey + ")";
        const b = document.createElement("span");
        b.className = "q-badge " + badgeCls(k.state);
        b.textContent = k.callsToday + " hoy · " + badgeText(k.state, k.cooldownSec);
        row.append(name, b);
        keysBox.appendChild(row);
      }

      const modBox = $("quota-models");
      modBox.textContent = "";
      for (const m of q.models || []) {
        const row = document.createElement("div");
        row.className = "q-row";
        const name = document.createElement("span");
        name.className = "q-name";
        name.textContent = (m.kind === "tts" ? "Voz: " : "Texto: ") + m.model;
        const b = document.createElement("span");
        b.className = "q-badge " + badgeCls(m.state);
        b.textContent = m.callsToday + " · " + badgeText(m.state, m.cooldownSec);
        row.append(name, b);
        modBox.appendChild(row);
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
    $("btn-minimize").addEventListener("click", () => vscode.postMessage({ type: "minimize" }));
    $("btn-open-aistudio").addEventListener("click", () => vscode.postMessage({ type: "openExternal", target: "aistudio" }));
    $("btn-sponsor").addEventListener("click", () => vscode.postMessage({ type: "openExternal", target: "sponsor" }));
    $("btn-repo").addEventListener("click", () => vscode.postMessage({ type: "openExternal", target: "repo" }));

    $("btn-save-key").addEventListener("click", () => {
      const apiKey = $("api-key-input").value.trim();
      const backupApiKeys = [
        $("backup-key-1").value.trim(),
        $("backup-key-2").value.trim(),
        $("backup-key-3").value.trim(),
      ].filter(Boolean);
      if (!apiKey && backupApiKeys.length === 0) {
        $("setup-feedback").textContent = "Pega al menos una clave primero.";
        $("setup-feedback").className = "feedback err";
        return;
      }
      $("btn-save-key").disabled = true;
      $("setup-feedback").textContent = "Verificando clave…";
      $("setup-feedback").className = "feedback";
      vscode.postMessage({ type: "verifyAndSaveKey", apiKey, backupApiKeys });
    });

    for (const s of segs) {
      s.addEventListener("click", () => vscode.postMessage({ type: "updateConfig", mode: s.dataset.mode }));
    }
    $("btn-auto-on").addEventListener("click", () =>
      vscode.postMessage({ type: "updateConfig", autoPlay: true })
    );
    $("btn-auto-off").addEventListener("click", () =>
      vscode.postMessage({ type: "updateConfig", autoPlay: false })
    );
    $("btn-last-turn").addEventListener("click", () =>
      vscode.postMessage({ type: "narrateLastTurn" })
    );
    $("select-voice").addEventListener("change", () =>
      vscode.postMessage({ type: "updateConfig", voiceName: $("select-voice").value })
    );
    $("btn-lang").addEventListener("click", () => {
      const nextLang = state.config && state.config.language === "en" ? "es" : "en";
      vscode.postMessage({ type: "updateConfig", language: nextLang });
    });
    $("btn-goldfish").addEventListener("click", () => {
      const current = state.config ? Boolean(state.config.goldfishReview) : false;
      vscode.postMessage({ type: "updateConfig", goldfishReview: !current });
    });
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
    audio.addEventListener("play", () => {
      $("btn-play").textContent = "⏸";
      vscode.postMessage({ type: "playbackState", playing: true });
    });
    audio.addEventListener("pause", () => {
      $("btn-play").textContent = "▶";
      vscode.postMessage({ type: "playbackState", playing: false });
    });
    audio.addEventListener("ended", () => {
      $("btn-play").textContent = "▶";
      vscode.postMessage({ type: "playbackState", playing: false });
    });
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
    $("btn-copy-script").addEventListener("click", () => {
      const text = ($("script-text").textContent || "").trim();
      if (!text) return;
      vscode.postMessage({ type: "copyScript", text });
      const btn = $("btn-copy-script");
      btn.textContent = "✓ Copiado";
      setTimeout(() => { btn.textContent = "📋 Copiar"; }, 1800);
    });
    $("btn-clear-manual").addEventListener("click", () => {
      manualEdited = true;
      $("manual-text").value = "";
      $("manual-text").focus();
    });

    window.addEventListener("message", (evt) => {
      const msg = evt.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "snapshot") {
        renderConfig(msg.config);
        renderHistory(msg.history || []);
        if (msg.quota) renderQuota(msg.quota);
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
        if (msg.quota) renderQuota(msg.quota);
        const next = [msg.entry, ...state.history.filter((h) => h.id !== msg.entry.id)].slice(0, 10);
        renderHistory(next);
        loadEntry(msg.entry, msg.audioBase64, Boolean(msg.autoPlay));
      } else if (msg.type === "quota" && msg.quota) {
        renderQuota(msg.quota);
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

