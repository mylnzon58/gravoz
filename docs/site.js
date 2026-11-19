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
        "La extensión nativa de Gravoz ya está integrada en la barra lateral de Antigravity IDE sin puertos abiertos ni dependencias externas. Solo queda pegar tu clave gratuita de Google AI Studio para escuchar cada plan con Gemini 3.8 Flash TTS.",
      meta: "modo normal / voz Kore / 45 a 80 segundos",
    },
    tecnico: {
      script:
        "La arquitectura separa dominio, infraestructura e interfaces mediante puertos estrechos. El hook Stop escribe un evento atómico en disco sin abrir puertos TCP, el lector toma la cola de doscientos cincuenta y seis kilobytes del archivo JSONL con validación realpathSync, Gemini tres punto ocho genera el guion y el audio PCM a veinticuatro kilohercios, y un codificador RIFF lo envía directo al panel nativo del IDE.",
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

