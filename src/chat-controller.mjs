import { AGENT_TOOL_NAMES, BROWSER_TOOL_NAMES, MAX_SKILL_READ_CHARS, ZEN_SERVER, agentsOn, prefs } from "./config.mjs";
import { handleZenMcp } from "./files.mjs";
import { attr, browserInfo, sanitizeUntrusted } from "./pages.mjs";
import { cleanSkillBody, folderParts, listDataFiles, loadSkills, saveNewSkill, skillFileText, skillSlug } from "./skills.mjs";
import { skillCard } from "./skill-form.mjs";
import { watchCard } from "./watch-view.mjs";
import { conditionMet, describeCondition, everyText, newWatch, watchCondition, watchEvery } from "./watches.mjs";
import { watchTab } from "./frames.mjs";
import { SESSION_GONE } from "./session.mjs";
import { aiName, chatProvider, createProviderSession, defaultProvider, providerInfo, providerModelPref, providerModelsPref } from "./providers.mjs";
import { NO_SPACE, chatRecap, chatTitle, chatToResume, newChatId, resumeMinutes, transcriptExists } from "./chats.mjs";
import { currentSpaceId, isPrivateWindow } from "./panel-parts.mjs";
import { buildMessage } from "./message-builder.mjs";
import { newTurnStats, noteCompact, noteRequest, noteTool, statsSummary, statsWarning, statsWorthShowing } from "./turn-stats.mjs";
import { newBrowserState } from "./browser-controller.mjs";

let chatTurnSeq = 0;
// Each reply gets an id: a helper agent belongs to exactly one (agent-runs.mjs)
const newTurnId = () => `t${Date.now().toString(36)}${++chatTurnSeq}`;

// ---------------------------------------------------------------------------
// Chats and their turns: each chat has its own thread, provider session and
// safety state; exactly one is shown (`active`). Owns sending, Stop, what a
// provider session reports, saving, reopening, Spaces and process trimming.
// Views render and report clicks; the browser controller decides and runs
// browser actions for an ACTOR.
//
// An actor is whoever acts in the browser and asks for approvals: the chat's
// own AI (chatActor below) or one of its agents (agent-host.mjs). It carries
// its own browser state, pending approvals and grants, and says where its
// cards and lines go.
// ---------------------------------------------------------------------------

