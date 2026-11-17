import { prefs } from "./config.mjs";
import { outputDir } from "./files.mjs";
import { aiName, chatProvider } from "./providers.mjs";

// ---------------------------------------------------------------------------
// Chat history: what the user saw, one small JSON file per chat
// ---------------------------------------------------------------------------
// A chat has two halves. Claude's memory is Claude Code's own transcript
// (--resume <sessionId>). What the panel shows is ours:
//   <profile>/zen-ai/chats/<chatId>.json   the visible conversation
//   <profile>/zen-ai/chats/index.json      one row per chat, for the history list
// Never saved: page text, tab text, file contents, images (an image is kept as
// its label only), and the sites the user allowed (a reopened chat asks again).
// No DOM in here, so it's unit-testable (test/unit/chats.test.mjs).

export const CHAT_FORMAT = 1;
export const RESUME_MINUTES = 60;      // about:config → zenai.resumeMinutes
export const RECENT_ROWS = 3;          // "Recent in <Space>" on the greeting
export const CHAT_TITLE_CHARS = 60;
export const CHAT_SAVE_DELAY_MS = 300; // writes are debounced
export const NO_SPACE = "default";     // no Zen Spaces: one list per window
const CHAT_ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export function chatsDir() {
  return PathUtils.join(PathUtils.profileDir, "zen-ai", "chats");
}

