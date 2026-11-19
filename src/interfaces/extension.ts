/**
 * Native Antigravity IDE / VS Code extension entrypoint with minimalist bottom Status Bar controls.
 * Punto de entrada nativo de la extensión para Antigravity IDE con controles minimalistas en la barra inferior.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { NarrationService } from "../application/narration-service.js";
import type { NarrationMode } from "../domain/types.js";
import { ConfigStore } from "../infrastructure/config-store.js";
import { ContextCollector } from "../infrastructure/context-collector.js";
import { GeminiClient } from "../infrastructure/gemini-client.js";
import { OsAudioPlayer } from "../infrastructure/os-audio-player.js";
import { StopEventWatcher } from "../infrastructure/stop-event-bus.js";
import {
  findLatestAntigravityTranscript,
  TranscriptParser,
} from "../infrastructure/transcript-parser.js";
import { GravozViewProvider } from "./webview-provider.js";

const MODE_LABELS: Readonly<Record<NarrationMode, string>> = {
  "al-grano": "Al grano",
  normal: "Normal",
  tecnico: "Técnico",
};

/**
 * Installs/syncs the lightweight Antigravity Stop hook into ~/.gemini/config/plugins/gravoz
 * pointing directly to this extension's bundled `dist/stop-hook.js`.
 * Instala/sincroniza el hook Stop de Antigravity apuntando al `dist/stop-hook.js` empaquetado.
 */
