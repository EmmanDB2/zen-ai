import { copyToClipboard, h, icon } from "./dom.mjs";
import { copyImageToClipboard, dataUrlToBlob, hostOf, pngBytes } from "./pages.mjs";
import { NO_SPACE } from "./chats.mjs";

// ---------------------------------------------------------------------------
// Small UI pieces shared by the panel's views (composer, thread, history,
// approvals): labels, chips, tool lines, copy buttons, right-click menus.
// No chat or session state here.
// ---------------------------------------------------------------------------

// --- Zen Spaces (see docs/zen-spaces.md). Without them, one list per window.
export function currentSpaceId() {
  try {
    const id = window.gZenWorkspaces && window.gZenWorkspaces.activeWorkspace;
    if (id && typeof id === "string") return id;
  } catch (e) {}
  return NO_SPACE;
}

export function spaceName(id) {
  if (!id || id === NO_SPACE) return "";
  try {
    const space = window.gZenWorkspaces.getWorkspaceFromId(id);
    return (space && typeof space.name === "string" && space.name.trim()) || "";
  } catch (e) {
    return "";
  }
}

// Private windows save nothing (checked three ways, any one is enough)
export function isPrivateWindow(win = window) {
  try { if (typeof PrivateBrowsingUtils !== "undefined" && PrivateBrowsingUtils.isWindowPrivate(win)) return true; } catch (e) {}
  try { if (win.gZenWorkspaces && win.gZenWorkspaces.isPrivateWindow) return true; } catch (e) {}
  return win.document.documentElement.getAttribute("privatebrowsingmode") === "temporary";
}

export function shortTitle(title, max = 40) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function selectionLabel(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return `“${oneLine.length > 28 ? oneLine.slice(0, 28) + "…" : oneLine}”`;
}

// Page and tab chips are labelled the same way: the site name, or the
// page title when two of them share a site
export function contextLabels(entries) {
  const hosts = entries.map((e) => hostOf(e.url));
  return entries.map((e, i) => {
    const host = hosts[i];
    const clash = host && hosts.indexOf(host) !== hosts.lastIndexOf(host);
    return (clash || !host ? shortTitle(e.title) : host) || host || "Tab";
  });
}

export function tabInfo(tab) {
  let url = "";
  try { url = tab.linkedBrowser.currentURI.spec; } catch (e) {}
  return { icon: tab.getAttribute("image") || "", title: tab.label || "", url };
}

export function currentTabInfo() {
  try { return tabInfo(gBrowser.selectedTab); } catch (e) { return { icon: "", title: "", url: "" }; }
}

export function currentBrowser() {
  try { return gBrowser.selectedBrowser; } catch (e) { return null; }
}

export function isReadableUrl(url) {
  return /^(https?|file):/i.test(url) || /^about:reader/i.test(url);
}

export function attachmentIcon(att) {
  if (att.kind === "image") return "image";
  if (att.kind === "text" && att.label === "Text") return "lines";
  return "doc";
}

export function chipIcon(src, fallbackIcon) {
  return src ? h("img", { class: "zai-chip-icon", src, alt: "" }) : icon(fallbackIcon, 14);
}

// One chip style everywhere: icon/thumbnail, short label, optional ×.
// onRemove runs after the chip's leaving animation.
export function chip({ lead, label, tip, onRemove, onContextMenu, loading }) {
  const el = h("span", { class: "zai-chip" + (loading ? " zai-loading" : ""), "data-tip": tip || label, oncontextmenu: onContextMenu },
    lead,
    h("span", { class: "zai-chip-label", text: label }),
    onRemove ? h("button", {
      class: "zai-chip-x",
      "aria-label": `Remove ${label}`,
      onclick: () => {
        el.classList.add("zai-leaving");
        setTimeout(onRemove, 130);
      },
    }, icon("close", 12, 2.2)) : null
  );
  return el;
}

