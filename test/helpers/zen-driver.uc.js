// ==UserScript==
// @name           Zen AI test driver
// @description    Only in the throwaway profiles of test/helpers/real-zen.mjs: runs the test's commands in the browser window.
// ==/UserScript==
//
// Chrome code can't eval, so each command is a script file the test writes
// into chrome/JS/cmd/ and this loads by its chrome:// address. Commands run
// side by side; each one's result goes back as JSON.
(function () {
  if (Services.prefs.getBoolPref("zenaitest.started", false)) return; // one window drives
  Services.prefs.setBoolPref("zenaitest.started", true);
  const base = Services.prefs.getStringPref("zenaitest.driver");
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  async function run(cmd) {
    let out;
    try {
      const value = await Services.scriptloader.loadSubScriptWithOptions(`chrome://userscripts/content/cmd/${cmd.file}`, { target: window, ignoreCache: true, wantReturnValue: true });
      out = { value: value === undefined ? null : value };
    } catch (e) {
      out = { error: `${e}${e && e.stack ? "\n" + e.stack : ""}` };
    }
    let body;
    try { body = JSON.stringify(Object.assign({ id: cmd.id }, out)); } catch (e) { body = JSON.stringify({ id: cmd.id, error: `The result isn't JSON: ${e}` }); }
    fetch(`${base}/done`, { method: "POST", body }).catch(() => {});
  }
  (async () => {
    if (window.delayedStartupPromise) await window.delayedStartupPromise;
    fetch(`${base}/ready`, { method: "POST" }).catch(() => {});
    for (;;) {
      let cmd = null;
      try { cmd = await (await fetch(`${base}/next`, { method: "POST" })).json(); } catch (e) { await pause(200); continue; }
      if (cmd && cmd.file) run(cmd);
    }
  })();
})();
