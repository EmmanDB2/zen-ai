// Drag and drop with the real page agent in Chromium: what a page read lists
// (draggable items, drop areas, including an empty column), HTML5 drags (a
// kanban board, a sortable list, a trash zone), mouse-based drags (a sortable
// list that waits for 5 px with the button held, a pointer slider), errors.
//
// Each runs twice: synthetic events, then through a stand-in for Firefox's
// real mouse (nsIDOMWindowUtils.sendMouseEvent: hit-tests the point, fires
// pointer then mouse events, with the buttons it's given).
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
      return !t.dispatchEvent(new MouseEvent(type, init));
    },
  };
}

(async () => {
  const browser = await launchChromium();
  for (const native of [false, true]) {
    const tag = native ? "real mouse" : "synthetic";
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
    await page.goto(pageUrl("drag.html"));
    if (native) await page.evaluate(nativeMouse);
    const agent = await pageAgentRunner(page);
    const snap = await agent({ action: "snapshot" });
    const line = (re) => snap.text.split("\n").find((l) => re.test(l)) || "";
    const ref = (re) => line(re).match(/\[(e\d+)\]/)?.[1];
    const R = {
      essay: ref(/draggable "Write essay"/), chapter4: ref(/draggable "Read chapter 4"/), done: ref(/drop area "Done"/), todo: ref(/drop area "To do"/),
      trash: ref(/drop area "Trash"/), ch1: ref(/draggable "Chapter 1"/), ch3: ref(/draggable "Chapter 3"/),
      sleep: ref(/draggable "Sleep"/), gym: ref(/draggable "Gym"/), volume: ref(/slider "Volume"/),
    };
    const order = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent.trim()).join(","), sel);

    if (!native) {
      check("read: draggable cards and list items are listed", R.essay && R.chapter4 && R.ch1 && R.ch3 && R.sleep && R.gym, R);
      check("read: columns are drop areas named by their heading, with a count", /drop area "To do" \(2 items\)/.test(snap.text) && /drop area "Doing" \(1 item\)/.test(snap.text), snap.text);
      check("read: an empty column is a drop area too", /drop area "Done" \(empty\)/.test(snap.text));
      check("read: a marked drop target (ondragover) is listed", !!R.trash);
      check("read: drop areas sit in page order (To do before its cards)", snap.text.indexOf('"To do"') < snap.text.indexOf('"Write essay"'));
      check("read: a slider gives its range and track length", /slider "Volume" value=20 range=0–100 track=400px/.test(snap.text), line(/slider/));
      const d = await agent({ action: "describe", refs: [R.essay, R.done] });
      check("describe names them for the approval card", d.items[0].role === "draggable" && d.items[0].label === "Write essay" && d.items[1].role === "drop area" && d.items[1].label === "Done", d.items);
    }

    // HTML5: a card onto the empty Done column
    let r = await agent({ action: "drag", from: R.essay, to: R.done });
    check(`${tag}: card dragged onto the empty column`, !r.error && (await order("#done .card")) === "Write essay" && r.label === "Write essay" && r.to === "Done", r);
    // HTML5: reorder, before an item
    r = await agent({ action: "drag", from: R.ch3, to: R.ch1, position: "before" });
    check(`${tag}: list item moved before another`, !r.error && (await order("#h5list li")) === "Chapter 3,Chapter 1,Chapter 2", await order("#h5list li"));
    // Mouse-based: after an item
    r = await agent({ action: "drag", from: R.sleep, to: R.gym, position: "after" });
    check(`${tag}: mouse-based list item moved after another`, !r.error && (await order("#mlist li")) === "Study,Gym,Sleep", { r, order: await order("#mlist li") });
    if (native) {
      const log = await page.evaluate(() => window.nativeLog.slice());
      check("real mouse: a press, a series of moves, a release", log[1] === "mousedown" && log.filter((x) => x === "mousemove").length >= 10 && log.at(-1) === "mouseup", log.join(" "));
    }
    // Mouse-based: a slider, by an offset
    r = await agent({ action: "drag", from: R.volume, by: { x: 100, y: 0 } });
    const vol = await page.evaluate(() => document.getElementById("thumb").getAttribute("aria-valuenow"));
    check(`${tag}: slider dragged 100 px right (20 → 45)`, !r.error && vol === "45", { r, vol });
    // HTML5: into the trash
    r = await agent({ action: "drag", from: R.chapter4, to: R.trash });
    check(`${tag}: card dropped in the trash`, !r.error && (await page.evaluate(() => log.trashed.join())) === "Read chapter 4", r);
    // Errors and refusals
    r = await agent({ action: "drag", from: R.ch1, to: R.ch1 });
    check(`${tag}: dragging onto itself is an error`, /itself/.test(r.error || ""), r);
    r = await agent({ action: "drag", from: R.ch1, by: { x: 0, y: 0 } });
    check(`${tag}: no target and no offset is an error`, /Say where/.test(r.error || ""), r);
    r = await agent({ action: "drag", from: R.ch1, to: R.volume });
    check(`${tag}: a drop nothing accepts says so`, !r.error && /Nothing there accepted the drop/.test(r.note), r);
    await page.close();
  }
  await browser.close();
  done();
})().catch(crash);
