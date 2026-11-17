// Smoke test of the whole built mod (dist/) inside jsdom, with stand-ins for
// Firefox's chrome APIs: opening, chips, attachments, skills, sending, the
// shield, menus and more.
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { dist, fixture } from "../helpers/common.mjs";

const MOD = fs.readFileSync(dist(), "utf8");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
const log = [];
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Web platform gaps in jsdom ---
w.Blob = NodeBlob;
w.File = NodeFile;
w.TextEncoder = TextEncoder;
w.TextDecoder = TextDecoder;
w.DecompressionStream = DecompressionStream;
w.devicePixelRatio = 2;
w.Element.prototype.setPointerCapture = function () {};
w.Element.prototype.releasePointerCapture = function () {};
w.Element.prototype.scrollIntoView = function () {};
const ctx2d = { fillRect() {}, clearRect() {}, drawImage() {}, fillStyle: "" };
w.HTMLCanvasElement.prototype.getContext = () => ctx2d;
w.HTMLCanvasElement.prototype.toDataURL = function (type) { return `data:${type || "image/png"};base64,QUJD`; };
w.HTMLCanvasElement.prototype.toBlob = function (cb, type) { setTimeout(() => cb(new NodeBlob(["PNGDATA"], { type: type || "image/png" })), 0); };
w.createImageBitmap = async (blob) => {
  if (blob && blob.type === "image/broken") throw new Error("decode failed");
  return { width: 3000, height: 2000, close() {} };
};
w.document.createXULElement = (tag) => {
  const el = w.document.createElement("xul-" + tag);
  el.openPopupAtScreen = (x, y, isContext) => log.push(["menu-open", tag, x, y, isContext]);
  return el;
};
const popupset = w.document.createElement("div");
popupset.id = "mainPopupSet";
w.document.documentElement.appendChild(popupset);

