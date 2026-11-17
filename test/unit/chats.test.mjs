// The chat store (src/chats.mjs) on an in-memory disk: Spaces never see each
// other's chats, search, delete (with Claude Code's transcript), corrupt or
// missing files, safe writes, two windows sharing the index, the resume window.
import "../helpers/firefox.mjs";
import { checker, crash } from "../helpers/common.mjs";
import { prefs as prefStore } from "../helpers/firefox.mjs";
import {
  ChatStore, chatTitle, chatToResume, chatRecap, dayGroups, parseChat, recentChats, resumeMinutes,
  searchChats, spaceChats, chatText, transcriptExists, transcriptPaths, claudeProjectDir, newChatId, NO_SPACE, serializeChat, parseIndex,
} from "../../src/chats.mjs";

const { check, done } = checker();

// --- An in-memory disk ---
const disk = new Map(); // path → text
const dirs = new Set();
let failMove = false;
const parentsOf = (p) => p.split("/").slice(1, -1).map((_, i, a) => "/" + a.slice(0, i + 1).join("/"));
globalThis.PathUtils = { join: (...a) => a.join("/").replace(/\/+/g, "/"), filename: (p) => p.split("/").pop(), profileDir: "/profile" };
globalThis.Services.dirsvc = { get: () => ({ path: "/home" }) };
globalThis.IOUtils = {
  exists: async (p) => disk.has(p) || dirs.has(p),
  makeDirectory: async (d) => { dirs.add(d); parentsOf(d + "/x").forEach((x) => dirs.add(x)); },
  readUTF8: async (p) => { if (!disk.has(p)) throw new Error("NotFoundError: " + p); return disk.get(p); },
  writeUTF8: async (p, t) => { disk.set(p, t); },
  move: async (from, to) => {
    if (failMove) throw new Error("crash during move");
    if (!disk.has(from)) throw new Error("no source");
    disk.set(to, disk.get(from));
    disk.delete(from);
  },
  getChildren: async (d) => [...new Set([...disk.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))],
  remove: async (p, opts = {}) => {
    const had = disk.delete(p) | dirs.delete(p);
    if (opts.recursive) for (const k of [...disk.keys()]) if (k.startsWith(p + "/")) disk.delete(k);
    if (!had && !opts.ignoreAbsent) throw new Error("absent");
  },
};
const DIR = "/profile/zen-ai/chats";
const files = () => [...disk.keys()].filter((k) => k.startsWith(DIR + "/")).map((k) => k.slice(DIR.length + 1)).sort();

const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime();
const MIN = 60 * 1000;
const SID = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

function chat(id, spaceId, title, updated, extra = {}) {
  return {
    id, spaceId, title, created: updated - 5 * MIN, updated, sessionId: SID(Number(id.slice(-1)) || 0), model: "default",
    tainted: false, toolsUnlocked: false,
    messages: [
      { role: "user", ts: updated - 5 * MIN, text: title, chips: [{ label: "github.com", icon: "doc" }], media: ["Screenshot"] },
      { role: "assistant", ts: updated, blocks: [{ type: "text", text: `Answer about ${title}` }, { type: "line", kind: "ok", text: "Allowed · run a command ·", code: "ls" }] },
    ],
    ...extra,
  };
}