export function createChatController({ store, view, composer, history, shield, approvals, browser, overlay, agents, popovers, flash, isOpen, watchHost = () => null }) {
  // Chats: each has its own thread, provider process and safety state.
  // Exactly one is shown (`active`); the panel swaps threads to switch.
  // record: a saved chat (from the store) to rebuild
  // -------------------------------------------------------------------------
  // Chats: each has its own thread, Claude Code process and safety state.
  // Exactly one is shown (`active`); the panel swaps threads to switch.
  // record: a saved chat (from the store) to rebuild
  // -------------------------------------------------------------------------
  function makeChat({ spaceId = currentSpaceId(), record = null, provider = defaultProvider() } = {}) {
    const now = Date.now();
    const chat = {
      id: record ? record.id : newChatId(now),
      provider: record ? chatProvider(record.provider) : chatProvider(provider),
      spaceId: record ? record.spaceId : spaceId,
      title: record ? record.title : "",
      created: record ? record.created : now,
      updated: record ? record.updated : now,
      messages: record ? record.messages : [], // what gets saved (see chats.mjs)
      expired: record ? record.expired : false, // Claude Code no longer has it: read-only
      unread: false,             // a reply finished while another chat was showing
      recap: null,               // "Continue in a new chat": goes with the first message
      thread: view.newThread(),
      hasMessages: false,
      streaming: false,
      turn: null,                // the reply being written (see send)
      pendingApprovals: new Set(),
      sentPages: new Set(),      // page URLs Claude already has
      lastSentSelection: "",     // so the same selection isn't re-sent every message
      tainted: record ? record.tainted : false,             // web content or files have entered this chat
      toolsUnlocked: record ? record.toolsUnlocked : false, // ...and the user turned the tools back on anyway
      skillAccess: new Set(),    // other skills read_skill may read (from the skills run in this chat, never saved)
      madeSkills: new Map(),     // skills create_skill made in this chat: name → file (may be updated; never saved)
      skillCards: new Set(),     // "New skill" cards waiting for the user
      allowedSites: new Set(),   // sites where browser actions don't ask (this chat only, never saved)
      allowAll: false,           // "Allow all actions": no browser action asks (this chat only, never saved)
      allowAllNoted: false,      // ...and Claude has been told so
      // The AI's browser state (not a delegated agent): acting now, one-shot
      // permissions, what it last saw of each tab, and its latest screenshot of
      // each (points refer to it); tabs: the tabs it has worked in during this
      // chat (going back needs no card)
      browser: newBrowserState(),
      longChat: { hint: null, shownAt: 0 },
      lastUsed: now,             // for stopping idle Claude Code processes
      session: null,
    };
    chat.session = createProviderSession(chat.provider, sessionHandlers(chat));
    chat.session.setModel(record ? record.model : prefs.get(providerModelPref(chat.provider), "default") || "default");
    chat.session.setEffort(composer.effort());
    if (record) {
      chat.session.sessionId = record.sessionId;
      chat.session.tainted = chat.tainted && !chat.toolsUnlocked;
      if (chat.messages.length) view.renderSavedChat(chat);
    }
    chat.actor = chatActor(chat);
    loadedChats.add(chat);
    return chat;
  }

  // The chat's own AI as a browser actor (see the top of this file)
  function chatActor(chat) {
    const actor = {
      kind: "chat", chat, from: "", scope: "this chat",
      get browser() { return chat.browser; },
      get pending() { return chat.pendingApprovals; },
      get allowedSites() { return chat.allowedSites; },
      get allowAll() { return chat.allowAll; },
      setAllowAll(on) {
        chat.allowAll = on;
        chat.allowAllNoted = false;
        if (chat === active) shield.refresh();
      },
      get secretAccess() { return !!chat.secretAccess; },
      live: () => !!chat.turn,
      token: () => chat.turn,
      tab: () => chat.turn && chat.turn.agentTab,
      setTab(tab) { if (chat.turn) chat.turn.agentTab = tab; },
      startTab: () => chat.turn && chat.turn.startTab,
      name: () => aiName(chat),
      overlayName: () => aiName(chat),
      line: (kind, text, code) => view.addToolLine(chat, kind, text, code),
      status: (text) => view.setTurnStatus(chat, text),
      clearStatus: () => view.clearTurnStatus(chat),
      place(el, block) { view.appendToTurn(chat, el); if (block) view.recordBlock(chat, block); },
      answered(block, allowed) { if (allowed && chat.turn) view.setTurnStatus(chat, "Working…"); },
      highlight: (rect, sticky) => overlay.highlight(actor, rect, sticky),
      unread() { if (chat !== active) history.markUnread(chat); }, // waiting on the user in a chat they can't see
      taint: () => markTainted(chat),
      stop: () => stopTurn(chat),
    };
    return actor;
  }

  // Chats with a thread in this window: each Space's current chat, plus any
  // still replying
  const loadedChats = new Set();

  const spaceChat = new Map(); // spaceId → the chat last shown in that Space

  function liveChats() {
    return [...loadedChats];
  }

  let active = makeChat();

  composer.setModelValue(active.session.model);

  spaceChat.set(active.spaceId, active);

  // Show another chat in the panel (its thread, shield, send button, model)
  function showChat(chat) {
    if (chat === active) return;
    const old = active;
    // Where you were in the old chat (null: at the bottom, so new replies stay in view)
    old.scrollTop = view.nearBottom(old) ? null : old.thread.scrollTop;
    active = chat;
    spaceChat.set(chat.spaceId, chat);
    if (old.thread.isConnected) old.thread.replaceWith(chat.thread);
    chat.thread.scrollTop = chat.scrollTop == null ? chat.thread.scrollHeight : chat.scrollTop;
    chat.unread = false;
    chat.lastUsed = Date.now();
    chat.session.setEffort(composer.effort());
    composer.setModelValue(chat.session.model);
    composer.renderModels();
    composer.updateModelButton();
    composer.updateSendButton();
    shield.update();
    composer.updateReadOnly();
    composer.showUsage();
  }

  // The chat as the store keeps it (only once something was said)
  function saveChat(chat) {
    if (!chat.messages.length) return;
    store.save({
      id: chat.id,
      provider: chat.provider,
      sessionId: chat.session.sessionId,
      spaceId: chat.spaceId,
      title: chat.title,
      created: chat.created,
      updated: chat.updated,
      model: chat.session.model,
      tainted: chat.tainted,
      toolsUnlocked: chat.toolsUnlocked,
      expired: chat.expired,
      messages: chat.messages,
    });
  }

  // Start Claude Code as soon as the chat opens, so the first reply doesn't
  // wait for it to boot. Guess whether the next message brings web content
  // (that decides which tools it starts with); a wrong guess just restarts it.
  function prewarm(chat = active) {
    const session = chat.session;
    if (session.proc || session.starting || chat.streaming || chat.expired) return;
    let webContent = chat.tainted || composer.webContentPending();
    try { webContent = webContent || composer.pageWillBeSent(chat) || composer.selectionWillBeSent(chat); } catch (e) {}
    session.setTainted(webContent && !chat.toolsUnlocked);
    session.ensureStarted().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Shield: web content or files are in this chat, so the built-in tools are
  // off. Click it to turn them back on for this chat (or off again).
  // -------------------------------------------------------------------------
  function toolsLocked(chat) {
    return chat.tainted && !chat.toolsUnlocked;
  }

  function markTainted(chat) {
    if (chat.tainted) return;
    chat.tainted = true;
    if (chat === active) shield.update();
    saveChat(chat);
  }

  function setToolsUnlocked(unlocked) {
    active.toolsUnlocked = unlocked;
    active.session.setTainted(toolsLocked(active)); // takes effect from the next message
    saveChat(active);
    shield.close();
    shield.update();
    flash(unlocked ? "Tools are on for this chat" : "Tools are off for this chat");
    composer.focus();
  }

  function setStreaming(chat, streaming) {
    chat.streaming = streaming;
    if (chat === active) composer.updateSendButton();
  }

  // The reply is over (done, failed or stopped): add it to the saved chat.
  // after: blocks that go after its text (update cards)
  function saveTurn(chat, lastBlock, after = []) {
    const t = chat.turn;
    if (!t || !t.saved) return; // the message itself never went out
    const blocks = t.blocks.filter((b) => !b.pending);
    if (t.seg && t.text.trim()) blocks.push({ type: "text", text: t.text });
    if (lastBlock) blocks.push(lastBlock);
    blocks.push(...after);
    chat.messages.push({ role: "assistant", ts: Date.now(), blocks });
    chat.updated = Date.now();
    saveChat(chat);
  }

  // What the reply cost, under it (several steps, agents or a summary only):
  // the saved block, or none
  function showStats(chat) {
    const t = chat.turn;
    if (!t || !t.stats) return [];
    const sum = statsSummary(t.stats);
    if (!statsWorthShowing(sum)) return [];
    view.addStats(chat, sum);
    return [sum];
  }

  function finishTurn(chat) {
    agents.cancelTurn(chat); // (none should be left: the reply waits for them)
    chat.lastUsed = Date.now();
    endWatchAllowAll(chat);
    setTimeout(trimProcesses, 0);
    if (chat.turn) {
      view.renderTurn(chat);
      view.clearTurnStatus(chat);
      const stats = showStats(chat);
      view.addReplyActions(chat.turn);
      saveTurn(chat, null, [...stats, ...view.offerUpdates(chat)]);
    }
    if (chat !== active && chat.turn) history.markUnread(chat);
    chat.turn = null;
    overlay.show(chat.actor, false);
    setStreaming(chat, false);
  }

  function failTurn(chat, message) {
    agents.cancelTurn(chat);
    chat.lastUsed = Date.now();
    approvals.denyAll(chat.actor);
    cancelSkillCards(chat);
    endWatchAllowAll(chat);
    if (chat.turn) {
      view.renderTurn(chat);
      view.clearTurnStatus(chat);
      view.addError(chat, view.friendlyError(message, chat));
      const stats = showStats(chat);
      view.addReplyActions(chat.turn);
      saveTurn(chat, { type: "error", text: view.friendlyError(message, chat) }, stats);
      view.scrollToBottom(chat);
      if (chat !== active) history.markUnread(chat);
    }
    chat.turn = null;
    overlay.show(chat.actor, false);
    setStreaming(chat, false);
  }

  function updateContext(chat) {
    return {
      aiName: aiName(chat),
      save: () => saveChat(chat),
      models: () => composer.claudeModels(),
      noteUsage: (info) => composer.noteUsage(info),
      scroll: () => { if (view.nearBottom(chat)) view.scrollToBottom(chat); },
    };
  }

  // What a chat's Claude Code process tells us goes into that chat, whether
  // or not it's the one showing
  function sessionHandlers(chat) {
    return {
      onText(text) {
        const turn = chat.turn;
        if (!turn) return;
        view.clearTurnStatus(chat);
        view.ensureSegment(chat);
        turn.text += text;
        turn.anyText = true;
        view.queueRender(chat);
      },
      onAssistantMessage(msg) {
        // Fallback in case streaming deltas didn't arrive
        const turn = chat.turn;
        if (!turn || turn.anyText) return;
        const blocks = (msg.message && msg.message.content) || [];
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (text) {
          view.clearTurnStatus(chat);
          view.ensureSegment(chat);
          turn.text = text;
          turn.anyText = true;
          view.queueRender(chat);
        }
      },
      onStatus(text) {
        if (chat.turn) view.setTurnStatus(chat, text);
      },
      onDone(msg) {
        const turn = chat.turn;
        if (!turn) return;
        const failed = msg.is_error || (msg.subtype && msg.subtype !== "success");
        if (failed) {
          const why = msg.result || (Array.isArray(msg.errors) && msg.errors.join("\n")) || msg.subtype || `${aiName(chat)} couldn't answer.`;
          if (SESSION_GONE.test(why)) chatGone(chat);
          else failTurn(chat, why);
          return;
        }
        if (!turn.anyText && msg.result) {
          view.ensureSegment(chat);
          turn.text = msg.result;
        }
        // Its agents are still working (or it didn't collect their results):
        // the reply stays open and continues once they're done
        if (agents.holdTurn(chat)) return;
        finishTurn(chat);
        view.noteChatSize(chat, turn, msg);
      },
      onError(text) {
        if (SESSION_GONE.test(text)) chatGone(chat);
        else failTurn(chat, text);
      },
      // --resume failed: Claude Code has deleted this chat's transcript
      onSessionGone() {
        chatGone(chat);
      },
      // Claude Code wants to use a tool: our file tools go straight through,
      // everything else needs your click (and is refused once web content is in the chat)
      async onPermission(req, sessionTainted) {
        const name = req.tool_name || "";
        if (name.startsWith(`mcp__${ZEN_SERVER}__`)) {
          const tool = name.slice(`mcp__${ZEN_SERVER}__`.length);
          // Agent tools: only while a skill that allows them runs (each call is checked again)
          if (AGENT_TOOL_NAMES.has(tool)) return agents.parentPermission(chat, req.input);
          if (!BROWSER_TOOL_NAMES.has(tool)) return { behavior: "allow", updatedInput: req.input };
          try {
            return await browser.permission(chat.actor, tool, req.input);
          } catch (e) {
            return { behavior: "deny", message: `Couldn't check that action: ${(e && e.message) || e}` };
          }
        }
        if (sessionTainted || toolsLocked(chat)) {
          return { behavior: "deny", message: "Not available right now: this chat has web content or attached files in it, so commands, file access and web tools are off. The user can turn them back on with the shield button at the top of the chat, or start a new chat." };
        }
        if (!chat.turn) return { behavior: "deny", message: "The user stopped this reply." };
        const allowed = await approvals.ask(chat.actor, name, req.input);
        return allowed
          ? { behavior: "allow", updatedInput: req.input }
          : { behavior: "deny", message: "The user denied this. Don't retry it; continue without it or ask the user what they'd like." };
      },
      onInit(info) {
        onProviderInit(chat, info);
      },
      onRateLimit(info) {
        composer.noteUsage(info);
      },
      // Claude Code summarized the chat to make room: earlier page reads are gone
      onCompact() {
        browser.forgetPages(chat.actor);
        if (!chat.turn) return;
        noteCompact(chat.turn.stats);
        view.addToolLine(chat, "ok", "Summarized the earlier steps to keep this chat light (pages are read again as needed)");
      },
      // What each request cost: counted for the reply, with a warning once its history gets big
      onUsage(u) {
        if (!chat.turn) return;
        noteRequest(chat.turn.stats, u);
        const warning = statsWarning(chat.turn.stats);
        if (warning) view.addToolLine(chat, "warn", warning);
      },
      // Our in-mod tools (save_file, create_docx/pdf/xlsx/notebook, browser_*)
      onMcpMessage(serverName, message) {
        if (serverName !== ZEN_SERVER) {
          return { jsonrpc: "2.0", id: message.id == null ? 0 : message.id, error: { code: -32601, message: "Unknown server" } };
        }
        const counted = (res) => {
          const content = (res && res.result && res.result.content) || [];
          if (message.method === "tools/call" && chat.turn) noteTool(chat.turn.stats, content.filter((c) => c && c.type === "image").length);
          return res;
        };
        return Promise.resolve(handleZenMcp(message, {
          onFile: (file) => {
            view.addFile(chat, file);
            view.recordBlock(chat, { type: "file", name: file.name, path: file.path, size: file.size });
          },
          browserTool: (name, args) => browser.run(chat.actor, name, args),
          readSkill: (name) => readSkillFor(chat, name),
          agents: (name, args) => agents.parentTool(chat, name, args),
          agentTools: !!chat.session.agentTools,
          images: chat.browser.images,
          files: chat.browser.files,
          createSkill: (args) => createSkillFor(chat, args),
          watchPage: (args) => watchPageFor(chat, args),
        })).then(counted);
      },
    };
  }

  // create_skill: a "New skill" card filled in with the AI's suggestions; the
  // user changes what they like and creates it or cancels. The header is
  // built from the card, never from the AI's text.
  async function createSkillFor(chat, args) {
    if (!chat.turn) throw new Error("The user stopped this reply.");
    const a = args || {};
    const instructions = cleanSkillBody(a.instructions);
    const { all, dataFiles } = await skillLists();
    const list = (x) => (Array.isArray(x) ? x.map((i) => String(i).trim()) : []);
    const canUse = (u) => u === "secrets" || (u.startsWith("/") ? all.some((s) => s.name === u.slice(1)) : dataFiles.includes(u));
    const folder = folderParts(a.folder);
    const suggested = {
      name: skillSlug(a.name) || "new-skill",
      description: String(a.description || "").replace(/\s+/g, " ").trim().slice(0, 300),
      folder: folder ? folder.join(" / ") : "",
      sees: list(a.sees).filter((c) => ["page", "selection", "screenshot"].includes(c)),
      uses: list(a.uses).map((u) => (u.startsWith("/") ? "/" + skillSlug(u) : u.toLowerCase().replace(/^_/, "").replace(/\.md$/, ""))).filter(canUse),
      lessons: a.lessons === true,
      agents: [1, 2].includes(Number(a.agents)) ? Number(a.agents) : 0,
      instructions,
    };
    // An update stays where the skill is, unless the user moves it on the card
    const made = chat.madeSkills.get(suggested.name);
    if (made) suggested.folder = made.split("/").slice(0, -1).join(" / ");
    const out = await skillCardFlow(chat, suggested, aiName(chat));
    if (!out) return "The user cancelled: no skill was saved. If it isn't clear why, ask what they'd like changed.";
    const { v, rel, replacing } = out;
    // Tell the AI what the user changed on the card
    const say = (k, x) => (k === "sees" || k === "uses" ? (x.length ? x.join(", ") : "nothing") : k === "lessons" ? (x ? "on" : "off") : k === "folder" ? x || "top" : String(x));
    const changes = ["name", "description", "folder", "sees", "uses", "lessons", "agents"]
      .filter((k) => JSON.stringify(v[k]) !== JSON.stringify(suggested[k]))
      .map((k) => `${k} → ${say(k, v[k])}`);
    if (v.instructions.trim() !== instructions) changes.push("edited the instructions");
    return `${replacing ? "Updated" : "Created"} /${v.name} (${rel} in the skills folder). ` +
      `Settings: sees ${say("sees", v.sees)}; uses ${say("uses", v.uses)}; lessons ${say("lessons", v.lessons)}; agents ${v.agents}.` +
      (changes.length ? ` The user changed: ${changes.join("; ")}.` : " The user kept your suggestions.");
  }

  async function skillLists() {
    const all = await loadSkills();
    return { all, dataFiles: await listDataFiles(), folders: [...new Set(all.map((s) => s.folder).filter(Boolean))].sort() };
  }

  // Shows the card (in the reply, or on its own for a blank one), waits, and
  // saves what the user confirmed. → { v, rel, replacing } or null (cancelled)
  async function skillCardFlow(chat, values, by) {
    const { all, dataFiles, folders } = await skillLists();
    const replacing = chat.madeSkills.has(values.name) ? values.name : "";
    const check = (v) => {
      if (!v.name) return "Give it a name.";
      if (v.name === "create-skill") return "/create-skill is built in. Pick another name.";
      const other = all.find((s) => s.name === v.name);
      if (other && chat.madeSkills.get(v.name) !== other.file) return `There's already a /${v.name} skill (${other.file}).`;
      if (!v.description.trim()) return "Give it a one-line description.";
      try { cleanSkillBody(v.instructions); } catch (e) { return e.message === "instructions are empty." ? "Write its instructions." : e.message; }
      return "";
    };
    const card = skillCard({ values, folders, skills: all.map((s) => s.name), dataFiles, agentsOn: agentsOn(), by, replacing, check });
    chat.skillCards.add(card);
    view.appendToTurn(chat, card.el);
    if (!by) card.focus();
    let choice;
    try {
      choice = await card.result;
    } finally {
      chat.skillCards.delete(card);
    }
    if (!choice.create) return null;
    const v = choice.values;
    const text = skillFileText(v, cleanSkillBody(v.instructions));
    let saved;
    try {
      saved = await saveNewSkill(v.folder, v.name, text, { replace: chat.madeSkills.get(v.name) || "" });
    } catch (e) {
      card.saved(`Couldn't save: ${(e && e.message) || e}`);
      throw e;
    }
    chat.madeSkills.set(v.name, saved.rel);
    card.saved(`Saved. Type /${v.name} to run it.`);
    const file = { name: `${v.name}.md`, path: saved.path, size: new TextEncoder().encode(text).length, kind: `Skill · /${v.name}` };
    view.addFile(chat, file);
    view.recordBlock(chat, { type: "file", ...file });
    return { v, rel: saved.rel, replacing };
  }

  // /create-skill sent with nothing to say: a blank card, no AI request
  async function blankSkillCard(chat) {
    if (!chat.hasMessages) {
      chat.thread.replaceChildren();
      chat.hasMessages = true;
    }
    try {
      await skillCardFlow(chat, { name: "", description: "", folder: "", sees: [], uses: [], lessons: false, agents: 0, instructions: "" }, "");
    } catch (e) {
      flash(`Couldn't save the skill: ${(e && e.message) || e}`);
    }
  }

  // watch_page: a "Watch this page?" card; Zen does the watching (watch-host.mjs)
  async function watchPageFor(chat, a) {
    if (!chat.turn) throw new Error("The user stopped this reply.");
    if (isPrivateWindow()) throw new Error("Watches can't be set in a private window (nothing from it is kept).");
    const host = watchHost();
    const lead = host && host.leader();
    if (!lead) throw new Error("Watches aren't available right now.");
    const tab = chat.actor.tab();
    const b = tab && tab.linkedBrowser;
    const info = b ? browserInfo(b) : null;
    if (!info || !/^https?:/i.test(info.url)) throw new Error("Open the page to watch first (browser_navigate or browser_switch_tab), then call watch_page.");
    const until = watchCondition(a);
    const reload = a.reload !== false;
    const minPref = prefs.get("watchMinMinutes", "");
    const every = watchEvery(reload, a.every_minutes, minPref !== "" && Number.isFinite(Number(minPref)) ? Number(minPref) : null);
    // Already so: nothing to watch
    const now = await watchTab(b, until).catch(() => null);
    if (conditionMet(until, now)) return `That's already the case on this page (${describeCondition(until)}), so there's nothing to watch.${a.then ? " Do what the user asked now." : ""}`;
    const w = newWatch({
      chatId: chat.id, spaceId: tab.getAttribute("zen-workspace-id") || chat.spaceId, url: info.url,
      title: sanitizeUntrusted(info.title || "").slice(0, 120), until, reload, every, then: a.then, what: a.what,
    });
    const card = watchCard(w, aiName(chat));
    chat.skillCards.add(card);
    view.appendToTurn(chat, card.el);
    let choice;
    try {
      choice = await card.result;
    } finally {
      chat.skillCards.delete(card);
    }
    if (!choice.start) return "The user didn't start the watch.";
    w.allowAll = choice.allowAll; // only ever from the user's tick
    await lead.add(w);
    let site = info.url;
    try { site = new URL(info.url).host.replace(/^www\./, ""); } catch (e) {}
    view.addToolLine(chat, "ok", `Watching ${site}: ${describeCondition(until)} (${everyText(w)})`);
    return `Watching. Zen checks the page ${everyText(w)} by itself and tells the user when ${describeCondition(until)}.` +
      (w.then ? ` When it happens, you'll get a message in this chat to do what they asked${w.allowAll ? " (the user allowed all your actions for that run, so they won't be asked; it ends with that reply)" : ""}.` : "") +
      " Don't wait for it: finish your reply now (say it's being watched; the eye button at the top of the chat lists watches).";
  }

  // A watch with something to do fired: its chat (reopened if needed, or a
  // new one in its Space when it's gone) gets the message. → the chat, or null
  // allowAll: the user ticked "without asking" on the card: Allow all for
  // this one reply (unless the chat had it already), off again when it ends
  async function wakeForWatch({ chatId, spaceId, text, display, tab, allowAll = false }) {
    let chat = liveChats().find((c) => c.id === chatId);
    if (!chat && chatId) {
      const record = await store.read(chatId).catch(() => null);
      if (record) {
        chat = makeChat({ record });
        await checkExpired(chat);
      }
    }
    if (!chat || chat.expired) chat = makeChat({ spaceId: spaceId || currentSpaceId() });
    for (let i = 0; chat.streaming && i < 120; i++) await new Promise((r) => setTimeout(r, 5000));
    if (chat.streaming) return null;
    const once = allowAll && !chat.allowAll;
    if (once) {
      browser.setAllowAll(chat.actor, true);
      chat.allowAllOnce = true; // the note to the AI says it's for this reply
    }
    const ok = await sendAutomatic(chat, { text, display, label: "watch", tab });
    if (once) {
      if (ok && chat.turn) chat.turn.watchAllowAll = true;
      else endWatchAllowAll(chat, true);
    }
    if (chat !== active) history.markUnread(chat);
    return ok ? chat : null;
  }

  // The reply a watch allowed all actions for is over: ask again
  function endWatchAllowAll(chat, force = false) {
    if (!force && !(chat.turn && chat.turn.watchAllowAll)) return;
    chat.allowAllOnce = false;
    browser.setAllowAll(chat.actor, false);
  }

  // A line in a chat that's open in this window (a watch that only tells)
  function noteInChat(chatId, kind, text) {
    const chat = liveChats().find((c) => c.id === chatId);
    if (!chat) return;
    view.addToolLine(chat, kind, text);
    if (chat !== active) history.markUnread(chat);
  }

  function cancelSkillCards(chat) {
    for (const card of chat.skillCards) card.cancel();
    chat.skillCards.clear();
  }

  // read_skill: only skills the skill that ran lists under access:. The
  // other skill's own access: and context don't come with it.
  async function readSkillFor(chat, raw) {
    const name = raw.trim().replace(/^\//, "").toLowerCase();
    if (!chat.turn) throw new Error("The user stopped this reply.");
    if (!chat.skillAccess.has(name)) throw new Error(`/${name} isn't available here: only skills listed under access: of the skill the user ran can be read.`);
    const skill = (await loadSkills()).find((s) => s.name === name);
    if (!skill) throw new Error(`There's no /${name} skill any more.`);
    view.addToolLine(chat, "ok", `Read the /${name} skill`);
    const cut = skill.body.length > MAX_SKILL_READ_CHARS;
    return `<skill name="${attr(name)}" note="Read for reference: use what helps with the skill the user ran.">\n${cut ? skill.body.slice(0, MAX_SKILL_READ_CHARS) : skill.body}\n</skill>`;
  }

  function stopTurn(chat = active) {
    agents.cancelTurn(chat); // its agents stop first, so their boxes are saved as stopped
    approvals.denyAll(chat.actor);
    cancelSkillCards(chat);
    endWatchAllowAll(chat);
    chat.session.stop();
    browser.forgetPages(chat.actor); // a stopped step may never have reached Claude
    if (chat.turn) {
      view.renderTurn(chat);
      view.clearTurnStatus(chat);
      view.addStatus(chat, "Stopped.");
      const stats = showStats(chat);
      view.addReplyActions(chat.turn);
      saveTurn(chat, { type: "status", text: "Stopped." }, stats);
    }
    chat.turn = null;
    overlay.show(chat.actor, false);
    setStreaming(chat, false);
  }

  async function send() {
    // The message belongs to the chat it was typed in, even if another one
    // is showing by the time the reply comes back
    const chat = active;
    if (chat.streaming) {
      stopTurn(chat);
      return;
    }
    if (chat.expired) return; // read-only: "Continue in a new chat" instead
    chat.lastUsed = Date.now();
    const text = composer.text();
    const next = composer.next();
    const skill = next.skill;
    const attachments = next.attachments;
    if (!text && !skill && !attachments.length && !next.tabs.length) return;
    if (skill && skill.builtin && !text && !attachments.length && !next.tabs.length) {
      composer.resetNextMessage();
      blankSkillCard(chat);
      return;
    }
    if (skill && skill.context.includes("selection")) {
      await composer.refreshSelection();
      if (!composer.selection()) {
        flash("Select some text on the page first");
        return;
      }
    }
    popovers.closeOthers();
    composer.takeText();
    let agentTabNow = null;
    try { agentTabNow = gBrowser.selectedTab; } catch (e) {}
    await startTurn(chat, {
      text, skill, attachments, agentTab: agentTabNow,
      io: {
        tabs: next.tabs,
        selection: composer.selection,
        refreshSelection: composer.refreshSelection,
        pageWillBeSent: composer.pageWillBeSent,
        selectionWillBeSent: composer.selectionWillBeSent,
      },
      onFailed: () => composer.restoreText(text), // so it isn't lost
      onSent: () => composer.resetNextMessage(attachments),
    });
  }

  // A message that didn't come from the message box: a watch firing (see
  // watch-host.mjs). Shown short (display), sent in full; works in a chat
  // that isn't showing; tab: where the AI works.
  async function sendAutomatic(chat, { text, display, label, tab }) {
    await startTurn(chat, {
      text, display, label, skill: null, attachments: [], agentTab: tab,
      io: { tabs: [], selection: () => "", refreshSelection: async () => {}, pageWillBeSent: () => false, selectionWillBeSent: () => false },
    });
    return !!chat.turn;
  }

  // The turn itself: the message in the thread, the context read, sent
  async function startTurn(chat, { text, display = text, label = "", skill, attachments, agentTab, io, onFailed = () => {}, onSent = () => {} }) {
    if (!chat.hasMessages) {
      chat.thread.replaceChildren();
      chat.hasMessages = true;
    }
    // Show the message right away; its chips and images fill in once the context is read
    const userMessage = view.makeUserMessage(display, (skill && skill.name) || label);
    const el = view.appendExchange(chat, userMessage.el);
    const agentTabNow = agentTab || null;
    chat.turn = { id: newTurnId(), el, seg: null, text: "", parts: [], blocks: [], saved: false, anyText: false, statusEl: null, renderQueued: false, agentTab: agentTabNow, startTab: agentTabNow, skill };
    // Helper agents: only for a skill that allows them (agents: N), and only
    // if they're on in the settings. Untrusted text can't turn them on.
    const turn = chat.turn;
    turn.stats = newTurnStats();
    turn.agents = skill && skill.agents > 0 && agentsOn() ? skill.agents : 0;
    if (skill && skill.agents > 0 && !turn.agents) turn.agentsWhyNot = "Agents are turned off in Zen AI's settings, so this skill runs without them.";
    // The agent tools are listed from now on in this chat's session (a restart with --resume if it's running)
    if (turn.agents) chat.session.setAgentTools(true);
    if (agentTabNow) chat.browser.tabs.add(agentTabNow);
    view.setTurnStatus(chat, attachments.some((a) => a.loading) ? "Reading files…" : "Reading…");
    setStreaming(chat, true);
    view.scrollToBottom(chat);

    let message;
    try {
      message = await buildMessage(chat, text, skill, attachments, {
        ...io,
        threadThumb: view.threadThumb,
        warn: (line) => view.addToolLine(chat, "warn", line),
        agents: turn.agents,
      });
    } catch (e) {
      failTurn(chat, "Couldn't prepare your message: " + (e && e.message ? e.message : e));
      onFailed();
      return;
    }
    if (!chat.turn || chat.turn.el !== el) return; // stopped while reading

    userMessage.fill(message.chipsForThread, message.mediaForThread);
    // What this message's agents may be given (by id; see message-builder.mjs)
    chat.turn.agentLibrary = message.agentLibrary;
    // Saved: what was typed and the chips' labels (never the page text or images)
    const now = Date.now();
    chat.messages.push({ role: "user", ts: now, text: display, skill: skill ? skill.name : label || undefined, chips: message.chipRecords, media: message.mediaRecords });
    if (!chat.title) {
      const context = message.chipRecords.find((c) => c.label !== "Earlier chat");
      chat.title = chatTitle({ text: display, skill: skill && skill.name, context: (context && context.label) || message.mediaRecords[0] });
    }
    chat.updated = now;
    chat.recap = null;
    chat.turn.saved = true;
    if (message.untrusted) markTainted(chat);
    saveChat(chat);
    chat.session.setTainted(toolsLocked(chat));
    onSent();
    view.setTurnStatus(chat, "Thinking…");
    view.scrollToBottom(chat);

    chat.session.send(message.content).catch((e) => failTurn(chat, e && e.message ? e.message : String(e)));
  }

  // Claude Code no longer has this chat: it becomes read-only
  function chatGone(chat) {
    if (chat.turn) failTurn(chat, `${(providerInfo(chat.provider) || {}).label || "The provider"} no longer has this chat, so it can't continue it.`);
    chat.expired = true;
    chat.session.kill();
    saveChat(chat);
    if (chat === active) composer.updateReadOnly();
  }

  // Before using a reopened chat: is Claude Code's transcript still there?
  async function checkExpired(chat) {
    if (chat.expired || chat.transcriptChecked || !chat.hasMessages) return;
    chat.transcriptChecked = true;
    const sessionId = chat.session.sessionId;
    const exists = sessionId ? await transcriptExists(sessionId, chat.provider) : false;
    if (exists === false && !chat.streaming) chatGone(chat);
  }

  // A new chat that starts with a recap of the expired one (sent only with
  // the first message, and only because the user asked for it)
  function continueInNewChat() {
    const old = active;
    const chat = makeChat({ spaceId: old.spaceId, provider: old.provider });
    chat.recap = { title: old.title || "Earlier chat", text: chatRecap(old), tainted: old.tainted };
    // The recap may carry what web content said: same safety as the old chat
    chat.tainted = old.tainted;
    chat.toolsUnlocked = old.toolsUnlocked;
    switchTo(chat);
    composer.focus();
  }

  // Leave the shown chat for another one. An empty chat is thrown away; one
  // that's replying keeps going in the background.
  function switchTo(chat) {
    const old = active;
    if (chat === old) return;
    popovers.closeOthers(history.entry);
    showChat(chat);
    // The old chat is saved; unless it's still replying, it can go (reopening
    // it from history reads it back, and asks again before acting on a site)
    if (!old.streaming && old.spaceId === chat.spaceId) dropChat(old);
    if (!chat.hasMessages) view.renderGreeting(chat);
    composer.renderChips();
    composer.updateSend();
    history.updateDot();
  }

  function dropChat(chat) {
    loadedChats.delete(chat);
    if (spaceChat.get(chat.spaceId) === chat) spaceChat.delete(chat.spaceId);
    chat.session.kill();
  }

  function startFreshChat() {
    switchTo(makeChat());
  }

  // Open a saved chat (or one already loaded in this window). A Space only
  // ever opens its own chats.
  async function openChat(id) {
    history.close();
    const space = currentSpaceId();
    let chat = liveChats().find((c) => c.id === id);
    if (!chat) {
      const record = await store.read(id);
      if (!record) {
        flash("That chat couldn't be opened");
        return;
      }
      if (record.spaceId !== space) return;
      chat = liveChats().find((c) => c.id === id) || makeChat({ record });
    }
    if (chat.spaceId !== space) return;
    switchTo(chat);
    if (isOpen()) composer.focus();
    await checkExpired(chat); // before anything can start Claude Code for it
  }

  async function deleteChat(id) {
    const chat = liveChats().find((c) => c.id === id);
    const owner = chat || store.get(id);
    if (!owner || owner.spaceId !== currentSpaceId()) return; // only this Space's chats

    if (chat) {
      if (chat.streaming) stopTurn(chat);
      agents.cancelChat(chat.id);
      loadedChats.delete(chat);
      if (chat === active) {
        showChat(makeChat());
        view.renderGreeting();
        composer.renderChips();
      }
      await chat.session.kill();
    }
    await store.remove(id);
    history.render();
    view.refreshGreeting();
    history.updateDot();
  }

  // Opening the panel: carry on with the Space's last chat if it was used
  // within zenai.resumeMinutes, else a fresh chat (its greeting lists Recent)
  const resumeChecked = new Set(); // Spaces whose last chat was considered already

  async function resumeOrFresh() {
    if (!store.enabled) return;
    await store.ensureLoaded();
    const chat = active;
    const space = currentSpaceId();
    if (chat.streaming || chat.spaceId !== space) return;
    if (chat.hasMessages) {
      if (Date.now() - chat.updated > resumeMinutes() * 60 * 1000) startFreshChat();
      return;
    }
    if (resumeChecked.has(space)) {
      view.refreshGreeting();
      return;
    }
    resumeChecked.add(space);
    const last = chatToResume(store.list(), space, Date.now(), resumeMinutes());
    if (last && active === chat) await openChat(last.id);
    else view.refreshGreeting();
  }

  // -------------------------------------------------------------------------
  // Spaces: one chat per Space. Switching Spaces shows that Space's chat; a
  // reply that's still running carries on into its own chat (and its history
  // row gets a dot). Zen has no switch event, only a listener list (see
  // docs/zen-spaces.md); TabSelect is the backup.
  // -------------------------------------------------------------------------
  async function onSpaceChanged() {
    const space = currentSpaceId();
    const old = active;
    if (space === old.spaceId) return;
    popovers.closeOthers();
    // Tabs attached in the other Space don't come along
    composer.forgetTabs();
    let chat = spaceChat.get(space);
    if (!chat || !loadedChats.has(chat)) chat = makeChat({ spaceId: space });
    showChat(chat);
    // An empty chat isn't worth keeping; one with messages stays as that Space's chat
    if (!old.hasMessages && !old.streaming) dropChat(old);
    if (!chat.hasMessages) view.renderGreeting(chat);
    composer.renderChips();
    composer.updateSend();
    history.updateDot();
    trimProcesses();
    if (isOpen()) {
      composer.refreshSelection();
      await resumeOrFresh();
      prewarm();
    }
  }

  // Zen awaits its listeners mid-switch, so this one returns right away
  const spaceListener = () => { onSpaceChanged().catch((e) => console.warn("[Zen AI] Couldn't switch chats with the Space:", e)); };

  try {
    if (window.gZenWorkspaces && typeof window.gZenWorkspaces.addChangeListeners === "function") {
      window.gZenWorkspaces.addChangeListeners(spaceListener);
    }
    // Started before Zen restored its Spaces: the first chat belongs to the real one
    const ready = window.gZenWorkspaces && window.gZenWorkspaces.promiseInitialized;
    if (ready && typeof ready.then === "function") ready.then(() => {
      if (!active.hasMessages && active.spaceId === NO_SPACE && currentSpaceId() !== NO_SPACE) {
        spaceChat.delete(NO_SPACE);
        active.spaceId = currentSpaceId();
        spaceChat.set(active.spaceId, active);
        view.refreshGreeting();
      }
    });
  } catch (e) {}

  // -------------------------------------------------------------------------
  // Claude Code processes: only chats in use keep one. Idle for 5 minutes →
  // stopped (--resume brings it back), and at most 2 at a time. A chat that's
  // replying is never stopped.
  // -------------------------------------------------------------------------
  const IDLE_PROCESS_MS = 5 * 60 * 1000;

  const MAX_PROCESSES = 2;

  function trimProcesses() {
    const now = Date.now();
    const running = liveChats().filter((c) => c.session.proc && !c.session.starting);
    for (const c of running) {
      if (!c.streaming && now - c.lastUsed > IDLE_PROCESS_MS) c.session.kill();
    }
    // Keep: replying chats, then the one showing, then the most recently used
    const alive = running.filter((c) => c.session.proc).sort((a, b) =>
      (b.streaming - a.streaming) || ((b === active) - (a === active)) || (b.lastUsed - a.lastUsed));
    alive.forEach((c, i) => {
      if (i >= MAX_PROCESSES && !c.streaming) c.session.kill();
    });
  }

  const trimTimer = setInterval(trimProcesses, 60 * 1000);

  function setModel(value, provider = active.provider) {
    const switched = provider !== active.provider;
    const hadMessages = active.messages.length > 0;
    if (switched) {
      // A provider owns its transcript. Never send that transcript ID to another.
      if (active.streaming) stopTurn(active);
      switchTo(makeChat({ spaceId: active.spaceId, provider }));
      prefs.set("provider", provider);
    }
    const changed = value !== composer.model();
    composer.setModelValue(value);
    prefs.set(providerModelPref(provider), value);
    active.session.setModel(value);
    saveChat(active);
    composer.renderModels();
    composer.updateModelButton();
    composer.setMenu(false);
    if (switched && hadMessages) flash(`Started a new ${(providerInfo(provider) || {}).label || provider} chat`);
    else if (changed && active.hasMessages) flash(`${composer.modelLabel()} answers from here on`);
  }

  // Claude Code started: keep its model list (names, default) for the menu
  function onProviderInit(chat, info) {
    const models = Array.isArray(info.models) ? info.models.filter((m) => m && typeof m.value === "string") : [];
    if (!models.length) return;
    const cleaned = models.map((m) => ({ value: m.value, displayName: String(m.displayName || m.value), description: String(m.description || "") }));
    composer.setModels(chat.provider, cleaned);
    prefs.set(providerModelsPref(chat.provider), JSON.stringify(cleaned));
    // A model that's gone from the list (renamed, plan changed) → back to the default
    if (!cleaned.some((m) => m.value === chat.session.model)) {
      chat.session.setModel("default");
      saveChat(chat);
      if (chat === active) composer.setModelValue("default");
    }
    composer.renderModels();
    composer.updateModelButton();
    if (chat === active) composer.updateReadOnly();
  }

  // New chat: the old one stops (if it was replying) and stays in history
  function newChat() {
    const old = active;
    if (old.streaming) stopTurn(old);
    showChat(makeChat());
    dropChat(old);
    popovers.closeOthers();
    shield.update();
    composer.resetNextMessage();
    view.renderGreeting();
    composer.clear();
    composer.focus();
  }

  return {
    active: () => active,
    liveChats,
    send, stopTurn, newChat, switchTo, openChat, wakeForWatch, noteInChat, deleteChat, continueInNewChat, startFreshChat,
    setModel, prewarm, resumeOrFresh, toolsLocked, setToolsUnlocked, updateContext,
    savedAgents: (block) => agents.saved(block),
    markTainted, failTurn, finishTurn,
    // A reply (or an agent's card) needs attention in a chat that isn't showing
    noteUnread(chat) { if (chat !== active) history.markUnread(chat); },
    // "Ask before each action again" (the shield)
    askAgain(chat) {
      browser.setAllowAll(chat.actor, false);
      flash(`${aiName(chat)} will ask before each action again`);
      composer.focus();
    },
    // The shown chat's Space isn't the window's any more (TabSelect backup)
    checkSpace() { if (currentSpaceId() !== active.spaceId) spaceListener(); },
    setEffort(level) { active.session.setEffort(level); },
    liveActors: () => [...liveChats().map((c) => c.actor), ...agents.liveActors()],
    dispose() {
      agents.dispose();
      clearInterval(trimTimer);
      for (const chat of liveChats()) chat.session.kill();
      store.flush();
      try { window.gZenWorkspaces.removeChangeListeners(spaceListener); } catch (e) {}
    },
  };
}