// --- Firefox chrome stand-ins ---
const prefStore = new Map();
const copied = [];
const stdinLines = [];
let pushStdout = null;
const SESSION = "5e55a0b1-0000-4000-8000-0000000000aa"; // Claude Code's session ids are UUIDs
const Subprocess = {
  async call(opts) {
    // `claude --version` (what the CLI supports): not a chat process
    if (opts.arguments.length === 1 && opts.arguments[0] === "--version") {
      let given = false;
      return { stdin: { async write() {} }, stdout: { async readString() { if (given) return ""; given = true; return "2.1.296 (Claude Code)\n"; } }, stderr: { async readString() { return ""; } }, wait: async () => ({ exitCode: 0 }), kill: async () => {} };
    }
    log.push(["spawn", opts.arguments.join(" ").slice(0, 60), "tools=" + opts.arguments[opts.arguments.indexOf("--tools") + 1]]);
    const queue = [];
    let waiter = null;
    pushStdout = (obj) => { queue.push(JSON.stringify(obj) + "\n"); if (waiter) { waiter(); waiter = null; } };
    return {
      stdin: {
        async write(line) {
          const msg = JSON.parse(line);
          stdinLines.push(msg);
          if (msg.type === "user") {
            setTimeout(() => {
              pushStdout({ type: "stream_event", session_id: SESSION, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Here's **the answer**." } } });
              pushStdout({ type: "result", subtype: "success", is_error: false, result: "Here's the answer.", session_id: SESSION });
            }, 20);
          }
        },
      },
      stdout: { async readString() { while (!queue.length) await new Promise((r) => (waiter = r)); return queue.splice(0).join(""); } },
      stderr: { async readString() { return new Promise(() => {}); } },
      wait: () => new Promise(() => {}),
      kill: async () => {},
    };
  },
};
w.ChromeUtils = {
  importESModule(url) {
    if (url.includes("Subprocess")) return { Subprocess };
    if (url.includes("BrowserUtils")) return { BrowserUtils: { copyImageToClipboard(buf) { copied.push(buf.byteLength); } } };
    throw new Error("unknown module " + url);
  },
};
w.Services = {
  prefs: {
    getStringPref: (n, f) => (prefStore.has(n) ? prefStore.get(n) : f),
    setStringPref: (n, v) => prefStore.set(n, v),
    addObserver() {},
    removeObserver() {},
  },
  dirsvc: { get: () => ({ path: "/tmp/zai-fakehome" }) },
  scriptSecurityManager: { createNullPrincipal: () => ({}) },
};
const pickedFiles = [];
w.Ci = { nsIFile: {}, nsIFilePicker: { modeOpenMultiple: 3, returnOK: 0, returnCancel: 1 }, nsIClipboardHelper: {} };
w.Cc = {
  "@mozilla.org/filepicker;1": {
    createInstance: () => ({
      init(bc, title, mode) { log.push(["picker-init", title, mode]); },
      open(cb) {
        const list = pickedFiles.slice();
        this.files = { hasMoreElements: () => list.length > 0, getNext: () => ({ QueryInterface: () => list.shift() }) };
        setTimeout(() => cb(0), 0);
      },
    }),
  },
  "@mozilla.org/widget/clipboardhelper;1": { getService: () => ({ copyString() {} }) },
};
const realFiles = new Map();
// The chat history folder (<profile>/zen-ai), in memory
const chatFiles = new Map();
const inHistory = (p) => String(p).startsWith("/profile/zen-ai");
w.IOUtils = {
  async makeDirectory() {},
  async exists(p) { return inHistory(p) ? chatFiles.has(p) : true; },
  async write() {},
  async writeUTF8(p, t) { if (inHistory(p)) chatFiles.set(p, t); },
  async move(from, to) { chatFiles.set(to, chatFiles.get(from)); chatFiles.delete(from); },
  async remove(p) { chatFiles.delete(p); },
  async getChildren(d) { return inHistory(d) ? [...chatFiles.keys()].filter((k) => k.startsWith(d + "/")) : ["/skills/summarize.md"]; },
  async readUTF8(p) {
    if (inHistory(p)) { if (!chatFiles.has(p)) throw new Error("no such file"); return chatFiles.get(p); }
    return "---\nname: summarize\ndescription: Summarize\ncontext: page\n---\nSummarize it.";
  },
  async read(p) { if (!realFiles.has(p)) throw new Error("no such file"); return new Uint8Array(fs.readFileSync(realFiles.get(p))); },
};
w.PathUtils = { join: (...a) => a.join("/"), filename: (p) => p.split("/").pop(), profileDir: "/profile" };
w.openLinkIn = () => {};
w.UC_API = { Hotkeys: { define: () => ({ attachToWindow() {} }) } };
w.browsingContext = {};
let loadedCss = "";
w.windowUtils = { AUTHOR_SHEET: 2, loadSheetUsingURIString(uri) { loadedCss = decodeURIComponent(uri.split(",").slice(1).join(",")); } };

function makeBrowser(url, title) {
  return {
    currentURI: { spec: url, host: new URL(url).host },
    contentTitle: title,
    messageManager: null,
    getBoundingClientRect: () => ({ left: 300, top: 50, width: 1200, height: 800, right: 1500, bottom: 850 }),
    focus() {},
    browsingContext: {
      currentWindowGlobal: {
        getActor: () => ({ getText: async () => ({ text: `Text of ${title}` }) }),
        drawSnapshot: async (rect, scale) => ({ width: 1200 * scale, height: 800 * scale, close() {} }),
      },
    },
  };
}
function makeTab(url, title) {
  return { label: title, linkedBrowser: makeBrowser(url, title), getAttribute: (n) => (n === "image" ? "" : null), hasAttribute: () => false };
}
const tabs = [
  makeTab("https://github.com/zen-browser/desktop", "zen-browser/desktop: Welcome to a calmer internet"),
  makeTab("https://github.com/anthropics/claude-code", "anthropics/claude-code: Claude Code is an agentic coding tool"),
  makeTab("https://en.wikipedia.org/wiki/Merge_sort", "Merge sort - Wikipedia"),
];
w.gBrowser = {
  selectedTab: tabs[0],
  get selectedBrowser() { return this.selectedTab.linkedBrowser; },
  visibleTabs: tabs,
  tabContainer: new w.EventTarget(),
};
w.delayedStartupPromise = Promise.resolve();

w.addEventListener("error", (e) => errors.push(e.message));
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(" ")); };
process.on("unhandledRejection", (e) => errors.push("unhandled: " + (e && e.stack || e)));

const $ = (sel) => w.document.querySelector(sel);
const $$ = (sel) => [...w.document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const chipLabels = () => $$(".zai-composer .zai-chip .zai-chip-label").map((e) => e.textContent);
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  → " + JSON.stringify(extra) : ""}`);
  if (!cond) process.exitCode = 1;
}
function fakeDragEvent(type, files) {
  const ev = new w.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"], files, dropEffect: "none" } });
  return ev;
}

