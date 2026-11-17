// A Zen window in jsdom running the built mod (dist/), for tests that need
// several windows or restarts sharing one profile: chat history, Spaces,
// background replies. Claude Code is faked; nothing here costs usage.
//
//   const disk = new Map();                   // shared "profile" (path → text)
//   const zen = await fakeZen({ disk });      // a window, mod loaded
//   await zen.open(); await zen.send("hi");   // talk to the fake Claude Code
//   zen.close();                              // "quit": flush, unload
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { dist } from "./common.mjs";
import { fakeAcp } from "./fake-acp.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const HOME = "/home/u";
export const PROJECT_DIR = HOME + "/.claude/projects/-home-u-Documents-Claude-Output";
let sessionCount = 0;
export const newSessionId = () => `5e55a0b1-0000-4000-8000-${String(++sessionCount).padStart(12, "0")}`;

// disk: Map path → text, shared between windows (the profile and ~/.claude)
// transcripts: Set of session ids Claude Code still has
// spaces: [{ uuid, name }] (Zen Spaces), or null for a browser without them
// replyMs: how long each fake reply streams for
// projectDirExists: false → the mod can't check transcripts up front, so an
// expired chat is only found when --resume fails
// holdReplies: replies wait for zen.finishReplies() (a task in progress, so
// zen.askPermission can play Claude Code asking to use a tool)
// page: HTML for the first tab. The mod's frame scripts (the page agent) then
// really run against it. moreTabs: [{ url, title, spaceId, page }] more tabs
// (page: HTML, so the agent can read that tab too). jsdom has no layout: every element gets the same
// small box (so it counts as visible) and there's no hit-testing (stub
// webPage().document.elementFromPoint for points). Its screenshots are the
// page's size (1024×768).
// replyFor(text, proc): the fake Claude Code's reply (or a Promise of it;
// null → "Reply to: …"); proc is the spawn that got the message.
//
// Several processes at once (a chat and its agents): askPermission, callTool,
// listTools, rateLimit and finishReplies take { proc } (a spawn) to talk to
// that one instead of the newest. zen.isChildSpawn(proc) tells an agent's
// process (--no-session-persistence with --mcp-config) from the chat's.
// `claude --version` (Zen AI checks what the CLI supports): answered like the real one
function fakeVersionRun(text = "2.1.296 (Claude Code)\n") {
  let given = false;
  return {
    stdin: { async write() {} },
    stdout: { async readString() { if (given) return ""; given = true; return text; } },
    stderr: { async readString() { return ""; } },
    wait: async () => ({ exitCode: 0 }),
    kill: async () => {},
  };
}

