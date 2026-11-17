// Acting on pages in real Zen, where the page agent's Firefox-only paths
// run: real mouse events (window.synthesizeMouseEvent), HTML5 drag events
// built through Firefox's security wrappers, key-by-key typing
// (nsITextInputProcessor), MathQuill's own API reached through them, and
// points from real screenshots. The same fixtures as the Chromium tests in
// test/browser/, driven through the panel; Claude Code is played by the test.
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const refIn = (text, re) => ((text.split("\n").find((l) => re.test(l)) || "").match(/\[((?:f\d+\.)?e\d+)\]/) || [])[1];

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ holdReplies: true });
  try {
    await zen.open();
    // Opens a page, starts a reply, reads it. The first action's card gets
    // "Allow all actions in this chat", so the rest run without cards.
    let started = false;
    const start = async (page, ask) => {
      await zen.openTab(zen.page(page));
      if (started) await zen.finishReplies();
      await zen.send(ask, { wait: false });
      started = true;
      return textOf(await zen.tool("browser_read", { full: true }));
    };
    let allowedAll = false;
    const act = async (name, args) => {
      const perm = zen.askPermission("mcp__zenai__" + name, args);
      if (!allowedAll) {
        await zen.approve("all");
        allowedAll = true;
      }
      const p = await perm;
      if (p.behavior !== "allow") return { denied: p.message };
      return zen.callTool(name, p.updatedInput);
    };

    // --- A click is a real, trusted one (window.synthesizeMouseEvent) ---
    let text = await start("frames.html", "Ask for help");
    let res = await act("browser_click", { ref: refIn(text, /button "Help"/) });
    let page = await zen.inPage((win) => ({ log: win.wrappedJSObject.log.slice(), help: win.document.getElementById("help").textContent }));
    check("a click on the page is real: trusted mousedown and click", page.log.includes("mousedown:help:true") && page.log.includes("click:help:true") && page.help === "Help is on the way", page);
    check("...with nothing sent around it (no note about it)", /^Clicked “Help”\.\n/.test(textOf(res)), textOf(res).slice(0, 120));

    // --- Drags: HTML5 (drag events through Firefox's wrappers) and mouse-based ---
    text = await start("drag.html", "Sort my board");
    res = await act("browser_drag", { from: refIn(text, /draggable "Write essay"/), to: refIn(text, /drop area "Done"/) });
    page = await zen.inPage((win) => ({ drops: win.wrappedJSObject.log.drops, done: [...win.document.querySelectorAll("#done .card")].map((c) => c.textContent) }));
    check("HTML5 drag: the card lands in Done", page.drops === 1 && page.done.join() === "Write essay", { page, res: textOf(res).slice(0, 160) });
    res = await act("browser_drag", { from: refIn(text, /"Sleep"/), to: refIn(text, /"Gym"/), position: "after" });
    page = await zen.inPage((win) => [...win.document.querySelectorAll("#mlist li")].map((li) => li.textContent).join(", "));
    check("mouse drag (real press, moves, release): Sleep moves after Gym", page === "Study, Gym, Sleep", { page, res: textOf(res).slice(0, 200) });
    check("...by the real mouse (no note that it fell back)", !/real mouse didn't work/.test(textOf(res)), textOf(res).slice(0, 200));
    res = await act("browser_drag", { from: refIn(text, /slider "Volume"/), by: { x: 120, y: 0 } });
    page = await zen.inPage((win) => Number(win.document.getElementById("thumb").getAttribute("aria-valuenow")));
    check("slider: dragged 120 px right goes from 20 to about 50", page >= 45 && page <= 55, page);

    // --- Math boxes: MathQuill's API through the wrappers, and key by key ---
    text = await start("math-api.html", "Answer the questions");
    res = await act("browser_type", { ref: refIn(text, /math box "Answer"/), text: "\\frac{3x^{2}}{4}" });
    page = await zen.inPage((win) => win.wrappedJSObject.readAnswers()[0]);
    check("MathQuill's API: the LaTeX is set exactly", page === "\\frac{3x^2}{4}", { page, res: textOf(res).slice(0, 160) });
    text = await start("math-noapi.html", "Answer the questions");
    check("without the API, the read says to type keys", /input=keys/.test(text));
    res = await act("browser_type", { ref: refIn(text, /math box "Answer"/), text: "3x^2{Right}/4" });
    page = await zen.inPage((win) => win.wrappedJSObject.readAnswers()[0]);
    check("key by key (real key presses): typed like a calculator", /3x\^2/.test(page) && /4/.test(page), { page, res: textOf(res).slice(0, 200) });
    res = await act("browser_type", { ref: refIn(text, /math box "Answer"/), text: "x+1" });
    page = await zen.inPage((win) => win.wrappedJSObject.readAnswers()[0]);
    check("...and replacing clears the old answer first", page === "x+1", page);

    // --- Points from a real screenshot: an SVG slider, a canvas, a same-site frame ---
    text = await start("points.html", "Set the peaks");
    check("the read names the drawn graphics", /Drawn graphics with no refs inside: /.test(text), text.slice(-500));
    const shot = await zen.tool("browser_screenshot", {});
    const [, w] = textOf(shot).match(/(\d+)×(\d+) px/) || [];
    const geo = await zen.inPage((win) => {
      const d = win.document;
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const c = d.querySelector("canvas").getBoundingClientRect();
      const f = d.querySelector("iframe").getBoundingClientRect();
      return { w: win.innerWidth, dot: box(d.getElementById("dot")), canvas: { x: c.left + 320, y: c.top + 70 }, frameBtn: { x: f.left + 80, y: f.top + 35 }, peaks: win.wrappedJSObject.log.peaks };
    });
    const ratio = Number(w) / geo.w;
    check("the screenshot is the visible page at one pixel per CSS pixel (or shrunk)", ratio > 0 && ratio <= 1, { w, css: geo.w });
    const px = (p) => ({ x: Math.round(p.x * ratio), y: Math.round(p.y * ratio) });
    res = await act("browser_drag", { from_point: px(geo.dot), to_point: px({ x: geo.dot.x - 75, y: geo.dot.y }) });
    page = await zen.inPage((win) => win.wrappedJSObject.log.peaks);
    check("SVG slider by points: its value changes", page !== geo.peaks, { before: geo.peaks, after: page, res: textOf(res).slice(0, 200) });
    await zen.tool("browser_screenshot", {});
    res = await act("browser_click", { point: px(geo.canvas) });
    page = await zen.inPage((win) => win.wrappedJSObject.log.added.length);
    check("canvas click by a point: the page gets it", page === 1, { page, res: textOf(res).slice(0, 200) });
    await zen.tool("browser_screenshot", {});
    res = await act("browser_click", { point: px(geo.frameBtn) });
    page = await zen.inPage((win) => win.wrappedJSObject.log.frameClicks);
    check("a point over a same-site frame clicks inside it", page === 1, { page, res: textOf(res).slice(0, 200) });

    check("no errors in Zen's console", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
