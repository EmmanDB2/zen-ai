// browser_wait through the panel: the built mod (dist/) in a jsdom Zen
// window, a fake Claude Code calling the tool, and the real page agent
// checking a jsdom lesson page. Covers: no approval card (it only reads), the
// line in the chat with a countdown and "Stop waiting", each way a wait ends
// (text shows, text goes, a button changes, the video ends, time's up, the
// user ends it, Stop), the cap, and what's saved.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const WAIT = "mcp__zenai__browser_wait";
const PAGE = `<!doctype html><html><body>
<h1>Lesson 4: Lab safety</h1>
<p id="loading">Loading lesson…</p>
<video id="v"></video>
<p id="status">Watch the whole video to continue.</p>
<button id="next" disabled>Next</button>
</body></html>`;

(async () => {
  const zen = await fakeZen({ holdReplies: true, page: PAGE });
  const { $, $$, click, w } = zen;
  const d = zen.webPage().document;
  // A stand-in video on a clock the test sets
  const clip = { duration: NaN, time: 0, playing: false };
  Object.defineProperties(d.getElementById("v"), {
    duration: { get: () => clip.duration },
    currentTime: { get: () => clip.time },
    paused: { get: () => !clip.playing },
    ended: { get: () => clip.duration > 0 && clip.time >= clip.duration },
  });
  const textOf = (res) => (res.content || []).map((c) => c.text || "").join("\n");
  const lines = () => $$(".zai-thread .zai-toolline").map((l) => l.textContent);
  // Ask for and run a wait (no card expected); returns { res, ms }
  const wait = async (args, during) => {
    const perm = await zen.askPermission(WAIT, args);
    if (perm.behavior !== "allow") return { perm };
    const t0 = Date.now();
    const p = zen.callTool("browser_wait", perm.updatedInput);
    if (during) await during();
    const res = await p;
    return { perm, res, ms: Date.now() - t0 };
  };

  await zen.open();
  await zen.send("Watch the lesson video and tell me when it's done", { wait: false });
  await sleep(80);

  // --- Text shows up: ends at the next check after it does ---
  let live = null;
  let pill = "";
  let r = await wait({ seconds: 60, reason: "for the lesson to finish", until_text: "Completed" }, async () => {
    await sleep(300);
    live = $(".zai-waiting");
    pill = $(".zai-agent-pill") ? $(".zai-agent-pill").textContent : "";
    d.getElementById("status").textContent = "Completed ✓";
  });
  check("waiting needs no approval (it only reads)", r.perm.behavior === "allow" && !$(".zai-approval"), r.perm);
  check("while waiting: a line says what for, with a countdown and Stop waiting", live && /Waiting for the lesson to finish/.test(live.textContent) && /[01]:\d\d left/.test(live.textContent) && !!live.querySelector(".zai-wait-stop"), live && live.textContent);
  check("while waiting: the pill over the tab says Claude is waiting", /Claude is waiting/.test(pill), pill);
  check("it ends at the next check once the text shows (about 2 s)", /After 0:0\d: “Completed” is on the page\. Right now the video hasn't started\./.test(textOf(r.res)) && r.ms < 3500, { text: textOf(r.res).slice(0, 120), ms: r.ms });
  check("...the result shows the page now", /The page now:/.test(textOf(r.res)));
  check("...and the line becomes a finished line", !$(".zai-waiting") && lines().some((l) => /^Waited 0:0\d for the lesson to finish · “Completed” is on the page$/.test(l)), lines());

  // --- Already true: no wait at all ---
  r = await wait({ seconds: 30, until_text: "completed" });
  check("already on the page: returns right away, no line", /No need to wait: “completed” is on the page already/.test(textOf(r.res)) && r.ms < 500 && !$(".zai-waiting"), textOf(r.res));

  // --- The loading note goes, then the video plays and ends ---
  r = await wait({ seconds: 30, until_text_gone: "Loading lesson" }, async () => {
    await sleep(200);
    d.getElementById("loading").remove();
    clip.duration = 8; clip.time = 0.5; clip.playing = true;
  });
  check("text gone: ends once it's gone, and says how far the video is", /“Loading lesson” is gone from the page\. Right now the video is at 0:00 of 0:08, playing\./.test(textOf(r.res)), textOf(r.res).slice(0, 200));
  r = await wait({ seconds: 30, reason: "for the video", until_video_ends: true }, async () => {
    await sleep(200);
    clip.time = 8; clip.playing = false;
  });
  check("video: ends when the video does", /the video ended\. Right now the video has ended \(0:08\)/.test(textOf(r.res)), textOf(r.res).slice(0, 200));

  // --- A button that gets enabled (until_changed) ---
  const read = await zen.askPermission("mcp__zenai__browser_read", { full: true });
  const snap = textOf(await zen.callTool("browser_read", read.updatedInput));
  const next = (snap.split("\n").find((l) => /button "Next"/.test(l)) || "").match(/\[(e\d+)\]/)?.[1];
  r = await wait({ seconds: 30, until_changed: next }, async () => {
    await sleep(200);
    d.getElementById("next").disabled = false;
  });
  check("a ref that changes (Next enabled) ends the wait", next && new RegExp(`${next} changed`).test(textOf(r.res)), textOf(r.res).slice(0, 120));
  r = await wait({ seconds: 30, until_changed: "e999" });
  check("a ref that isn't on the page is an error right away", r.res && r.res.isError && /e999 isn't on the page/.test(textOf(r.res)), r.res);

  // --- Time's up ---
  r = await wait({ seconds: 1, until_text: "Download ready" });
  check("time's up: says so, what hasn't happened, and how to keep waiting", /Waited the full 0:01\. “Download ready” isn't on the page yet\./.test(textOf(r.res)) && /Call browser_wait again/.test(textOf(r.res)) && r.ms < 2500, { text: textOf(r.res).slice(0, 160), ms: r.ms });

  // --- The user ends it ---
  r = await wait({ seconds: 9999, reason: "for the download" }, async () => {
    await sleep(300);
    live = $(".zai-waiting");
    click(live.querySelector(".zai-wait-stop"));
  });
  check("the wait is capped (4:30 at most)", /4:[23]\d left/.test(live.textContent), live.textContent);
  check("Stop waiting: ends it quickly, and Claude hears the user ended it", /The user ended the wait after 0:0\d \(of up to 4:30\); they may want you to check now/.test(textOf(r.res)) && r.ms < 1000, { text: textOf(r.res).slice(0, 160), ms: r.ms });
  check("...the line says so", lines().some((l) => /^Waited 0:0\d for the download · you ended the wait$/.test(l)), lines().slice(-2));

  // --- No video to watch ---
  d.getElementById("v").remove();
  r = await wait({ seconds: 30, until_video_ends: true });
  check("until_video_ends with no video: says so right away", /no video on this page or in its frames that can be watched/.test(textOf(r.res)) && r.ms < 500, textOf(r.res));

  // --- Stop (the whole reply) ends a wait too ---
  r = await wait({ seconds: 60, reason: "for the next part" }, async () => {
    await sleep(300);
    click($(".zai-send"));
  });
  check("Stop: the wait ends with the reply", /stopped the reply/.test(textOf(r.res)) && r.ms < 1000 && !$(".zai-waiting"), { text: textOf(r.res), ms: r.ms });
  check("...and the pill no longer says waiting", !($(".zai-agent-pill") && /waiting/.test($(".zai-agent-pill").textContent) && !$("#zai-agent").hidden));

  // --- What's saved: the finished lines, never the live one ---
  await sleep(400);
  const saved = JSON.stringify([...zen.disk.entries()].filter(([k]) => /chats\/(?!index)/.test(k)).map(([, v]) => JSON.parse(v).messages));
  check("history keeps the finished wait lines", /Waited 0:0\d for the lesson to finish · “Completed” is on the page/.test(saved) && /you ended the wait/.test(saved) && !/"pending":true/.test(saved), saved.slice(0, 300));

  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  void w;
  done();
})().catch(crash);
