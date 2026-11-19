---
name: gravoz-narrate
description: Control the Gravoz Spanish voice narrator for Antigravity — narrate the latest response or plan in 3 depth modes (al-grano, normal, tecnico), toggle auto-play, or inspect player status.
---

# Gravoz — Voice Narration Control

Use the `gravoz-voice` MCP tools when the user asks you to speak, narrate, summarize aloud, change depth mode, or toggle automatic playback.

## Available Tools

- `gravoz_narrate`: Trigger spoken Spanish narration for the provided text (or latest response) in `al-grano`, `normal`, or `tecnico` mode.
- `gravoz_set_config`: Update `mode` (`al-grano` | `normal` | `tecnico`), `autoPlay` (`true` | `false`), or `voiceName` (`Kore`, `Zephyr`, `Puck`, `Aoede`, `Fenrir`, `Leda`).
- `gravoz_status`: Inspect current Gravoz state (configured API key status, active mode, auto-play flag, and latest narration status).

## Guidelines

- If the user says "léeme esto al grano" or "resúmelo en voz alta", call `gravoz_narrate` with the relevant summary text and `mode: "al-grano"`.
- If Gravoz reports that no Gemini API key is configured, guide the user to open the Gravoz panel (`[Gravoz](sidecar://gravoz/player/)`) and follow the 3-step Google AI Studio key setup.