function syncAntigravityStopHook(extensionPath: string): void {
  try {
    const pluginDir = join(homedir(), ".gemini", "config", "plugins", "gravoz");
    mkdirSync(pluginDir, { recursive: true });

    const hookScript = join(extensionPath, "dist", "stop-hook.js");
    const quotedPath = `"${hookScript.replace(/"/g, '\\"')}"`;

    writeFileSync(
      join(pluginDir, "plugin.json"),
      `${JSON.stringify(
        {
          name: "gravoz",
          displayName: "Gravoz",
          version: "1.0.0",
          description:
            "Hook automático de Gravoz para narrar en español las respuestas y planes de Google Antigravity IDE.",
          author: { name: "mylnzon58", url: "https://github.com/mylnzon58" },
          repository: "https://github.com/mylnzon58/gravoz",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    writeFileSync(
      join(pluginDir, "hooks.json"),
      `${JSON.stringify(
        {
          "gravoz-auto-narrate": {
            Stop: [
              {
                type: "command",
                command: `node ${quotedPath}`,
                timeout: 5,
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // Non-fatal: manual narration commands still work even if ~/.gemini is read-only.
  }
}

let activeWatcher: StopEventWatcher | null = null;
let activePlayer: OsAudioPlayer | null = null;
let transcriptPoller: ReturnType<typeof setInterval> | null = null;

export function activate(context: vscode.ExtensionContext): void {
  syncAntigravityStopHook(context.extensionPath);

  const configStore = new ConfigStore();
  const gemini = new GeminiClient();
  const osPlayer = new OsAudioPlayer();
  activePlayer = osPlayer;

  let viewProvider: GravozViewProvider | null = null;

  // Three minimalist, high-priority bottom Status Bar buttons (always visible):
  // 1) Mode selector  2) Auto/Manual 1-click toggle  3) Quick Action (Stop / Play Last / Open Panel)
  const modeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1002);
  modeBar.command = "gravoz.selectMode";

  const autoBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1001);
  autoBar.command = "gravoz.toggleAutoPlay";

  const actionBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);

  let service!: NarrationService;

  const refreshStatusBars = (): void => {
    const cfg = service.getPublicConfig();
    const busy = service.isBusy();
    const playing = service.isPlaying();

    if (!cfg.hasApiKey) {
      modeBar.text = "$(key) Gravoz: Configurar API";
      modeBar.command = "gravoz.openPanel";
      modeBar.tooltip = "Clic para abrir Gravoz y pegar tu API key gratuita de Google AI Studio.";
      modeBar.show();
      autoBar.hide();
      actionBar.hide();
      return;
    }

    modeBar.command = "gravoz.selectMode";
    modeBar.text = busy
      ? `$(loading~spin) Gravoz: ${MODE_LABELS[cfg.mode]}`
      : playing
        ? `$(unmute) Hablando (${MODE_LABELS[cfg.mode]})`
        : `$(unmute) Gravoz: ${MODE_LABELS[cfg.mode]}`;
    modeBar.tooltip = "Clic para cambiar el nivel (Al grano, Normal, Técnico) o abrir ajustes.";
    modeBar.show();

    autoBar.text = cfg.autoPlay ? "$(sync) Auto" : "$(circle-slash) Manual";
    autoBar.tooltip = cfg.autoPlay
      ? "Modo Automático ACTIVO: narra solo cuando Antigravity termina (incluso con el panel cerrado). Clic para pasar a Manual."
      : "Modo Manual: solo narra cuando tú lo pides. Clic para activar Automático.";
    autoBar.show();

    if (busy || playing) {
      actionBar.text = "$(debug-stop) Detener";
      actionBar.command = "gravoz.stopPlayback";
      actionBar.tooltip = "Detener la narración actual de Gravoz (Ctrl+Alt+S).";
    } else {
      actionBar.text = "$(play) Escuchar";
      actionBar.command = "gravoz.narrateLastTurn";
      actionBar.tooltip = "Reproducir la última respuesta del chat de Antigravity (Ctrl+Alt+G).";
    }
    actionBar.show();
  };

  let lastAnnouncedSwitch = "";

  service = new NarrationService({
    configStore,
    contextCollector: new ContextCollector(),
    transcriptParser: new TranscriptParser(),
    summarizer: gemini,
    tts: gemini,
    osPlayer,
    hasActiveWebview: () => Boolean(viewProvider?.isVisible()),
    emit: (event) => {
      viewProvider?.postEvent(event);
      refreshStatusBars();
      const sw = event.quota?.lastSwitchNotice ?? "";
      if (sw && sw !== lastAnnouncedSwitch) {
        lastAnnouncedSwitch = sw;
        void vscode.window.setStatusBarMessage(`Gravoz: ${sw} (por límite de cuota)`, 8_000);
      }
      if (event.type === "status" && event.message?.includes("Cuota Gemini agotada")) {
        void vscode.window.showInformationMessage(`Gravoz: ${event.message}`);
      }
      if (event.type === "error" && event.message && !viewProvider?.isVisible()) {
        void vscode.window.showWarningMessage(`Gravoz: ${event.message}`, "Abrir Gravoz").then((sel) => {
          if (sel === "Abrir Gravoz") {
            void vscode.commands.executeCommand("gravoz.playerView.focus");
          }
        });
      }
    },
  });

  viewProvider = new GravozViewProvider(service, refreshStatusBars);
  refreshStatusBars();

  const getOpenWorkspacePaths = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  const ownsStopPayload = (payloadWorkspacePaths?: readonly string[]): boolean => {
    const open = getOpenWorkspacePaths();
    if (!payloadWorkspacePaths || payloadWorkspacePaths.length === 0 || open.length === 0) {
      return false;
    }
    return payloadWorkspacePaths.some((p) => open.includes(p));
  };

  const watcher = new StopEventWatcher(configStore.getStateDir());
  watcher.start((payload) => {
    // Multi-window guard: only the window owning this workspace handles its Stop event.
    if (!ownsStopPayload(payload.workspacePaths)) return;
    service.handleStopHook(payload);
    refreshStatusBars();
  });
  activeWatcher = watcher;

  // Live Antigravity chat transcript poller strictly scoped to THIS window's workspace.
  const initialLatest = findLatestAntigravityTranscript(getOpenWorkspacePaths());
  let lastSeenMtime = initialLatest ? initialLatest.mtimeMs : 0;
  let lastSeenPath = initialLatest ? initialLatest.transcriptPath : "";
  let pendingTriggerAt = 0;

  transcriptPoller = setInterval(() => {
    refreshStatusBars();
    const wsPaths = getOpenWorkspacePaths();
    if (wsPaths.length === 0) return;
    const latest = findLatestAntigravityTranscript(wsPaths);
    if (!latest) return;

    if (latest.transcriptPath !== lastSeenPath || latest.mtimeMs > lastSeenMtime) {
      lastSeenPath = latest.transcriptPath;
      lastSeenMtime = latest.mtimeMs;
      // Fast 1.2s settle window (isTurnComplete verifies the turn has no pending tool_calls).
      pendingTriggerAt = Date.now() + 1_200;
      return;
    }

    if (pendingTriggerAt > 0 && Date.now() >= pendingTriggerAt) {
      pendingTriggerAt = 0;
      service.handleLiveTranscriptUpdate(
        latest.transcriptPath,
        latest.artifactDirectoryPath,
        wsPaths,
      );
      refreshStatusBars();
    }
  }, 600);

  context.subscriptions.push(
    modeBar,
    autoBar,
    actionBar,
    vscode.window.registerWebviewViewProvider(GravozViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("gravoz.openPanel", () => {
      if (viewProvider?.isVisible()) {
        void vscode.commands.executeCommand("workbench.action.closeSidebar");
      } else {
        void vscode.commands.executeCommand("gravoz.playerView.focus");
      }
    }),

    vscode.commands.registerCommand("gravoz.configureApiKey", async () => {
      const apiKey = await vscode.window.showInputBox({
        title: "Gravoz — API Key de Google AI Studio",
        prompt:
          "Pega tu clave gratuita de https://aistudio.google.com/apikey (se guarda en local con permisos 0600)",
        password: true,
        ignoreFocusOut: true,
      });
      if (!apiKey) return;
      const check = await service.verifyApiKey(apiKey);
      if (!check.valid) {
        void vscode.window.showErrorMessage(check.error ?? "API key inválida.");
        return;
      }
      service.updateConfig({ apiKey });
      refreshStatusBars();
      void vscode.window.showInformationMessage("Gravoz: API key verificada y guardada.");
    }),

    vscode.commands.registerCommand("gravoz.selectMode", async () => {
      type PickAction =
        | (vscode.QuickPickItem & { readonly action: "mode"; readonly mode: NarrationMode })
        | (vscode.QuickPickItem & { readonly action: "panel" })
        | (vscode.QuickPickItem & { readonly action: "apikey" });

      const picked = await vscode.window.showQuickPick<PickAction>(
        [
          { label: "$(zap) Al grano", description: "Resumen ejecutivo (15–30s)", action: "mode", mode: "al-grano" },
          { label: "$(comment-discussion) Normal", description: "Explicación clara y natural (45–80s)", action: "mode", mode: "normal" },
          { label: "$(tools) Técnico", description: "Arquitectura, flujo y seguridad (90–150s)", action: "mode", mode: "tecnico" },
          { label: "$(layout-sidebar-left) Abrir panel de Gravoz", description: "Reproductor, voz, velocidad e historial", action: "panel" },
          { label: "$(key) Configurar API Key", description: "Cambiar o verificar tu clave de Google AI Studio", action: "apikey" },
        ],
        { placeHolder: "Gravoz — Elige nivel de narración o abre ajustes" },
      );
      if (!picked) return;
      if (picked.action === "mode") {
        service.updateConfig({ mode: picked.mode });
        refreshStatusBars();
      } else if (picked.action === "panel") {
        void vscode.commands.executeCommand("gravoz.playerView.focus");
      } else {
        void vscode.commands.executeCommand("gravoz.configureApiKey");
      }
    }),

    vscode.commands.registerCommand("gravoz.toggleAutoPlay", () => {
      const current = service.getPublicConfig();
      const nextAuto = !current.autoPlay;
      service.updateConfig({ autoPlay: nextAuto });
      refreshStatusBars();
      void vscode.window.setStatusBarMessage(
        nextAuto
          ? "Gravoz: modo Automático activado (narrará al terminar cada respuesta)"
          : "Gravoz: modo Manual activado (pulsa Escuchar cuando quieras)",
        3_000,
      );
    }),

    vscode.commands.registerCommand("gravoz.narrateLastTurn", () => {
      const wsPaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const res = service.narrateLastTurn(wsPaths);
      if (!res.accepted) {
        const msg =
          res.reason === "no_api_key"
            ? "Gravoz: configura primero tu API key de Google AI Studio."
            : "Gravoz: no se encontró ninguna respuesta reciente en el chat de Antigravity.";
        void vscode.window.showInformationMessage(msg);
      }
    }),

    vscode.commands.registerCommand("gravoz.narrateSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor ? editor.document.getText(editor.selection).trim() : "";
      if (!selected) {
        void vscode.window.showWarningMessage("Gravoz: selecciona primero un texto o plan en el editor.");
        return;
      }
      try {
        const wsPaths = getOpenWorkspacePaths();
        const collected = new ContextCollector().collect({ workspacePaths: wsPaths });
        const fileName = editor?.document.fileName ? editor.document.fileName.split(/[\\/]/).pop() : "";
        const contextLabel = fileName
          ? `${collected.summary}\nArchivo seleccionado: ${fileName}`
          : collected.summary;
        await service.narrateText({
          text: selected,
          projectName: collected.projectName,
          contextSummary: contextLabel,
          autoPlay: true,
        });
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : "Error al narrar.");
      }
    }),

    vscode.commands.registerCommand("gravoz.stopPlayback", () => {
      service.stopPlayback();
      refreshStatusBars();
    }),
  );
}

export function deactivate(): void {
  if (transcriptPoller) {
    clearInterval(transcriptPoller);
    transcriptPoller = null;
  }
  activeWatcher?.stop();
  activeWatcher = null;
  activePlayer?.stop();
  activePlayer = null;
}