export function newChatId(now = Date.now()) {
  return now.toString(36) + "-" + Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

export function resumeMinutes() {
  const n = parseInt(prefs.get("resumeMinutes", String(RESUME_MINUTES)), 10);
  return Number.isFinite(n) && n >= 0 ? n : RESUME_MINUTES;
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function clipText(text, max) {
  const t = oneLine(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "") + "…";
}

// The first message names the chat (no AI call: it would cost usage).
// text: what the user typed; skill: its name; context: the first chip's label
export function chatTitle({ text, skill, context } = {}) {
  const typed = oneLine(text);
  if (skill) {
    const name = skill.charAt(0).toUpperCase() + skill.slice(1);
    if (typed) return clipText(`${name}: ${typed}`, CHAT_TITLE_CHARS);
    return clipText(context ? `${name} · ${context}` : name, CHAT_TITLE_CHARS);
  }
  if (typed) return clipText(typed, CHAT_TITLE_CHARS);
  return clipText(context || "New chat", CHAT_TITLE_CHARS);
}

// One index row, checked field by field (a hand-edited or half-written file
// must never break the panel)
export function cleanEntry(raw) {
  if (!raw || typeof raw !== "object" || !CHAT_ID_RE.test(String(raw.id || ""))) return null;
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const created = num(raw.created);
  const updated = num(raw.updated) || created;
  if (!updated) return null;
  return {
    id: raw.id,
    provider: chatProvider(raw.provider),
    sessionId: SESSION_ID_RE.test(String(raw.sessionId || "")) ? raw.sessionId : null,
    spaceId: typeof raw.spaceId === "string" && raw.spaceId ? raw.spaceId : NO_SPACE,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.slice(0, 200) : "Untitled chat",
    created: created || updated,
    updated,
    model: typeof raw.model === "string" && raw.model ? raw.model.slice(0, 80) : "default",
    tainted: raw.tainted === true,
    toolsUnlocked: raw.toolsUnlocked === true,
    expired: raw.expired === true,
  };
}

export function entryOf(chat) {
  return cleanEntry({
    id: chat.id, provider: chat.provider, sessionId: chat.sessionId, spaceId: chat.spaceId, title: chat.title,
    created: chat.created, updated: chat.updated, model: chat.model,
    tainted: chat.tainted, toolsUnlocked: chat.toolsUnlocked, expired: chat.expired,
  });
}

const str = (v, max = 100000) => (typeof v === "string" ? v.slice(0, max) : "");
const LINE_KINDS = new Set(["ok", "warn", "denied"]);

function cleanBlock(b) {
  if (!b || typeof b !== "object") return null;
  switch (b.type) {
    case "text": return str(b.text) ? { type: "text", text: str(b.text) } : null;
    case "line": return { type: "line", kind: LINE_KINDS.has(b.kind) ? b.kind : "ok", text: str(b.text, 2000), code: str(b.code, 400) || undefined };
    case "file": return str(b.path, 4000) ? { type: "file", name: str(b.name, 400), path: str(b.path, 4000), size: Number(b.size) || 0, ...(b.kind ? { kind: str(b.kind, 80) } : {}) } : null;
    case "error": return { type: "error", text: str(b.text, 4000) };
    case "status": return { type: "status", text: str(b.text, 200) };
    // A skill-update card (skill-updates.mjs): the run's Lessons / New info
    // text (part of the reply anyway) and what became of it. Never file contents.
    case "update": {
      if (!["lessons", "info"].includes(b.kind) || !str(b.file, 300) || !str(b.skill, 80)) return null;
      const state = ["offered", "skipped", "saved", "undone", "nochange"].includes(b.state) ? b.state : "offered";
      return {
        type: "update", kind: b.kind, skill: str(b.skill, 80), from: str(b.from, 80) || undefined, file: str(b.file, 300), run: str(b.run, 200), text: str(b.text, 20000), state,
        savedFile: str(b.savedFile, 300) || undefined, backup: str(b.backup, 300) || undefined, hash: str(b.hash, 40) || undefined,
        summary: Array.isArray(b.summary) ? b.summary.filter((x) => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 400)) : undefined,
        count: Number(b.count) || undefined,
      };
    }
    // Helper agents of a reply (agent-host.mjs): their labels, state, a bounded
    // result or error and the files they saved. Never their instructions,
    // context, approvals or transcripts. One still running when it was saved
    // (Zen quit) comes back as interrupted: nothing restarts by itself.
    case "agents": {
      const runs = Array.isArray(b.runs) ? b.runs.slice(0, 12).map(cleanAgentRun).filter(Boolean) : [];
      return runs.length ? { type: "agents", runs } : null;
    }
    // What the reply cost (turn-stats.mjs): numbers only
    case "stats": {
      const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
      const out = { type: "stats" };
      for (const k of ["requests", "peak", "reread", "written", "fresh", "output", "tools", "images", "compacts", "agentRequests", "agentReread", "seconds"]) out[k] = n(b[k]);
      return out;
    }
    default: return null;
  }
}

const AGENT_SAVED_STATES = new Set(["done", "failed", "stopped", "interrupted"]);
export const AGENT_SAVED_RESULT_CHARS = 4000;
function cleanAgentRun(r) {
  if (!r || typeof r !== "object" || !str(r.title, 80).trim()) return null;
  const files = Array.isArray(r.files)
    ? r.files.filter((f) => f && str(f.path, 4000)).slice(0, 20).map((f) => ({ name: str(f.name, 400), path: str(f.path, 4000), size: Number(f.size) || 0 }))
    : [];
  return {
    title: str(r.title, 80),
    provider: str(r.provider, 40) || undefined,
    model: str(r.model, 80) || undefined,
    state: AGENT_SAVED_STATES.has(r.state) ? r.state : "interrupted",
    result: str(r.result, AGENT_SAVED_RESULT_CHARS) || undefined,
    error: str(r.error, 400) || undefined,
    files,
  };
}

function cleanMessage(m) {
  if (!m || typeof m !== "object") return null;
  const ts = Number.isFinite(m.ts) ? m.ts : 0;
  if (m.role === "user") {
    const chips = Array.isArray(m.chips) ? m.chips.filter((c) => c && typeof c.label === "string").map((c) => ({ label: str(c.label, 200), icon: str(c.icon, 20) || "doc" })) : [];
    const media = Array.isArray(m.media) ? m.media.filter((x) => typeof x === "string").map((x) => x.slice(0, 200)) : [];
    return { role: "user", ts, text: str(m.text), skill: str(m.skill, 80) || undefined, chips, media };
  }
  if (m.role === "assistant") {
    const blocks = Array.isArray(m.blocks) ? m.blocks.map(cleanBlock).filter(Boolean) : [];
    return { role: "assistant", ts, blocks };
  }
  return null;
}

// A chat file → { ...entry, messages } or null if it isn't one of ours
export function parseChat(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return null; }
  if (!raw || typeof raw !== "object" || !Number.isFinite(raw.version) || raw.version < 1 || !Array.isArray(raw.messages)) return null;
  const entry = cleanEntry(raw);
  if (!entry) return null;
  return { ...entry, messages: raw.messages.map(cleanMessage).filter(Boolean) };
}

