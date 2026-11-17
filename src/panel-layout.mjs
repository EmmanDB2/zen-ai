import { ANIM_MS, BLUR_MODES, GLASS_DEFAULTS, MAX_WIDTH, MIN_HEIGHT, MIN_WIDTH, PANEL_WIDTH, PREF_ROOT, SNAP_INTERVAL_MS, SNAP_PAD, SNAP_SCALE, TIP_MORE_MS, TOOLTIP_DELAY_MS, prefs } from "./config.mjs";
import { clamp, h, icon } from "./dom.mjs";

// ---------------------------------------------------------------------------
// The window's frame: tooltips, docking, position, resizing, dragging and the
// blurred backdrop. Owns only layout state (open/docked/position/size/blur);
// chats, history and the composer live elsewhere.
// ---------------------------------------------------------------------------

// One shared tooltip element, kept fully on screen. more: element → () =>
// [{ text, note }] for the lines it grows after a longer hover (TIP_MORE_MS).
export function createTooltips(more = new WeakMap()) {
  const tip = h("div", { id: "zai-tooltip", role: "tooltip", hidden: true });
  document.documentElement.appendChild(tip);
  let tipTarget = null;
  let tipTimer = null;

  function hide() {
    clearTimeout(tipTimer);
    tipTarget = null;
    tip.classList.remove("zai-show");
    tip.hidden = true;
  }

  function show(target, longer = false) {
    const text = target.getAttribute("data-tip");
    if (!text || !target.isConnected) return;
    const extra = longer && more.has(target) ? more.get(target)() : null;
    if (extra && extra.length) tip.replaceChildren(h("div", {}, text), ...extra.map((l) => h("div", { class: l.note ? "zai-tip-note" : "zai-tip-more" }, l.text)));
    else tip.textContent = text;
    tip.classList.toggle("zai-tip-wide", !!(extra && extra.length));
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const preferBelow = target.getAttribute("data-tip-pos") === "below";
    let top = preferBelow ? r.bottom + 6 : r.top - th - 6;
    if (top < 6) top = r.bottom + 6;
    if (top + th > window.innerHeight - 6) top = r.top - th - 6;
    const left = clamp(r.left + r.width / 2 - tw / 2, 6, window.innerWidth - tw - 6);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
    tip.classList.add("zai-show");
  }

  function bind(root) {
    root.addEventListener("mouseover", (e) => {
      const target = e.target.closest && e.target.closest("[data-tip]");
      if (target === tipTarget) return;
      hide();
      if (!target || !root.contains(target)) return;
      tipTarget = target;
      tipTimer = setTimeout(() => {
        show(target);
        if (more.has(target)) tipTimer = setTimeout(() => show(target, true), TIP_MORE_MS - TOOLTIP_DELAY_MS);
      }, TOOLTIP_DELAY_MS);
    });
    root.addEventListener("mouseleave", hide);
    root.addEventListener("pointerdown", hide, true);
    root.addEventListener("keydown", hide, true);
  }

  return { hide, bind, more };
}

