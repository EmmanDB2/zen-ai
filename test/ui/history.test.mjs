// Chat history across windows and restarts, on the built mod (dist/) in
// jsdom with a fake Claude Code: resume within the hour, a fresh chat with
// "Recent" after it, expired chats (read-only + "Continue in a new chat"),
// deleting the transcript, two windows, private windows.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep, PROJECT_DIR } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const CHATS = "/profile/zen-ai/chats";

// Pretend a chat was last used `minutes` ago (index row and file)
function age(disk, id, minutes) {
  const ts = Date.now() - minutes * 60 * 1000;
  const index = JSON.parse(disk.get(`${CHATS}/index.json`));
  for (const e of index.chats) if (e.id === id) e.updated = ts;
  disk.set(`${CHATS}/index.json`, JSON.stringify(index));
  const chat = JSON.parse(disk.get(`${CHATS}/${id}.json`));
  chat.updated = ts;
  disk.set(`${CHATS}/${id}.json`, JSON.stringify(chat));
}

(async () => {
  const disk = new Map();
  const transcripts = new Set();

  // --- A chat, then a restart within the hour: it's still there ---
  let zen = await fakeZen({ disk, transcripts });
  await zen.open();
  check("first start: a fresh chat, no Recent yet", !!zen.$(".zai-greeting") && !zen.$(".zai-recent"));
  await zen.send("What is merge sort?");
  await sleep(400);
  const [first] = zen.index();
  check("saved after the first reply", first && first.title === "What is merge sort?" && transcripts.has(first.sessionId), zen.index());
  await zen.close();

  zen = await fakeZen({ disk, transcripts });
  await zen.open();
  check("restart within the hour: the last chat comes back", zen.bubbles().join() === "What is merge sort?" && /Reply to/.test(zen.replies().join()), zen.bubbles());
  check("...and isn't read-only", zen.$(".zai-expired").hidden && !zen.$(".zai-input").disabled);
  await zen.send("And quick sort?");
  check("the next message resumes Claude Code's own transcript", zen.spawns.at(-1).resume === first.sessionId, zen.spawns.map((s) => s.resume));
  await sleep(400);
  check("one chat, now with two exchanges", zen.index().length === 1 && JSON.parse(disk.get(`${CHATS}/${first.id}.json`)).messages.length === 4);
  await zen.close();

  // --- Over an hour later: a fresh chat whose greeting lists Recent ---
  age(disk, first.id, 61);
  zen = await fakeZen({ disk, transcripts });
  await zen.open();
  check("restart after an hour: a fresh chat", !!zen.$(".zai-greeting") && zen.bubbles().length === 0);
  const recentRows = zen.$$(".zai-recent-row");
  check("greeting: Recent lists the old chat", recentRows.length === 1 && /What is merge sort\?/.test(recentRows[0].textContent), zen.$$(".zai-recent-row").map((r) => r.textContent));
  check("no Claude Code process started for the old chat", !zen.spawns.some((s) => s.resume));
  zen.click(recentRows[0]);
  await sleep(80);
  check("clicking a Recent row opens it", zen.bubbles().join("|") === "What is merge sort?|And quick sort?");
  await zen.close();

  // zenai.resumeMinutes widens the window
  zen = await fakeZen({ disk, transcripts, prefs: { resumeMinutes: "120" } });
  await zen.open();
  check("zenai.resumeMinutes = 120 resumes a 61-minute-old chat", zen.bubbles().length === 2);
  await zen.close();

  // --- Expired: Claude Code deleted the transcript ---
  age(disk, first.id, 5);
  transcripts.delete(first.sessionId);
  zen = await fakeZen({ disk, transcripts });
  await zen.open();
  await sleep(80);
  check("expired chat: shown read-only with the banner", zen.bubbles().length === 2 && !zen.$(".zai-expired").hidden &&
    /no longer has this chat/.test(zen.$(".zai-expired").textContent) && zen.$(".zai-input").disabled);
  check("expired chat: no Claude Code process started", zen.spawns.length === 0);
  await sleep(400);
  check("expired is remembered in the index", zen.index()[0].expired === true);
  zen.click(zen.$(".zai-expired-btn"));
  await sleep(50);
  check("Continue in a new chat: fresh chat, the recap waits as a chip", zen.bubbles().length === 0 && zen.$(".zai-expired").hidden &&
    zen.$$(".zai-composer .zai-chip-label").some((c) => c.textContent === "Earlier chat"));
  check("nothing is sent until you send", zen.sent.length === 0);
  await zen.send("Keep going");
  const recapMsg = zen.sent.at(-1).text;
  check("the first message carries a recap of the visible chat", /<earlier_chat title="What is merge sort\?"/.test(recapMsg) && /User: What is merge sort\?/.test(recapMsg) && /Claude: Reply to/.test(recapMsg) && recapMsg.trim().endsWith("Keep going"));
  check("the old chat had web content, so the new one starts with tools off", zen.spawns.at(-1).args[zen.spawns.at(-1).args.indexOf("--tools") + 1] === "");
  check("the sent message shows the recap chip", zen.$$(".zai-thread .zai-user .zai-chip-label").some((c) => c.textContent === "Earlier chat"));
  await zen.send("Second message");
  check("the recap only goes with the first message", !/<earlier_chat/.test(zen.sent.at(-1).text));
  await sleep(400);
  check("both chats are in history", zen.index().map((e) => e.title).sort().join("|") === "Keep going|What is merge sort?");
  const second = zen.index().find((e) => e.title === "Keep going");
  await zen.close();

  // --- Expired found only when --resume fails (transcripts can't be checked) ---
  transcripts.delete(second.sessionId);
  zen = await fakeZen({ disk, transcripts, projectDirExists: false });
  await zen.open();
  check("can't tell up front: the chat opens normally", zen.bubbles().length === 2 && zen.$(".zai-expired").hidden);
  await zen.send("Are you there?", { wait: false });
  await sleep(300);
  check("--resume fails → the reply ends and the chat turns read-only", !zen.$(".zai-expired").hidden && zen.$(".zai-input").disabled && !zen.$(".zai-send.zai-stop") &&
    /no longer has this chat/.test(zen.$(".zai-thread .zai-error").textContent));
  check("no error leaked to the console", zen.errors.length === 0, zen.errors);
  await zen.close();

  // --- Delete: our file and Claude Code's transcript ---
  transcripts.add(second.sessionId); // pretend it's back so delete has something to remove
  zen = await fakeZen({ disk, transcripts });
  await zen.open();
  await zen.openHistory();
  check("history lists both chats", zen.historyRows().sort().join("|") === "Keep going|What is merge sort?", zen.historyRows());
  const row = zen.$$(".zai-hist-row").find((r) => /Keep going/.test(r.textContent));
  zen.click(row.querySelector(".zai-hist-del"));
  zen.click(row.querySelector(".zai-hist-del"));
  await sleep(150);
  check("delete removes the chat file and Claude Code's transcript", !disk.has(`${CHATS}/${second.id}.json`) &&
    zen.removed.includes(`${PROJECT_DIR}/${second.sessionId}.jsonl`) && zen.removed.includes(`${PROJECT_DIR}/${second.sessionId}`) && !transcripts.has(second.sessionId));
  check("the other chat stays", zen.historyRows().join() === "What is merge sort?" && disk.has(`${CHATS}/${first.id}.json`));
  await zen.close();

  // --- Two windows at once share the history ---
  const a = await fakeZen({ disk, transcripts });
  const b = await fakeZen({ disk, transcripts });
  await a.open();
  await b.open();
  a.newChat();
  b.newChat();
  await Promise.all([a.send("From window A"), b.send("From window B")]);
  await sleep(450);
  await a.openHistory();
  check("window A's history shows window B's chat too", a.historyRows().includes("From window B") && a.historyRows().includes("From window A"), a.historyRows());
  check("the index has both", ["From window A", "From window B"].every((t) => a.index().some((e) => e.title === t)));
  await a.close();
  await b.close();

  // --- Private windows save nothing ---
  const before = new Map(disk);
  const p = await fakeZen({ disk, transcripts, isPrivate: true });
  await p.open();
  check("private window: no history button, no Recent", p.historyBtn().hidden && !p.$(".zai-recent"));
  await p.send("Private question");
  p.newChat();
  await sleep(450);
  check("private window: nothing written", disk.size === before.size && [...disk].every(([k, v]) => before.get(k) === v));
  await p.close();

  done();
})().catch(crash);
