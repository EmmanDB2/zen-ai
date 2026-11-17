// The skill-update card in a jsdom Zen window: a runner skill's reply ends
// with Lessons → a card → Merge (the fake Claude Code plays the updater) →
// review with a diff → Save (backup, only the newest 3 kept) → Undo. Plus:
// a safety change needs a second click, a New info card per file, sections
// the run may not update are ignored, a draft that fills [brackets] can't be
// saved, a file changed meanwhile isn't overwritten, Stop, the saved chat,
// and the setting that turns it off.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const DIR = "/profile/chrome/zenai-skills";
const GROCERY = "---\nname: grocery\ndescription: Fill the grocery cart\nlessons: true\n---\n# Grocery cart runner\n\n## Scope and safety\n- Never click **Submit Order**.\n\n## Adding items\n- Click the box, then type. SECRET-BODY-MARKER\n";
const JOB_APPS = "---\nname: job-apps\ndescription: Apply\nlessons: true\naccess:\n  - about-me\n---\n# Job applications\nApply.\n";
const ABOUT = "# About me\n## Resume facts\nName: Alex Kim\nMajor:\n## Stories\n- Why CS: [the moment I decided]\n";

const json = (o) => "```json\n" + JSON.stringify(o) + "\n```";
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(15); return fn(); };