// Only the known fields are written, whatever the caller hands in
export function serializeChat(chat) {
  const messages = Array.isArray(chat.messages) ? chat.messages.map(cleanMessage).filter(Boolean) : [];
  return JSON.stringify({ version: CHAT_FORMAT, ...entryOf(chat), messages });
}

export function parseIndex(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return []; }
  const rows = raw && Array.isArray(raw.chats) ? raw.chats : [];
  return rows.map(cleanEntry).filter(Boolean);
}

// Everything searchable in a chat, lowercased: title, messages, replies
export function chatText(chat) {
  const parts = [chat.title || ""];
  for (const m of chat.messages || []) {
    if (m.role === "user") parts.push(m.text || "", m.skill || "", ...(m.chips || []).map((c) => c.label));
    else for (const b of m.blocks || []) {
      if (b.type === "text" || b.type === "line") parts.push(b.text || "");
      // Agents: found by their titles (their results would repeat the reply)
      else if (b.type === "agents") parts.push(...(b.runs || []).map((r) => r.title || ""));
    }
  }
  return parts.join("\n").toLowerCase();
}

// ---------------------------------------------------------------------------
// Lists: one Space, search, day groups, resume
// ---------------------------------------------------------------------------
// A Space only ever sees its own chats
export function spaceChats(entries, spaceId) {
  return entries.filter((e) => e.spaceId === (spaceId || NO_SPACE)).sort((a, b) => b.updated - a.updated);
}

