// Clicking and dragging at points from a screenshot, with the real page agent
// in Chromium, for things a page read can't list: a slider drawn in SVG with
// no roles, a canvas graph, a button in a same-site frame. Also: what a point
// is on (for the approval card), a shrunk screenshot (ratio), a page scrolled
// since the screenshot, and a page that changed.
//
// Each runs twice: synthetic events, then through the stand-in for Firefox's
// real mouse (as in drag.test.mjs).
import { checker, crash, launchChromium, pageAgentRunner, pageUrl } from "../helpers/common.mjs";

const { check, done } = checker();

function nativeMouse() {
  window.nativeLog = [];
  window.windowUtils = {
    sendMouseEvent(type, x, y, button, clickCount, modifiers, ignore, pressure, source, synth, widget, buttons = type === "mousedown" ? 1 : 0) {
      const t = document.elementFromPoint(x, y);
      window.nativeLog.push(type);
      if (!t) return false;
      const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button, buttons, detail: clickCount };
      const ptype = { mousedown: "pointerdown", mousemove: "pointermove", mouseup: "pointerup" }[type];
      t.dispatchEvent(new PointerEvent(ptype, Object.assign({ pointerId: 1, isPrimary: true, pointerType: "mouse" }, init)));
      const go = t.dispatchEvent(new MouseEvent(type, init));
      if (type === "mouseup") t.dispatchEvent(new MouseEvent("click", init)); // a real release clicks too
      return !go;
    },
  };
}

(async () => {
  const browser = await launchChromium();
  for (const native of [false, true]) {
    const tag = native ? "real mouse" : "synthetic";
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
    await page.goto(pageUrl("points.html"));
    if (native) await page.evaluate(nativeMouse);
    const agent = await pageAgentRunner(page);
    const log = () => page.evaluate(() => JSON.parse(JSON.stringify(window.log)));

    // The screenshot's geometry, as the panel keeps it
    const view = await agent({ action: "viewport" });
    const shot = { ratio: 1, sx: view.sx, sy: view.sy, doc: view.doc };
    if (!native) {
      check("viewport: size, scroll and the document's id", view.w === 1000 && view.h === 700 && view.sx === 0 && /^\w{4,}$/.test(view.doc), view);
      const snap = await agent({ action: "snapshot" });
      check("read: the SVG and canvas are named as graphics without refs", /Drawn graphics with no refs inside: svg 520×80, canvas 400×300\. To click or drag something in one, take a browser_screenshot/.test(snap.text), snap.text.split("\n").filter((l) => /graphic/.test(l)));
      check("read: same document id as the viewport", snap.docId === view.doc);
      const d = await agent({ action: "describe", refs: [], points: [{ x: 320, y: 120 }, { x: 680, y: 220 }, { x: 5, y: 650 }], shot });
      const [dotSpot, btn, empty] = d.spots;
      check("describe: a point on the SVG dot is a spot, named by its tag", dotSpot.found && dotSpot.role === "spot" && dotSpot.what === "circle#dot" && dotSpot.label === "", dotSpot);
      check("describe: ...with a small box around the point to highlight", dotSpot.rect.w === 28 && Math.round(dotSpot.rect.x) === 306 && Math.round(dotSpot.rect.y) === 106, dotSpot.rect);
      check("describe: a point on a button is that button, with the submit warning", btn.role === "button" && btn.label === "Submit answer" && /Submit answer/.test(btn.submits), btn);
      check("describe: an empty part of the page is a spot too", empty.found && empty.role === "spot", empty);
      check("describe: nothing was scrolled", (await page.evaluate(() => window.scrollY)) === 0);
    }

    // SVG slider: from the dot (3) to tick 0
    let r = await agent({ action: "drag", fromAt: { x: 320, y: 120 }, toAt: { x: 80, y: 120 }, shot });
    check(`${tag}: SVG slider dragged from 3 to 0`, !r.error && (await log()).peaks === 0 && (await page.evaluate(() => document.getElementById("val").textContent)) === "0", { r, log: await log() });
    check(`${tag}: ...and the result names what was dragged`, r.what === "circle#dot" && r.how === "mouse", r);
    if (native) {
      const nl = await page.evaluate(() => window.nativeLog.slice());
      check("real mouse: the drag was a real press, moves and release", nl.includes("mousedown") && nl.filter((x) => x === "mousemove").length >= 10 && nl.at(-1) === "mouseup", nl.join(" "));
    }

    // A screenshot shrunk to half size: points are in its pixels (0 → 2: css 80 → 240)
    const half = { ...shot, ratio: 0.5 };
    r = await agent({ action: "drag", fromAt: { x: 40, y: 60 }, toAt: { x: 120, y: 60 }, shot: half });
    check(`${tag}: a half-size screenshot's points map back (0 → 2)`, !r.error && (await log()).peaks === 2, { r, log: await log() });
    // ...and by is in screenshot pixels with a point (2 → 3: 40 screenshot px = 80 css px)
    r = await agent({ action: "drag", fromAt: { x: 120, y: 60 }, by: { x: 40, y: 0 }, shot: half });
    check(`${tag}: by is in screenshot pixels with from_point (2 → 3)`, !r.error && (await log()).peaks === 3, { r, log: await log() });

    // Canvas: drag the red point from canvas (100, 200) to (300, 100)
    r = await agent({ action: "drag", fromAt: { x: 140, y: 380 }, toAt: { x: 340, y: 280 }, shot });
    let L = await log();
    check(`${tag}: canvas point dragged (both ends on the same canvas)`, !r.error && L.point.x === 300 && L.point.y === 100 && !L.added.length, { r, L });
    // Canvas: click to add a point at canvas (200, 50)
    r = await agent({ action: "click", at: { x: 240, y: 230 }, shot });
    L = await log();
    check(`${tag}: a click at a point on the canvas lands there`, !r.error && L.added.length === 1 && L.added[0].x === 200 && L.added[0].y === 50, { r, L });
    check(`${tag}: ...and the result names the canvas`, r.what === "canvas#graph", r);

    // A button inside a same-site frame
    r = await agent({ action: "click", at: { x: 680, y: 335 }, shot });
    check(`${tag}: a point inside a same-site frame clicks its button`, !r.error && (await log()).frameClicks === 1 && r.label === "Inside frame", { r, log: await log() });

    // The page scrolled since the screenshot: the same point still finds the button
    await page.evaluate(() => window.scrollTo(0, 100));
    r = await agent({ action: "click", at: { x: 680, y: 220 }, shot });
    check(`${tag}: after scrolling, a point from the screenshot still hits what it showed`, !r.error && (await log()).submits === 1 && r.label === "Submit answer", { r, log: await log() });
    r = await agent({ action: "click", at: { x: 100, y: 30 }, shot });
    check(`${tag}: a point that has scrolled out of view is refused`, /isn't on screen anymore/.test(r.error || ""), r);
    r = await agent({ action: "click", at: { x: 680, y: 220 }, shot: { ...shot, doc: "elsewhere" } });
    check(`${tag}: a screenshot of another document is refused`, /page changed since your screenshot/.test(r.error || "") && (await log()).submits === 1, r);
    await page.close();
  }
  await browser.close();
  done();
})().catch(crash);