// Under a Today/Yesterday heading: the time. Earlier: the date. Without a
// heading (Recent), yesterday says so.
export function historyTime(ts, noHeading = false) {
  const d = new Date(ts);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (ts >= today.getTime() || (ts >= yesterday.getTime() && !noHeading)) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (ts >= yesterday.getTime()) return "Yesterday";
  return d.toLocaleDateString([], d.getFullYear() === today.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function timeAgo(ts) {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// A copy button that says "Copied" for a moment
export function copyAction(getText, label) {
  const btn = h("button", { class: "zai-icon-btn zai-act-btn", "aria-label": label, "data-tip": label }, icon("copy", 15));
  btn.addEventListener("click", () => {
    if (!copyToClipboard(getText())) return;
    btn.replaceChildren(icon("check", 15, 2.2));
    btn.classList.add("zai-copied");
    btn.setAttribute("data-tip", "Copied");
    setTimeout(() => {
      btn.replaceChildren(icon("copy", 15));
      btn.classList.remove("zai-copied");
      btn.setAttribute("data-tip", label);
    }, 1500);
  });
  return btn;
}

// A line in a reply: ok (✓), warn (shield, amber) or denied (×)
export function toolLine(kind, text, code) {
  const iconName = kind === "ok" ? "check" : kind === "warn" ? "shield" : "x";
  return h("div", { class: "zai-toolline" + (kind === "ok" ? "" : kind === "warn" ? " zai-warned" : " zai-denied") },
    icon(iconName, 14, 2.2),
    h("span", {}, text, code ? h("code", { text: " " + String(code).slice(0, 160) }) : null)
  );
}

// The short message over the composer ("Copied", "Image copied", errors)
export function createFlash() {
  const el = h("div", { class: "zai-flash", hidden: true });
  let timer = null;
  let hideTimer = null;
  function flash(text) {
    el.textContent = text;
    el.hidden = false;
    el.style.opacity = "1";
    clearTimeout(timer);
    clearTimeout(hideTimer);
    timer = setTimeout(() => {
      el.style.opacity = "0";
      hideTimer = setTimeout(() => (el.hidden = true), 200);
    }, Math.max(1800, Math.min(4500, text.length * 45)));
  }
  return { el, flash };
}

// Native right-click menus: Copy Image (and Remove, in the composer) for
// images, Copy for text selected in the chat
export function createContextMenus({ flash, hideTip }) {
  let imageMenu = null;
  let imageMenuRemove = null;
  let imageMenuTarget = null;
  let textMenu = null;
  let textMenuText = "";

  async function copyImage(att) {
    try {
      if (att.ready) await att.ready;
      const blob = att.blob || (att.image && dataUrlToBlob(att.image.dataUrl));
      if (!blob) throw new Error("no image");
      flash(copyImageToClipboard(await pngBytes(blob)) ? "Image copied" : "Couldn't copy the image");
    } catch (e) {
      console.error("[Zen AI] Couldn't copy the image:", e);
      flash("Couldn't copy the image");
    }
  }

  function openImageMenu(e, att, onRemove) {
    e.preventDefault();
    e.stopPropagation();
    hideTip();
    imageMenuTarget = { att, onRemove };
    try {
      if (!imageMenu) {
        imageMenu = document.createXULElement("menupopup");
        imageMenu.id = "zai-image-menu";
        const copyItem = document.createXULElement("menuitem");
        copyItem.setAttribute("label", "Copy Image");
        copyItem.addEventListener("command", () => imageMenuTarget && copyImage(imageMenuTarget.att));
        const removeItem = document.createXULElement("menuitem");
        removeItem.setAttribute("label", "Remove");
        removeItem.addEventListener("command", () => imageMenuTarget && imageMenuTarget.onRemove && imageMenuTarget.onRemove());
        imageMenu.append(copyItem, removeItem);
        imageMenuRemove = removeItem;
        (document.getElementById("mainPopupSet") || document.documentElement).appendChild(imageMenu);
      }
      imageMenuRemove.hidden = !onRemove;
      imageMenu.openPopupAtScreen(e.screenX, e.screenY, true, e);
    } catch (err) {
      // No native menu here: just copy
      console.warn("[Zen AI] Image menu unavailable, copying instead:", err);
      copyImage(att);
    }
  }

  function openTextMenu(e, text) {
    e.preventDefault();
    hideTip();
    textMenuText = text;
    try {
      if (!textMenu) {
        textMenu = document.createXULElement("menupopup");
        textMenu.id = "zai-text-menu";
        const copyItem = document.createXULElement("menuitem");
        copyItem.setAttribute("label", "Copy");
        copyItem.addEventListener("command", () => copyToClipboard(textMenuText));
        textMenu.append(copyItem);
        (document.getElementById("mainPopupSet") || document.documentElement).appendChild(textMenu);
      }
      textMenu.openPopupAtScreen(e.screenX, e.screenY, true, e);
    } catch (err) {
      copyToClipboard(text);
      flash("Copied");
    }
  }

  return { openImageMenu, openTextMenu };
}

// Popovers and menus that close each other: opening one closes the rest,
// Escape closes the top one, a click outside closes any it didn't land in.
// entries: { isOpen(), close(), contains(path) } in Escape order
export function createPopovers() {
  const entries = [];
  return {
    register(entry) { entries.push(entry); return entry; },
    closeOthers(except) { for (const e of entries) if (e !== except && e.isOpen()) e.close(); },
    // Escape: closes the first open one; false if none was open
    closeTop() {
      const open = entries.find((e) => e.isOpen());
      if (!open) return false;
      open.close({ escape: true });
      return true;
    },
    clickedAt(path) { for (const e of entries) if (e.isOpen() && !e.contains(path)) e.close(); },
  };
}
