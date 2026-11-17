import { prefs } from "./config.mjs";
import { openInNewTab, settle, sleep } from "./browser-agent.mjs";
import { watchTab } from "./frames.mjs";
import { browserInfo, sanitizeUntrusted } from "./pages.mjs";
import { isPrivateWindow } from "./panel-parts.mjs";
import { WATCH_LIMITS, checkNote, cleanWatches, conditionMet, describeCondition, isDue, readWatches, watchWakeText, writeWatches } from "./watches.mjs";

// ---------------------------------------------------------------------------
// Running the watches: one window (the first normal one that has Zen AI) does
// the checking for all of them, so each page is checked once; if it closes,
// the next one takes over from the saved list. A check reloads the page (in
// its tab, or a background tab it opens) unless the watch says not to or the
// user is looking at it, and reads it with the page agent: no AI. When the
// condition holds: a notification and a line in the chat; with something to
// do, the chat's AI gets one message in the window that has the tab.
// deps: { chats (wakeForWatch, noteInChat), onChange() }
// ---------------------------------------------------------------------------
export function createWatchHost({ chats, onChange = () => {} }) {
  let list = null;           // the leader's list (null until loaded)
  let busy = false;
  const tabs = new Map();    // watch id → the tab it checks (this session)
  const tickMs = () => Math.max(100, Number(prefs.get("watchTickMs", "")) || 30000);
  const changed = () => {
    try { for (const w of windows()) w.ZenAIChat.watchHost.refreshView(); } catch (e) {}
  };

  function windows() {
    const out = [];
    try {
      const e = Services.wm.getEnumerator("navigator:browser");
      while (e.hasMoreElements()) {
        const w = e.getNext();
        try { if (w.ZenAIChat && w.ZenAIChat.watchHost && !w.closed) out.push(w); } catch (err) {}
      }
    } catch (err) {}
    return out;
  }

  // The window that checks: the first normal (not private) one
  function leaderWindow() {
    return windows().find((w) => { try { return !isPrivateWindow(w); } catch (e) { return false; } }) || null;
  }
  const leaderHost = () => { const w = leaderWindow(); return w ? w.ZenAIChat.watchHost : null; };
  const amLeader = () => leaderWindow() === window;

  async function ensureLoaded() {
    if (!list) list = await readWatches();
    return list;
  }
  const save = () => writeWatches(list || []);

  // --- What other windows (and this one's chats) call, on the leader ---
  async function add(w) {
    await ensureLoaded();
    if (list.filter((x) => x.state === "watching").length >= WATCH_LIMITS.active) {
      throw new Error(`There are already ${WATCH_LIMITS.active} watches running. Stop one first (the eye button at the top of the chat).`);
    }
    list.unshift(w);
    await save();
    changed();
    return w;
  }
  async function stop(id, why = "stopped") {
    await ensureLoaded();
    const w = list.find((x) => x.id === id);
    if (!w || w.state !== "watching") return false;
    w.state = why;
    tabs.delete(id);
    await save();
    changed();
    return true;
  }
  async function remove(id) {
    await ensureLoaded();
    list = list.filter((x) => x.id !== id);
    tabs.delete(id);
    await save();
    changed();
  }
  async function all() {
    return cleanWatches(await ensureLoaded());
  }

  // --- Checking ---
  // The tab for a watch: the one it used, else an open tab at that address
  // (in its Space), else a background tab it opens
  function tabFor(w) {
    const known = tabs.get(w.id);
    if (known && known.isConnected && known.linkedBrowser) return known;
    const strip = (u) => String(u || "").replace(/#.*$/, "");
    for (const win of windows()) {
      if (isPrivateWindow(win)) continue;
      for (const tab of win.gBrowser.tabs) {
        let url = "";
        try { url = tab.linkedBrowser.currentURI.spec; } catch (e) {}
        const space = tab.getAttribute("zen-workspace-id") || "";
        if (strip(url) === strip(w.url) && (!w.spaceId || !space || space === w.spaceId || tab.hasAttribute("zen-essential"))) {
          tabs.set(w.id, tab);
          return tab;
        }
      }
    }
    const tab = openInNewTab(w.url, { background: true, space: w.spaceId });
    if (tab) tabs.set(w.id, tab);
    return tab;
  }

  async function check(w) {
    const tab = tabFor(w);
    if (!tab) throw new Error("Couldn't open the page");
    const b = tab.linkedBrowser;
    const win = winOf(tab);
    // The user is looking at it: don't reload under them
    const looking = win.gBrowser.selectedTab === tab && (() => { try { return Services.focus.activeWindow === win; } catch (e) { return true; } })();
    const pending = tab.hasAttribute("pending");
    if (pending || (w.reload && !looking)) {
      const before = browserInfo(b).url;
      b.reload();
      await sleep(300);
      await settle(b, before, 20000, false, 800);
    }
    const res = await watchTab(b, w.until);
    return { res, tab };
  }

  async function runDue() {
    if (busy || !amLeader()) {
      if (!amLeader()) list = null; // another window leads; read the file again if this one takes over
      return;
    }
    busy = true;
    try {
      await ensureLoaded();
      const now = Date.now();
      let dirty = false;
      for (const w of list) {
        if (w.state === "watching" && now > w.ends) { w.state = "expired"; dirty = true; continue; }
        if (!isDue(w, Date.now())) continue;
        let out = null;
        try {
          out = await check(w);
        } catch (e) {
          out = { res: { error: (e && e.message) || String(e) } };
        }
        if (w.state !== "watching") continue; // stopped meanwhile
        w.lastCheck = Date.now();
        w.checks += 1;
        w.lastNote = checkNote(w.until, out.res);
        w.failures = out.res && out.res.error ? w.failures + 1 : 0;
        dirty = true;
        if (conditionMet(w.until, out.res)) await fire(w, out.tab);
      }
      if (dirty) { await save(); changed(); }
    } catch (e) {
      console.error("[Zen AI] Watch check failed:", e);
    } finally {
      busy = false;
    }
  }

  // --- When it happens ---
  async function fire(w, tab) {
    w.state = "fired";
    w.firedAt = Date.now();
    await save();
    changed();
    const what = w.what || describeCondition(w.until);
    const title = (() => { try { return sanitizeUntrusted(tab.linkedBrowser.contentTitle || tab.label || "").slice(0, 120); } catch (e) { return ""; } })();
    notify(w.then ? `${what}: Zen AI is on it${w.allowAll ? " (without asking)" : ""}` : what, w.then ? `Now: ${w.then.slice(0, 120)}` : `${describeCondition(w.until)} · ${hostOf(w.url)}`, tab);
    const tw = tab && winOf(tab);
    const owner = tw && tw.ZenAIChat && tw.ZenAIChat.watchHost ? tw.ZenAIChat.watchHost : null;
    if (!w.then) {
      for (const win of windows()) win.ZenAIChat.watchHost.noteInChat(w.chatId, "ok", `Watch done: ${describeCondition(w.until)} (${hostOf(w.url)})`);
      return;
    }
    const display = `Watch: ${describeCondition(w.until)}. Now: ${w.then}`;
    const sent = owner ? await owner.wakeHere({ chatId: w.chatId, spaceId: w.spaceId, text: watchWakeText(w, title), display, tab, allowAll: w.allowAll }) : false;
    if (!sent) notify("A watch fired, but Zen AI couldn't act", `Open Zen AI to do it: ${w.then.slice(0, 100)}`, tab);
  }

  // The window a tab is in
  function winOf(tab) {
    try { return tab.ownerDocument.defaultView; } catch (e) { return null; }
  }

  function hostOf(url) {
    try { return new URL(url).host.replace(/^www\./, ""); } catch (e) { return ""; }
  }

  // A macOS notification; clicking it shows the tab
  function notify(title, text, tab) {
    try {
      const alerts = Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);
      const listener = { observe(subject, topic) { if (topic === "alertclickcallback") showTab(tab); } };
      const alert = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
      alert.init("zenai-watch-" + Date.now(), "", title, text, true, "", "auto", "", "", null, false, false);
      alerts.showAlert(alert, listener);
    } catch (e) {
      console.error("[Zen AI] Couldn't show a notification:", e);
    }
  }

  function showTab(tab) {
    try {
      const win = winOf(tab);
      win.focus();
      win.gBrowser.selectedTab = tab;
      win.ZenAIChat.open();
    } catch (e) {}
  }

  const timer = setInterval(runDue, tickMs());
  setTimeout(runDue, Math.min(5000, tickMs())); // soon after start: pick up saved watches

  return {
    // Called on whichever window leads
    add, stop, remove, all,
    leader: leaderHost,
    // This window: its chat gets the message / a line
    async wakeHere(args) { return !!(await chats.wakeForWatch(args)); },
    noteInChat(chatId, kind, text) { chats.noteInChat(chatId, kind, text); },
    refreshView() { onChange(); },
    checkNow: runDue,
    dispose() { clearInterval(timer); },
  };
}
