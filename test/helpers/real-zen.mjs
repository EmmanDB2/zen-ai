// Real Zen, headless, running the built mod (dist/): for what only real
// Firefox does (frame scripts, frames from other sites in processes of their
// own, real mouse and key events, screenshots, video). Nothing touches your
// Zen profile: each run gets a throwaway one (fx-autoconfig's profile part
// from FX_AUTOCONFIG, ~/fx-autoconfig by default, plus dist/ and a test
// driver). Pages come from a local server under two sites, 127.0.0.1 and
// localhost, so a frame from "another site" really is one. Claude Code is
// played by the test (like fake-zen.mjs), unless claude: "real".
//
//   const zen = await realZen({ holdReplies: true });
//   await zen.openTab(zen.page("frames.html"));          // on 127.0.0.1
//   await zen.open(); await zen.send("Do the lesson", { wait: false });
//   const perm = zen.askPermission("mcp__zenai__browser_click", { ref: "f1.e2" });
//   const card = await zen.approve(); await perm;        // click "Allow once"
//   const res = await zen.callTool("browser_click", (await perm).updatedInput);
//   await zen.inPage((win) => win.document.title, { frame: "frames-course" });
//   await zen.quit();
import net from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT, claudeBin, dist, servePages } from "./common.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ZEN_APP = process.env.ZEN_APP || "/Applications/Zen.app";
const FX = process.env.FX_AUTOCONFIG || join(homedir(), "fx-autoconfig");

// Why real Zen can't run here ("" if it can)
export function zenMissing() {
  if (!existsSync(join(ZEN_APP, "Contents/MacOS/zen"))) return `Zen isn't at ${ZEN_APP} (set ZEN_APP)`;
  if (!existsSync(join(ZEN_APP, "Contents/Resources/config.js"))) return "fx-autoconfig's loader isn't in Zen.app (scripts/install.sh puts it back)";
  if (!existsSync(join(FX, "profile/chrome/utils/boot.sys.mjs"))) return `fx-autoconfig isn't at ${FX} (set FX_AUTOCONFIG)`;
  return "";
}

let sessions = 0;
const newSessionId = () => `5e55a0b1-0000-4000-8000-${String(++sessions).padStart(12, "0")}`;

