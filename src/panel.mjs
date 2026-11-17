import { HOTKEY, SNAP_PAD } from "./config.mjs";
import { CSS } from "./styles.mjs";
import { copyToClipboard, gripIcon, h, icon } from "./dom.mjs";
import { SETTINGS_PANE, watchSettingsPages } from "./settings.mjs";
import { ChatStore, recentChats } from "./chats.mjs";
import { createLayout, createTooltips } from "./panel-layout.mjs";
import { createContextMenus, createFlash, createPopovers, currentSpaceId, isPrivateWindow, spaceName } from "./panel-parts.mjs";
import { createChatView } from "./chat-view.mjs";
import { createApprovalView } from "./approval-view.mjs";
import { createHistoryView } from "./history-view.mjs";
import { createShieldView } from "./shield-view.mjs";
import { createComposer } from "./composer.mjs";
import { createTabOverlay } from "./tab-overlay.mjs";
import { createBrowserController } from "./browser-controller.mjs";
import { createChatController } from "./chat-controller.mjs";
import { createAgentView } from "./agent-view.mjs";
import { createAgentHost } from "./agent-host.mjs";
import { createWatchView } from "./watch-view.mjs";
import { createWatchHost } from "./watch-host.mjs";

// ---------------------------------------------------------------------------
// Builds the window: creates the views and controllers, puts them together
// and wires the window-wide events. What each part owns is in its module.
// ---------------------------------------------------------------------------
export function init() {
  window.windowUtils.loadSheetUsingURIString(
    "data:text/css;charset=utf-8," + encodeURIComponent(CSS),
    window.windowUtils.AUTHOR_SHEET
  );

  const store = new ChatStore({ enabled: !isPrivateWindow() });
  // The chat controller is made last; views ask it for the shown chat when
  // something happens (never while they're being built)
  let chats = null;
  const getActive = () => chats.active();

  // --- Header ---
  const grip = h("button", { class: "zai-grip", "aria-label": "Drag to move", tabindex: "-1" }, gripIcon());
  const newChatBtn = h("button", { class: "zai-icon-btn", "aria-label": "New chat", "data-tip": "New chat", "data-tip-pos": "below" }, icon("compose"));
  const dockBtn = h("button", { class: "zai-icon-btn", "data-tip-pos": "below", "data-tip-align": "end" });
  const closeBtn = h("button", { class: "zai-icon-btn", "aria-label": "Close", "data-tip": "Close", "data-tip-pos": "below", "data-tip-align": "end" }, icon("close"));
  const settingsBtn = h("button", { class: "zai-icon-btn", "aria-label": "Settings", "data-tip": "Settings", "data-tip-pos": "below", "data-tip-align": "end" }, icon("sliders"));

  const backdropCanvas = h("canvas", { width: "1", height: "1" });
  const backdrop = h("div", { class: "zai-backdrop", "aria-hidden": "true" }, backdropCanvas);
  const tint = h("div", { class: "zai-tint", "aria-hidden": "true" });
  const panel = h("section", { id: "zai-panel", class: "zai-closed", "aria-label": "Claude chat" });

  // --- Shared pieces ---
  let tips = null;
  function hideTip() { if (tips) tips.hide(); }
  const tipMore = new WeakMap();
  const { el: flashEl, flash } = createFlash();
  const menus = createContextMenus({ flash, hideTip });
  const popovers = createPopovers();
  let layout = null;
  const isOpen = () => !!layout && layout.isOpen();
  const placePopover = (pop, anchor) => layout.placePopover(pop, anchor);

  // --- Views ---
  const shield = createShieldView({
    placePopover, popovers, hideTip, getActive,
    toolsLocked: (chat) => chats.toolsLocked(chat),
    onToolsUnlocked: (unlocked) => chats.setToolsUnlocked(unlocked),
    onAskAgain: (chat) => chats.askAgain(chat),
  });
  const history = createHistoryView({
    store, panel, placePopover, popovers, hideTip, currentSpaceId, spaceName, getActive,
    liveChats: () => chats.liveChats(),
    onOpen: (id) => chats.openChat(id),
    onDelete: (id) => chats.deleteChat(id),
  });
  const approvals = createApprovalView();
  let browser = null;
  const composer = createComposer({
    panel, flashEl, flash, hideTip, tipMore, menus, popovers, getActive,
    isOpen, isDocked: () => layout.isDocked(), openPanel: () => setOpen(true),
    setPanelLabel: (label) => panel.setAttribute("aria-label", label),
    secretShowing: (b) => browser.secretShowing(b),
    onSend: () => chats.send(),
    onModelPick: (value, provider) => chats.setModel(value, provider),
    onEffort: (level) => { if (chats) chats.setEffort(level); },
    onContinue: () => chats.continueInNewChat(),
    onTyping: () => chats.prewarm(), // a reopened chat's provider starts once you type
  });
  const view = createChatView({
    getActive, isOpen, flash, hideTip, menus,
    quick: {
      runSkill: (name) => composer.runSkillByName(name),
      openTabs: () => composer.openTabPicker(true),
      capture: () => composer.startCapture(),
    },
    // "Recent in <Space>": the Space's last few chats, under the suggestions
    recent: {
      rows: (chat) => recentChats(store.list().filter((e) => e.id !== chat.id), chat.spaceId),
      spaceName,
      open: (id) => chats.openChat(id),
    },
    onNewChat: () => chats.newChat(),
    updateContext: (chat) => chats.updateContext(chat),
    savedAgents: (block, chat) => chats.savedAgents(block, chat),
  });

  // Watches (watch_page): the eye button and its list; the checking runs in watch-host.mjs
  let watchHost = null;
  const watchView = createWatchView({ placePopover, popovers, hideTip, flash, host: () => (watchHost ? watchHost.leader() : null) });
  const header = h("header", { class: "zai-header" }, grip, newChatBtn, history.button, shield.button, watchView.button, h("div", { class: "zai-spacer" }), settingsBtn, dockBtn, closeBtn);
  panel.append(backdrop, tint, header, shield.pop, history.pop, watchView.popover, composer.el, composer.dropZone);
  panel.style.setProperty("--zai-snap-pad", SNAP_PAD + "px");
  document.documentElement.appendChild(panel);

  // Docking, position, resizing, dragging and the blurred backdrop
  layout = createLayout({ panel, header, grip, dockBtn, backdropCanvas, hideTip });
  tips = createTooltips(tipMore);
  tips.bind(panel);

  // --- Controllers ---
  const overlay = createTabOverlay({ liveActors: () => (chats ? chats.liveActors() : []) });
  browser = createBrowserController({ approvals, overlay });
  // Helper agents: their boxes, and the host that runs them for a chat's skill
  const agentView = createAgentView({ fileCard: (f) => view.fileCard(f), savedFileCard: (b) => view.savedFileCard(b) });
  const agents = createAgentHost({
    view, agentView, approvals, browser, overlay,
    onUnread: (chat) => chats.noteUnread(chat),
    markTainted: (chat) => chats.markTainted(chat),
    toolsLocked: (chat) => chats.toolsLocked(chat),
    failTurn: (chat, message) => chats.failTurn(chat, message),
    finishTurn: (chat) => chats.finishTurn(chat),
  });
  chats = createChatController({ store, view, composer, history, shield, approvals, browser, overlay, agents, popovers, flash, isOpen, watchHost: () => watchHost });
  watchHost = createWatchHost({ chats, onChange: () => watchView.render() });
  panel.insertBefore(chats.active().thread, composer.el);
  composer.showUsage();

  function setOpen(open) {
    layout.setOpen(open);
    if (open) {
      if (!chats.active().hasMessages) view.renderGreeting();
      watchView.render();
      composer.renderChips();
      composer.refreshSelection();
      window.requestAnimationFrame(() => composer.focus());
      chats.resumeOrFresh().finally(() => { if (layout.isOpen()) chats.prewarm(); });
    } else {
      popovers.closeOthers();
      hideTip();
      if (panel.contains(document.activeElement)) {
        try { gBrowser.selectedBrowser.focus(); } catch (e) {}
      }
    }
  }

  // --- Wiring ---
  newChatBtn.addEventListener("click", () => chats.newChat());
  dockBtn.addEventListener("click", () => {
    shield.close();
    layout.toggleDock();
  });
  closeBtn.addEventListener("click", () => setOpen(false));
  // Zen AI's pane in Zen's settings (the tab that has them open, else a new one)
  settingsBtn.addEventListener("click", () => {
    try { openPreferences(SETTINGS_PANE); } catch (e) { console.error("[Zen AI] Couldn't open settings:", e); }
  });
  let stopSettings = () => {};
  try { stopSettings = watchSettingsPages(window); } catch (e) { console.error("[Zen AI] Couldn't add the settings pane:", e); }

  // Escape closes the top popover, else the window
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (!popovers.closeTop()) setOpen(false);
  });
  // Clicking elsewhere closes menus. (The event's path is used because a click
  // can re-render the list it landed in, detaching its target.)
  panel.addEventListener("click", (e) => popovers.clickedAt(e.composedPath()));

  // Cmd+C copies text selected in the chat, wherever focus is
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "c" || e.shiftKey || e.altKey) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === "TEXTAREA" || focused.tagName === "INPUT") && focused.selectionStart !== focused.selectionEnd) return;
    const text = view.threadSelection();
    if (text) copyToClipboard(text);
  }, true);

  window.addEventListener("resize", () => {
    overlay.place();
    layout.onWindowResize();
  });
  window.addEventListener("unload", () => {
    layout.dispose();
    composer.dispose();
    history.dispose();
    view.dispose();
    stopSettings();
    chats.dispose();
    watchHost.dispose();
    overlay.dispose();
  });
  try {
    gBrowser.tabContainer.addEventListener("TabSelect", () => {
      overlay.place();
      // Backup for the Space listener (a tab in another Space, or a Zen change)
      chats.checkSpace();
      if (!layout.isOpen()) return;
      composer.pageChanged();
      composer.refreshSelection();
      layout.takeSnapshot();
    });
    gBrowser.tabContainer.addEventListener("TabAttrModified", (e) => {
      if (layout.isOpen() && e.target === gBrowser.selectedTab) composer.renderChips();
    });
  } catch (e) {}

  // Initial render
  layout.start();
  composer.renderModels();
  composer.setEffort(composer.effort());
  layout.applyDock();
  view.renderGreeting();
  composer.updateReadOnly();
  store.ensureLoaded().then(() => view.refreshGreeting());

  // Shortcut
  try {
    UC_API.Hotkeys.define({
      id: "zenai-toggle-key",
      modifiers: HOTKEY.modifiers,
      key: HOTKEY.key,
      command: (win) => win.ZenAIChat && win.ZenAIChat.toggle(),
    }).attachToWindow(window, { suppressOriginal: true });
  } catch (e) {
    console.error("[Zen AI] Could not register the shortcut:", e);
  }

  window.ZenAIChat = {
    toggle: () => setOpen(!layout.isOpen()),
    open: () => setOpen(true),
    close: () => setOpen(false),
    capture: () => composer.startCapture(),
    attach: () => composer.pickFiles(),
    // Other windows' schedulers read this one: the agent process cap is app-wide
    agentScheduler: agents.scheduler,
    // Watches: one window checks them all (see watch-host.mjs)
    watchHost,
  };
  console.log(`[Zen AI] floating chat ready. Toggle with ${HOTKEY.label}.`);
}
