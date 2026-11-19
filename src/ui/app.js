/**
 * Minimalist Lean UX controller for the Gravoz Antigravity Sidecar Panel.
 * Controlador minimalista Lean UX para el panel sidecar de Gravoz en Antigravity.
 */
(() => {
  const tokenMeta = document.querySelector('meta[name="gravoz-token"]');
  const token = tokenMeta ? tokenMeta.getAttribute("content") || "" : "";

  const SPEEDS = [1.0, 1.25, 1.5, 0.85];
  const MODE_LABELS = {
    "al-grano": "Al grano",
    normal: "Normal",
    tecnico: "Técnico",
  };

  const el = {
    dot: document.getElementById("status-dot"),
    phase: document.getElementById("phase-label"),
    btnSettings: document.getElementById("btn-settings"),
    setupCard: document.getElementById("setup-card"),
    apiKeyInput: document.getElementById("api-key-input"),
    btnSaveKey: document.getElementById("btn-save-key"),
    setupFeedback: document.getElementById("setup-feedback"),
    segments: Array.from(document.querySelectorAll(".segment")),
    toggleAutoplay: document.getElementById("toggle-autoplay"),
    selectVoice: document.getElementById("select-voice"),
    btnSpeed: document.getElementById("btn-speed"),
    nowProject: document.getElementById("now-project"),
    nowMode: document.getElementById("now-mode"),
    btnPlay: document.getElementById("btn-play"),
    btnStop: document.getElementById("btn-stop"),
    seekBar: document.getElementById("seek-bar"),
    timeCurrent: document.getElementById("time-current"),
    timeTotal: document.getElementById("time-total"),
    renarrateBar: document.getElementById("renarrate-bar"),
    renarrateBtns: Array.from(document.querySelectorAll("[data-renarrate]")),
    scriptText: document.getElementById("script-text"),
    audio: document.getElementById("audio-el"),
    manualText: document.getElementById("manual-text"),
    btnManualNarrate: document.getElementById("btn-manual-narrate"),
    historyCount: document.getElementById("history-count"),
    historyList: document.getElementById("history-list"),
  };

  let state = {
    config: null,
    history: [],
    currentEntry: null,
    speedIndex: 0,
  };

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function setPhase(phase, message) {
    el.phase.textContent = message || phase;
    el.dot.className = "dot";
    if (phase === "ready") el.dot.classList.add("dot-ready");
    else if (phase === "error") el.dot.classList.add("dot-error");
    else if (phase === "summarizing" || phase === "synthesizing" || phase === "collecting") {
      el.dot.classList.add("dot-busy");
    } else {
      el.dot.classList.add("dot-idle");
    }
  }

  function renderConfig(cfg) {
    state.config = cfg;
    el.setupCard.classList.toggle("hidden", cfg.hasApiKey);
    el.toggleAutoplay.checked = Boolean(cfg.autoPlay);
    el.selectVoice.value = cfg.voiceName || "Kore";

    for (const seg of el.segments) {
      seg.classList.toggle("active", seg.dataset.mode === cfg.mode);
    }

    const rate = cfg.playbackRate || 1.0;
    const idx = SPEEDS.indexOf(rate);
    state.speedIndex = idx >= 0 ? idx : 0;
    el.btnSpeed.textContent = `${rate.toFixed(rate % 1 === 0 ? 1 : 2)}x`;
    el.audio.playbackRate = rate;
  }

  function loadEntry(entry, shouldAutoPlay) {
    state.currentEntry = entry;
    el.nowProject.textContent = entry.projectName || "Antigravity";
    el.nowMode.textContent = MODE_LABELS[entry.mode] || entry.mode;
    el.scriptText.textContent = entry.script || "";
    el.renarrateBar.classList.remove("hidden");
    el.btnPlay.disabled = false;
    el.seekBar.disabled = false;

    el.audio.src = `/api/audio/${encodeURIComponent(entry.id)}?token=${encodeURIComponent(token)}`;
    el.audio.playbackRate = state.config ? state.config.playbackRate || 1.0 : 1.0;

    if (shouldAutoPlay) {
      el.audio.play().catch(() => {
        setPhase("ready", "Pulsa ▶ para escuchar");
      });
    }
  }

  function renderHistory(items) {
    state.history = items;
    el.historyCount.textContent = String(items.length);
    el.historyList.textContent = "";

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "history-empty";
      empty.textContent = "Aún no hay narraciones en esta sesión.";
      el.historyList.appendChild(empty);
      return;
    }

    for (const item of items) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item";

      const meta = document.createElement("div");
      meta.className = "history-meta";

      const left = document.createElement("span");
      left.textContent = `${MODE_LABELS[item.mode] || item.mode} · ${item.voiceName}`;

      const right = document.createElement("span");
      right.textContent = `${item.durationEstimateSec}s`;

      meta.append(left, right);

      const preview = document.createElement("div");
      preview.className = "history-preview";
      preview.textContent = item.script;

      btn.append(meta, preview);
      btn.addEventListener("click", () => loadEntry(item, true));
      li.appendChild(btn);
      el.historyList.appendChild(li);
    }
  }

  // Event bindings
  el.btnSettings.addEventListener("click", () => {
    el.setupCard.classList.toggle("hidden");
    if (!el.setupCard.classList.contains("hidden")) {
      el.apiKeyInput.focus();
    }
  });

  el.btnSaveKey.addEventListener("click", async () => {
    const key = el.apiKeyInput.value.trim();
    if (!key) {
      el.setupFeedback.textContent = "Pega tu clave de Google AI Studio primero.";
      el.setupFeedback.className = "feedback err";
      return;
    }
    el.btnSaveKey.disabled = true;
    el.setupFeedback.textContent = "Verificando clave con Gemini…";
    el.setupFeedback.className = "feedback";
    try {
      const check = await api("POST", "/api/verify-key", { apiKey: key });
      if (!check.valid) {
        throw new Error(check.error || "Clave rechazada por Google AI Studio.");
      }
      const saved = await api("POST", "/api/config", { apiKey: key });
      el.apiKeyInput.value = "";
      el.setupFeedback.textContent = "Clave verificada y guardada en local.";
      el.setupFeedback.className = "feedback ok";
      renderConfig(saved.config);
      setPhase("ready", "Conectado");
    } catch (err) {
      el.setupFeedback.textContent = err instanceof Error ? err.message : "Error al verificar.";
      el.setupFeedback.className = "feedback err";
    } finally {
      el.btnSaveKey.disabled = false;
    }
  });

  for (const seg of el.segments) {
    seg.addEventListener("click", async () => {
      const mode = seg.dataset.mode;
      const res = await api("POST", "/api/config", { mode });
      renderConfig(res.config);
    });
  }

  el.toggleAutoplay.addEventListener("change", async () => {
    const res = await api("POST", "/api/config", { autoPlay: el.toggleAutoplay.checked });
    renderConfig(res.config);
  });

  el.selectVoice.addEventListener("change", async () => {
    const res = await api("POST", "/api/config", { voiceName: el.selectVoice.value });
    renderConfig(res.config);
  });

  el.btnSpeed.addEventListener("click", async () => {
    state.speedIndex = (state.speedIndex + 1) % SPEEDS.length;
    const rate = SPEEDS[state.speedIndex];
    const res = await api("POST", "/api/config", { playbackRate: rate });
    renderConfig(res.config);
  });

  el.btnPlay.addEventListener("click", () => {
    if (el.audio.paused) {
      el.audio.play().catch(() => {});
    } else {
      el.audio.pause();
    }
  });

  el.btnStop.addEventListener("click", async () => {
    el.audio.pause();
    el.audio.currentTime = 0;
    await api("POST", "/api/stop").catch(() => {});
  });

  el.audio.addEventListener("play", () => {
    el.btnPlay.textContent = "⏸";
  });
  el.audio.addEventListener("pause", () => {
    el.btnPlay.textContent = "▶";
  });
  el.audio.addEventListener("timeupdate", () => {
    const dur = el.audio.duration || 0;
    el.timeCurrent.textContent = formatTime(el.audio.currentTime);
    el.timeTotal.textContent = formatTime(dur);
    if (dur > 0) {
      el.seekBar.value = String((el.audio.currentTime / dur) * 100);
    }
  });
  el.seekBar.addEventListener("input", () => {
    const dur = el.audio.duration || 0;
    if (dur > 0) {
      el.audio.currentTime = (Number(el.seekBar.value) / 100) * dur;
    }
  });

  for (const btn of el.renarrateBtns) {
    btn.addEventListener("click", async () => {
      if (!state.currentEntry) return;
      const mode = btn.dataset.renarrate;
      try {
        await api("POST", "/api/renarrate", { id: state.currentEntry.id, mode });
      } catch (err) {
        setPhase("error", err instanceof Error ? err.message : "Error al re-narrar");
      }
    });
  }

  el.btnManualNarrate.addEventListener("click", async () => {
    const text = el.manualText.value.trim();
    if (!text) return;
    el.btnManualNarrate.disabled = true;
    try {
      await api("POST", "/api/narrate", {
        text,
        mode: state.config ? state.config.mode : "normal",
        autoPlay: true,
      });
    } catch (err) {
      setPhase("error", err instanceof Error ? err.message : "Error al narrar");
    } finally {
      el.btnManualNarrate.disabled = false;
    }
  });

  function connectEvents() {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "status") {
          setPhase(msg.phase || "idle", msg.message || "");
        } else if (msg.type === "config" && msg.config) {
          renderConfig(msg.config);
        } else if (msg.type === "narration" && msg.entry) {
          setPhase("ready", "Listo");
          const nextHistory = [msg.entry, ...state.history.filter((h) => h.id !== msg.entry.id)].slice(0, 10);
          renderHistory(nextHistory);
          loadEntry(msg.entry, Boolean(msg.autoPlay));
        } else if (msg.type === "error") {
          setPhase("error", msg.message || "Error");
        }
      } catch {
        // Ignore malformed SSE frame.
      }
    };
  }

  async function init() {
    try {
      const status = await api("GET", "/api/status");
      renderConfig(status.config);
      renderHistory(status.history || []);
      setPhase(status.phase || "idle", status.message || (status.config.hasApiKey ? "Listo" : "Configura tu API key"));
      if (status.history && status.history.length > 0) {
        loadEntry(status.history[0], false);
      }
      connectEvents();
    } catch (err) {
      setPhase("error", err instanceof Error ? err.message : "Error de conexión");
    }
  }

  void init();
})();
