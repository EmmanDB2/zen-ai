// Frames from another site, in real Zen (each site in its own process): a
// course page whose lesson player is embedded from another site, with a
// question, a password field, a video and a survey inside, and a glossary
// frame inside the player. Claude Code is played by the test; the clicks
// on approval cards are the user's. Covers reading frames (refs like f1.e2),
// clicking and typing in them (with real, trusted events), the card naming
// the frame's site, protected fields, waiting for the frame's video, a point
// from a screenshot over the frame, the submit warning, keys going into the
// frame, a frame inside a frame, and refs that go stale when a frame loads
// another page.
import { checker, crash } from "../helpers/common.mjs";
import { realZen, sleep, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const COURSE = "frames-course";

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ holdReplies: true });
  try {
    await zen.openTab(zen.page("frames.html?video=3"));
    await zen.open();
    await zen.send("Do this lesson for me", { wait: false });
    const inFrame = (fn, args = []) => zen.inPage(fn, { frame: COURSE, args });

    // --- Reading: the player's inside, with refs that name the frame ---
    let text = textOf(await zen.tool("browser_read", {}));
    const refOf = (src, label, role) => (src.match(new RegExp(`\\[(f\\d+\\.e\\d+)\\] ${role} "${label}"`)) || [])[1];
    check("the read includes the player, a frame from another site", /Embedded frame f1: “Course player” from localhost:\d+, 900×600\. Refs inside it start with f1\./.test(text), text.slice(0, 500));
    const goggles = refOf(text, "Goggles", "radio");
    const notes = refOf(text, "Notes", "textbox");
    const code = refOf(text, "Unlock code", "textbox");
    const next = refOf(text, "Next", "button");
    check("its radios, fields and Next have frame refs", !!(goggles && notes && code && next), { goggles, notes, code, next });
    check("...with the question as their group", /radio "Goggles" unchecked group="Which of these should you wear when handling chemicals\?"/.test(text));
    check("its password field is marked protected", /"Unlock code" type=password PROTECTED/.test(text));
    check("no unlabeled extra fields (Firefox's own widgets inside inputs)", !/\(no label\)/.test(text), text);
    check("small frames are listed, not read: the ad, and the glossary inside the player", /Other embedded frames \(not read; browser_read with frame: "f\d+" reads one\): f\d+ “Sponsored” from localhost:\d+ \(300×90\), f\d+ “Glossary” from 127\.0\.0\.1:\d+ \(260×44\)/.test(text), text.slice(-400));
    check("a hidden frame isn't mentioned", (text.match(/Sponsored/g) || []).length === 1);
    check("the page's own refs stay as they were", /\[e1\] button "Help"/.test(text));

    // --- A click in the frame: the card names its site; real mouse events ---
    let perm = zen.askPermission("mcp__zenai__browser_click", { ref: goggles });
    let card = await zen.approve("once");
    check("the card: Click “Goggles”, a radio in a frame from the other site", card.title === "Click “Goggles”" && /^radio in a frame from localhost:\d+ on 127\.0\.0\.1:\d+$/.test(card.sub), card);
    let res = await zen.callTool("browser_click", (await perm).updatedInput);
    check("the result says it clicked it in frame f1", /^Clicked “Goggles” in frame f1\./.test(textOf(res)), textOf(res).slice(0, 200));
    check("...and shows the change inside the frame", textOf(res).includes(`[${goggles}] radio "Goggles" checked`), textOf(res));
    let inner = await inFrame((win) => ({ checked: win.document.querySelector("input[value=goggles]").checked, log: win.wrappedJSObject.log.slice() }));
    check("in the frame, Goggles is checked", inner.checked, inner);
    check("...by real (trusted) mouse events", inner.log.includes("mousedown:ppe:true") && inner.log.includes("click:ppe:true"), inner.log);

    // --- Typing in the frame ("Allow on this site": the tab's site covers its frames) ---
    perm = zen.askPermission("mcp__zenai__browser_type", { ref: notes, text: "Wear goggles" });
    card = await zen.approve("site");
    check("the typing card names the frame's site too", card.title === "Type into “Notes”" && /^in a frame from localhost:\d+ on 127\.0\.0\.1:\d+$/.test(card.sub), card);
    res = await zen.callTool("browser_type", (await perm).updatedInput);
    inner = await inFrame((win) => ({ value: win.document.getElementById("notes").value, log: win.wrappedJSObject.log.filter((l) => l.startsWith("input:")) }));
    check("typed into the frame's box", inner.value === "Wear goggles" && /^Typed into “Notes” in frame f1\./.test(textOf(res)), { inner, res: textOf(res).slice(0, 120) });
    res = await zen.tool("browser_type", { ref: code, text: "1234" });
    inner = await inFrame((win) => win.document.getElementById("code").value);
    check("its password field is refused, like anywhere", /password/.test(res.denied || "") && inner === "", { res, inner });

    // --- Next (site allowed: no card), then wait for the frame's video ---
    res = await zen.tool("browser_click", { ref: next });
    check("Next: no card on an allowed site", !(await zen.card()) && /^Clicked “Next” in frame f1\./.test(textOf(res)), textOf(res).slice(0, 160));
    check("...and the result shows the video step (only what changed)", /Changes since your last look/.test(textOf(res)) && /\[f1\.e\d+\] button "Continue" disabled/.test(textOf(res)), textOf(res));
    const t0 = Date.now();
    res = await zen.tool("browser_wait", { seconds: 30, reason: "for the lesson video", until_video_ends: true });
    check("browser_wait sees the frame's video end (3 s)", /^After 0:0[2-6]: the video ended\. Right now the video has ended \(0:03\)\./.test(textOf(res)) && Date.now() - t0 < 9000, textOf(res).slice(0, 160));
    check("...and the page now shows Continue enabled", /\[f1\.e\d+\] button "Continue"(?! disabled)/.test(textOf(res)), textOf(res));

    // --- A point from a screenshot, over the frame: Continue ---
    const shot = await zen.tool("browser_screenshot", {});
    const size = textOf(shot).match(/(\d+)×(\d+) px/);
    const topWin = await zen.inPage((win) => { const r = win.document.getElementById("player").getBoundingClientRect(); return { w: win.innerWidth, x: r.left + 1, y: r.top + 1 }; });
    const btn = await inFrame((win) => { const r = win.document.getElementById("continue").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const ratio = Number(size[1]) / topWin.w;
    const point = { x: Math.round((topWin.x + btn.x) * ratio), y: Math.round((topWin.y + btn.y) * ratio) };
    res = await zen.tool("browser_click", { point });
    check("a click at a point over the frame lands on its Continue button", /^Clicked “Continue” in frame f1 at \(\d+, \d+\) in your screenshot\./.test(textOf(res)), textOf(res).slice(0, 200));
    check("...and the tool line says what and where", (await zen.lines()).some((l) => /^Click “Continue” · allowed on this site$/.test(l)), await zen.lines());
    check("...with a new screenshot to check it", (res.content || []).some((c) => c.type === "image"));
    inner = await inFrame((win) => win.document.getElementById("where").textContent);
    check("the survey step is showing", inner === "Quick survey", inner);

    // --- The survey's submit button still asks, with the warning ---
    const now = textOf(await zen.tool("browser_read", { full: true }));
    const submit = refOf(now, "Submit survey", "button");
    const more = refOf(now, "Anything else you'd like to tell us\\?", "textbox");
    perm = zen.askPermission("mcp__zenai__browser_click", { ref: submit });
    card = await zen.approve("deny");
    check("submitting inside the frame asks even on an allowed site, with the warning", /submits a form/.test(card.warn) && card.title === "Click “Submit survey”", card);
    check("...and denying it stops it", (await perm).behavior === "deny");

    // --- Keys: focus in the frame, a key without a ref goes there ---
    await zen.tool("browser_click", { ref: more });
    res = await zen.tool("browser_press_key", { key: "Tab" });
    inner = await inFrame((win) => win.document.activeElement && win.document.activeElement.id);
    check("Tab (no ref) goes to the focused frame: focus moves to Submit", inner === "submit" && /in frame f1\.$/.test(textOf(res).split("\n")[0]), { inner, res: textOf(res).slice(0, 120) });

    // --- A frame inside the frame (the glossary, back on the course's own site) ---
    const key = (now.match(/(f\d+) “Glossary”/) || [])[1];
    text = textOf(await zen.tool("browser_read", { frame: key }));
    const define = refOf(text, "Define PPE", "button");
    check("browser_read with frame reads a listed frame", new RegExp(`^Embedded frame ${key}: “Glossary” from 127\\.0\\.0\\.1:\\d+`).test(text.split("\n").slice(2).join("\n")) && !!define, text.slice(0, 400));
    res = await zen.tool("browser_click", { ref: define });
    inner = await zen.inPage((win) => win.document.getElementById("def").textContent, { frame: "frames-glossary" });
    check("clicking in a frame inside a frame works", inner === "PPE: personal protective equipment" && new RegExp(`in frame ${key}\\.`).test(textOf(res).split("\n")[0]), { inner, res: textOf(res).slice(0, 120) });
    check("...and from then on it's read along with the page", textOf(res).includes(`[${define}] button "Define PPE"`) || new RegExp(`Embedded frame ${key}`).test(textOf(await zen.tool("browser_read", { full: true }))));

    // --- The player loads another page: its old refs fail instead of landing elsewhere ---
    await zen.inPage((win) => { win.document.getElementById("player").src = win.document.getElementById("ad").src; return true; });
    await sleep(1200);
    res = await zen.tool("browser_click", { ref: submit });
    check("an old ref in a frame that loaded a new page is refused", /f1 isn't on the page anymore/.test(res.denied || ""), res);
    text = textOf(await zen.tool("browser_read", {}));
    check("the next read gives that frame a new key", /Embedded frames from other sites now: f\d+ “Course player”/.test(text) && !/Embedded frames[^\n]*\bf1\b/.test(text) && !/\[f1\./.test(text), text.slice(0, 600));

    check("no errors in Zen's console", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