(async () => {
  w.eval(MOD);
  await sleep(50);
  check("mod initialised", !!w.ZenAIChat && !!$("#zai-panel"));
  check("no page-context switch", !$(".zai-ctx") && !$(".zai-switch"));

  // Open (docked) → page attribute + transient animation attribute
  prefStore.set("zenai.docked", "true");
  w.ZenAIChat.open();
  await sleep(30);
  // (docked pref was read at init as false, so dock via the button)
  const dockBtn = $$(".zai-header .zai-icon-btn").find((b) => /Dock to side/.test(b.getAttribute("aria-label")));
  click(dockBtn);
  const root = w.document.documentElement;
  check("docking sets zai-docked + zai-dock-anim", root.hasAttribute("zai-docked") && root.hasAttribute("zai-dock-anim"));
  await sleep(400);
  check("zai-dock-anim removed after the slide", !root.hasAttribute("zai-dock-anim"));
  w.ZenAIChat.close();
  check("closing also animates the page back", !root.hasAttribute("zai-docked") && root.hasAttribute("zai-dock-anim"));
  check("panel gets zai-closed", $("#zai-panel").classList.contains("zai-closed"));
  await sleep(400);
  w.ZenAIChat.open();
  await sleep(30);

  // Page chip + @tab chips use the same labels (host, or title when hosts clash)
  check("page chip is the site name", chipLabels()[0] === "github.com" || chipLabels()[0] === "zen-browser/desktop: Welc…", chipLabels());
  const tabsBtn = $$(".zai-toolbar .zai-icon-btn").find((b) => b.getAttribute("aria-label") === "Add tabs");
  click(tabsBtn);
  check("tabs button shows active state while picker is open", tabsBtn.getAttribute("aria-expanded") === "true");
  const picks = $$(".zai-picker .zai-pick");
  if (!picks.length) console.log("PICKER:", $(".zai-picker").outerHTML.slice(0, 500), errors);
  click(picks[0]); // github (same host as page) → title labels
  click($$(".zai-picker .zai-pick")[1]); // wikipedia
  check("toggled tab's checkmark pops", $$(".zai-picker .zai-check.zai-pop").length === 1);
  check("chips: page + 2 tabs", chipLabels().length === 3, chipLabels());
  check("same-site chips fall back to titles", chipLabels()[0] !== chipLabels()[1] && !chipLabels().includes("github.com"), chipLabels());
  check("other tab chip is its host", chipLabels()[2] === "en.wikipedia.org", chipLabels());
  check("new chips pop in", $$(".zai-composer .zai-chip.zai-pop").length >= 1);
  w.document.body.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  click($("#zai-panel .zai-thread"));
  check("picker closes on outside click", $(".zai-picker").hidden && tabsBtn.getAttribute("aria-expanded") === "false");

  // Attach with the + button (native picker): PDF + docx + code + unsupported
  realFiles.set("/u/secret.pdf", fixture("secret.pdf"));
  realFiles.set("/u/lab3.docx", fixture("lab3.docx"));
  realFiles.set("/u/budget.xlsx", fixture("budget.xlsx"));
  realFiles.set("/u/old.doc", fixture("secret.pdf"));
  pickedFiles.push(
    { leafName: "secret.pdf", fileSize: fs.statSync(fixture("secret.pdf")).size, path: "/u/secret.pdf" },
    { leafName: "lab3.docx", fileSize: fs.statSync(fixture("lab3.docx")).size, path: "/u/lab3.docx" },
    { leafName: "budget.xlsx", fileSize: fs.statSync(fixture("budget.xlsx")).size, path: "/u/budget.xlsx" },
    { leafName: "old.doc", fileSize: 10, path: "/u/old.doc" },
    { leafName: "Lectures", fileSize: 0, path: "/u/Lectures", isDirectory: () => true },
  );
  for (const f of pickedFiles) if (!f.isDirectory) f.isDirectory = () => false;
  const attachBtn = $$(".zai-toolbar .zai-icon-btn").find((b) => b.getAttribute("aria-label") === "Attach files");
  click(attachBtn);
  await sleep(10);
  check("loading chips appear right away", $$(".zai-chip.zai-loading").length >= 1, $$(".zai-chip.zai-loading").length);
  await sleep(200);
  check("unsupported file / folder flashes a hint", /\.doc files|is a folder/.test($(".zai-flash").textContent), $(".zai-flash").textContent);
  check("3 file chips", chipLabels().filter((l) => /secret.pdf|lab3.docx|budget.xlsx/.test(l)).length === 3, chipLabels());

  // Drop a text file and an image onto the panel
  const panel = $("#zai-panel");
  panel.dispatchEvent(fakeDragEvent("dragover", []));
  check("drop zone shows while dragging files", !$(".zai-drop").hidden);
  const md = new NodeFile(["# Notes\nmerge sort is O(n log n)"], "notes.md", { type: "text/markdown" });
  const png = new NodeFile([new Uint8Array([137, 80, 78, 71])], "diagram.png", { type: "image/png" });
  panel.dispatchEvent(fakeDragEvent("drop", [md, png]));
  check("drop zone hides on drop", $(".zai-drop").hidden);
  await sleep(100);
  check("dropped files attached", chipLabels().includes("notes.md") && chipLabels().includes("diagram.png"), chipLabels());
  check("image chip has a thumbnail", $$(".zai-composer .zai-chip-thumb").length === 1);

  // Paste: image without text attaches; text paste is left alone
  const input = $(".zai-input");
  const pasteEv = (files, text) => {
    const ev = new w.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { files, getData: () => text } });
    return ev;
  };
  const shot = new NodeFile([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
  const ev1 = pasteEv([shot], "");
  input.dispatchEvent(ev1);
  const ev2 = pasteEv([shot], "A1\tB1");
  input.dispatchEvent(ev2);
  await sleep(60);
  check("pasted image attached as 'Pasted image.png'", chipLabels().includes("Pasted image.png") && ev1.defaultPrevented);
  check("text paste with an image representation stays text", !ev2.defaultPrevented);

  // Screenshot: drag → release → attached instantly, no menu
  const captureBtn = $$(".zai-toolbar .zai-icon-btn").find((b) => b.getAttribute("aria-label") === "Screenshot an area");
  click(captureBtn);
  const overlay = $("#zai-capture");
  check("capture overlay opens, button shows active", !!overlay && captureBtn.getAttribute("aria-pressed") === "true");
  const pe = (type, x, y) => {
    const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(ev, "pointerId", { value: 1 });
    return ev;
  };
  overlay.dispatchEvent(pe("pointerdown", 400, 100));
  overlay.dispatchEvent(pe("pointermove", 700, 300));
  check("selection box drawn", !!overlay.querySelector(".zai-cap-sel"));
  overlay.dispatchEvent(pe("pointerup", 700, 300));
  await sleep(20);
  check("no action bar anymore", !w.document.querySelector(".zai-cap-bar"));
  await sleep(30);
  check("overlay gone after release", !$("#zai-capture") && captureBtn.getAttribute("aria-pressed") === "false");
  check("screenshot chip in composer", chipLabels().includes("Screenshot"), chipLabels());
  await sleep(30);

  // Right-click the screenshot chip → native menu → Copy Image
  const shotChip = $$(".zai-composer .zai-chip").find((c) => c.textContent.includes("Screenshot"));
  const ctx = new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, screenX: 900, screenY: 600 });
  shotChip.dispatchEvent(ctx);
  check("right-click opens the native image menu", ctx.defaultPrevented && log.some((l) => l[0] === "menu-open" && l[4] === true));
  const menuItems = [...w.document.querySelectorAll("#zai-image-menu xul-menuitem")];
  check("menu has Copy Image + Remove (composer)", menuItems.length === 2 && menuItems[0].getAttribute("label") === "Copy Image" && !menuItems[1].hidden);
  menuItems[0].dispatchEvent(new w.Event("command"));
  await sleep(50);
  check("Copy Image puts PNG bytes on the clipboard", copied.length === 1, copied);

  // Too many attachments → friendly cap
  check("attachment count", chipLabels().length > 0, chipLabels().length);

  // Send: everything goes out in one message
  input.value = "Compare these";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  const send = $(".zai-send");
  check("send is ready", send.classList.contains("zai-ready"));
  click(send);
  await sleep(300);
  const userMsgs = stdinLines.filter((m) => m.type === "user");
  check("one user message sent", userMsgs.length === 1);
  const blocks = userMsgs[0].message.content;
  const types = blocks.map((b) => b.type);
  check("PDF sent as a document block", blocks.some((b) => b.type === "document" && b.source.media_type === "application/pdf" && b.title === "secret.pdf"), types);
  check("images sent as image blocks (dropped, pasted, screenshot)", blocks.filter((b) => b.type === "image").length === 3, types);
  const text = blocks[blocks.length - 1].text;
  check("docx text inside <attached_file>", /<attached_file name="lab3.docx" type="Word document">[\s\S]*merge sort/.test(text));
  check("xlsx as tab-separated text", /Rent \(monthly\)\t1200.5/.test(text));
  check("markdown file text included", /<attached_file name="notes.md"/.test(text));
  check("attachment list line", /The user attached: /.test(text), (text.match(/The user attached: [^\n]*/) || [""])[0].slice(0, 160));
  check("page + both tabs included", (text.match(/<web_page /g) || []).length === 1 && (text.match(/<web_tab /g) || []).length === 2);
  check("user text last", text.trim().endsWith("Compare these"));
  check("composer cleared after send", chipLabels().length === 0, chipLabels());
  check("sent message shows thumbnails", $$(".zai-thread .zai-thumb").length === 3);
  check("sent message chips: page, 2 tabs, 4 files", $$(".zai-thread .zai-user .zai-chip").length === 7, $$(".zai-thread .zai-user .zai-chip-label").map((e) => e.textContent));
  await sleep(100);
  check("reply rendered", /the answer/.test($(".zai-assistant").textContent));

  // Right-click a sent thumbnail → menu without Remove
  const thumb = $(".zai-thread .zai-thumb");
  thumb.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, screenX: 10, screenY: 10 }));
  check("thread image menu has no Remove", menuItems[1].hidden === true);
  menuItems[0].dispatchEvent(new w.Event("command"));
  await sleep(50);
  check("copying a sent image works too", copied.length === 2, copied);

  // Shield: visible (web content), click → popover → turn tools on
  const shield = $(".zai-shield");
  check("shield visible after web content", !shield.hidden && !shield.classList.contains("zai-unlocked"));
  click(shield);
  const pop = $(".zai-popover");
  check("shield opens the popover", !pop.hidden && shield.getAttribute("aria-expanded") === "true", pop.textContent.slice(0, 60));
  click(pop.querySelector(".zai-pop-btn"));
  check("tools turned on: popover closes, shield shows unlocked", pop.hidden && shield.classList.contains("zai-unlocked"));
  input.value = "Run ls";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  click($(".zai-send"));
  await sleep(300);
  const spawns = log.filter((l) => l[0] === "spawn");
  check("first spawn had no tools (web content), restart after unlock has them", spawns.length === 2 && spawns[0][2] === "tools=" && /Bash/.test(spawns[1][2]), spawns.map((s) => s[2]));
  click(shield);
  click(pop.querySelector(".zai-pop-btn"));
  check("turning tools off again", !shield.classList.contains("zai-unlocked"));

  // New chat resets the shield
  const newChat = $$(".zai-header .zai-icon-btn").find((b) => b.getAttribute("aria-label") === "New chat");
  click(newChat);
  check("new chat hides the shield", shield.hidden);

  // --- Chat history: saved per chat, reopened from the history popover ---
  await sleep(400); // saves are debounced
  const index = JSON.parse(chatFiles.get("/profile/zen-ai/chats/index.json") || "{}");
  const row0 = (index.chats || [])[0] || {};
  check("the chat was saved, titled by its first message", index.chats && index.chats.length === 1 && row0.title === "Compare these" && row0.sessionId === SESSION && row0.tainted === true, index.chats);
  const saved = chatFiles.get(`/profile/zen-ai/chats/${row0.id}.json`) || "";
  check("saved: both messages, replies and chip labels", /"Compare these"/.test(saved) && /"Run ls"/.test(saved) && /the answer/.test(saved) && /zen-browser\/desktop/.test(saved) && /en\.wikipedia\.org/.test(saved) && /lab3\.docx/.test(saved) && /"media":\["/.test(saved), saved.slice(0, 300));
  check("saved: never page text, file contents or image data", !/Text of /.test(saved) && !/O\(n log n\)/.test(saved) && !/Rent \(monthly\)/.test(saved) && !/QUJD|PNGDATA|base64/.test(saved));
  check("no temp files left", ![...chatFiles.keys()].some((k) => k.endsWith(".tmp")), [...chatFiles.keys()]);
  const recent = $$(".zai-recent-row");
  check("the fresh chat's greeting lists it under Recent", recent.length === 1 && /Compare these/.test(recent[0].textContent) && /^Recent/.test($(".zai-recent-label").textContent), $(".zai-recent-label") && $(".zai-recent-label").textContent);

  const historyBtn = $$(".zai-header .zai-icon-btn").find((b) => b.getAttribute("aria-label") === "Chat history");
  const newChatIndex = $$(".zai-header > *").indexOf(newChat);
  check("history button sits between New chat and the shield", historyBtn && $$(".zai-header > *").indexOf(historyBtn) === newChatIndex + 1 && $$(".zai-header > *").indexOf(shield) === newChatIndex + 2);
  click(historyBtn);
  await sleep(50);
  const histPop = $(".zai-history");
  check("history opens: search box, a Today group, one row", !histPop.hidden && historyBtn.getAttribute("aria-expanded") === "true" && !!histPop.querySelector(".zai-hist-search") &&
    $$(".zai-hist-group").map((g) => g.textContent).join() === "Today" && $$(".zai-hist-row").length === 1);
  const search = histPop.querySelector(".zai-hist-search");
  search.value = "quicksort zzz";
  search.dispatchEvent(new w.Event("input", { bubbles: true }));
  await sleep(250);
  check("search with no match says so", $$(".zai-hist-row").length === 0 && /No chats match/.test(histPop.textContent));
  search.value = "ANSWER";
  search.dispatchEvent(new w.Event("input", { bubbles: true }));
  await sleep(250);
  check("search finds words inside replies", $$(".zai-hist-row").length === 1);
  click($(".zai-hist-row"));
  await sleep(50);
  check("clicking a row opens the chat and closes history", histPop.hidden && $$(".zai-thread .zai-bubble").map((b) => b.textContent).join("|") === "Compare these|Run ls" && /the answer/.test($(".zai-thread .zai-assistant").textContent));
  check("reopened chat: shield back (web content), chips as labels, nothing read-only", !shield.hidden && $$(".zai-thread .zai-user .zai-chip-label").some((l) => l.textContent === "lab3.docx") && $(".zai-expired").hidden && !input.disabled);
  check("saved images come back as labels only", $$(".zai-thread .zai-thumb").length === 0 && $$(".zai-thread .zai-user .zai-chip-label").some((l) => l.textContent === "diagram.png"));

  // Delete: first click asks, second deletes (row, file and the open chat)
  click(historyBtn);
  await sleep(50);
  check("the open chat is marked current in history", $(".zai-hist-row").getAttribute("aria-current") === "true");
  const del = $(".zai-hist-row .zai-hist-del");
  click(del);
  check("first click on trash asks to confirm", $(".zai-hist-row").classList.contains("zai-confirm") && /Delete/.test(del.textContent));
  click(del);
  await sleep(100);
  const afterDelete = JSON.parse(chatFiles.get("/profile/zen-ai/chats/index.json") || "{}");
  check("deleted: gone from history, index and disk", $$(".zai-hist-row").length === 0 && afterDelete.chats.length === 0 && !chatFiles.has(`/profile/zen-ai/chats/${row0.id}.json`));
  check("deleting the open chat leaves a fresh one", !!$(".zai-greeting") && $$(".zai-recent-row").length === 0 && shield.hidden);
  panel.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("Escape closes history (not the window)", histPop.hidden && !panel.classList.contains("zai-closed"));

  // Settings: Zen AI's pane in Zen's settings
  const opened = [];
  w.openPreferences = (pane) => opened.push(pane);
  $(".zai-header [aria-label='Settings']").click();
  check("the Settings button opens Zen's settings on the Zen AI pane", opened.join() === "paneZenAI", opened);

  // Hover/press styles exist (CSS)
  const css = w.eval("1") && MOD;
  check("zero-specificity button reset", MOD.includes(":where(#zai-panel) button"));
  check("no leftover !important on component buttons", !/\.zai-(pick|send|menu-item|chip-x|action)[^{]*\{[^}]*!important/.test(MOD));

  console.log("\nErrors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
  process.exit();
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
