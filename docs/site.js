/**
 * Interactive 3-mode script preview and copy buttons for the Gravoz landing page.
 * Vista previa interactiva de los 3 modos y botones de copia para la página de Gravoz.
 */
(() => {
  const DEMOS = {
    "al-grano": {
      script:
        "El plugin ya compila sin dependencias externas y pasó las once pruebas de integración. Solo queda instalarlo en tu carpeta local y pegar tu clave gratuita de Google AI Studio.",
      meta: "modo al grano / voz Kore / 15 a 30 segundos",
    },
    normal: {
      script:
        "Se terminó de estructurar el servidor local de Gravoz en el puerto de loopback y se validó la codificación WAV en memoria para evitar dependencias externas. El siguiente paso es instalar el paquete en tu carpeta de plugins y pegar tu clave gratuita de Google AI Studio.",
      meta: "modo normal / voz Kore / 45 a 80 segundos",
    },
    tecnico: {
      script:
        "La arquitectura separa el dominio, la infraestructura y la capa de interfaces mediante puertos estrechos. El hook Stop reenvía la ruta de transcripción a 127.0.0.1 con autenticación Bearer por sesión, el lector toma los últimos doscientos cincuenta y seis kilobytes del archivo JSONL con validación realpathSync contra path traversal, y un codificador RIFF envuelve el flujo PCM a veinticuatro kilohercios de Gemini TTS.",
      meta: "modo técnico / voz Kore / 90 a 150 segundos",
    },
  };

  const tabs = Array.from(document.querySelectorAll(".mode-tab"));
  const output = document.getElementById("demo-script");
  const meta = document.getElementById("demo-meta");

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const mode = tab.dataset.mode;
      const demo = DEMOS[mode];
      if (!demo || !output || !meta) return;
      for (const other of tabs) {
        other.setAttribute("aria-selected", String(other === tab));
      }
      output.textContent = demo.script;
      meta.textContent = demo.meta;
    });
  }

  const copyBtns = Array.from(document.querySelectorAll(".copy-btn"));
  for (const btn of copyBtns) {
    btn.addEventListener("click", async () => {
      const targetId = btn.dataset.copy;
      const pre = targetId ? document.getElementById(targetId) : null;
      if (!pre) return;
      try {
        await navigator.clipboard.writeText(pre.textContent || "");
        const prev = btn.textContent;
        btn.textContent = "Copiado";
        setTimeout(() => {
          btn.textContent = prev;
        }, 1400);
      } catch {
        // Clipboard unavailable in restricted contexts.
      }
    });
  }
})();