// panel: the window's <section>; header/grip: what drags it; dockBtn: its
// dock/float button; backdropCanvas: the snapshot blur's canvas
export function createLayout({ panel, header, grip, dockBtn, backdropCanvas, hideTip }) {
  const state = {
    open: false,
    docked: prefs.get("docked", "false") === "true",
    pos: (() => { try { return JSON.parse(prefs.get("position", "")); } catch (e) { return null; } })(),
    size: (() => { try { return JSON.parse(prefs.get("size", "")); } catch (e) { return null; } })(), // floating { w, h|null }
    dockWidth: parseInt(prefs.get("dockWidth", String(PANEL_WIDTH)), 10) || PANEL_WIDTH,
    blur: "snapshot",
  };

  function updateDockButton() {
    dockBtn.replaceChildren(icon(state.docked ? "undock" : "dock"));
    const label = state.docked ? "Float window" : "Dock to side";
    dockBtn.setAttribute("aria-label", label);
    dockBtn.setAttribute("data-tip", label);
  }

  // Makes room for the docked chat. The page slides the same way whether the
  // chat is opening or closing (zai-dock-anim turns the transition on for both).
  let dockAnimTimer = null;
  function setRootDocked(docked) {
    const root = document.documentElement;
    if (root.hasAttribute("zai-docked") === docked) return;
    root.setAttribute("zai-dock-anim", "");
    clearTimeout(dockAnimTimer);
    dockAnimTimer = setTimeout(() => root.removeAttribute("zai-dock-anim"), ANIM_MS + 120);
    root.toggleAttribute("zai-docked", docked);
  }

  function applyDock() {
    panel.classList.toggle("zai-docked", state.docked);
    setRootDocked(state.open && state.docked);
    updateDockButton();
    applyPosition();
    updateBackdropLoop();
  }

  function setDockWidth(width) {
    state.dockWidth = Math.round(clamp(width, MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth * 0.6)));
    document.documentElement.style.setProperty("--zai-dock-width", state.dockWidth + "px");
  }

  function applyPosition() {
    if (state.docked) {
      panel.style.left = "";
      panel.style.top = "";
      panel.style.width = "";
      panel.style.height = "";
      panel.style.maxHeight = "";
      setDockWidth(state.dockWidth);
      return;
    }
    const width = clamp((state.size && state.size.w) || PANEL_WIDTH, MIN_WIDTH, Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 16)));
    const pos = state.pos || { right: 24, top: 80 };
    const left = clamp(window.innerWidth - width - pos.right, 8, Math.max(8, window.innerWidth - width - 8));
    const top = clamp(pos.top, 8, Math.max(8, window.innerHeight - 120));
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - top - 16);
    panel.style.width = width + "px";
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.maxHeight = maxHeight + "px";
    panel.style.height = state.size && state.size.h ? Math.min(state.size.h, maxHeight) + "px" : "";
  }

  // --- Resizing (floating: left/right/bottom edges + bottom corners; docked: left edge) ---
  function startResize(e, dir) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    hideTip();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, rect: panel.getBoundingClientRect(), dockWidth: state.dockWidth };
    panel.classList.add("zai-dragging");
    document.documentElement.setAttribute("zai-resizing", "");

    const onMove = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (state.docked) {
        setDockWidth(start.dockWidth - dx);
        return;
      }
      const r = start.rect;
      let left = r.left;
      let width = r.width;
      if (dir.includes("l")) {
        width = clamp(r.width - dx, MIN_WIDTH, Math.min(MAX_WIDTH, r.right - 8));
        left = r.right - width;
      }
      if (dir.includes("r")) {
        width = clamp(r.width + dx, MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 8 - r.left));
      }
      panel.style.left = left + "px";
      panel.style.width = width + "px";
      if (dir.includes("b")) {
        panel.style.height = clamp(r.height + dy, MIN_HEIGHT, window.innerHeight - 8 - r.top) + "px";
      }
      paintBackdrop();
    };
    const onUp = (ev) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      try { handle.releasePointerCapture(ev.pointerId); } catch (err) {}
      panel.classList.remove("zai-dragging");
      document.documentElement.removeAttribute("zai-resizing");
      if (state.docked) {
        prefs.set("dockWidth", state.dockWidth);
        return;
      }
      const r = panel.getBoundingClientRect();
      const keptHeight = dir.includes("b") || (state.size && state.size.h);
      state.size = { w: Math.round(r.width), h: keptHeight ? Math.round(r.height) : null };
      state.pos = { right: Math.round(window.innerWidth - r.right), top: Math.round(r.top) };
      prefs.set("size", JSON.stringify(state.size));
      prefs.set("position", JSON.stringify(state.pos));
      applyPosition();
      takeSnapshot();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  function resetSize() {
    if (state.docked) {
      setDockWidth(PANEL_WIDTH);
      prefs.set("dockWidth", PANEL_WIDTH);
    } else {
      state.size = null;
      prefs.set("size", "");
      applyPosition();
      takeSnapshot();
    }
  }

  for (const dir of ["l", "r", "b", "bl", "br"]) {
    const handle = h("div", { class: `zai-resize zai-r-${dir}`, "aria-hidden": "true" });
    handle.addEventListener("pointerdown", (e) => startResize(e, dir));
    handle.addEventListener("dblclick", resetSize);
    panel.append(handle);
  }

  // --- Blur ---
  const snap = { bitmap: null, busy: false, timer: null, failures: 0 };

  function readBlurMode() {
    const mode = prefs.get("blur", "snapshot");
    return BLUR_MODES.includes(mode) ? mode : "snapshot";
  }

  function setBlurMode(mode) {
    state.blur = mode;
    for (const m of BLUR_MODES) panel.classList.toggle("zai-blur-" + m, m === mode);
    updateBackdropLoop();
  }

  function readNumberPref(name, fallback, min, max) {
    const n = parseFloat(prefs.get(name, String(fallback)));
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  }

  function applyGlass() {
    const tint = readNumberPref("glass.tint", GLASS_DEFAULTS.tint, 0, 100);
    const blur = readNumberPref("glass.blur", GLASS_DEFAULTS.blur, 0, 60);
    panel.style.setProperty("--zai-tint-pct", tint + "%");
    panel.style.setProperty("--zai-input-pct", Math.min(100, tint + 22) + "%");
    panel.style.setProperty("--zai-blur", blur + "px");
  }

  function wantsSnapshot() {
    return state.open && !state.docked && state.blur === "snapshot";
  }

  function updateBackdropLoop() {
    if (wantsSnapshot()) {
      if (!snap.timer) {
        takeSnapshot();
        snap.timer = setInterval(takeSnapshot, SNAP_INTERVAL_MS);
      }
    } else if (snap.timer) {
      clearInterval(snap.timer);
      snap.timer = null;
    }
  }

  async function takeSnapshot() {
    if (snap.busy || !wantsSnapshot() || document.hidden) return;
    let browser, windowGlobal;
    try {
      browser = gBrowser.selectedBrowser;
      windowGlobal = browser.browsingContext && browser.browsingContext.currentWindowGlobal;
    } catch (e) {}
    if (!windowGlobal) return;
    snap.busy = true;
    try {
      const bitmap = await windowGlobal.drawSnapshot(null, SNAP_SCALE, "white");
      if (snap.bitmap && snap.bitmap.close) snap.bitmap.close();
      snap.bitmap = bitmap;
      snap.failures = 0;
      paintBackdrop();
    } catch (e) {
      // Some pages (still loading, internal pages) can't be captured; only
      // give up on snapshots if it keeps failing.
      if (++snap.failures >= 5) {
        console.warn("[Zen AI] Snapshot blur isn't working here, switching to native blur.", e);
        setBlurMode("native");
      }
    } finally {
      snap.busy = false;
    }
  }

  function paintBackdrop() {
    if (!snap.bitmap || state.blur !== "snapshot" || state.docked) return;
    let browserRect;
    try { browserRect = gBrowser.selectedBrowser.getBoundingClientRect(); } catch (e) { return; }
    if (!browserRect.width || !browserRect.height) return;

    const panelRect = panel.getBoundingClientRect();
    // How many bitmap pixels per CSS pixel (works whatever scale the capture used)
    const factor = snap.bitmap.width / browserRect.width;
    const width = Math.max(1, Math.ceil((panelRect.width + SNAP_PAD * 2) * factor));
    const height = Math.max(1, Math.ceil((panelRect.height + SNAP_PAD * 2) * factor));
    if (backdropCanvas.width !== width) backdropCanvas.width = width;
    if (backdropCanvas.height !== height) backdropCanvas.height = height;

    const ctx = backdropCanvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    const sx = (panelRect.left - SNAP_PAD - browserRect.left) * factor;
    const sy = (panelRect.top - SNAP_PAD - browserRect.top) * factor;
    ctx.drawImage(snap.bitmap, sx, sy, width, height, 0, 0, width, height);
  }

  // --- Dragging (floating mode only) ---
  header.addEventListener("pointerdown", (e) => {
    if (state.docked || e.button !== 0) return;
    const onButton = e.target.closest("button");
    if (onButton && onButton !== grip) return;
    const rect = panel.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    panel.classList.add("zai-dragging");
    header.setPointerCapture(e.pointerId);
    e.preventDefault();

    const onMove = (ev) => {
      const left = clamp(ev.clientX - offsetX, 8, window.innerWidth - rect.width - 8);
      const top = clamp(ev.clientY - offsetY, 8, window.innerHeight - 120);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      paintBackdrop();
    };
    const onUp = (ev) => {
      header.removeEventListener("pointermove", onMove);
      header.removeEventListener("pointerup", onUp);
      try { header.releasePointerCapture(ev.pointerId); } catch (err) {}
      panel.classList.remove("zai-dragging");
      const r = panel.getBoundingClientRect();
      state.pos = { right: Math.round(window.innerWidth - r.right), top: Math.round(r.top) };
      prefs.set("position", JSON.stringify(state.pos));
      applyPosition();
    };
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", onUp);
  });

  // A popover under its button, inside the panel
  function placePopover(pop, anchor) {
    const pr = panel.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const top = ar.bottom - pr.top + 6;
    pop.style.left = clamp(ar.left - pr.left - 6, 8, Math.max(8, pr.width - pop.offsetWidth - 8)) + "px";
    pop.style.top = top + "px";
    // A short window: the popover scrolls instead of being cut off
    pop.style.maxHeight = Math.max(120, Math.floor(pr.height - top - 8)) + "px";
  }

  const blurObserver = { observe: () => setBlurMode(readBlurMode()) };
  const glassObserver = { observe: () => applyGlass() };
  Services.prefs.addObserver(PREF_ROOT + "blur", blurObserver);
  Services.prefs.addObserver(PREF_ROOT + "glass.", glassObserver);

  return {
    isOpen: () => state.open,
    isDocked: () => state.docked,
    // The layout half of opening/closing (the panel does the rest)
    setOpen(open) {
      state.open = open;
      panel.classList.toggle("zai-closed", !open);
      setRootDocked(open && state.docked);
      updateBackdropLoop();
      if (open) applyPosition();
    },
    toggleDock() {
      state.docked = !state.docked;
      prefs.set("docked", state.docked);
      applyDock();
    },
    // First paint: glass, blur mode and dock state from the prefs
    start() {
      applyGlass();
      setBlurMode(readBlurMode());
    },
    applyDock,
    onWindowResize() {
      if (!state.open) return;
      applyPosition();
      takeSnapshot();
    },
    takeSnapshot,
    placePopover,
    dispose() {
      Services.prefs.removeObserver(PREF_ROOT + "blur", blurObserver);
      Services.prefs.removeObserver(PREF_ROOT + "glass.", glassObserver);
      if (snap.timer) clearInterval(snap.timer);
      snap.timer = null;
      clearTimeout(dockAnimTimer);
    },
  };
}
