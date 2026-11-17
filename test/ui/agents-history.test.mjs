// Helper agents in chat history: a reply's agent boxes are saved (labels,
// state, a bounded result; never instructions or context), come back after a
// restart as saved boxes (no Stop, "View result"), agents that were still
// running when Zen quit come back as interrupted and never restart, old chat
// files without agents render as before, and search finds an agent's title.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const CHATS = "/profile/zen-ai/chats";
const DIR = "/profile/chrome/zenai-skills";
const sk = (name, extra = "") => `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\nBODY-OF-${name}`;
const FILES = {
  "team.md": sk("team", "agents: 2\naccess:\n  - about-me\n"),
  "_about-me.md": "# About me\nName: ABOUT-ME-TEXT\n",
};

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
};

// The skills folder, on top of fake-zen's IOUtils
function skillsFolder(w) {
  const paths = new Map(Object.entries(FILES).map(([k, v]) => [`${DIR}/${k}`, v]));
  const io = w.IOUtils;
  const { getChildren, readUTF8, exists, stat } = io;
  const kids = (d) => [...new Set([...paths.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))];
  io.getChildren = async (d) => (d.startsWith(DIR) ? kids(d) : getChildren(d));
  io.readUTF8 = async (p) => { if (paths.has(p)) return paths.get(p); if (p.startsWith(DIR)) throw new Error("not found"); return readUTF8(p); };
  io.exists = async (p) => (p.startsWith(DIR) ? p === DIR || paths.has(p) || kids(p).length > 0 : exists(p));
  io.stat = async (p) => (p.startsWith(DIR) ? { type: kids(p).length ? "directory" : "regular" } : stat(p));
  w.Services.prefs.setStringPref("zenai.skillsVersion", "3");
}

const chatFiles = (disk) => [...disk.entries()].filter(([k]) => k.startsWith(CHATS + "/") && k.endsWith(".json") && !k.endsWith("index.json"));
const textOf = (res) => (res.content || []).map((c) => c.text || "").join("");

