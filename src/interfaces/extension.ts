/**
 * Native Antigravity IDE / VS Code extension entrypoint.
 * Punto de entrada nativo de la extensión para Antigravity IDE / VS Code.
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
import { TranscriptParser } from "../infrastructure/transcript-parser.js";
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

export function activate(context: vscode.ExtensionContext): void {
  syncAntigravityStopHook(context.extensionPath);

  const configStore = new ConfigStore();
  const gemini = new GeminiClient();
  const osPlayer = new OsAudioPlayer();
  activePlayer = osPlayer;

  let viewProvider: GravozViewProvider | null = null;

  const service = new NarrationService({
    configStore,
    contextCollector: new ContextCollector(),
    transcriptParser: new TranscriptParser(),
    summarizer: gemini,
    tts: gemini,
    osPlayer,
    hasActiveWebview: () => Boolean(viewProvider?.isVisible()),
    emit: (event) => viewProvider?.postEvent(event),
  });

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "gravoz.selectMode";

  const refreshStatusBar = (): void => {
    const cfg = service.getPublicConfig();
    const icon = cfg.autoPlay ? "$(unmute)" : "$(mute)";
    statusBar.text = `${icon} Gravoz: ${MODE_LABELS[cfg.mode]}`;
    statusBar.tooltip = cfg.hasApiKey
      ? `Gravoz (${MODE_LABELS[cfg.mode]}) — Auto: ${cfg.autoPlay ? "ON" : "OFF"}. Clic para cambiar nivel.`
      : "Gravoz: falta configurar tu API key de Google AI Studio.";
    statusBar.show();
  };

  viewProvider = new GravozViewProvider(service, refreshStatusBar);
  refreshStatusBar();

  const watcher = new StopEventWatcher(configStore.getStateDir());
  watcher.start((payload) => {
    service.handleStopHook(payload);
  });
  activeWatcher = watcher;

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider(GravozViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("gravoz.configureApiKey", async () => {
      const apiKey = await vscode.window.showInputBox({
        title: "Gravoz — API Key de Google AI Studio",
        prompt: "Pega tu clave gratuita de https://aistudio.google.com/apikey (se guarda en local con permisos 0600)",
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
      refreshStatusBar();
      void vscode.window.showInformationMessage("Gravoz: API key verificada y guardada.");
    }),

    vscode.commands.registerCommand("gravoz.selectMode", async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: "Al grano", description: "Resumen ejecutivo (15–30s)", mode: "al-grano" as const },
          { label: "Normal", description: "Explicación clara y natural (45–80s)", mode: "normal" as const },
          { label: "Técnico", description: "Arquitectura, flujo y seguridad (90–150s)", mode: "tecnico" as const },
        ],
        { placeHolder: "Elige el nivel de narración de Gravoz" },
      );
      if (!picked) return;
      service.updateConfig({ mode: picked.mode });
      refreshStatusBar();
    }),

    vscode.commands.registerCommand("gravoz.toggleAutoPlay", () => {
      const current = service.getPublicConfig();
      service.updateConfig({ autoPlay: !current.autoPlay });
      refreshStatusBar();
    }),

    vscode.commands.registerCommand("gravoz.narrateSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor ? editor.document.getText(editor.selection).trim() : "";
      if (!selected) {
        void vscode.window.showWarningMessage("Gravoz: selecciona primero un texto o plan en el editor.");
        return;
      }
      try {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        await service.narrateText({
          text: selected,
          ...(wsFolder ? { projectName: wsFolder.name } : {}),
          autoPlay: true,
        });
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : "Error al narrar.");
      }
    }),

    vscode.commands.registerCommand("gravoz.stopPlayback", () => {
      service.stopPlayback();
    }),
  );
}

export function deactivate(): void {
  activeWatcher?.stop();
  activeWatcher = null;
  activePlayer?.stop();
  activePlayer = null;
}
