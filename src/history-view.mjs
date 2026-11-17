import { h, icon } from "./dom.mjs";
import { dayGroups, searchChats } from "./chats.mjs";
import { historyTime } from "./panel-parts.mjs";

// ---------------------------------------------------------------------------
// The history popover: this Space's chats, search, delete, and the unread
// dots (on rows and on the clock button). The store (chats.mjs) keeps the
// chats; the chat controller opens and deletes them (onOpen / onDelete).
// ---------------------------------------------------------------------------
export function createHistoryView({ store, panel, placePopover, popovers, hideTip, currentSpaceId, spaceName, liveChats, getActive, onOpen, onDelete }) {
  const historyBtn = h("button", { class: "zai-icon-btn", "aria-label": "Chat history", "data-tip": "History", "data-tip-pos": "below", "aria-haspopup": "dialog", "aria-expanded": "false", hidden: !store.enabled }, icon("history"));

  const historySearch = h("input", { class: "zai-hist-search", type: "search", placeholder: "Search chats", "aria-label": "Search chats in this Space", spellcheck: "false" });

  const historyList = h("div", { class: "zai-hist-list", role: "list" });

  const historyPop = h("div", { class: "zai-popover zai-history", role: "dialog", "aria-label": "Chats in this Space", hidden: true },
    h("div", { class: "zai-hist-search-row" }, icon("search", 15), historySearch),
    historyList
  );

  // A reply finished (or needs an answer) in a chat that isn't showing
  function markUnread(chat) {
    chat.unread = true;
    updateHistoryDot();
    if (!historyPop.hidden) renderHistory();
  }

  function updateHistoryDot() {
    const space = currentSpaceId();
    const active = getActive();
    historyBtn.classList.toggle("zai-has-unread", liveChats().some((c) => c.unread && c !== active && c.spaceId === space));
  }

  // --- The history popover: this Space's chats, search, delete ---
  let historyQuery = "";

  let historyTimer = null;

  function openHistory() {
    hideTip();
    popovers.closeOthers(entry);
    historyQuery = "";
    historySearch.value = "";
    const name = spaceName(currentSpaceId());
    historySearch.placeholder = name ? `Search ${name}` : "Search chats";
    historyPop.hidden = false;
    historyBtn.setAttribute("aria-expanded", "true");
    historyBtn.removeAttribute("data-tip");
    renderHistory();
    placePopover(historyPop, historyBtn);
    historySearch.focus();
    // Pick up chats other windows saved meanwhile
    store.load().then(() => { if (!historyPop.hidden) renderHistory(); });
  }

  function closeHistory() {
    if (historyPop.hidden) return;
    historyPop.hidden = true;
    clearTimeout(historyTimer);
    historyBtn.setAttribute("aria-expanded", "false");
    historyBtn.setAttribute("data-tip", "History");
  }

  async function renderHistory() {
    const space = currentSpaceId();
    const query = historyQuery.trim();
    let entries = store.list(space);
    if (query) {
      await store.loadTexts(entries.map((e) => e.id));
      if (historyQuery.trim() !== query || historyPop.hidden) return; // typed on meanwhile
      entries = searchChats(store.list(space), query, store.texts);
    }
    // Room for the list: never past the bottom of the window
    const room = panel.getBoundingClientRect().height - 150;
    historyList.style.maxHeight = Math.max(140, Math.min(380, room)) + "px";
    if (!entries.length) {
      const name = spaceName(space);
      historyList.replaceChildren(h("div", { class: "zai-hist-empty", text: query ? `No chats match “${query}”` : name ? `No chats in ${name} yet` : "No chats yet" }));
      return;
    }
    historyList.replaceChildren(...dayGroups(entries).flatMap((g) => [
      h("div", { class: "zai-hist-group", role: "presentation", text: g.label }),
      ...g.chats.map(historyRow),
    ]));
  }

  function historyRow(e) {
    const loaded = liveChats().find((c) => c.id === e.id);
    const del = h("button", { class: "zai-hist-del", "aria-label": `Delete “${e.title}”`, "data-tip": "Delete" }, icon("trash", 15));
    const row = h("div", {
      class: "zai-hist-row",
      role: "listitem",
      tabindex: "0",
      "data-chat": e.id,
      "aria-current": e.id === getActive().id ? "true" : null,
      onclick: () => onOpen(e.id),
      onkeydown: (ev) => {
        if (ev.target !== row) return;
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onOpen(e.id); }
        else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); moveHistoryFocus(row, ev.key === "ArrowDown" ? 1 : -1); }
        else if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); del.click(); }
      },
    },
      h("span", { class: "zai-hist-title", text: e.title }),
      loaded && (loaded.unread || loaded.streaming) && loaded !== getActive()
        ? h("span", { class: "zai-hist-dot" + (loaded.streaming ? " zai-live" : ""), role: "img", "aria-label": loaded.streaming ? "Replying" : "New reply" })
        : null,
      h("span", { class: "zai-hist-time", text: historyTime(e.updated) }),
      del
    );
    // First click asks, second click deletes (the transcript goes too)
    const reset = () => {
      row.classList.remove("zai-confirm");
      del.replaceChildren(icon("trash", 15));
      del.setAttribute("aria-label", `Delete “${e.title}”`);
      del.setAttribute("data-tip", "Delete");
    };
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!row.classList.contains("zai-confirm")) {
        hideTip();
        row.classList.add("zai-confirm");
        del.replaceChildren(h("span", { text: "Delete" }));
        del.setAttribute("aria-label", `Confirm: delete “${e.title}”`);
        del.removeAttribute("data-tip");
        return;
      }
      row.classList.add("zai-leaving");
      onDelete(e.id);
    });
    row.addEventListener("mouseleave", reset);
    row.addEventListener("focusout", (ev) => { if (!row.contains(ev.relatedTarget)) reset(); });
    return row;
  }

  function moveHistoryFocus(from, step) {
    const rows = [...historyList.querySelectorAll(".zai-hist-row")];
    const i = from ? rows.indexOf(from) + step : step > 0 ? 0 : rows.length - 1;
    if (i < 0) historySearch.focus();
    else if (rows[i]) rows[i].focus();
  }

  historyBtn.addEventListener("click", () => (historyPop.hidden ? openHistory() : closeHistory()));

  historySearch.addEventListener("input", () => {
    historyQuery = historySearch.value;
    clearTimeout(historyTimer);
    historyTimer = setTimeout(renderHistory, 120);
  });

  historySearch.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveHistoryFocus(null, 1);
    } else if (e.key === "Enter") {
      const first = historyList.querySelector(".zai-hist-row");
      if (first) onOpen(first.dataset.chat);
    }
  });

  const entry = popovers.register({
    isOpen: () => !historyPop.hidden,
    close: ({ escape } = {}) => { closeHistory(); if (escape) historyBtn.focus(); },
    contains: (path) => path.includes(historyPop) || path.includes(historyBtn),
  });

  return {
    button: historyBtn, pop: historyPop, entry,
    open: openHistory, close: closeHistory, isOpen: () => !historyPop.hidden,
    render: () => { if (!historyPop.hidden) renderHistory(); },
    markUnread, updateDot: updateHistoryDot,
    dispose() { clearTimeout(historyTimer); },
  };
}
