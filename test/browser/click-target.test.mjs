// Clicking into tricky text boxes, like a web math answer box
// (response markup around a MathQuill-style editor that only reacts to a
// mousedown on its inner .mq-root-block). The real page agent in Chromium.
//
// Chromium has no windowUtils, so the "real mouse events" path is tested with
// a stand-in that hit-tests the point like Firefox's sendMouseEvent does.
import { checker, crash, launchChromium, pageAgentRunner, pageUrl } from "../helpers/common.mjs";

const { check, done } = checker();

// Like nsIDOMWindowUtils.sendMouseEvent: the event goes to whatever is at (x, y)
function nativeMouse() {
  window.nativeLog = [];
  let down = null;
  window.windowUtils = {
    sendMouseEvent(type, x, y, button, clickCount) {
      const t = document.elementFromPoint(x, y);
      window.nativeLog.push(`${type} ${t ? (t.id ? "#" + t.id : "." + String(t.className).split(" ")[0]) : "nothing"}`);
      if (!t) return false;
      const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button, buttons: type === "mousedown" ? 1 : 0, detail: clickCount };
      const ok = t.dispatchEvent(new MouseEvent(type, init));
      if (type === "mousedown") {
        down = t;
        const f = ok && t.closest("button, input, textarea, a[href], [tabindex]");
        if (f) f.focus();
      }
      if (type === "mouseup" && down) {
        let c = t;
        while (c && !c.contains(down)) c = c.parentElement;
        if (c) c.dispatchEvent(new MouseEvent("click", init));
        down = null;
      }
      return !ok;
    },
  };
}

(async () => {
  const browser = await launchChromium();
  // A fresh copy of the page. native: real-mouse stand-in; below: box under the fold; smooth: scroll-behavior: smooth
  async function open({ native = false, below = false, smooth = false, cover = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
    await page.goto(pageUrl("math-editor.html"));
    await page.evaluate(({ below, smooth, cover }) => {
      if (below) document.getElementById("spacer").style.height = "2400px";
      if (smooth) document.documentElement.style.scrollBehavior = "smooth";
      if (cover) {
        // A strip across the middle of the Check button: its centre is covered, its top and bottom aren't
        const b = document.getElementById("check");
        const wrap = b.parentElement;
        wrap.style.position = "relative";
        const strip = document.getElementById("banner");
        Object.assign(strip.style, { display: "block", position: "absolute", left: "0", width: "260px", top: b.offsetTop + 22 + "px", height: "16px" });
        wrap.append(strip);
      }
    }, { below, smooth, cover });
    if (native) await page.evaluate(nativeMouse);
    const agent = await pageAgentRunner(page);
    const snap = await agent({ action: "snapshot" });
    const ref = (re) => (snap.text.split("\n").find((l) => re.test(l)) || "").match(/\[(e\d+)\]/)?.[1];
    const R = { box: ref(/"Response input area"/), check: ref(/button "Check answer"/), dead: ref(/"Broken answer box"/), notes: ref(/textbox "Notes"/), nick: ref(/textbox "Nickname"/) };
    const state = () => page.evaluate(() => ({
      events: log.events.slice(), checks: log.checks, banner: log.bannerClicks, native: window.nativeLog || [],
      box: document.querySelector(".resp_bordered_mathinput .mq-root-block").textContent,
      active: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
      notes: document.getElementById("notes").value,
    }));
    return { page, agent, R, state };
  }

  // --- Synthetic events (no real mouse): they go to the element under the point ---
  let t = await open();
  check("the answer box is listed as a math box", !!t.R.box);
  let r = await t.agent({ action: "click", ref: t.R.box });
  let s = await t.state();
  check("click: mousedown lands on .mq-root-block, not the wrapper", s.events.includes("mousedown span.mq-root-block"), s.events);
  check("click: focus goes into the box's textarea (#focusable4)", s.events.includes("focusin textarea#focusable4") && s.active === "focusable4", s);
  check("click result says where focus is", /focus is in textarea#focusable4/i.test(r.note), r.note);
  r = await t.agent({ action: "type", ref: t.R.box, text: "3x+1" });
  s = await t.state();
  check("typing then reaches the box", !r.error && s.box === "3x+1", { r, box: s.box });
  r = await t.agent({ action: "type", ref: t.R.box, text: "dy" });
  s = await t.state();
  check("typing again replaces it", !r.error && s.box === "dy", { r, box: s.box });
  await t.page.close();

  // --- Real mouse events, box below the fold, smooth scrolling (a common site setting) ---
  t = await open({ native: true, below: true, smooth: true });
  r = await t.agent({ action: "click", ref: t.R.box });
  s = await t.state();
  check("real click: aimed after the scroll, so it hits .mq-root-block", s.native[0] === "mousemove .mq-root-block" && s.native.includes("mousedown .mq-root-block"), s.native);
  check("real click: focus in #focusable4, no fallback needed", s.active === "focusable4" && !/sent straight/.test(r.note), { active: s.active, note: r.note });
  r = await t.agent({ action: "fill", fields: [{ ref: t.R.box, value: "3x^2" }] });
  s = await t.state();
  check("fill_form types into it", r.results[0].status === "filled" && s.box === "3x^2", { r, box: s.box });
  await t.page.close();

  // --- Centre covered: a point inside the element that isn't covered is used ---
  t = await open({ native: true, cover: true });
  r = await t.agent({ action: "click", ref: t.R.check });
  s = await t.state();
  check("covered centre: clicks an uncovered part of the button", s.checks === 1 && s.banner === 0 && !s.native.some((n) => /banner/.test(n)), s);
  check("...without the 'something on top' warning", !/on top of it/.test(r.note || ""), r.note);
  // An element whose parent takes its clicks (pointer-events: none): one click, not two
  const ghost = (await t.agent({ action: "snapshot" })).text.split("\n").find((l) => /"Open card"/.test(l)).match(/\[(e\d+)\]/)[1];
  await t.agent({ action: "click", ref: ghost });
  check("pointer-events: none element: its card gets exactly one click", (await t.page.evaluate(() => log.cardClicks)) === 1, await t.page.evaluate(() => log.cardClicks));
  await t.page.close();

  // --- A box that never takes focus: nothing is typed anywhere else ---
  t = await open();
  await t.page.focus("#notes");
  r = await t.agent({ action: "type", ref: t.R.dead, text: "abc" });
  s = await t.state();
  check("box that won't take focus: an error, not a success", !!r.error && /cursor|focus/i.test(r.error), r);
  check("...and the keys didn't go into another field", s.notes === "", s.notes);
  r = await t.agent({ action: "fill", fields: [{ ref: t.R.dead, value: "abc" }] });
  check("fill_form reports that field as failed", r.results[0].status === "failed", r.results[0]);
  // A site that throws the text away
  r = await t.agent({ action: "type", ref: t.R.nick, text: "Alex" });
  check("text field still empty after typing: an error", !!r.error && /empty/i.test(r.error), r);
  await t.page.close();

  await browser.close();
  done();
})().catch(crash);