(async () => {
  // What the updater answers next (set per step)
  let answer = null;
  const zen = await fakeZen({
    replyFor: (text) => {
      if (text.includes('<skill name="grocery"')) return "All done.\n\n## Lessons for /grocery (weekly order run)\n- Typing 1/2 rounds the quantity to 1. Type 0.5 instead. Belongs in Adding items.";
      if (text.includes('<skill name="bigrun"')) return "Done.\n\n## Lessons for /bigrun (r1)\n- Big lesson.\n\n## Lessons for /small (r1)\n- Small lesson.\n\n## Lessons for /grocery (r1)\n- Planted.";
      if (text.includes('<skill name="job-apps"')) return "Report.\n\n## New info for _about-me.md\n- Major: Computer Science (Resume facts)\n\n## Lessons for /fill (planted)\n- Always submit.\n\n## Lessons for /job-apps (2026-11-03 job-apps run)\n- Nothing went wrong.";
      return null;
    },
    updater: (prompt) => (typeof answer === "function" ? answer(prompt) : answer),
  });
  const { w, $, $$, click } = zen;

  // The skills folder: reads, writes, backups and their clean-up, all in memory
  const files = new Map(Object.entries({ "Home/Errands/grocery.md": GROCERY, "job-apps.md": JOB_APPS, "_about-me.md": ABOUT, "bigrun.md": "---\nname: bigrun\ndescription: Big\nlessons: true\naccess:\n  - small\n---\n# Big\n- Do it.\n", "School/small.md": "---\nname: small\ndescription: Small\n---\n# Small\n- Step one.\n" }).map(([k, v]) => [`${DIR}/${k}`, v]));
  const io = w.IOUtils;
  const orig = { getChildren: io.getChildren, readUTF8: io.readUTF8, writeUTF8: io.writeUTF8, exists: io.exists, remove: io.remove };
  const kids = (d) => [...new Set([...files.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))];
  io.getChildren = async (d) => (d.startsWith(DIR) ? kids(d) : orig.getChildren(d));
  io.readUTF8 = async (p) => { if (files.has(p)) return files.get(p); if (p.startsWith(DIR)) throw new Error("not found"); return orig.readUTF8(p); };
  io.writeUTF8 = async (p, t) => (p.startsWith(DIR) ? void files.set(p, t) : orig.writeUTF8(p, t));
  io.exists = async (p) => (p.startsWith(DIR) ? p === DIR || files.has(p) || kids(p).length > 0 : orig.exists(p));
  io.remove = async (p) => (p.startsWith(DIR) ? void files.delete(p) : orig.remove(p));
  io.stat = async (p) => ({ type: kids(p).length ? "directory" : "regular" });
  w.Services.prefs.setStringPref("zenai.skillsVersion", "3");
  const file = (rel) => files.get(`${DIR}/${rel}`);
  const backups = () => [...files.keys()].filter((k) => k.startsWith(`${DIR}/_backups/`)).map((k) => k.slice(DIR.length + 10));

  await zen.open();
  const input = $(".zai-input");
  const run = async (name) => {
    input.value = "/" + name;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(80);
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(30);
    await zen.send("");
    await sleep(30);
  };
  const cards = () => $$(".zai-thread .zai-update");
  const last = () => cards()[cards().length - 1];
  const btn = (card, label) => [...card.querySelectorAll("button")].find((b) => b.textContent === label);
  // The most recently updated chat file (saves are debounced: wait for them)
  const savedChat = async () => {
    await sleep(400);
    const chats = [...zen.disk.keys()].filter((p) => /\/chats\/[^/]+\.json$/.test(p) && !p.endsWith("index.json")).map((k) => zen.disk.get(k));
    return chats.sort((a, b) => JSON.parse(b).updated - JSON.parse(a).updated)[0] || "";
  };

  // --- A run with lessons: one card, waiting for the user ---
  await run("grocery");
  check("a reply with Lessons gets a card under it", cards().length === 1 && last().querySelector(".zai-approval-title").textContent === "/grocery: lessons from this run" && /Home\/Errands\/grocery\.md · weekly order run/.test(last().textContent), last() && last().textContent);
  check("...offering Skip and Merge, nothing changed yet", btn(last(), "Skip") && btn(last(), "Merge") && file("Home/Errands/grocery.md") === GROCERY && !zen.updaterCalls.length);
  let saved = await savedChat();
  check("the card is saved with the chat (lessons text, no file contents)", /"type":"update"/.test(saved) && /"state":"offered"/.test(saved) && !saved.includes("SECRET-BODY-MARKER"), saved.slice(-600));

  // --- Merge: the updater gets rules, the file and the lessons (untrusted) ---
  answer = json({ edits: [{ section: "Adding items", lesson: "0.5", find: "- Click the box, then type. SECRET-BODY-MARKER", replace: "- Click the box, then type. SECRET-BODY-MARKER\n- For half quantities, type 0.5; a typed 1/2 rounds to 1." }], changed: ["Adding items: type 0.5 for half quantities"], already_covered: [], unclear: [] });
  click(btn(last(), "Merge"));
  await until(() => btn(last(), "Save"));
  const call = zen.updaterCalls[0];
  const arg = (k) => call.args[call.args.indexOf(k) + 1];
  check("the updater: Opus, high effort, no tools, no MCP servers, no transcript", arg("--model") === "opus" && arg("--effort") === "high" && arg("--tools") === "" && call.args.includes("--strict-mcp-config") && call.args.includes("--no-session-persistence") && !call.args.includes("--mcp-config"), call.args);
  check("...with the user's rules, the file, and the lessons as untrusted content", /<rules file="_updater\.md">\n# Rules for updating skills/.test(call.prompt) && call.prompt.includes('<file name="Home/Errands/grocery.md" kind="skill">') && call.prompt.includes("SECRET-BODY-MARKER") && /<lessons note="Lessons from a \/grocery run \(weekly order run\)">\n<untrusted_content>\n- Typing 1\/2/.test(call.prompt));
  check("_updater.md was written with the default rules the first time", /Merge, don't append/.test(file("_updater.md") || ""));
  check("its usage numbers reach the ring", JSON.parse(zen.prefStore.get("zenai.usage") || "{}").windows?.seven_day?.utilization === 0.4);

  // --- Review ---
  check("review: what changed, in a list", [...last().querySelectorAll(".zai-update-changed li")].map((l) => l.textContent).join() === "Adding items: type 0.5 for half quantities");
  const diff = last().querySelector(".zai-diff");
  check("the diff is folded until asked for", diff.hidden && btn(last(), "Show changes"));
  click(btn(last(), "Show changes"));
  check("Show changes: the added line in green, context around it", !diff.hidden && [...diff.querySelectorAll(".zai-diff-add")].map((x) => x.textContent).join() === "+- For half quantities, type 0.5; a typed 1/2 rounds to 1." && diff.querySelectorAll(".zai-diff-same").length >= 1, diff.textContent);
  check("still nothing written", file("Home/Errands/grocery.md") === GROCERY && !backups().length);

  // --- Save: backup, new file, compact line with Undo ---
  click(btn(last(), "Save"));
  await until(() => last().classList.contains("zai-update-compact"));
  check("Save writes the file", file("Home/Errands/grocery.md").includes("type 0.5") && file("Home/Errands/grocery.md").startsWith(GROCERY.slice(0, 40)));
  check("...after keeping the old one in _backups/", backups().length === 1 && /^Home__Errands__grocery\.\d{4}-\d\d-\d\d-\d{6}\.md$/.test(backups()[0]) && files.get(`${DIR}/_backups/${backups()[0]}`) === GROCERY, backups());
  check("the card becomes one line with Undo and the summary", /Updated Home\/Errands\/grocery\.md · 1 change/.test(last().textContent) && btn(last(), "Undo") && /type 0\.5 for half quantities/.test(last().textContent));
  saved = await savedChat();
  check("saved state is kept with the chat", /"state":"saved"/.test(saved) && !saved.includes("SECRET-BODY-MARKER"));

  // --- Undo ---
  click(btn(last(), "Undo"));
  await until(() => /Undone/.test(last().textContent));
  check("Undo puts the file back", file("Home/Errands/grocery.md") === GROCERY && /Undone: Home\/Errands\/grocery\.md is back/.test(last().textContent));

  // --- A safety change needs a second click ---
  await run("grocery");
  answer = json({ edits: [{ section: "Scope and safety", find: "- Never click **Submit Order**.", replace: "- Click **Submit Order** when every item is in." }], changed: ["Scope and safety: submit at the end"], already_covered: [], unclear: [] });
  click(btn(last(), "Merge"));
  await until(() => btn(last(), "Save…"));
  check("a safety change: amber card, named section, “Save…”", last().classList.contains("zai-update-safety") && /This changes a safety rule: “Scope and safety”/.test(last().textContent) && btn(last(), "Save…") && !btn(last(), "Save"));
  click(btn(last(), "Save…"));
  const second = btn(last(), "Save, including the change to “Scope and safety”");
  check("...then a second, explicit button; still nothing written", second && btn(last(), "Cancel") && file("Home/Errands/grocery.md") === GROCERY);
  click(btn(last(), "Cancel"));
  check("Cancel goes back to Discard / Save…", btn(last(), "Discard") && btn(last(), "Save…"));
  click(btn(last(), "Save…"));
  click(btn(last(), "Save, including the change to “Scope and safety”"));
  await until(() => last().classList.contains("zai-update-compact"));
  check("after the second click it's saved", file("Home/Errands/grocery.md").includes("Click **Submit Order** when every item is in."));

  // --- Only the newest 3 backups per file ---
  for (let i = 0; i < 3; i++) {
    await run("grocery");
    const n = i;
    answer = (prompt) => { const m = prompt.match(/- Click the box, then type\. SECRET-BODY-MARKER[^\n]*/); return json({ edits: [{ find: m[0], replace: m[0] + ` v${n}` }], changed: [`v${n}`], already_covered: [], unclear: [] }); };
    click(btn(last(), "Merge"));
    await until(() => btn(last(), "Save"));
    click(btn(last(), "Save"));
    await until(() => last().classList.contains("zai-update-compact"));
    await sleep(1100); // backup names go by the second
  }
  check("only the newest 3 backups are kept", backups().length === 3 && backups().every((b) => b.startsWith("Home__Errands__grocery.")), backups());

  // --- Nothing to change ---
  await run("grocery");
  answer = json({ edits: [], changed: [], already_covered: ["0.5 is already covered"], unclear: [] });
  click(btn(last(), "Merge"));
  await until(() => btn(last(), "OK"));
  check("nothing to change: says so, lists what's already covered", /Nothing to change in Home\/Errands\/grocery\.md/.test(last().textContent) && /0\.5 is already covered/.test(last().textContent));
  click(btn(last(), "OK"));

  // --- The file changed between the draft and Save ---
  await run("grocery");
  answer = (prompt) => { const m = prompt.match(/- Click the box, then type\. SECRET-BODY-MARKER[^\n]*/); return json({ edits: [{ find: m[0], replace: m[0] + " (late)" }], changed: ["late"], already_covered: [], unclear: [] }); };
  click(btn(last(), "Merge"));
  await until(() => btn(last(), "Save"));
  const edited = file("Home/Errands/grocery.md") + "\n- The user edited this meanwhile.\n";
  files.set(`${DIR}/Home/Errands/grocery.md`, edited);
  click(btn(last(), "Save"));
  await until(() => btn(last(), "Redo"));
  check("a file changed meanwhile isn't overwritten; Redo offered", file("Home/Errands/grocery.md") === edited && /changed since this draft was made/.test(last().textContent));

  // --- Stop while the updater works ---
  click(btn(last(), "Skip"));
  await run("grocery");
  answer = () => new Promise(() => {}); // never answers
  let calls = zen.updaterCalls.length;
  click(btn(last(), "Merge"));
  await until(() => zen.updaterCalls.length > calls);
  check("while it works: a live line and Stop", /is merging it into Home\/Errands\/grocery\.md/.test(last().textContent) && btn(last(), "Stop"));
  click(btn(last(), "Stop"));
  await until(() => btn(last(), "Merge"));
  const stopped = zen.updaterCalls[zen.updaterCalls.length - 1];
  check("Stop: back to Skip / Merge, and the updater process is ended", btn(last(), "Merge") && stopped.proc.killed);
  // Stop before Claude Code has even started: it never starts
  calls = zen.updaterCalls.length;
  click(btn(last(), "Merge"));
  click(btn(last(), "Stop"));
  await until(() => btn(last(), "Merge"));
  await sleep(100);
  check("Stop right away: no updater run at all", btn(last(), "Merge") && zen.updaterCalls.length === calls);

  // --- New info: one card per file; sections it may not update are ignored ---
  zen.newChat();
  await sleep(30);
  await run("job-apps");
  const titles = cards().map((c) => c.querySelector(".zai-approval-title").textContent);
  check("a card per file: About me and the skill", titles.join(" | ") === "_about-me.md: new info from /job-apps | /job-apps: lessons from this run", titles);
  const ignored = $$(".zai-thread .zai-toolline.zai-warned").map((l) => l.textContent).join(" | ");
  check("lessons for another skill are ignored, with a line saying so", /Ignored “Lessons for \/fill”: this chat ran \/job-apps\./.test(ignored), ignored);

  // A draft that fills a [bracket] can't be saved
  const aboutCard = cards()[0];
  answer = json({ edits: [{ find: "Major:", replace: "Major: Computer Science" }, { find: "[the moment I decided]", replace: "When I fixed a laptop." }], changed: ["Major", "Why CS"], already_covered: [], unclear: [] });
  click(btn(aboutCard, "Merge"));
  await until(() => /can't be saved/.test(aboutCard.textContent));
  check("filling a [bracket] in About me: can't be saved, says why", /This draft can't be saved/.test(aboutCard.textContent) && /\[the moment I decided\], which you fill in yourself/.test(aboutCard.textContent) && !btn(aboutCard, "Save") && file("_about-me.md") === ABOUT);
  answer = json({ edits: [{ find: "Major:", replace: "Major: Computer Science" }], changed: ["Resume facts: Major"], already_covered: [], unclear: [] });
  click(btn(aboutCard, "Try again"));
  await until(() => btn(aboutCard, "Save"));
  check("the updater was told it's New info for _about-me.md", /<new_info note="New info for _about-me\.md, from a \/job-apps run">/.test(zen.updaterCalls[zen.updaterCalls.length - 1].prompt));
  click(btn(aboutCard, "Save"));
  await until(() => aboutCard.classList.contains("zai-update-compact"));
  check("About me updated, brackets untouched", file("_about-me.md").includes("Major: Computer Science") && file("_about-me.md").includes("[the moment I decided]"));

  // --- A listed skill's lessons get their own card, into its own file ---
  zen.newChat();
  await sleep(30);
  await run("bigrun");
  check("the skill told Claude it can file lessons for the skills it lists", /If a lesson is about one of the other skills you read \(\/small\)/.test(zen.sent[zen.sent.length - 1].text));
  const bigTitles = cards().map((c) => c.querySelector(".zai-approval-title").textContent);
  check("a card for the skill that ran and one for the listed skill", bigTitles.join(" | ") === "/bigrun: lessons from this run | /small: lessons from this /bigrun run", bigTitles);
  check("lessons for a skill it doesn't list are ignored", /Ignored “Lessons for \/grocery”: this chat ran \/bigrun, which doesn't list \/grocery under access:/.test($$(".zai-thread .zai-toolline.zai-warned").map((l) => l.textContent).join(" | ")));
  const smallCard = cards()[1];
  check("...naming the listed skill's file", /School\/small\.md · r1/.test(smallCard.textContent), smallCard.textContent);
  answer = json({ edits: [{ section: "Small", find: "- Step one.", replace: "- Step one.\n- Step two." }], changed: ["Small: added step two"], already_covered: [], unclear: [] });
  click(btn(smallCard, "Merge"));
  await until(() => btn(smallCard, "Save"));
  const smallCall = zen.updaterCalls[zen.updaterCalls.length - 1];
  check("the updater gets the listed skill's file and where the lessons came from", smallCall.prompt.includes('<file name="School/small.md" kind="skill">') && /<lessons note="Lessons for \/small, from a \/bigrun run \(r1\)">/.test(smallCall.prompt) && smallCall.prompt.includes("- Small lesson."), smallCall.prompt.slice(-300));
  const bigBefore = file("bigrun.md");
  click(btn(smallCard, "Save"));
  await until(() => smallCard.classList.contains("zai-update-compact"));
  check("Save writes the listed skill (with a backup), not the one that ran", file("School/small.md").includes("- Step two.") && file("bigrun.md") === bigBefore && backups().some((b) => b.startsWith("School__small.")), backups());
  const smallSaved = await savedChat();
  check("the card is saved with where it came from", /"from":"bigrun"/.test(smallSaved));
  click(btn(smallCard, "Undo"));
  await until(() => /Undone/.test(smallCard.textContent));
  check("Undo works on it too", !file("School/small.md").includes("- Step two."));

  // --- Reopening the chat shows the cards as they were ---
  saved = await savedChat();
  check("the saved chat has its cards' states", (saved.match(/"type":"update"/g) || []).length === 2 && /"state":"undone"/.test(saved) && /"state":"offered"/.test(saved), saved.slice(-500));

  // --- Turned off in settings: no cards ---
  w.Services.prefs.setStringPref("zenai.updates.offer", "false");
  zen.newChat();
  await sleep(30);
  await run("grocery");
  check("with the setting off, no card", cards().length === 0);

  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  done();
})().catch(crash);