// Every word must appear in the title, or in the chat's text if it's known
export function searchChats(entries, query, texts = new Map()) {
  const words = oneLine(query).toLowerCase().split(" ").filter(Boolean);
  if (!words.length) return entries.slice();
  return entries.filter((e) => {
    const hay = e.title.toLowerCase() + "\n" + (texts.get(e.id) || "");
    return words.every((w) => hay.includes(w));
  });
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// [{ label: "Today" | "Yesterday" | "Earlier", chats }] with empty groups left out
export function dayGroups(entries, now = Date.now()) {
  const today = startOfDay(now);
  const yesterday = startOfDay(today - DAY_MS / 2);
  const groups = [
    { label: "Today", chats: [] },
    { label: "Yesterday", chats: [] },
    { label: "Earlier", chats: [] },
  ];
  for (const e of entries) {
    const g = e.updated >= today ? 0 : e.updated >= yesterday ? 1 : 2;
    groups[g].chats.push(e);
  }
  return groups.filter((g) => g.chats.length);
}

// Opening the panel: the Space's last chat if it was used within the resume
// window, else null (a fresh chat, with "Recent in <Space>")
export function chatToResume(entries, spaceId, now = Date.now(), minutes = RESUME_MINUTES) {
  const last = spaceChats(entries, spaceId)[0];
  if (!last || minutes <= 0) return null;
  return now - last.updated <= minutes * 60 * 1000 ? last : null;
}

export function recentChats(entries, spaceId, count = RECENT_ROWS) {
  return spaceChats(entries, spaceId).slice(0, count);
}

// "Continue in a new chat": the visible conversation, compacted, newest kept
// first when it doesn't all fit
export function chatRecap(chat, maxChars = 6000) {
  const lines = [];
  for (const m of chat.messages || []) {
    if (m.role === "user") {
      const what = [m.skill ? `/${m.skill}` : "", m.text || "", (m.chips || []).length ? `[with ${m.chips.map((c) => c.label).join(", ")}]` : ""].filter(Boolean).join(" ");
      if (what) lines.push(`User: ${clipText(what, 600)}`);
    } else {
      const text = (m.blocks || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
      if (text.trim()) lines.push(`${aiName(chat)}: ${clipText(text, 900)}`);
      // Agents: one short line (their results are in the reply's own text)
      const runs = (m.blocks || []).filter((b) => b.type === "agents").flatMap((b) => b.runs || []);
      if (runs.length) lines.push(`(Agents: ${runs.map((r) => `“${r.title}” ${r.state}`).join(", ")})`);
    }
  }
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > maxChars) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  if (kept.length < lines.length) kept.unshift(`(${lines.length - kept.length} earlier messages left out)`);
  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Claude Code's transcripts: ~/.claude/projects/<working dir, every
// non-alphanumeric character → "-">/<sessionId>.jsonl (+ a <sessionId>/ folder)
// Checked on this Mac: "/Users/x/Documents/Claude Output" →
// "-Users-x-Documents-Claude-Output". See docs/progress.md.
// ---------------------------------------------------------------------------
export function claudeProjectDir(home, workdir) {
  return PathUtils.join(home, ".claude", "projects", String(workdir).replace(/[^A-Za-z0-9]/g, "-"));
}

export function transcriptPaths(home, workdir, sessionId) {
  if (!SESSION_ID_RE.test(String(sessionId || ""))) return [];
  const dir = claudeProjectDir(home, workdir);
  return [PathUtils.join(dir, sessionId + ".jsonl"), PathUtils.join(dir, sessionId)];
}

async function claudeHomeAndWorkdir() {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  return { home, workdir: await outputDir() };
}

// true / false, or null when we can't tell (the folder isn't where we expect,
// so a wrong guess never makes a chat read-only)
export async function transcriptExists(sessionId, provider = "claude") {
  if (chatProvider(provider) !== "claude") return null;
  try {
    const { home, workdir } = await claudeHomeAndWorkdir();
    const [file] = transcriptPaths(home, workdir, sessionId);
    if (!file) return null;
    if (!(await IOUtils.exists(claudeProjectDir(home, workdir)))) return null;
    return await IOUtils.exists(file);
  } catch (e) {
    return null;
  }
}

export async function deleteTranscript(sessionId, provider = "claude") {
  if (chatProvider(provider) !== "claude") return;
  try {
    const { home, workdir } = await claudeHomeAndWorkdir();
    for (const p of transcriptPaths(home, workdir, sessionId)) {
      await IOUtils.remove(p, { ignoreAbsent: true, recursive: true });
    }
  } catch (e) {
    console.warn("[Zen AI] Couldn't delete Claude Code's transcript:", e);
  }
}

// ---------------------------------------------------------------------------
// The store: index in memory, files on disk
// ---------------------------------------------------------------------------
// Several windows share the folder (each has its own store), so the index is
// re-read and merged before every write: a window only adds, updates or
// removes the rows it changed itself.
export class ChatStore {
  constructor({ dir = null, enabled = true } = {}) {
    this.dir = dir;
    this.enabled = enabled;   // false in private windows: nothing is read or written
    this.rows = new Map();    // id → entry
    this.texts = new Map();   // id → chatText, for search
    this.pending = new Map(); // id → chat waiting to be written
    this.changed = new Set(); // index rows this window changed
    this.removed = new Set(); // ... or deleted
    this.timer = null;
    this.queue = Promise.resolve(); // writes happen one at a time
    this.loaded = null;
  }

  folder() {
    if (!this.dir) this.dir = chatsDir();
    return this.dir;
  }

  path(name) {
    return PathUtils.join(this.folder(), name);
  }

  async readIndexFile() {
    try {
      const file = this.path("index.json");
      if (!(await IOUtils.exists(file))) return [];
      return parseIndex(await IOUtils.readUTF8(file));
    } catch (e) {
      return [];
    }
  }

  // (Re)reads the index, picking up chats other windows saved
  async load() {
    if (!this.enabled) return [];
    const disk = await this.readIndexFile();
    const onDisk = new Set(disk.map((e) => e.id));
    for (const e of disk) {
      if (this.removed.has(e.id) || this.changed.has(e.id)) continue;
      this.rows.set(e.id, e);
    }
    // Deleted by another window (rows this window changed are kept)
    for (const id of [...this.rows.keys()]) {
      if (!this.changed.has(id) && !onDisk.has(id)) this.rows.delete(id);
    }
    await this.recoverRows(onDisk);
    return this.list();
  }

  // A chat file with no index row (a crash between the two writes, or two
  // windows writing the index at once): read the row back from the file
  async recoverRows(onDisk) {
    let names = [];
    try { names = await IOUtils.getChildren(this.folder()); } catch (e) { return; }
    for (const p of names) {
      const id = PathUtils.filename(p).replace(/\.json$/, "");
      if (!p.endsWith(".json") || id === "index" || onDisk.has(id) || this.rows.has(id) || this.removed.has(id) || !CHAT_ID_RE.test(id)) continue;
      const chat = await this.read(id);
      if (!chat) continue;
      this.rows.set(id, entryOf(chat));
      this.changed.add(id); // written back with the next save
    }
  }

  ensureLoaded() {
    if (!this.loaded) this.loaded = this.load();
    return this.loaded;
  }

  list(spaceId) {
    const all = [...this.rows.values()];
    return spaceId === undefined ? all.sort((a, b) => b.updated - a.updated) : spaceChats(all, spaceId);
  }

  get(id) {
    return this.rows.get(id) || null;
  }

  // The chat's file, or null if it's missing or unreadable
  async read(id) {
    if (!this.enabled || !CHAT_ID_RE.test(String(id))) return null;
    if (this.pending.has(id)) return parseChat(serializeChat(this.pending.get(id)));
    try {
      const chat = parseChat(await IOUtils.readUTF8(this.path(id + ".json")));
      if (!chat || chat.id !== id) return null;
      this.texts.set(id, chatText(chat));
      return chat;
    } catch (e) {
      return null;
    }
  }

  // Search needs each chat's text: read the ones we haven't yet
  async loadTexts(ids) {
    for (const id of ids) if (!this.texts.has(id)) await this.read(id);
    return this.texts;
  }

  // chat: { id, sessionId, spaceId, title, created, updated, model, tainted,
  // toolsUnlocked, expired, messages }. Written a moment later.
  save(chat) {
    if (!this.enabled) return;
    const entry = entryOf(chat);
    if (!entry) return;
    this.rows.set(entry.id, entry);
    this.changed.add(entry.id);
    this.removed.delete(entry.id);
    this.texts.set(entry.id, chatText(chat));
    this.pending.set(entry.id, chat);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), CHAT_SAVE_DELAY_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.enabled) return this.queue;
    const chats = [...this.pending.values()];
    this.pending.clear();
    const indexToo = chats.length > 0 || this.changed.size > 0 || this.removed.size > 0;
    this.queue = this.queue.then(async () => {
      for (const chat of chats) await this.writeFile(chat.id + ".json", serializeChat(chat));
      if (indexToo) await this.writeIndex();
    }).catch((e) => console.warn("[Zen AI] Couldn't save the chat history:", e));
    return this.queue;
  }

  // Temp file + move, so a crash can't leave half a file
  async writeFile(name, text) {
    await IOUtils.makeDirectory(this.folder(), { ignoreExisting: true, createAncestors: true });
    const file = this.path(name);
    // Own temp name per write: two windows may write the same file at once
    const tmp = `${file}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await IOUtils.writeUTF8(tmp, text);
    await IOUtils.move(tmp, file);
  }

  async writeIndex() {
    // What this write covers (a save that lands meanwhile stays marked for the next one)
    const changed = [...this.changed];
    const removed = [...this.removed];
    const same = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
    let chats = [];
    // Another window can write between our read and write: check, and redo it
    for (let attempt = 0; attempt < 3; attempt++) {
      const merged = new Map((await this.readIndexFile()).map((e) => [e.id, e]));
      for (const id of removed) merged.delete(id);
      for (const id of changed) if (this.rows.has(id)) merged.set(id, this.rows.get(id));
      chats = [...merged.values()].sort((a, b) => b.updated - a.updated);
      await this.writeFile("index.json", JSON.stringify({ version: CHAT_FORMAT, chats }));
      const now = new Map((await this.readIndexFile()).map((e) => [e.id, e]));
      const landed = removed.every((id) => !now.has(id)) && changed.every((id) => !this.rows.has(id) || same(now.get(id), this.rows.get(id)));
      if (landed) break;
    }
    const written = new Map(chats.map((e) => [e.id, e]));
    for (const id of changed) if (this.rows.get(id) === written.get(id)) this.changed.delete(id);
    for (const id of removed) if (!this.rows.has(id)) this.removed.delete(id);
    for (const e of chats) if (!this.rows.has(e.id) && !this.removed.has(e.id)) this.rows.set(e.id, e);
  }

  // Deletes our file and (unless told not to) Claude Code's transcript
  async remove(id, { transcript = true } = {}) {
    const entry = this.rows.get(id);
    this.rows.delete(id);
    this.texts.delete(id);
    this.pending.delete(id);
    this.changed.delete(id);
    if (!this.enabled || !CHAT_ID_RE.test(String(id))) return;
    this.removed.add(id);
    this.queue = this.queue.then(async () => {
      await IOUtils.remove(this.path(id + ".json"), { ignoreAbsent: true });
      await this.writeIndex();
    }).catch((e) => console.warn("[Zen AI] Couldn't delete the chat:", e));
    await this.queue;
    if (transcript && entry && entry.sessionId) await deleteTranscript(entry.sessionId, entry.provider);
  }
}
