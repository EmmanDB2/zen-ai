// The page agent's side of frames from another site, in Chromium (which,
// like Firefox, keeps a frame from another site out of the page's reach):
// the course page with its lesson player from the other site. Firefox would
// give the agent each <iframe>'s BrowsingContext id; here the test sets one.
// Covers: frames listed in a snapshot (where, how big, how much shows), the
// player's own snapshot with refs named after its key (f1.e2) and "in view"
// meaning the frame is too, points over the frame handed on in its own
// pixels (describe, click, drag; mixed ends refused), a key with focus in it
// handed on, scrolling a page that only scrolls inside it, frameBox, and the
// video's size for picking the main one. (The rest, in real Zen: test/zen/.)
import { checker, crash, launchChromium, pageAgentRunner, servePages, src } from "../helpers/common.mjs";
import { pathToFileURL } from "node:url";

const { check, done } = checker();

(async () => {
  const site = await servePages();
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await page.goto(`${site.originA}/frames.html?video=2`);
  await page.waitForFunction(() => document.getElementById("player").getBoundingClientRect().height > 0);
  await page.waitForTimeout(500);
  // Firefox's BrowsingContext ids for the frames from the other site
  await page.evaluate(() => {
    const ids = { player: 77, ad: 78, tracker: 79 };
    for (const [id, bc] of Object.entries(ids)) Object.defineProperty(document.getElementById(id), "browsingContext", { value: { id: bc } });
  });
  const agent = await pageAgentRunner(page);
  // The same agent inside the player (Playwright can reach the frame; the page can't)
  const { pageAgent } = await import(pathToFileURL(src("page-agent.mjs")).href);
  const player = page.frames().find((f) => f.url().includes("frames-course"));
  const inPlayer = (args) => player.evaluate(([s, a]) => (0, eval)("(" + s + ")")(window, a, null), [pageAgent.toString(), args]);

  // --- The page's snapshot lists its frames from other sites ---
  const snap = await agent({ action: "snapshot" });
  const byBc = new Map(snap.frames.map((f) => [f.bc, f]));
  const pf = byBc.get(77);
  check("the player is listed with its name, box and how much of it shows", pf && pf.name === "Course player" && pf.w === 900 && pf.h === 600 && pf.visible && pf.seenW === 900 && pf.seenH > 0, pf);
  const el = await page.evaluate(() => { const f = document.getElementById("player"); const r = f.getBoundingClientRect(); return { x: r.left + f.clientLeft, y: r.top + f.clientTop }; });
  check("...the box is its inside (past the border)", pf && Math.abs(pf.x - el.x) < 0.01 && Math.abs(pf.y - el.y) < 0.01, { pf, el });
  check("the ad is listed too; the hidden tracker isn't visible", byBc.get(78) && byBc.get(78).visible && byBc.get(79) && !byBc.get(79).visible, snap.frames);
  check("the page's own list doesn't include the frames' insides", !/Goggles/.test(snap.text) && /\[e1\] button "Help"/.test(snap.text));
  check("the snapshot gives the viewport size", snap.vw === 1200 && snap.vh === 800, { vw: snap.vw, vh: snap.vh });

  // --- The player's own snapshot: refs with its key, its words on request ---
  const fs = await inPlayer({ action: "snapshot", prefix: "f1.", offset: { x: pf.x, y: pf.y }, vh: 800, withText: true });
  check("refs inside are shown with the frame's key", /\[f1\.e1\] radio "Goggles" unchecked/.test(fs.text) && fs.rows[0][0] === "f1.e1", fs.text.slice(0, 300));
  check("...but stored plainly on the page (e1)", (await player.evaluate(() => document.querySelector("input[value=goggles]").getAttribute("data-zai-ref"))) === "e1");
  check("its last line says frame, not page", /Scrolled \d+% down the frame\.$/.test(fs.text), fs.text.slice(-60));
  check("withText gives the frame's words", /Which of these should you wear/.test(fs.bodyText || ""), (fs.bodyText || "").slice(0, 80));
  const below = await inPlayer({ action: "snapshot", prefix: "f1.", offset: { x: 0, y: 900 }, vh: 800 });
  check("in view means the frame is too: a frame below the tab's view puts its rows below view", below.rows.every(([, , where]) => where === "(below view)"), below.rows.map((r) => r[2]));
  const ok = await inPlayer({ action: "describe", refs: ["e1", "e6"] });
  check("describe inside the frame, by its own refs", ok.items[0].label === "Goggles" && ok.items[1].label === "Next" && ok.items[1].role === "button", ok.items);

  // --- A point over the frame: handed on, in the frame's own pixels ---
  const shot = { ...(await agent({ action: "viewport" })), ratio: 1 };
  const inside = await player.evaluate(() => { const r = document.getElementById("next1").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const pt = { x: pf.x + inside.x, y: pf.y + inside.y };
  const d = await agent({ action: "describe", refs: [], points: [pt], shot });
  const s = d.spots[0];
  check("a point over the frame is on a frame from another site", s.found && s.role === "frame" && s.label === "Course player" && s.remote && s.remote.bc === 77, s);
  check("...with the point in the frame's own pixels", Math.abs(s.remote.x - inside.x) < 1 && Math.abs(s.remote.y - inside.y) < 1, { remote: s.remote, inside });
  const there = await inPlayer({ action: "describe", refs: [], points: [{ x: s.remote.x, y: s.remote.y }], local: true });
  check("...where the frame's agent finds its Next button", there.spots[0].found && there.spots[0].label === "Next" && there.spots[0].role === "button", there.spots[0]);
  const outside = await inPlayer({ action: "describe", refs: [], points: [{ x: 5000, y: 10 }], local: true });
  check("a point outside the frame's window is refused", !outside.spots[0].found && /isn't inside the frame/.test(outside.spots[0].error), outside.spots[0]);
  const click = await agent({ action: "click", at: pt, shot });
  check("a click there isn't sent to the <iframe>: it's handed on", click.forward && click.forward.bc === 77 && Math.abs(click.forward.x - inside.x) < 1, click);
  const clicked = await inPlayer({ action: "click", at: { x: click.forward.x, y: click.forward.y }, local: true });
  check("...and the frame's agent clicks Next", clicked.label === "Next" && (await player.evaluate(() => !document.getElementById("step2").hidden)), clicked);

  // --- Drags: both ends in the frame are handed on; mixed ends aren't allowed ---
  const drag = await agent({ action: "drag", fromAt: pt, toAt: { x: pt.x + 40, y: pt.y }, shot, by: null });
  check("a drag with both points in the frame is handed on with both", drag.forward && drag.forward.bc === 77 && drag.forward.fromAt && drag.forward.toAt && Math.abs(drag.forward.toAt.x - drag.forward.fromAt.x - 40) < 1, drag);
  // (a screenshot at half size: points and offsets in its pixels)
  const byOnly = await agent({ action: "drag", fromAt: { x: pt.x / 2, y: pt.y / 2 }, shot: { ...shot, ratio: 0.5 }, by: { x: 20, y: 0 } });
  check("...a drag by an offset from a point in it too (passed on in CSS pixels)", byOnly.forward && byOnly.forward.by.x === 40 && Math.abs(byOnly.forward.fromAt.x - inside.x) < 1, byOnly);
  const mixed = await agent({ action: "drag", fromAt: pt, toAt: { x: 30, y: 30 }, shot });
  check("from the frame to the page isn't possible", /same frame/.test(mixed.error || ""), mixed);

  // --- Keys: focus inside the frame → handed on ---
  await player.evaluate(() => document.getElementById("continue").removeAttribute("disabled"));
  await page.evaluate(() => document.getElementById("player").focus());
  const key = await agent({ action: "key", key: "Tab" });
  check("a key while focus is in the frame is handed on", key.forward && key.forward.bc === 77, key);
  const keyRef = await agent({ action: "key", key: "Tab", ref: "e1" });
  check("...but a key on a ref of the page goes to the page", !keyRef.forward && !keyRef.error, keyRef);

  // --- Scrolling a page that only scrolls inside a big frame ---
  const fill = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await fill.goto(`${site.originA}/frames.html`);
  await fill.evaluate(() => {
    document.body.style.cssText = "margin:0;overflow:hidden";
    document.body.innerHTML = '<iframe id="big" style="position:fixed;inset:0;width:100%;height:100%;border:0" src="about:blank"></iframe>';
    Object.defineProperty(document.getElementById("big"), "contentDocument", { value: null });
    Object.defineProperty(document.getElementById("big"), "browsingContext", { value: { id: 91 } });
  });
  const fillAgent = await pageAgentRunner(fill);
  const sc = await fillAgent({ action: "scroll", direction: "down" });
  check("a page that doesn't scroll, filled by a frame: the scroll is handed on to it", sc.forward && sc.forward.bc === 91, sc);
  await fill.close();

  // --- frameBox: where a frame is (and bring it into view) ---
  await page.evaluate(() => window.scrollTo(0, 400));
  const box = await agent({ action: "frameBox", bc: 78, show: true });
  check("frameBox finds a frame by its id and scrolls it into view", box.visible && box.y >= 0 && box.y + box.h <= 800 && box.w === 300, box);
  const gone = await agent({ action: "frameBox", bc: 12345 });
  check("...and says so for one that isn't there", /isn't on the page anymore/.test(gone.error || ""), gone);

  // --- The video's size, so the main one can be picked across frames ---
  await player.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const w = await inPlayer({ action: "watch" });
  check("watch reports the video's size on screen", w.video && w.video.area === 320 * 60, w.video);

  await browser.close();
  site.close();
  done();
})().catch(crash);
