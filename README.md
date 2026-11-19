# Gravoz

**Reproductor de voz inteligente y minimalista para Google Antigravity.**

Gravoz escucha cuándo Antigravity termina un plan o una respuesta, lee el contexto real de tu proyecto y el hilo de la conversación, y lo narra en español natural usando la voz nativa de **Google Gemini** (`gemini-2.5-flash-preview-tts`).

No es un lector de pantalla robótico: interpreta lo que se construyó o decidió y te lo explica en **3 niveles de profundidad**:

- **Al grano** *(15–30s)*: qué cambió, qué se decidió y cuál es el siguiente paso.
- **Normal** *(45–80s)*: explicación clara y conversacional conectada al objetivo del proyecto.
- **Técnico** *(90–150s)*: arquitectura, flujo de datos, decisiones de diseño y seguridad.

---

## Instalación rápida

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

Al abrir el panel lateral de **Gravoz** en Antigravity, una guía de 3 pasos te pedirá pegar tu clave gratuita de Google AI Studio y la verificará al instante.

---

## ¿Por qué necesita una API key de Google AI Studio?

El núcleo de Google Antigravity es propietario y aísla la sesión de tu cuenta Google de los plugins locales. Por seguridad (y siguiendo buenas prácticas OWASP), Gravoz nunca intenta leer ni reutilizar tokens internos de Antigravity. En su lugar, utiliza tu propia clave de **Google AI Studio** (que ofrece nivel gratuito) almacenada localmente con permisos privados (`0600` en Linux/macOS y `%LOCALAPPDATA%\gravoz` en Windows).

---

## Arquitectura

```text
Antigravity (Stop Hook < 50ms)
        │
        ▼  127.0.0.1 + Bearer token por sesión
Sidecar Local (Node.js ESM, 0 dependencias en producción)
  ├── ContextCollector   → README, manifiestos, árbol raíz y artefactos recientes
  ├── TranscriptParser   → Lectura incremental por cola de transcript.jsonl
  ├── GeminiClient       → Guion oral en español + Voz nativa PCM 24kHz
  ├── WavEncoder         → Cabecera RIFF/WAVE en TypeScript puro (sin ffmpeg)
  ├── Aux Pane UI        → Panel minimalista Lean UX con SSE e historial
  └── OsAudioPlayer      → Respaldo nativo opcional (paplay/aplay, afplay, PowerShell)
```

### Decisiones de ingeniería

- **Cero dependencias de runtime** (`dependencies: {}`): menor superficie de ataque y arranque inmediato en Linux, macOS y Windows.
- **TypeScript estricto**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **Seguridad OWASP**: servidor enlazado solo a `127.0.0.1`, validación estricta de `Host` y `Origin` (anti DNS-rebinding / CSRF), token criptográfico por sesión con `timingSafeEqual`, API key enviada solo por cabecera HTTPS (`x-goog-api-key`), validación anti path-traversal con `realpathSync` y cero interpolación de shell (`execFile`).
- **Cancelación determinista**: si llega una nueva respuesta mientras Gemini sintetiza, se cancela la solicitud anterior (`AbortController`) y se evita audio superpuesto.

---

## Desarrollo y pruebas

```bash
npm install
npm run typecheck
npm test
```

## Licencia y créditos

Open source bajo licencia [MIT](./LICENSE).  
Creado por [@mylnzon58](https://github.com/mylnzon58).