(async () => {
  // --- Titles ---
  check("title: the first message", chatTitle({ text: "  What does   this error mean?  " }) === "What does this error mean?");
  const long = chatTitle({ text: "Explain the difference between merge sort and quick sort for my algorithms exam tomorrow please" });
  check("title: long messages cut near 60 characters on a word", long.length <= 60 && long.endsWith("…") && !long.includes("  "), long);
  check("title: a skill alone is named with its page", chatTitle({ skill: "summarize", context: "github.com" }) === "Summarize · github.com");
  check("title: a skill with text", chatTitle({ skill: "reply", text: "say yes politely" }) === "Reply: say yes politely");
  check("title: only attachments", chatTitle({ context: "lab3.docx" }) === "lab3.docx");
  check("chat ids are file-name safe", /^[a-z0-9-]+$/.test(newChatId()) && newChatId() !== newChatId());

  // --- Saving ---
  const a = new ChatStore();
  await a.ensureLoaded();
  check("empty profile: no chats, no crash", a.list().length === 0);
  a.save(chat("chat-a1", "space-A", "Merge sort notes", NOW - 30 * MIN));
  a.save(chat("chat-a2", "space-A", "Quick sort pivot", NOW - 10 * MIN));
  a.save(chat("chat-b1", "space-B", "Biology lab report", NOW - 5 * MIN));
  await a.flush();
  check("one file per chat plus the index, no temp files left", files().join() === "chat-a1.json,chat-a2.json,chat-b1.json,index.json", files());
  const index = JSON.parse(disk.get(DIR + "/index.json"));
  check("index rows have the documented fields only", index.version === 1 && index.chats.length === 3 &&
    Object.keys(index.chats[0]).sort().join() === "created,expired,id,model,provider,sessionId,spaceId,tainted,title,toolsUnlocked,updated", Object.keys(index.chats[0]));
  check("chat file has a version", JSON.parse(disk.get(DIR + "/chat-a1.json")).version === 1);

  // --- Space isolation ---
  check("Space A lists only its chats, newest first", a.list("space-A").map((e) => e.id).join() === "chat-a2,chat-a1");
  check("Space B lists only its chat", a.list("space-B").map((e) => e.id).join() === "chat-b1");
  check("an unknown Space lists nothing", a.list("space-C").length === 0);
  check("no Space id → the window-wide list", spaceChats([{ id: "x", spaceId: NO_SPACE, updated: 1 }], undefined).length === 1);

  // --- A restart (new store) reads it all back ---
  const b = new ChatStore();
  await b.ensureLoaded();
  check("restart: index read back", b.list().length === 3 && b.list("space-A").length === 2);
  const back = await b.read("chat-a1");
  check("restart: messages round-trip", back && back.messages.length === 2 && back.messages[1].blocks[0].text === "Answer about Merge sort notes" && back.messages[0].chips[0].label === "github.com", back);

  // Only the known fields are kept: page text or images handed in by mistake are dropped
  a.save(chat("chat-a3", "space-A", "Leaky", NOW, {
    pageText: "SECRET PAGE TEXT",
    messages: [{ role: "user", ts: NOW, text: "hi", pageText: "SECRET PAGE TEXT", image: { base64: "AAAA" }, media: ["Screenshot"] }, { role: "tool", text: "x" }],
  }));
  await a.flush();
  const leaky = disk.get(DIR + "/chat-a3.json");
  check("unknown fields (page text, image data) never reach the file", !leaky.includes("SECRET") && !leaky.includes("AAAA") && leaky.includes("Screenshot"), leaky);
  check("unknown message roles are dropped", (await a.read("chat-a3")).messages.length === 1);

  // --- Search ---
  await b.load();
  const texts = await b.loadTexts(b.list("space-A").map((e) => e.id));
  check("search by title word", searchChats(b.list("space-A"), "pivot", texts).map((e) => e.id).join() === "chat-a2");
  check("search inside replies", searchChats(b.list("space-A"), "answer merge", texts).map((e) => e.id).join() === "chat-a1");
  check("search is case-insensitive, every word must match", searchChats(b.list("space-A"), "QUICK merge", texts).length === 0 && searchChats(b.list("space-A"), "QUICK", texts).length === 1);
  check("search never crosses Spaces", searchChats(b.list("space-A"), "biology", texts).length === 0);
  check("empty search lists everything", searchChats(b.list("space-A"), "  ", texts).length === 3);

  // --- Two windows saving at once: the index keeps both ---
  b.save(chat("chat-b2", "space-B", "From window B", NOW - 1 * MIN));
  a.save(chat("chat-a1", "space-A", "Merge sort notes (renamed)", NOW - 2 * MIN));
  await Promise.all([a.flush(), b.flush()]);
  const both = new ChatStore();
  await both.load();
  check("two windows: neither overwrites the other's rows", both.get("chat-b2") && both.get("chat-a1").title === "Merge sort notes (renamed)", both.list().map((e) => e.title));
  check("two windows: no temp files left behind", !files().some((f) => f.endsWith(".tmp")), files());

  // A chat file whose index row got lost (crash between the two writes) comes back
  const idx = JSON.parse(disk.get(DIR + "/index.json"));
  disk.set(DIR + "/index.json", JSON.stringify({ ...idx, chats: idx.chats.filter((e) => e.id !== "chat-b2") }));
  const healed = new ChatStore();
  await healed.load();
  check("a chat file without an index row is recovered", healed.get("chat-b2") && healed.get("chat-b2").title === "From window B");

  // --- Delete: our file, the row, Claude Code's transcript ---
  const projectDir = claudeProjectDir("/home", "/home/Documents/Claude Output");
  check("transcript folder encoding (checked on this Mac)", projectDir === "/home/.claude/projects/-home-Documents-Claude-Output", projectDir);
  const [jsonl, sub] = transcriptPaths("/home", "/home/Documents/Claude Output", SID(2)); // chat-a2's
  dirs.add(projectDir);
  disk.set(jsonl, "{}");
  disk.set(sub + "/tool-results/x.txt", "x");
  disk.set(projectDir + "/" + SID(1) + ".jsonl", "other chat");
  check("transcript exists before delete", (await transcriptExists(SID(2))) === true);
  await both.remove("chat-a2");
  check("delete removes our file and the row", !disk.has(DIR + "/chat-a2.json") && !both.get("chat-a2") && !JSON.parse(disk.get(DIR + "/index.json")).chats.some((e) => e.id === "chat-a2"));
  check("delete removes Claude Code's transcript (file and folder)", !disk.has(jsonl) && !disk.has(sub + "/tool-results/x.txt"));
  check("other transcripts and chats stay", disk.has(projectDir + "/" + SID(1) + ".jsonl") && disk.has(DIR + "/chat-a1.json"));
  await a.load();
  check("another window's next load drops the deleted chat", !a.get("chat-a2") && a.get("chat-b2"));
  check("odd session ids are never turned into paths", transcriptPaths("/home", "/w", "../../etc").length === 0);
  check("transcript gone → false; folder missing → unknown (null)", (await transcriptExists(SID(2))) === false && (dirs.delete(projectDir), (await transcriptExists(SID(2))) === null));

  // --- Corrupt or missing files are ignored, never crash ---
  disk.set(DIR + "/chat-b1.json", "{ not json");
  check("corrupt chat file → null", (await b.read("chat-b1")) === null);
  check("missing chat file → null", (await b.read("chat-zz9999")) === null);
  check("bad ids are never read", (await b.read("../../prefs")) === null);
  check("wrong shapes → null", parseChat('{"version":1,"id":"chat-x1","messages":"no"}') === null && parseChat("null") === null && parseChat('{"version":1,"id":"chat-x1","updated":5,"messages":[]}') !== null);
  disk.set(DIR + "/index.json", "garbage");
  const c = new ChatStore();
  const rebuilt = await c.load();
  check("corrupt index → rebuilt from the chat files (the corrupt one skipped)", rebuilt.map((e) => e.id).sort().join() === "chat-a1,chat-a3,chat-b2", rebuilt.map((e) => e.id));
  disk.set(DIR + "/index.json", JSON.stringify({ version: 1, chats: [{ id: "../evil", updated: 1 }, { id: "chat-ok1", updated: NOW, title: 5 }, null, "x"] }));
  const rows = await new ChatStore().load();
  const ok1 = rows.find((e) => e.id === "chat-ok1");
  check("bad rows skipped, fixable rows repaired", !rows.some((e) => /evil/.test(e.id)) && ok1 && ok1.title === "Untitled chat" && ok1.spaceId === NO_SPACE, rows.map((e) => e.id));

  // --- Safe writes: a crash mid-write leaves the old file whole ---
  const before = disk.get(DIR + "/chat-a1.json");
  failMove = true;
  const warn = console.warn;
  console.warn = () => {};
  a.save(chat("chat-a1", "space-A", "Half written", NOW));
  await a.flush();
  console.warn = warn;
  failMove = false;
  check("failed write: the old file is untouched", disk.get(DIR + "/chat-a1.json") === before);

  // --- Private windows: nothing read or written ---
  const n = disk.size;
  const priv = new ChatStore({ enabled: false });
  priv.save(chat("chat-p1", "space-A", "Private", NOW));
  await priv.flush();
  check("private window saves nothing", disk.size === n && (await priv.load()).length === 0 && (await priv.read("chat-a1")) === null);

  // --- Resume or fresh ---
  const entries = [
    { id: "a", spaceId: "space-A", updated: NOW - 59 * MIN },
    { id: "b", spaceId: "space-A", updated: NOW - 3 * 60 * MIN },
    { id: "c", spaceId: "space-B", updated: NOW - 1 * MIN },
  ];
  check("resume: last chat used within the hour", (chatToResume(entries, "space-A", NOW, 60) || {}).id === "a");
  check("resume: older than the window → fresh chat", chatToResume(entries, "space-A", NOW + 2 * MIN, 60) === null);
  check("resume: another Space's recent chat doesn't count", chatToResume([entries[1], entries[2]], "space-A", NOW, 60) === null);
  check("resume: 0 minutes means always fresh", chatToResume(entries, "space-A", NOW, 0) === null);
  prefStore.set("zenai.resumeMinutes", "15");
  check("resume window comes from zenai.resumeMinutes", resumeMinutes() === 15);
  prefStore.set("zenai.resumeMinutes", "soon");
  check("a bad pref falls back to 60", resumeMinutes() === 60);
  check("recent rows: this Space, newest first, at most 3", recentChats([...entries, { id: "d", spaceId: "space-A", updated: NOW - 9000 * MIN }, { id: "e", spaceId: "space-A", updated: NOW - 2 * MIN }], "space-A").map((e) => e.id).join() === "e,a,b");

  // --- Day groups ---
  const groups = dayGroups([
    { id: "t", updated: NOW - 60 * MIN },
    { id: "y", updated: new Date(2026, 9, 11, 9, 0).getTime() },
    { id: "e1", updated: new Date(2026, 9, 10, 23, 59).getTime() },
    { id: "e2", updated: new Date(2025, 0, 1).getTime() },
  ], NOW);
  check("groups: Today, Yesterday, Earlier", groups.map((g) => `${g.label}:${g.chats.map((x) => x.id).join("+")}`).join(" ") === "Today:t Yesterday:y Earlier:e1+e2", groups);
  check("empty groups are left out", dayGroups([{ id: "t", updated: NOW }], NOW).map((g) => g.label).join() === "Today");

  // --- Recap for "Continue in a new chat" ---
  const recap = chatRecap(chat("chat-r1", "space-A", "Merge sort notes", NOW));
  check("recap: user and Claude lines", /^User: Merge sort notes \[with github\.com\]\nClaude: Answer about Merge sort notes$/.test(recap), recap);
  const many = { messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `message ${i} `.repeat(30), blocks: [{ type: "text", text: `reply ${i} `.repeat(30) }] })) };
  const cut = chatRecap(many, 2000);
  check("recap: long chats keep the newest messages and say what was left out", cut.length < 2300 && /earlier messages left out/.test(cut) && /reply 39/.test(cut) && !/message 0 /.test(cut));

  // --- Provider identity and transcript isolation ---
  const legacy = chat("chat-legacy", "space-A", "Old chat", NOW);
  check("legacy records and index rows default to Claude", parseChat(JSON.stringify({ version: 1, ...legacy })).provider === "claude" && parseIndex(JSON.stringify({ chats: [legacy] }))[0].provider === "claude");
  const agy = chat("chat-agy", "space-A", "Other provider", NOW, { provider: "antigravity", model: "gemini-test", sessionId: SID(1) });
  check("provider survives the chat whitelist", parseChat(serializeChat(agy)).provider === "antigravity");
  check("unknown providers are preserved, malformed IDs never become Claude", parseChat(serializeChat({ ...agy, provider: "future-ai" })).provider === "future-ai" && parseChat(serializeChat({ ...agy, provider: {} })).provider === "unavailable");
  check("recaps name the original model's family", chatRecap(agy).includes("Gemini: Answer") && !chatRecap(agy).includes("Claude:"));
  dirs.add(projectDir);
  const collision = projectDir + "/" + SID(1) + ".jsonl";
  disk.set(collision, "Claude's transcript with the same session id");
  check("another provider never checks Claude's transcript", await transcriptExists(SID(1), "antigravity") === null && await transcriptExists(SID(1), "future-ai") === null);
  const providerStore = new ChatStore();
  await providerStore.load();
  providerStore.save(agy);
  await providerStore.flush();
  const restarted = new ChatStore();
  await restarted.load();
  check("provider survives restart in both index and record", restarted.get(agy.id).provider === "antigravity" && (await restarted.read(agy.id)).provider === "antigravity");
  await restarted.remove(agy.id);
  check("deleting another provider's chat leaves Claude's transcript intact", disk.has(collision) && !disk.has(DIR + "/" + agy.id + ".json"));

  // --- Helper agents' saved block (cleanBlock "agents") ---
  const withAgents = (block) => {
    const c = chat("chat-ag1", "space-A", "Agents chat", NOW);
    c.messages[1].blocks.push(block);
    return c;
  };
  const agentsOf = (c) => parseChat(serializeChat(c)).messages[1].blocks.find((b) => b.type === "agents");
  const longResult = "R".repeat(5000);
  const ag = agentsOf(withAgents({ type: "agents", secret: "x", runs: [
    { title: "Source A", provider: "claude", model: "sonnet", state: "done", result: longResult, error: "", instruction: "INSTR-A", context: ["data:_about-me.md"], contextLabels: ["About me"], task: "<agent_task>", grants: ["x"], sessionId: SID(3), activity: [{ kind: "update", text: "hmm" }], files: [{ name: "a.txt", path: "/home/u/Documents/Claude Output/a.txt", size: 3, bytes: "QUJD" }] },
    { title: "Source B", state: "failed", error: "It broke" },
    { title: "Source C", state: "stopped" },
    { title: "Source D", state: "interrupted" },
    { title: "Source E", state: "working" },
    { title: "Source F", state: "queued" },
    { title: "Source G", state: "waiting" },
    { title: "Source H", state: "bogus" },
    { title: "   ", state: "done" },
    { state: "done" },
    "not a run",
  ] }));
  check("agents block survives the whitelist", !!ag && ag.runs[0].title === "Source A" && ag.runs[0].provider === "claude" && ag.runs[0].model === "sonnet", ag);
  check("agents block: unknown fields on the block and runs are dropped", ag && !("secret" in ag) && ["activity", "sessionId", "grants", "task", "contextLabels"].every((k) => !(k in ag.runs[0])), ag && Object.keys(ag.runs[0]));
  check("agents block: instructions and context are never kept", ag && !("instruction" in ag.runs[0]) && !("context" in ag.runs[0]) && !JSON.stringify(ag).includes("INSTR-A") && !JSON.stringify(ag).includes("about-me"));
  check("agents block: a result is capped at 4000 characters", ag && ag.runs[0].result.length === 4000);
  check("agents block: files keep name/path/size only", ag && ag.runs[0].files.length === 1 && Object.keys(ag.runs[0].files[0]).sort().join() === "name,path,size");
  check("agents block: done/failed/stopped/interrupted are kept", ag && ag.runs.slice(0, 4).map((r) => r.state).join() === "done,failed,stopped,interrupted" && ag.runs[1].error === "It broke", ag && ag.runs.map((r) => r.state));
  check("agents block: running, queued, waiting and unknown states become interrupted", ag && ag.runs.slice(4).map((r) => `${r.title}:${r.state}`).join() === "Source E:interrupted,Source F:interrupted,Source G:interrupted,Source H:interrupted", ag && ag.runs.map((r) => r.title + ":" + r.state));
  check("agents block: runs without a title are dropped", ag && ag.runs.length === 8);
  check("agents block: an empty runs list drops the block", !agentsOf(withAgents({ type: "agents", runs: [] })) && !agentsOf(withAgents({ type: "agents", runs: [{ state: "done" }] })) && !agentsOf(withAgents({ type: "agents" })));
  const many13 = agentsOf(withAgents({ type: "agents", runs: Array.from({ length: 20 }, (_, i) => ({ title: `Run ${i}`, state: "done", result: "ok" })) }));
  check("agents block: at most 12 runs", many13 && many13.runs.length === 12 && many13.runs[11].title === "Run 11");
  const agChat = parseChat(serializeChat(withAgents({ type: "agents", runs: [{ title: "Zebra Survey", state: "done", result: "UNIQUE-RESULT-TEXT" }, { title: "Second Opinion", state: "stopped" }] })));
  const hay = chatText(agChat);
  check("chatText includes agent titles (not their results)", hay.includes("zebra survey") && hay.includes("second opinion") && !hay.includes("unique-result-text"));
  check("search finds a chat by an agent title", searchChats([{ id: agChat.id, title: agChat.title, updated: NOW }], "Zebra", new Map([[agChat.id, hay]])).length === 1);
  const agRecap = chatRecap(agChat);
  const agentLines = agRecap.split("\n").filter((l) => l.startsWith("(Agents:"));
  check("recap adds one (Agents: …) line", agentLines.length === 1 && agentLines[0] === "(Agents: “Zebra Survey” done, “Second Opinion” stopped)" && !agRecap.includes("UNIQUE-RESULT-TEXT"), agRecap);
  check("recap of a chat without agents has no Agents line", !chatRecap(chat("chat-r2", "space-A", "Plain", NOW)).includes("(Agents:"));

  done();
})().catch(crash);
