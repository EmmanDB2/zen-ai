import { init } from "./panel.mjs";

// Starts once per window, after Zen has finished starting up
if (!window.ZenAIChat) {
  const ready = window.delayedStartupPromise || Promise.resolve();
  ready.then(() => {
    try { init(); } catch (e) { console.error("[Zen AI] floating chat failed to start:", e); }
  });
}
