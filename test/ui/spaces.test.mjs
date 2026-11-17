// One chat per Zen Space, on the built mod (dist/) in jsdom with Zen's
// workspace API stubbed (see docs/zen-spaces.md): switching swaps the thread,
// a reply started in one Space lands in that Space's chat while another is
// shown (with an unread dot), Spaces never see each other's chats, and idle
// Claude Code processes are capped.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const WORK = { uuid: "space-work", name: "Work" };
const SCHOOL = { uuid: "space-school", name: "School" };
const HOME = { uuid: "space-home", name: "Home" };

(async () => {
  const disk = new Map();
  const transcripts = new Set();
  const zen = await fakeZen({ disk, transcripts, spaces: [WORK, SCHOOL, HOME], replyMs: 500 });
  check("the mod listens for Space switches", zen.listeners.length === 1);
  await zen.open();
  check("starts in Work, with a fresh chat and no Recent", !!zen.$(".zai-greeting") && !zen.$(".zai-recent"));

  // A reply starts in Work, then you switch to School
  await zen.send("Question in Work", { wait: false });
  await sleep(120);
  check("Work's reply is streaming", !!zen.$(".zai-send.zai-stop") && zen.bubbles().join() === "Question in Work");
  await zen.switchSpace(SCHOOL.uuid);
  check("switching swaps the thread: School has its own fresh chat", zen.bubbles().length === 0 && !!zen.$(".zai-greeting"));
  check("School's send button isn't Work's Stop", !zen.$(".zai-send.zai-stop"));
  check("School's greeting has no Recent (Work's chats aren't School's)", !zen.$(".zai-recent"));
  await sleep(700); // Work's reply finishes in the background
  check("Work's reply didn't land in School", zen.bubbles().length === 0 && zen.replies().length === 0);
  check("no unread dot in School for Work's chat", !zen.historyBtn().classList.contains("zai-has-unread"));
  await zen.openHistory();
  check("School's history never lists Work's chats", zen.historyRows().length === 0 && /No chats in School yet/.test(zen.$(".zai-hist-list").textContent));
  check("search is per Space too", zen.$(".zai-hist-search").placeholder === "Search School");
  zen.click(zen.historyBtn());

  await zen.send("Question in School");
  await sleep(400);
  const index = zen.index();
  check("each chat is saved under its own Space", index.find((e) => e.title === "Question in Work").spaceId === WORK.uuid &&
    index.find((e) => e.title === "Question in School").spaceId === SCHOOL.uuid, index.map((e) => [e.title, e.spaceId]));
  const workFile = JSON.parse(disk.get(`/profile/zen-ai/chats/${index.find((e) => e.title === "Question in Work").id}.json`));
  check("the background reply was saved into Work's chat", workFile.messages.length === 2 && /Reply to: Question in Work/.test(workFile.messages[1].blocks[0].text));

  // Back to Work: its chat, with the reply that finished meanwhile
  await zen.switchSpace(WORK.uuid);
  check("back in Work: Work's chat with its finished reply", zen.bubbles().join() === "Question in Work" && /Reply to: Question in Work/.test(zen.replies().join()));
  await zen.openHistory();
  check("Work's history lists only Work's chat", zen.historyRows().join() === "Question in Work", zen.historyRows());
  zen.click(zen.historyBtn());

  // The unread dot: a reply finishing in a chat you've left (same Space)
  zen.newChat();
  await zen.send("Long task in Work", { wait: false });
  await sleep(100);
  await zen.openHistory();
  const firstRow = zen.$$(".zai-hist-row").find((r) => /Question in Work/.test(r.textContent));
  zen.click(firstRow); // look at the older chat while the reply runs
  await sleep(80);
  check("opening another chat doesn't stop the running reply", zen.bubbles().join() === "Question in Work" && zen.sent.length === 3);
  await zen.openHistory();
  const liveDot = zen.$$(".zai-hist-row").find((r) => /Long task/.test(r.textContent)).querySelector(".zai-hist-dot");
  check("while it runs, its row has a pulsing dot", liveDot && liveDot.classList.contains("zai-live"));
  zen.click(zen.historyBtn());
  await sleep(700);
  check("finished: the history button gets a dot", zen.historyBtn().classList.contains("zai-has-unread"));
  await zen.openHistory();
  const doneRow = zen.$$(".zai-hist-row").find((r) => /Long task/.test(r.textContent));
  const dot = doneRow.querySelector(".zai-hist-dot");
  check("...and so does its row, until you look", dot && !dot.classList.contains("zai-live"));
  zen.click(doneRow);
  await sleep(80);
  check("opening it shows the reply and clears the dots", /Reply to: Long task in Work/.test(zen.replies().join()) && !zen.historyBtn().classList.contains("zai-has-unread"));
  await zen.openHistory();
  check("no dot left on the row", !zen.$$(".zai-hist-row").some((r) => r.querySelector(".zai-hist-dot")));
  zen.click(zen.historyBtn());

  // TabSelect alone (a tab from another Space) also switches chats
  await zen.switchSpace(SCHOOL.uuid, { withListeners: false });
  check("TabSelect backup: switching via a tab swaps to School's chat", zen.bubbles().join() === "Question in School");

  // Three Spaces with chats → at most 2 Claude Code processes stay
  await zen.switchSpace(HOME.uuid);
  await zen.send("Question at Home");
  await sleep(50);
  check("at most two Claude Code processes alive", zen.alive() <= 2, zen.alive());
  await zen.switchSpace(WORK.uuid);
  check("Work's chat survived the trimming (it resumes when used)", /Reply to: Long task in Work/.test(zen.replies().join()));
  await zen.send("Follow-up in Work");
  check("its follow-up reaches Claude Code", /Reply to: Follow-up in Work/.test(zen.replies().join()) && zen.alive() <= 2);

  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  check("unload removes the Space listener", zen.listeners.length === 0);
  done();
})().catch(crash);