export async function fakeZen({ disk = new Map(), transcripts = new Set(), spaces = null, isPrivate = false, prefs = {}, replyMs = 40, projectDirExists = true, holdReplies = false, page = null, moreTabs = [], updater = null, replyFor = null, antigravity = false } = {}) {
  let MOD = fs.readFileSync(dist(), "utf8");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const acp = antigravity ? fakeAcp({ transcripts, replyMs, holdReplies }) : null;
  if (acp) {
    w.testAcpDependencies = acp;
    const injected = MOD.replace("new provider.Session(handlers)", "new provider.Session(handlers, provider.id === 'antigravity' ? window.testAcpDependencies : undefined)");
    if (injected === MOD) throw new Error("fake-zen: couldn't inject the fake ACP session (src changed the `new provider.Session(handlers)` expression)");
    MOD = injected;
  }
  const errors = [];
  const spawns = [];   // { args, resume }
  const sent = [];     // user messages Claude Code received
  // The skill updater (a one-off run with --no-session-persistence):
  // updater(prompt) → its reply text (or a Promise of it); calls are kept
  const updaterCalls = [];
  const removed = [];  // paths deleted
  const held = [];     // replies waiting (holdReplies): { proc, stream }
  const answers = new Map(); // control request id → resolve (askPermission)
  let liveProc = null;

  w.Blob = NodeBlob;
  w.File = NodeFile;
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.Element.prototype.setPointerCapture = function () {};
  w.Element.prototype.releasePointerCapture = function () {};
  w.Element.prototype.scrollIntoView = function () {};
  w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, clearRect() {}, drawImage() {} });
  w.HTMLCanvasElement.prototype.toDataURL = function (type) { return `data:${type || "image/png"};base64,QUJD`; };
  w.document.createXULElement = (tag) => { const el = w.document.createElement("xul-" + tag); el.openPopupAtScreen = () => {}; return el; };
  if (isPrivate) w.document.documentElement.setAttribute("privatebrowsingmode", "temporary");

  // --- Fake Claude Code: one process per spawn, replies stream in chunks ---
  // The skill updater is a one-off run: --no-session-persistence and no
  // --mcp-config. With --mcp-config it's an agent's process, faked like a chat.
  const isUpdaterRun = (args) => args.includes("--no-session-persistence") && !args.includes("--mcp-config");
  const Subprocess = {
    async call(opts) {
      const args = opts.arguments;
      if (args.length === 1 && args[0] === "--version") return fakeVersionRun();
      const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
      const proc = { args, resume, killed: false };
      if (isUpdaterRun(args)) return fakeUpdater(proc);
      spawns.push(proc);
      liveProc = proc;
      const sessionId = resume || newSessionId();
      const out = [];
      let outWaiter = null;
      const err = [];
      let errWaiter = null;
      let exit = null;
      const exited = new Promise((r) => (exit = r));
      const push = (o) => { if (proc.killed) return; out.push(JSON.stringify(o) + "\n"); if (outWaiter) { outWaiter(); outWaiter = null; } };
      const end = (code) => { proc.killed = true; out.push(""); if (outWaiter) { outWaiter(); outWaiter = null; } if (errWaiter) { errWaiter(); errWaiter = null; } exit({ exitCode: code }); };
      // --resume of a chat Claude Code no longer has: it says so and exits
      if (resume && !transcripts.has(resume)) {
        setTimeout(() => { err.push(`No conversation found with session ID: ${resume}\n`); if (errWaiter) { errWaiter(); errWaiter = null; } setTimeout(() => end(1), 5); }, 5);
      } else {
        transcripts.add(sessionId);
      }
      proc.stdin = {
        async write(line) {
          const msg = JSON.parse(line);
          if (msg.type === "control_response" && answers.has(msg.response.request_id)) {
            answers.get(msg.response.request_id)(msg.response);
            answers.delete(msg.response.request_id);
            return;
          }
          if (msg.type === "control_request" && msg.request.subtype === "interrupt") {
            proc.interrupted = true;
            setTimeout(() => push({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId }), 5);
          }
          if (msg.type !== "user") return;
          const text = msg.message.content.map((b) => b.text || "").join("");
          sent.push({ text, sessionId, proc });
          const fallback = () => `Reply to: ${text.split("\n").pop().slice(0, 40)}`;
          const custom = replyFor && replyFor(text, proc);
          // A Promise from replyFor: stream (or hold) once it settles
          if (custom && typeof custom.then === "function") { custom.then((r) => respond(r || fallback())); return; }
          respond(custom || fallback());
        },
      };
      function respond(reply) {
        if (proc.killed || proc.interrupted) return;
        const chunks = reply.match(/[\s\S]{1,6}/g);
        let i = 0;
        const step = Math.max(1, Math.floor(replyMs / chunks.length));
        const stream = () => {
          const t = setInterval(() => {
            if (proc.killed || proc.interrupted) { clearInterval(t); return; }
            if (i < chunks.length) push({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: chunks[i++] } } });
            else { clearInterval(t); push({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId }); }
          }, step);
        };
        if (holdReplies) held.push({ proc, stream }); else stream();
      }
      proc.stdout = { async readString() { while (!out.length) await new Promise((r) => (outWaiter = r)); return out.splice(0).join(""); } };
      proc.stderr = { async readString() { while (!err.length && !proc.killed) await new Promise((r) => (errWaiter = r)); return err.splice(0).join(""); } };
      proc.wait = () => exited;
      proc.push = push;
      proc.kill = async () => { if (!proc.killed) end(0); };
      return proc;
    },
  };
  function fakeUpdater(proc) {
    const out = [];
    let waiter = null;
    let exit = null;
    const exited = new Promise((r) => (exit = r));
    const push = (o) => { if (proc.killed) return; out.push(JSON.stringify(o) + "\n"); if (waiter) { waiter(); waiter = null; } };
    const end = () => { if (proc.killed) return; proc.killed = true; out.push(""); if (waiter) { waiter(); waiter = null; } exit({ exitCode: 0 }); };
    proc.stdin = {
      async write(line) {
        const msg = JSON.parse(line);
        const prompt = msg.message.content.map((b) => b.text || "").join("");
        const call = { args: proc.args, prompt, proc };
        updaterCalls.push(call);
        push({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { utilization: 0.4, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } } });
        Promise.resolve(updater ? updater(prompt, call) : "```json\n{\"edits\": [], \"changed\": [], \"already_covered\": [], \"unclear\": []}\n```").then((reply) => {
          push({ type: "result", subtype: "success", is_error: false, result: reply });
        });
      },
    };
    proc.stdout = { async readString() { while (!out.length) await new Promise((r) => (waiter = r)); return out.splice(0).join(""); } };
    proc.stderr = { async readString() { await exited; return ""; } };
    proc.wait = () => exited;
    proc.kill = async () => end();
    return proc;
  }

  w.ChromeUtils = { importESModule: (url) => (url.includes("Subprocess") ? { Subprocess } : { BrowserUtils: { copyImageToClipboard() {} } }) };
  const prefStore = new Map(Object.entries(prefs).map(([k, v]) => ["zenai." + k, String(v)]));
  const prefObservers = [];
  w.Services = {
    prefs: {
      getStringPref: (n, f) => (prefStore.has(n) ? prefStore.get(n) : f),
      setStringPref: (n, v) => { prefStore.set(n, String(v)); for (const [root, o] of prefObservers) if (n.startsWith(root)) o.observe(null, "nsPref:changed", n); },
      addObserver: (root, o) => prefObservers.push([root, o]),
      removeObserver: (root, o) => { const i = prefObservers.findIndex(([r, x]) => r === root && x === o); if (i >= 0) prefObservers.splice(i, 1); },
    },
    dirsvc: { get: () => ({ path: HOME }) },
    scriptSecurityManager: { createNullPrincipal: () => ({}) },
  };
  w.Ci = { nsIFile: {}, nsIFilePicker: {}, nsIClipboardHelper: {} };
  w.Cc = { "@mozilla.org/widget/clipboardhelper;1": { getService: () => ({ copyString() {} }) } };

  // --- The disk: the profile's zen-ai folder and Claude Code's transcripts ---
  const SKILL = "---\nname: summarize\ndescription: Summarize\ncontext: page\n---\nSummarize it.";
  const transcriptOf = (p) => (p.startsWith(PROJECT_DIR + "/") ? p.slice(PROJECT_DIR.length + 1).replace(/\.jsonl$/, "") : null);
  w.IOUtils = {
    async stat(p) { return { type: p.endsWith("/claude") || (antigravity && p.endsWith("/agy")) ? "regular" : "directory" }; },
    async makeDirectory() {},
    async exists(p) {
      if (p === PROJECT_DIR) return projectDirExists;
      const t = transcriptOf(p);
      if (t) return transcripts.has(t);
      if (p.startsWith("/profile/zen-ai")) return disk.has(p) || [...disk.keys()].some((k) => k.startsWith(p + "/"));
      if (p.startsWith(HOME + "/Documents/")) return disk.has(p); // files the mod made
      return true;
    },
    async write(p, bytes) { if (String(p).startsWith(HOME + "/Documents/")) disk.set(p, bytes); },
    async writeUTF8(p, text) { disk.set(p, text); },
    async move(a, b) { disk.set(b, disk.get(a)); disk.delete(a); },
    async remove(p) {
      removed.push(p);
      const t = transcriptOf(p);
      if (t) transcripts.delete(t);
      disk.delete(p);
    },
    async getChildren(d) { return d.startsWith("/profile/zen-ai") ? [...disk.keys()].filter((k) => k.startsWith(d + "/")) : ["/skills/summarize.md"]; },
    async readUTF8(p) {
      if (p.startsWith("/profile/zen-ai")) { if (!disk.has(p)) throw new Error("NotFoundError"); return disk.get(p); }
      return SKILL;
    },
    async read() { throw new Error("no such file"); },
  };
  w.PathUtils = { join: (...a) => a.join("/").replace(/\/+/g, "/"), filename: (p) => p.split("/").pop(), profileDir: "/profile" };
  w.openLinkIn = () => {};
  w.UC_API = { Hotkeys: { define: () => ({ attachToWindow() {} }) } };
  w.browsingContext = {};
  w.windowUtils = { AUTHOR_SHEET: 2, loadSheetUsingURIString() {} };

  // --- Tabs, and Zen's Spaces (see docs/zen-spaces.md) ---
  const makeTab = (url, title, spaceId) => {
    const tab = {
      label: title,
      linkedBrowser: {
        currentURI: { spec: url, host: new URL(url).host },
        contentTitle: title,
        getBoundingClientRect: () => ({ left: 300, top: 50, width: 1200, height: 800, right: 1500, bottom: 850 }),
        focus() {},
        browsingContext: { currentWindowGlobal: { getActor: () => ({ getText: async () => ({ text: `Text of ${title}` }) }), drawSnapshot: async () => (webPage ? { width: webPage.innerWidth, height: webPage.innerHeight, close() {} } : { width: 10, height: 10, close() {} }) } },
      },
      getAttribute: (n) => (n === "zen-workspace-id" ? spaceId : null),
      hasAttribute: () => false,
      isConnected: true,
    };
    return tab;
  };
  // The web page behind the first tab, and Firefox's message manager for it:
  // loadFrameScript runs the script with content = the page's window
  let webPage = null;
  const frameScripts = [];
  function messageManager(pageWin) {
    const listeners = new Map();
    const call = (name, data) => [...(listeners.get(name) || [])].map((fn) => fn({ name, data }));
    return {
      addMessageListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
      removeMessageListener(name, fn) { const set = listeners.get(name); if (set) set.delete(fn); },
      loadFrameScript(url) {
        const code = decodeURIComponent(url.slice(url.indexOf(",") + 1));
        frameScripts.push(code.length);
        const sendSyncMessage = (name, data) => call(name, data);
        const sendAsyncMessage = (name, data) => setTimeout(() => call(name, JSON.parse(JSON.stringify(data === undefined ? null : data))), 0);
        new Function("sendSyncMessage", "sendAsyncMessage", "content", "Components", code)(sendSyncMessage, sendAsyncMessage, pageWin, undefined);
      },
    };
  }
  const tabContainer = new w.EventTarget();
  const tabs = spaces
    ? spaces.map((s, i) => makeTab(`https://example${i}.com/${s.name.toLowerCase()}`, `${s.name} page`, s.uuid))
    : [makeTab("https://example.com/", "Example page", null)];
  // A jsdom page behind a tab, read by the real page agent
  const pageFor = (tab, html, url) => {
    const win = new JSDOM(html, { url, pretendToBeVisual: true }).window;
    win.Element.prototype.scrollIntoView = function () {};
    win.Element.prototype.getBoundingClientRect = function () { return { left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30, x: 10, y: 10 }; };
    const b = tab.linkedBrowser;
    b.messageManager = messageManager(win);
    b.webProgress = { isLoadingDocument: false };
    return win;
  };
  if (page) webPage = pageFor(tabs[0], page, "https://example.com/apply");
  for (const t of moreTabs) {
    const tab = makeTab(t.url, t.title, t.spaceId || null);
    if (t.page) tab.webPage = pageFor(tab, t.page, t.url);
    tabs.push(tab);
  }
  w.gBrowser = {
    selectedTab: tabs[0],
    get selectedBrowser() { return this.selectedTab.linkedBrowser; },
    get visibleTabs() { return tabs.filter((t) => !spaces || t.getAttribute("zen-workspace-id") === (w.gZenWorkspaces && w.gZenWorkspaces.activeWorkspace)); },
    tabContainer,
  };
  const listeners = [];
  if (spaces) {
    w.gZenWorkspaces = {
      activeWorkspace: spaces[0].uuid,
      getWorkspaces: () => spaces.slice(),
      getWorkspaceFromId: (id) => spaces.find((s) => s.uuid === id),
      addChangeListeners: (fn) => listeners.push(fn),
      removeChangeListeners: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      isPrivateWindow: isPrivate,
    };
  }
  // Like Zen: set the active Space, select its tab (TabSelect), then call
  // listeners (withListeners: false → only TabSelect, to test the backup path)
  async function switchSpace(uuid, { withListeners = true } = {}) {
    w.gZenWorkspaces.activeWorkspace = uuid;
    w.gBrowser.selectedTab = tabs.find((t) => t.getAttribute("zen-workspace-id") === uuid);
    tabContainer.dispatchEvent(new w.Event("TabSelect"));
    if (withListeners) for (const fn of listeners.slice()) await fn({ workspace: w.gZenWorkspaces.getWorkspaceFromId(uuid), onInit: false });
    await sleep(40);
  }

  w.delayedStartupPromise = Promise.resolve();
  w.addEventListener("error", (e) => errors.push(e.message));
  w.console.error = (...a) => errors.push(a.map(String).join(" "));

  w.eval(MOD);
  await sleep(30);

  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  // Agent boxes still running (idle waits for them too)
  const BUSY_TASKS = ["queued", "starting", "working", "waiting"].map((s) => `.zai-task[data-state="${s}"]`).join(", ");
  const headerBtn = (label) => $$(".zai-header .zai-icon-btn").find((b) => b.getAttribute("aria-label") === label);
  const zen = {
    w, $, $$, click, errors, spawns, sent, removed, disk, transcripts, listeners, switchSpace, tabs, updaterCalls, acp,
    alive: () => spawns.filter((p) => !p.killed).length,
    // An agent's process (resumable chats never pass --no-session-persistence)
    isChildSpawn: (proc) => proc.args.includes("--no-session-persistence") && proc.args.includes("--mcp-config"),
    // Claude Code asking to use a tool → the mod's control_response
    askPermission(toolName, input, { proc = liveProc } = {}) {
      const id = "perm-" + Math.random().toString(36).slice(2);
      const answered = new Promise((r) => answers.set(id, r));
      proc.push({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: toolName, input } });
      return answered.then((r) => r.response || r);
    },
    // Release held replies: all of them, or only that process's
    async finishReplies({ proc } = {}) {
      const go = proc ? held.filter((h) => h.proc === proc) : held.slice();
      for (const h of go) held.splice(held.indexOf(h), 1);
      go.forEach((h) => h.stream());
      await zen.idle();
    },
    // Claude Code calling one of the mod's tools (after askPermission allowed it)
    callTool(name, args, { proc = liveProc } = {}) {
      return zen.mcp({ method: "tools/call", params: { name, arguments: args } }, { proc }).then((m) => m.result || m);
    },
    // Claude Code asking for the mod's tool list → the JSON-RPC result ({ tools })
    listTools({ proc = liveProc } = {}) {
      return zen.mcp({ method: "tools/list", params: {} }, { proc }).then((m) => m.result || m);
    },
    // One mcp_message to the zenai server → the JSON-RPC response
    mcp(message, { proc = liveProc } = {}) {
      const id = "mcp-" + Math.random().toString(36).slice(2);
      const answered = new Promise((r) => answers.set(id, r));
      proc.push({ type: "control_request", request_id: id, request: { subtype: "mcp_message", server_name: "zenai", message: { jsonrpc: "2.0", id: 7, ...message } } });
      return answered.then((r) => (r.response && r.response.mcp_response) || r);
    },
    // Claude Code's rate_limit_event (the plan's usage limits)
    rateLimit(info, { proc = liveProc } = {}) { proc.push({ type: "rate_limit_event", rate_limit_info: info }); },
    // Any stream-json line from Claude Code (usage records, compaction…)
    emit(obj, { proc = liveProc } = {}) { proc.push(obj); },
    prefStore,
    webPage: () => webPage,
    frameScripts,
    async open() { w.ZenAIChat.open(); await sleep(60); },
    hide() { w.ZenAIChat.close(); },
    // Type and send; waits for the reply unless wait is false
    async send(text, { wait = true } = {}) {
      const input = $(".zai-input");
      input.value = text;
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
      click($(".zai-send"));
      if (wait) await zen.idle();
    },
    // Until no chat in this window is replying
    async idle(ms = 3000) {
      const t0 = Date.now();
      await sleep(20);
      while (Date.now() - t0 < ms && ($(".zai-send.zai-stop") || $(".zai-status.zai-live") || $(BUSY_TASKS))) await sleep(20);
      await sleep(20);
    },
    newChat() { click(headerBtn("New chat")); },
    async openHistory() { click(headerBtn("Chat history")); await sleep(60); },
    historyBtn: () => headerBtn("Chat history"),
    historyRows: () => $$(".zai-hist-row").map((r) => r.querySelector(".zai-hist-title").textContent),
    bubbles: () => $$(".zai-thread .zai-bubble").map((b) => b.textContent),
    replies: () => $$(".zai-thread .zai-assistant .zai-seg").map((s) => s.textContent),
    index: () => { try { return JSON.parse(disk.get("/profile/zen-ai/chats/index.json")).chats; } catch (e) { return []; } },
    // "Quit Zen": the window unloads (saves are flushed)
    async close() { w.dispatchEvent(new w.Event("unload")); await sleep(50); w.close(); },
  };
  return zen;
}
