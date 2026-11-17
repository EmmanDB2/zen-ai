import { fileKind, outputFolderPath } from "./files.mjs";
import { skillsDir } from "./skills.mjs";
import { ICONS, h, icon } from "./dom.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { aiName } from "./providers.mjs";
import { updateBlocksFor, updateCard, updatesOn } from "./skill-updates.mjs";
import { chip, copyAction, formatSize, historyTime, timeAgo, toolLine } from "./panel-parts.mjs";
import { statsDetail, statsLine } from "./turn-stats.mjs";

// ---------------------------------------------------------------------------
// The thread: greeting, sent messages, a reply streaming in (text segments,
// status, tool lines, cards), reply actions, file cards, and saved chats
// rebuilt from history. Renders what the chat controller tells it; it never
// decides what a turn means or what is allowed.
//
// A reply is a sequence of blocks: text segments, approval cards, tool
// lines and file cards. Text streams into the current segment; a tool step
// closes it and the next text starts a new one. Each chat has its own
// turn: chat.turn = { el, seg, text, parts, blocks, anyText, statusEl, renderQueued, ... }
// ---------------------------------------------------------------------------
export function createChatView({ getActive, isOpen, flash, hideTip, menus, quick, recent, onNewChat, updateContext, savedAgents }) {
  // A chat's thread element (scrolling hides the tooltip; right-click on
  // selected text offers Copy)
  function newThread() {
    const thread = h("div", { class: "zai-thread", role: "log", "aria-live": "polite" });
    thread.addEventListener("scroll", hideTip, { passive: true });
    thread.addEventListener("contextmenu", (e) => {
      const text = threadSelection();
      if (text.trim()) menus.openTextMenu(e, text);
    });
    return thread;
  }

  function quickAction(iconName, label, hint, onclick) {
    return h("button", { class: "zai-action", onclick }, icon(iconName, 18), h("span", { text: label }), hint ? h("span", { class: "zai-action-hint", text: hint }) : null);
  }

  function renderGreeting(chat = getActive()) {
    chat.thread.replaceChildren(
      h("div", { class: "zai-greeting" }, icon("spark", 26, 2.3), h("h1", { text: "What are we looking at?" })),
      h("nav", { class: "zai-actions", "aria-label": "Quick actions" },
        quickAction("doc", "Summarize this page", "/summarize", () => quick.runSkill("summarize")),
        quickAction("tabs", "Ask across open tabs", tabCountHint(), () => quick.openTabs()),
        quickAction("capture", "Screenshot an area", null, () => quick.capture()),
        quickAction("explain", "Explain what I selected", "/explain", () => quick.runSkill("explain"))
      ),
      ...[recentSection(chat)].filter(Boolean) // (replaceChildren would write null as text)
    );
    chat.hasMessages = false;
  }

  // "Recent in <Space>": the Space's last few chats, under the suggestions
  function recentSection(chat) {
    const rows = recent.rows(chat);
    if (!rows.length) return null;
    const name = recent.spaceName(chat.spaceId);
    return h("nav", { class: "zai-recent", "aria-label": name ? `Recent in ${name}` : "Recent chats" },
      h("div", { class: "zai-recent-label", text: name ? `Recent in ${name}` : "Recent chats" }),
      rows.map((e) => h("button", { class: "zai-action zai-recent-row", "data-chat": e.id, onclick: () => recent.open(e.id) },
        icon("chat", 18),
        h("span", { class: "zai-recent-title", text: e.title }),
        h("span", { class: "zai-action-hint", text: historyTime(e.updated, true) })
      ))
    );
  }

  // Re-render the greeting if it's showing (the list it shows changed)
  function refreshGreeting() {
    const active = getActive();
    if (!active.hasMessages && !active.streaming) renderGreeting(active);
  }

  function tabCountHint() {
    try {
      const n = gBrowser.visibleTabs.length;
      return n === 1 ? "1 tab" : `${n} tabs`;
    } catch (e) { return null; }
  }

  // A sent message. Its context chips and images are filled in once the page is read.
  function makeUserMessage(text, skillName, saved = false) {
    const chipsEl = h("div", { class: "zai-chips", hidden: !skillName }, skillName ? h("span", { class: "zai-pill", text: skillName }) : null);
    const mediaEl = h("div", { class: "zai-media", hidden: true });
    const el = h("div", { class: "zai-user" + (saved ? "" : " zai-enter") }, chipsEl, mediaEl,
      text ? h("div", { class: "zai-bubble", text }) : null,
      text ? h("div", { class: "zai-msg-actions zai-user-actions" }, copyAction(() => text, "Copy message")) : null
    );
    return {
      el,
      fill(chips, media) {
        if (!saved) for (const node of chips) node.classList.add("zai-pop");
        chipsEl.append(...chips);
        chipsEl.hidden = !chipsEl.children.length;
        mediaEl.append(...media);
        mediaEl.hidden = !media.length;
      },
    };
  }

  function threadSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode || !getActive().thread.contains(sel.anchorNode)) return "";
    return String(sel);
  }

  // A sent image, shown in the thread (right-click → Copy Image)
  function threadThumb(att) {
    return h("img", {
      class: "zai-thumb",
      src: att.image.dataUrl,
      alt: att.name,
      "data-tip": `${att.name} · right-click to copy`,
      oncontextmenu: (e) => menus.openImageMenu(e, att, null),
    });
  }

  // -------------------------------------------------------------------------
  // Talking to Claude
  // -------------------------------------------------------------------------
  // A reply is a sequence of blocks: text segments, approval cards, tool
  // lines and file cards. Text streams into the current segment; a tool step
  // closes it and the next text starts a new one. Each chat has its own
  // turn: chat.turn = { el, seg, text, parts, anyText, statusEl, renderQueued, agentTab }

  function nearBottom(chat) {
    const thread = chat.thread;
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  }

  function scrollToBottom(chat) {
    chat.thread.scrollTop = chat.thread.scrollHeight;
  }

  function setTurnStatus(chat, text) {
    const turn = chat.turn;
    if (!turn) return;
    if (!turn.statusEl) {
      turn.statusEl = h("div", { class: "zai-status zai-live" });
      intoTurn(turn, turn.statusEl);
    }
    turn.statusEl.textContent = text;
  }

  function clearTurnStatus(chat) {
    const turn = chat.turn;
    if (turn && turn.statusEl) {
      turn.statusEl.remove();
      turn.statusEl = null;
    }
  }

  function ensureSegment(chat) {
    const turn = chat.turn;
    if (!turn.seg) {
      turn.seg = h("div", { class: "zai-seg" });
      turn.text = "";
      intoTurn(turn, turn.seg);
    }
  }

  function renderTurn(chat) {
    const turn = chat.turn;
    if (!turn) return;
    turn.renderQueued = false;
    if (!turn.seg) return;
    const stick = nearBottom(chat);
    turn.seg.replaceChildren(renderMarkdown(turn.text));
    if (stick) scrollToBottom(chat);
  }

  function queueRender(chat) {
    const turn = chat.turn;
    if (!turn || turn.renderQueued) return;
    turn.renderQueued = true;
    window.requestAnimationFrame(() => renderTurn(chat));
  }

  // Close the current text segment so a card can go after it
  function breakSegment(chat) {
    const turn = chat.turn;
    if (!turn) return;
    if (turn.seg) {
      renderTurn(chat);
      if (turn.text.trim()) {
        turn.parts.push(turn.text);
        turn.blocks.push({ type: "text", text: turn.text });
      }
    }
    turn.seg = null;
    clearTurnStatus(chat);
  }

  // What the saved chat keeps of this reply, in order (see saveTurn)
  function recordBlock(chat, block) {
    if (chat.turn) chat.turn.blocks.push(block);
  }

  function addToolLine(chat, kind, text, code) {
    appendToTurn(chat, toolLine(kind, text, code));
    recordBlock(chat, { type: "line", kind, text, code });
  }

  // While a reply runs, its files tray stays under everything else in it
  function intoTurn(turn, node) {
    turn.el.insertBefore(node, turn.filesEl && turn.filesEl.parentNode === turn.el ? turn.filesEl : null);
  }

  // A file the reply made: a card in the tray at the end of the reply
  function addFile(chat, file) {
    const card = fileCard(file);
    const turn = chat.turn;
    if (!turn) return appendToTurn(chat, card);
    const stick = nearBottom(chat);
    breakSegment(chat);
    if (!turn.filesEl) turn.filesEl = h("div", { class: "zai-files" });
    turn.filesEl.append(card);
    turn.el.append(turn.filesEl);
    if (stick) scrollToBottom(chat);
  }

  function appendToTurn(chat, node) {
    const stick = nearBottom(chat);
    if (chat.turn) {
      breakSegment(chat);
      intoTurn(chat.turn, node);
    } else {
      chat.thread.append(node);
    }
    if (stick) scrollToBottom(chat);
  }

  function friendlyError(text, chat) {
    const t = String(text || "Something went wrong.");
    if (/not (logged|signed) in|\/login|authenticat|credential|oauth/i.test(t)) {
      if (chat.provider === "antigravity") return "Antigravity isn't signed in. Open Terminal, run `agy`, and log in. Then try again.";
      return "Claude Code isn't signed in. Open Terminal, run `claude`, type /login and choose your Claude subscription. Then try again.";
    }
    if (/rate.?limit|usage limit|limit reached/i.test(t)) {
      return `You've hit your ${aiName(chat)} usage limit for now.\n` + t;
    }
    return t;
  }

  function refreshTimes() {
    for (const el of getActive().thread.querySelectorAll(".zai-time")) el.textContent = timeAgo(Number(el.dataset.ts));
  }

  function replyActions(text, ts) {
    if (!text) return null;
    return h("div", { class: "zai-msg-actions zai-reply-actions" },
      copyAction(() => text, "Copy reply"),
      h("span", {
        class: "zai-time",
        "data-ts": String(ts),
        "data-tip": new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        text: timeAgo(ts),
      })
    );
  }

  function addReplyActions(t) {
    const actions = replyActions([...t.parts, t.seg ? t.text : ""].filter((part) => part.trim()).join("\n\n"), Date.now());
    if (actions) t.el.append(actions);
  }

  // Long chats: every message re-reads the whole conversation, so after a
  // while a fresh chat is much lighter on the usage limit. Say so, once per size step.
  const LONG_CHAT_TOKENS = 50000;

  function chatTokens(msg) {
    if (Number.isFinite(msg.contextTokens)) return msg.contextTokens;
    const u = (msg && msg.usage) || {};
    // The last request of the turn = the whole chat as Claude last read it
    const its = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : null;
    const x = its || u;
    const total = (x.input_tokens || 0) + (x.cache_read_input_tokens || 0) + (x.cache_creation_input_tokens || 0) + (x.output_tokens || 0);
    return its ? total : Math.round(total / Math.max(1, msg.num_turns || 1));
  }

  function noteChatSize(chat, t, msg) {
    const tokens = chatTokens(msg);
    const long = chat.longChat;
    if (!t || !t.el || tokens < LONG_CHAT_TOKENS) return;
    // Show it again only once the chat has grown another half
    if (long.shownAt && tokens < long.shownAt * 1.5) {
      if (long.hint && long.hint.parentNode !== t.el) t.el.append(long.hint);
      return;
    }
    if (long.hint) long.hint.remove();
    long.shownAt = tokens;
    const k = Math.round(tokens / 1000);
    long.hint = h("div", { class: "zai-long-chat" },
      icon("stack", 15),
      h("span", { text: `This chat is ~${k}k tokens, and each message re-reads all of it. A new chat uses much less of your limit.` }),
      h("button", { class: "zai-long-chat-btn", text: "New chat", onclick: () => onNewChat() })
    );
    t.el.append(long.hint);
    scrollToBottom(chat);
  }

  // A finished reply from a skill: a card for each file its Lessons / New info
  // sections may update (skill-updates.mjs), and a line for any it may not.
  // Returns the blocks to save after the reply's text.
  function offerUpdates(chat) {
    const t = chat.turn;
    if (!t || !t.skill || !updatesOn()) return [];
    const text = [...t.blocks.filter((b) => b.type === "text").map((b) => b.text), t.seg ? t.text : ""].join("\n\n");
    const { blocks, ignored } = updateBlocksFor(text, t.skill);
    const out = [];
    for (const why of ignored) {
      t.el.append(toolLine("warn", why));
      out.push({ type: "line", kind: "warn", text: why });
    }
    for (const block of blocks) {
      t.el.append(updateCard(block, updateContext(chat)));
      out.push(block);
    }
    return out;
  }

  // A file card that behaves like a file: the system's icon for its type,
  // click to open, drag it out (onto Finder or a page's upload box)
  function fileCard(file) {
    const ext = ((file.name.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || "").toLowerCase();
    const nsFile = () => {
      const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(file.path);
      return f;
    };
    const open = () => { try { nsFile().launch(); } catch (e) { flash("Couldn't open the file"); } };
    const show = () => { try { nsFile().reveal(); } catch (e) { flash("Couldn't show the file"); } };
    const tile = h("div", { class: "zai-file-tile", "data-ext": ext || null, "aria-hidden": "true" },
      h("span", { class: "zai-file-ext", text: (ext || "file").toUpperCase().slice(0, 4) }));
    if (ext) {
      // macOS's own icon for the type (by extension, so a moved file still has one)
      const img = h("img", { class: "zai-file-icon", alt: "", src: `moz-icon://.${ext}?size=64` });
      img.addEventListener("load", () => { if (img.naturalWidth) tile.classList.add("zai-has-icon"); });
      img.addEventListener("error", () => img.remove());
      tile.append(img);
    }
    const main = h("div", {
      class: "zai-file-main", role: "button", tabindex: "0", draggable: "true",
      "data-tip": "Open, or drag it where it's needed",
      onclick: open,
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } },
      ondragstart: (e) => {
        try {
          const f = nsFile();
          if (!f.exists()) throw new Error("gone");
          e.dataTransfer.mozSetDataAt("application/x-moz-file", f, 0);
          e.dataTransfer.setData("text/uri-list", Services.io.newFileURI(f).spec);
          e.dataTransfer.effectAllowed = "copy";
        } catch (err) {
          e.preventDefault();
          flash("That file isn't there anymore");
        }
      },
    },
      tile,
      h("div", { class: "zai-file-text" },
        h("span", { class: "zai-file-name", text: file.name, title: file.path }),
        h("span", { class: "zai-file-meta", text: `${file.kind || fileKind(file.name)} · ${formatSize(file.size)}` })
      )
    );
    return h("div", { class: "zai-filecard" },
      main,
      h("button", { class: "zai-icon-btn zai-file-btn", "aria-label": "Open", "data-tip": "Open", onclick: open }, icon("external", 17)),
      h("button", { class: "zai-icon-btn zai-file-btn", "aria-label": "Show in Finder", "data-tip": "Show in Finder", onclick: show }, icon("folder", 17))
    );
  }

  // -------------------------------------------------------------------------
  // History: saved chats, reopening them, the history popover
  // -------------------------------------------------------------------------
  // A saved chat's thread, rebuilt from what was kept (labels, not images)
  function renderSavedChat(chat) {
    chat.thread.replaceChildren(...chat.messages.map((m) => (m.role === "user" ? savedUserMessage(m) : savedReply(m, chat))));
    chat.hasMessages = true;
  }

  function savedUserMessage(m) {
    const msg = makeUserMessage(m.text, m.skill, true);
    const chips = m.chips.map((c) => chip({ lead: icon(ICONS[c.icon] ? c.icon : "doc", 14), label: c.label }));
    const media = m.media.map((label) => chip({ lead: icon("image", 14), label, tip: `${label} · images aren't kept in history` }));
    msg.fill([...chips, ...media], []);
    return msg.el;
  }

  function savedReply(m, chat) {
    const el = h("div", { class: "zai-assistant" });
    // Files go in a tray after the reply's text, as they did live
    const files = m.blocks.filter((b) => b.type === "file").map(savedFileCard);
    const tray = files.length ? h("div", { class: "zai-files" }, files) : null;
    for (const b of m.blocks) {
      if (tray && !tray.parentNode && (b.type === "stats" || b.type === "update")) el.append(tray);
      if (b.type === "update") { el.append(updateCard(b, updateContext(chat))); continue; }
      if (b.type === "agents") { const box = savedAgents(b, chat); if (box) el.append(box); continue; }
      if (b.type === "stats") { el.append(statsEl(b)); continue; }
      if (b.type === "text") el.append(h("div", { class: "zai-seg" }, renderMarkdown(b.text)));
      else if (b.type === "line") el.append(toolLine(b.kind, b.text, b.code));
      else if (b.type === "error") el.append(h("div", { class: "zai-error", text: b.text }));
      else if (b.type === "status") el.append(h("div", { class: "zai-status", text: b.text }));
    }
    if (tray && !tray.parentNode) el.append(tray);
    const actions = replyActions(m.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n"), m.ts || Date.now());
    if (actions) el.append(actions);
    return el;
  }

  // Open/Show in Finder only for files in Claude Output (the saved path is
  // just text in a file, so it isn't trusted to point anywhere else)
  function savedFileCard(b) {
    let folder = "";
    let skills = "";
    try { folder = outputFolderPath(); } catch (e) {}
    try { skills = skillsDir(); } catch (e) {}
    // Claude Output, or a skill create_skill made (in the skills folder)
    const inside = !b.path.split("/").includes("..") && ((folder && b.path.startsWith(folder + "/")) || (skills && b.kind && b.path.startsWith(skills + "/") && /\.md$/.test(b.path)));
    return inside ? fileCard(b) : toolLine("ok", `Saved ${b.name}`);
  }

  const timesTimer = setInterval(() => { if (isOpen()) refreshTimes(); }, 30000);

  // A sent message and the (empty) reply that follows it
  function appendExchange(chat, userEl) {
    const el = h("div", { class: "zai-assistant" });
    chat.thread.append(userEl, el);
    return el;
  }

  // What a reply cost (turn-stats.mjs): one muted line, details on hover
  function statsEl(sum) {
    return h("div", { class: "zai-turn-stats", "data-tip": statsDetail(sum), "aria-label": `Usage: ${statsLine(sum)}. ${statsDetail(sum)}` },
      icon("stack", 13), h("span", { text: statsLine(sum) }));
  }
  function addStats(chat, sum) { chat.turn.el.append(statsEl(sum)); }

  // The reply ends with an error / a status ("Stopped.")
  function addError(chat, text) { chat.turn.el.append(h("div", { class: "zai-error", text })); }
  function addStatus(chat, text) { chat.turn.el.append(h("div", { class: "zai-status", text })); }

  return {
    newThread, threadSelection, threadThumb, renderGreeting, refreshGreeting, makeUserMessage,
    nearBottom, scrollToBottom, setTurnStatus, clearTurnStatus, ensureSegment, renderTurn, queueRender, breakSegment,
    recordBlock, addToolLine, appendToTurn, addFile, friendlyError, addReplyActions, addError, addStatus, addStats,
    noteChatSize, offerUpdates, fileCard, savedFileCard, renderSavedChat, appendExchange,
    dispose() { clearInterval(timesTimer); },
  };
}