// profileFiles: { "zen-ai/watches.json": text, … } written into the profile
// before Zen starts (what an earlier session would have left)
export async function realZen({ claude = "fake", holdReplies = false, prefs = {}, width = 1280, height = 900, timeoutMs = 60000, profileFiles = {} } = {}) {
  const missing = zenMissing();
  if (missing) throw new Error(`Can't run real Zen: ${missing}`);
  const dir = mkdtempSync(join(tmpdir(), "zenai-test-"));
  const profile = join(dir, "profile");
  const cmdDir = join(profile, "chrome", "JS", "cmd");
  mkdirSync(cmdDir, { recursive: true });
  cpSync(join(FX, "profile", "chrome", "utils"), join(profile, "chrome", "utils"), { recursive: true });
  cpSync(dist(), join(profile, "chrome", "JS", "zen-ai-chat.uc.js"));
  for (const [rel, text] of Object.entries(profileFiles)) {
    mkdirSync(dirname(join(profile, rel)), { recursive: true });
    writeFileSync(join(profile, rel), text);
  }
  cpSync(join(ROOT, "test", "helpers", "zen-driver.uc.js"), join(profile, "chrome", "JS", "zz-test-driver.uc.js"));

  // --- Pages, from two sites (see servePages); and the driver's channel ---
  const queue = [];
  let nextWaiter = null;
  const commands = new Map(); // id → { resolve, reject }
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  const driver = (req, res, url) => {
    if (!url.pathname.startsWith("/__driver/")) return false;
    const what = url.pathname.slice("/__driver/".length);
    if (what === "ready") {
      readyResolve();
      res.end("{}");
    } else if (what === "done") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.end("{}");
        let msg = {};
        try { msg = JSON.parse(body); } catch (e) {}
        const c = commands.get(msg.id);
        if (!c) return;
        commands.delete(msg.id);
        if (msg.error) c.reject(new Error(msg.error));
        else c.resolve(msg.value);
      });
    } else {
      // "next": the driver's long poll for a command
      const send = () => res.end(JSON.stringify(queue.shift() || {}));
      if (queue.length) send();
      else {
        const t = setTimeout(() => { nextWaiter = null; send(); }, 20000);
        nextWaiter = () => { clearTimeout(t); nextWaiter = null; send(); };
      }
    }
    return true;
  };
  const site = await servePages(driver);
  const { port, originA, originB } = site;

  // --- Claude Code: played by the test, through zen-relay.mjs ---
  const procs = [];
  const sent = [];
  const held = [];
  const answers = new Map();
  let live = null;
  const relay = net.createServer((sock) => {
    let buf = "";
    let proc = null;
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (!proc) {
          const args = msg.args || [];
          const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
          proc = { args, resume, sessionId: resume || newSessionId(), killed: false, push: (o) => { if (!proc.killed) sock.write(JSON.stringify(o) + "\n"); } };
          procs.push(proc);
          live = proc;
          continue;
        }
        onLine(proc, msg);
      }
    });
    sock.on("close", () => { if (proc) proc.killed = true; });
    sock.on("error", () => {});
  });
  function onLine(proc, msg) {
    if (msg.type === "control_response" && answers.has(msg.response && msg.response.request_id)) {
      answers.get(msg.response.request_id)(msg.response);
      answers.delete(msg.response.request_id);
      return;
    }
    if (msg.type === "control_request" && msg.request && msg.request.subtype === "interrupt") {
      proc.interrupted = true;
      setTimeout(() => proc.push({ type: "result", subtype: "error_during_execution", is_error: true, session_id: proc.sessionId }), 5);
      return;
    }
    if (msg.type !== "user") return;
    proc.interrupted = false;
    const text = (msg.message.content || []).map((b) => b.text || "").join("");
    sent.push({ text, proc });
    const reply = `Reply to: ${text.split("\n").pop().slice(0, 40)}`;
    const finish = () => {
      if (proc.killed || proc.interrupted) return;
      proc.push({ type: "stream_event", session_id: proc.sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } } });
      proc.push({ type: "result", subtype: "success", is_error: false, result: reply, session_id: proc.sessionId });
    };
    if (holdReplies) held.push({ proc, finish });
    else setTimeout(finish, 30);
  }
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));

  let claudePath = claudeBin();
  if (claude === "fake") {
    claudePath = join(dir, "claude");
    // (--version is answered here: Zen AI asks it to see what the CLI supports)
    writeFileSync(claudePath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.296 (Claude Code)"; exit 0; fi\nexec "${process.execPath}" "${join(ROOT, "test", "helpers", "zen-relay.mjs")}" "$@"\n`);
    chmodSync(claudePath, 0o755);
  }
  const now = Math.floor(Date.now() / 1000);
  const allPrefs = {
    "zenaitest.driver": `${originA}/__driver`,
    "zenai.claudePath": claudePath,
    // the mod's and Firefox's console messages, for zen.log()
    "devtools.console.stdout.chrome": true,
    "browser.dom.window.dump.enabled": true,
    // a quiet throwaway profile: no update checks, no first-run pages
    "app.update.lastUpdateTime.background-update-timer": now,
    "app.update.timerMinimumDelay": 86400,
    "app.update.timerFirstInterval": 86400000,
    "browser.shell.checkDefaultBrowser": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.enabled": false,
    "browser.sessionstore.resume_from_crash": false,
    "browser.startup.homepage_override.mstone": "ignore",
    "browser.aboutwelcome.enabled": false,
    "zen.welcome-screen.seen": true,
    ...prefs,
  };
  writeFileSync(join(profile, "user.js"), Object.entries(allPrefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n");

  let log = "";
  const app = spawn(join(ZEN_APP, "Contents/MacOS/zen"), ["-headless", "-no-remote", "-profile", profile], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOZ_HEADLESS: "1", MOZ_HEADLESS_WIDTH: String(width), MOZ_HEADLESS_HEIGHT: String(height), ZENAI_RELAY_PORT: String(relay.address().port) },
  });
  app.stdout.on("data", (d) => (log += d));
  app.stderr.on("data", (d) => (log += d));
  const exited = new Promise((r) => app.on("exit", r));
  const startTimer = setTimeout(() => readyResolve("timeout"), 30000);
  if ((await ready) === "timeout") {
    app.kill();
    throw new Error(`Zen didn't start (or the driver didn't load). Log:\n${log.slice(-3000)}`);
  }
  clearTimeout(startTimer);

  let cmdCount = 0;
  const zen = {
    dir, profile, port, originA, originB, procs, sent,
    relayPath: claudePath, // what zenai.claudePath points at
    // A fixture page: on 127.0.0.1 (other: true → on localhost, another site)
    page: (name, { other = false } = {}) => `${other ? originB : originA}/${name}`,
    log: () => log,
    // The mod's own errors in the console: uncaught ones in its script, and
    // its console.error lines (not Firefox's, even when the mod's call led there)
    errors: () => log.split("\n").filter((l) => /^JavaScript error: chrome:\/\/userscripts\/content\/zen-ai-chat\.uc\.js/.test(l) || /^console\.error: "?\[Zen AI\]/.test(l)),
    // Runs fn(...args) in the browser window; resolves with its (JSON) result
    chrome(fn, ...args) {
      const id = ++cmdCount;
      const file = `c${id}.js`;
      writeFileSync(join(cmdDir, file), `(async () => (${fn.toString()})(...${JSON.stringify(args)}))()`);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { commands.delete(id); reject(new Error(`A command in Zen timed out: ${fn.toString().slice(0, 120)}`)); }, timeoutMs);
        commands.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
        queue.push({ id, file });
        if (nextWaiter) nextWaiter();
      });
    },
    // Runs fn(win, ...args) inside the selected tab's page, or the frame whose
    // address contains `frame` (any process), and resolves with its result
    inPage(fn, { frame = null, args = [] } = {}) {
      return zen.chrome(async (src, match, args) => {
        const browser = gBrowser.selectedBrowser;
        const all = browser.browsingContext.getAllBrowsingContextsInSubtree();
        const bc = match ? all.find((b) => b.currentWindowGlobal && b.currentWindowGlobal.documentURI.spec.includes(match)) : browser.browsingContext;
        if (!bc) throw new Error(`No frame at an address with ${match}`);
        const name = "ZenTest:page:" + Math.random().toString(36).slice(2);
        const code = `(function () {
          const ctx = BrowsingContext.get(${bc.id});
          if (!ctx || !ctx.docShell) return;
          let r;
          try { r = { value: (${src})(ctx.window, ...${JSON.stringify(args)}) }; } catch (e) { r = { error: String(e) }; }
          Services.cpmm.sendAsyncMessage(${JSON.stringify(name)}, JSON.parse(JSON.stringify(r)));
        })();`;
        return await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("The page didn't answer")), 8000);
          Services.ppmm.addMessageListener(name, function got(m) {
            clearTimeout(t);
            Services.ppmm.removeMessageListener(name, got);
            if (m.data && m.data.error) reject(new Error(m.data.error));
            else resolve(m.data ? m.data.value : null);
          });
          Services.ppmm.loadProcessScript("data:application/javascript;charset=utf-8," + encodeURIComponent(code), false);
        });
      }, fn.toString(), frame, args);
    },
    // Opens a tab and waits until it and its frames have loaded
    openTab(url) {
      return zen.chrome(async (url) => {
        const tab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        gBrowser.selectedTab = tab;
        const b = tab.linkedBrowser;
        const t0 = Date.now();
        while (Date.now() - t0 < 15000) {
          await new Promise((r) => setTimeout(r, 100));
          if (!b.browsingContext || (b.webProgress && b.webProgress.isLoadingDocument)) continue;
          const all = b.browsingContext.getAllBrowsingContextsInSubtree();
          if (all.every((bc) => bc.currentWindowGlobal && !/^about:blank/.test(bc.currentWindowGlobal.documentURI.spec))) break;
        }
        await new Promise((r) => setTimeout(r, 300));
        return b.currentURI.spec;
      }, url);
    },
    async open() {
      await zen.chrome(() => window.ZenAIChat.open());
      await sleep(150);
    },
    async send(text, { wait = true } = {}) {
      await zen.chrome((text) => {
        const input = document.querySelector(".zai-input");
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector(".zai-send").click();
      }, text);
      if (wait) await zen.idle();
      else if (claude === "fake") await zen.until(() => live && sent.length && sent[sent.length - 1].proc === live, 15000, "the message to reach Claude Code");
      else await zen.until(() => zen.chrome(() => !!document.querySelector(".zai-send.zai-stop")), 15000, "the reply to start");
    },
    // Until no reply is running
    async idle(ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms && (await zen.chrome(() => !!(document.querySelector(".zai-send.zai-stop") || document.querySelector(".zai-status.zai-live"))))) await sleep(100);
    },
    async until(cond, ms = 10000, what = "a condition") {
      const t0 = Date.now();
      for (;;) {
        if (await cond()) return;
        if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
        await sleep(100);
      }
    },
    $$text: (sel) => zen.chrome((sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent), sel),
    lines: () => zen.$$text(".zai-thread .zai-toolline"),
    // The approval card showing, if any: { title, sub, warn, buttons }
    card: () => zen.chrome(() => {
      const c = [...document.querySelectorAll(".zai-approval")].pop();
      if (!c || c.classList.contains("zai-done")) return null;
      const t = (s) => { const e = c.querySelector(s); return e ? e.textContent : ""; };
      return { title: t(".zai-approval-title"), sub: t(".zai-approval-sub"), warn: t(".zai-approval-warn"), buttons: [...c.querySelectorAll("button")].map((b) => b.textContent) };
    }),
    // Waits for an approval card and clicks: "once", "site", "all" or "deny"
    async approve(choice = "once", ms = 10000) {
      let card = null;
      await zen.until(async () => (card = await zen.card()), ms, "an approval card");
      const sel = { once: ".zai-allow", site: ".zai-allow-site", all: ".zai-allow-all", deny: ".zai-deny" }[choice];
      await zen.chrome((sel) => [...document.querySelectorAll(".zai-approval")].pop().querySelector(sel).click(), sel);
      return card;
    },
    // Claude Code asking to use a tool → the mod's answer. proc: which
    // process asks (a helper agent's, say); the newest one if not given
    askPermission(toolName, input, { proc = null } = {}) {
      const id = "perm-" + Math.random().toString(36).slice(2);
      const answered = new Promise((r) => answers.set(id, r));
      (proc || live).push({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: toolName, input } });
      return answered.then((r) => r.response || r);
    },
    // Claude Code calling one of the mod's tools (after askPermission allowed it)
    callTool(name, args, { proc = null } = {}) {
      const id = "mcp-" + Math.random().toString(36).slice(2);
      const answered = new Promise((r) => answers.set(id, r));
      (proc || live).push({ type: "control_request", request_id: id, request: { subtype: "mcp_message", server_name: "zenai", message: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } } } });
      return answered.then((r) => { const m = (r.response && r.response.mcp_response) || r; return m.result || m; });
    },
    // A helper agent's process (agent-runs.mjs): one task, no saved transcript
    isChildSpawn: (proc) => proc.args.includes("--no-session-persistence") && proc.args.includes("--mcp-config"),
    // Both, for a tool that needs no card (or allowed already)
    async tool(name, args) {
      const perm = await zen.askPermission("mcp__zenai__" + name, args);
      if (perm.behavior !== "allow") return { denied: perm.message };
      return zen.callTool(name, perm.updatedInput);
    },
    async finishReplies({ proc = null } = {}) {
      const mine = held.filter((x) => !proc || x.proc === proc);
      for (const x of mine) held.splice(held.indexOf(x), 1);
      mine.forEach((x) => x.finish());
      if (!proc) await zen.idle();
    },
    async quit() {
      zen.chrome(() => { setTimeout(() => Services.startup.quit(Ci.nsIAppStartup.eForceQuit), 50); return true; }).catch(() => {});
      const gone = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]);
      if (!gone) app.kill("SIGKILL");
      site.close();
      relay.close();
      if (!process.env.KEEP_ZEN_PROFILE) rmSync(dir, { recursive: true, force: true });
      else console.log("Profile kept at", profile);
    },
  };
  return zen;
}

// The text of a tool result
export const textOf = (res) => ((res && res.content) || []).map((c) => c.text || "").join("\n");
