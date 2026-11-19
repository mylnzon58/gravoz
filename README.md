# Gravoz

**Extensión nativa de voz inteligente en español para Google Antigravity IDE.**

Gravoz vive directamente dentro de la barra lateral y la barra de estado de **Antigravity IDE** (sin servidores web externos ni puertos abiertos). Cuando Antigravity termina un plan o una respuesta, Gravoz lee el contexto real de tu proyecto y el hilo de la conversación, y lo narra en español natural usando **Gemini 3.8 Flash** + **Gemini 3.8 Flash TTS**.

No es un lector de pantalla robótico: interpreta lo que se construyó o decidió y te lo explica en **3 niveles de profundidad**:

- **Al grano** *(15–30s)*: qué cambió, qué se decidió y cuál es el siguiente paso.
- **Normal** *(45–80s)*: explicación clara y conversacional conectada al objetivo del proyecto.
- **Técnico** *(90–150s)*: arquitectura, flujo de datos, decisiones de diseño y seguridad.

---

## Instalación rápida (extensión nativa `.vsix`)

Requiere **Node.js 20+** y una API key gratuita de [Google AI Studio](https://aistudio.google.com/apikey).

### Linux / macOS

```bash
git clone https://github.com/mylnzon58/gravoz.git
cd gravoz
./scripts/install.sh
```

### Windows (PowerShell)

```powershell
git clone https://github.com/mylnzon58/gravoz.git
cd gravoz
.\scripts\install.ps1
```

Recarga la ventana de Antigravity IDE (`Ctrl+Shift+P` → `Developer: Reload Window`). Verás el **icono de Gravoz** en la barra lateral izquierda y el botón **Gravoz: Normal** en la barra de estado inferior. Al abrirlo, pega tu clave gratuita de Google AI Studio en la tarjeta guiada de 3 pasos.

---

## Arquitectura (0 puertos TCP, 0 dependencias en producción)

```text
Antigravity (Hook Stop < 10ms)
        │
        ▼  Escritura atómica en ~/.gravoz/stop-event.json (0600, sin HTTP)
Extensión Nativa de Antigravity IDE (dist/extension.js)
  ├── ContextCollector   → README, manifiestos, árbol raíz y artefactos recientes
  ├── TranscriptParser   → Lectura incremental por cola de transcript.jsonl
  ├── GeminiClient       → Guion oral (gemini-3.8-flash) + Voz (gemini-3.8-flash-tts)
  ├── WavEncoder         → Cabecera RIFF/WAVE en TypeScript puro (sin ffmpeg)
  ├── Panel Lateral IDE  → Webview nativo con tokens --vscode-* e historial
  └── OsAudioPlayer      → Respaldo opcional si el panel está cerrado (paplay/aplay, afplay, PowerShell)
```

### Decisiones de ingeniería y seguridad OWASP

- **Cero dependencias de runtime** (`dependencies: {}`) y **cero puertos TCP abiertos** (sin superficie de DNS-rebinding ni CSRF local).
- **TypeScript estricto**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **Seguridad OWASP**: API key enviada solo por cabecera HTTPS (`x-goog-api-key`), guardada en local con permisos `0600` (o `%LOCALAPPDATA%\gravoz` en Windows), validación anti path-traversal con `realpathSync`, delimitadores anti prompt-injection y ejecución sin shell (`execFile`).
- **Cancelación determinista**: si llega una nueva respuesta mientras Gemini sintetiza, `AbortController` cancela el turno anterior y evita audio superpuesto.

---

## Desarrollo y pruebas

```bash
npm install
npm run typecheck
npm test
npm run package
```

## Licencia y créditos

Open source bajo licencia [MIT](./LICENSE).  
Creado por [@mylnzon58](https://github.com/mylnzon58).