(async () => {
  const disk = new Map();
  const transcripts = new Set();

  // --- 1. A reply with two agents: one done, one stopped ----------------------------
  let zen = await fakeZen({
    disk, transcripts, holdReplies: true,
    replyFor: (text) => {
      const m = text.match(/<agent_task title="([^"]*)"/);
      if (m) return `RESULT-OF-${m[1]}\n\nSecond line of the result.`;
      if (text.includes("your agents have finished")) return "COMBINED ANSWER";
      return "PARENT DRAFT";
    },
  });
  skillsFolder(zen.w);
  await zen.open();
  const input = zen.$(".zai-input");
  input.value = "/team";
  input.dispatchEvent(new zen.w.Event("input", { bubbles: true }));
  await sleep(80);
  input.dispatchEvent(new zen.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await sleep(30);
  await zen.send("", { wait: false });
  await until(() => zen.sent.length && zen.sent.at(-1).text.includes("BODY-OF-team"));
  const parent = zen.sent.at(-1).proc;
  const start = async (args) => {
    const perm = await zen.askPermission("mcp__zenai__agent_start", args, { proc: parent });
    const res = await zen.callTool("agent_start", perm.updatedInput || args, { proc: parent });
    return (textOf(res).match(/Started agent (a[0-9a-f]+)/) || [])[1];
  };
  const idA = await start({ title: "Zebra Survey", instruction: "SECRET-INSTRUCTION-A", context: ["data:_about-me.md"] });
  const idB = await start({ title: "Second Opinion", instruction: "SECRET-INSTRUCTION-B" });
  const children = () => zen.spawns.filter((p) => zen.isChildSpawn(p));
  await until(() => children().length === 2);
  check("setup: two agents started", !!idA && !!idB && children().length === 2);
  await zen.finishReplies({ proc: children()[0] });
  await until(() => zen.$$('.zai-task[data-state="done"]').length === 1);
  await zen.callTool("agent_cancel", { id: idB }, { proc: parent });
  await until(() => zen.$$('.zai-task[data-state="stopped"]').length === 1);
  await zen.callTool("agent_wait", { seconds: 1 }, { proc: parent });
  await zen.finishReplies({ proc: parent });
  await until(() => !zen.$(".zai-send.zai-stop"));
  await zen.finishReplies();
  await zen.idle();
  await sleep(400);

  const savedEntry = chatFiles(disk).find(([, v]) => String(v).includes('"agents"'));
  const saved = savedEntry ? JSON.parse(savedEntry[1]) : null;
  const block = saved && saved.messages.flatMap((m) => m.blocks || []).find((b) => b.type === "agents");
  check("the chat file has an agents block with both runs", !!block && block.runs.length === 2 && block.runs.map((r) => `${r.title}:${r.state}`).join() === "Zebra Survey:done,Second Opinion:stopped", block);
  check("the done run keeps its result", block && /RESULT-OF-Zebra Survey/.test(block.runs[0].result || ""));
  const raw = savedEntry ? savedEntry[1] : "";
  check("the saved file never has the agents' instructions or context", raw && !raw.includes("SECRET-INSTRUCTION") && !raw.includes("ABOUT-ME-TEXT") && !raw.includes("<agent_task") && !raw.includes("data:_about-me.md"));
  check("no window errors (first window)", zen.errors.length === 0, zen.errors);
  const teamId = saved && saved.id;
  await zen.close();

  // --- 2. Reopened in a new window ------------------------------------------------
  zen = await fakeZen({ disk, transcripts });
  await zen.open();
  await sleep(80);
  const boxes = () => zen.$$(".zai-thread .zai-task");
  const boxOf = (title) => boxes().find((b) => b.querySelector(".zai-task-title").textContent === title);
  check("restart: the saved agent boxes come back", boxes().length === 2 && boxOf("Zebra Survey")?.dataset.state === "done" && boxOf("Second Opinion")?.dataset.state === "stopped", boxes().map((b) => b.dataset.state));
  check("saved boxes have no Stop button", !zen.$(".zai-thread .zai-task-stop"));
  const doneBox = boxOf("Zebra Survey");
  const toggle = doneBox && doneBox.querySelector(".zai-task-toggle");
  check("a done box offers View result, collapsed", toggle && /View result/.test(toggle.textContent) && doneBox.querySelector(".zai-task-details").hidden);
  if (toggle) zen.click(toggle);
  const details = doneBox && doneBox.querySelector(".zai-task-details");
  check("View result expands the saved result", details && !details.hidden && /RESULT-OF-Zebra Survey/.test(details.textContent) && /Second line/.test(details.textContent), details && details.textContent);
  check("reopening starts no agent process", !zen.spawns.some((p) => zen.isChildSpawn(p)) && zen.sent.length === 0);

  // --- 3. Search finds the chat by an agent's title -------------------------------
  await zen.openHistory();
  const search = zen.$(".zai-hist-search");
  search.value = "zebra survey";
  search.dispatchEvent(new zen.w.Event("input", { bubbles: true }));
  await sleep(250);
  const rows = zen.$$(".zai-hist-row");
  check("search finds the chat by an agent's title", rows.length === 1 && saved && zen.historyRows()[0] === saved.title, zen.historyRows());
  search.value = "SECRET-INSTRUCTION-A";
  search.dispatchEvent(new zen.w.Event("input", { bubbles: true }));
  await sleep(250);
  check("...but not by an agent's instruction", zen.$$(".zai-hist-row").length === 0, zen.historyRows());
  check("no window errors (reopened)", zen.errors.length === 0, zen.errors);
  await zen.close();

  // --- 4. Hand-written files: a crash mid-run, and an old chat --------------------------
  const old = Date.now() - 3 * 60 * 60 * 1000;
  const base = (id, title, updated, messages) => ({ version: 1, id, provider: "claude", sessionId: null, spaceId: saved.spaceId, title, created: updated - 1000, updated, model: "default", tainted: false, toolsUnlocked: false, expired: false, messages });
  const crashId = old.toString(36) + "-crashaaa";
  const crashChat = base(crashId, "Crashed run", old, [
    { role: "user", ts: old - 500, text: "", skill: "team", chips: [], media: [] },
    { role: "assistant", ts: old, blocks: [
      { type: "text", text: "Starting two agents." },
      { type: "agents", runs: [
        { title: "Still Working", provider: "claude", model: "default", state: "working", result: "", error: "", instruction: "LEAK-1", context: ["LEAK-2"] },
        { title: "Still Queued", provider: "claude", model: "default", state: "queued" },
      ] },
    ] },
  ]);
  const oldId = (old - 5000).toString(36) + "-oldchatx";
  const oldChat = base(oldId, "Old plain chat", old - 5000, [
    { role: "user", ts: old - 6000, text: "What is merge sort?", chips: [], media: [] },
    { role: "assistant", ts: old - 5000, blocks: [{ type: "text", text: "Merge sort splits the list." }, { type: "line", kind: "ok", text: "Saved notes.txt" }] },
  ]);
  disk.set(`${CHATS}/${crashId}.json`, JSON.stringify(crashChat));
  disk.set(`${CHATS}/${oldId}.json`, JSON.stringify(oldChat));
  const index = JSON.parse(disk.get(`${CHATS}/index.json`));
  const { messages: _a, version: _b, ...crashRow } = crashChat;
  const { messages: _c, version: _d, ...oldRow } = oldChat;
  index.chats.push(crashRow, oldRow);
  disk.set(`${CHATS}/index.json`, JSON.stringify(index));

  zen = await fakeZen({ disk, transcripts });
  await zen.open();
  await sleep(80);
  const openRow = async (title) => {
    await zen.openHistory();
    const row = zen.$$(".zai-hist-row").find((r) => r.querySelector(".zai-hist-title").textContent === title);
    if (row) zen.click(row);
    await sleep(120);
    return !!row;
  };
  const opened = await openRow("Crashed run");
  const crashBoxes = zen.$$(".zai-thread .zai-task");
  check("a chat saved mid-run opens", opened && crashBoxes.length === 2, crashBoxes.length);
  check("its running and queued agents show as interrupted", crashBoxes.length === 2 && crashBoxes.every((b) => b.dataset.state === "interrupted"), crashBoxes.map((b) => b.dataset.state));
  check("...saying nothing restarts by itself", crashBoxes.length > 0 && crashBoxes.every((b) => /Nothing restarts by itself/.test(b.textContent)), crashBoxes.map((b) => b.textContent));
  check("...with no Stop button", !zen.$(".zai-thread .zai-task-stop"));
  await sleep(200);
  check("no agent process starts for interrupted agents, and nothing is sent", !zen.spawns.some((p) => zen.isChildSpawn(p)) && zen.sent.length === 0, zen.spawns.map((p) => p.args.includes("--no-session-persistence")));
  check("unknown fields (instructions) never show", !zen.$(".zai-thread").textContent.includes("LEAK-"));

  await openRow("Old plain chat");
  check("an old chat without agents renders as before", zen.bubbles().join("|") === "What is merge sort?" && zen.replies().join("|") === "Merge sort splits the list." &&
    zen.$$(".zai-thread .zai-toolline").map((l) => l.textContent).join() .includes("Saved notes.txt") && !zen.$(".zai-thread .zai-task, .zai-thread .zai-tasks"), [zen.bubbles(), zen.replies()]);
  check("no window errors (hand-written files)", zen.errors.length === 0, zen.errors);
  await zen.close();
  check("the team chat file is still there after reopening", disk.has(`${CHATS}/${teamId}.json`));

  done();
})().catch(crash);
