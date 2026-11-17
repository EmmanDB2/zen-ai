// Clicking and dragging at points from Claude's screenshot, through the panel:
// the built mod (dist/) in a jsdom Zen window, a fake Claude Code asking for
// and calling the tools, and the real page agent against a jsdom page (with a
// stand-in hit-test, since jsdom has no layout). Covers: points need a
// screenshot taken since the last action, the approval card's close-up with
// the spots marked, warnings for what's under a point, the new screenshot
// after a point action, and Allow all.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const CLICK = "mcp__zenai__browser_click";
const DRAG = "mcp__zenai__browser_drag";
const SHOT = "mcp__zenai__browser_screenshot";
const PAGE = `<!doctype html><html><body>
<h2>How many peaks?</h2>
<svg id="slider" width="520" height="80"><line x1="40" y1="50" x2="440" y2="50"/><circle id="dot" cx="280" cy="50" r="9"/></svg>
<button id="submit">Submit answer</button>
<button id="help">Help</button>
</body></html>`;

(async () => {
  const zen = await fakeZen({ holdReplies: true, page: PAGE });
  const { $, $$, click } = zen;
  const web = zen.webPage();
  const d = web.document;
  // Where things are on the "screen" (jsdom has no layout)
  const dot = d.getElementById("dot");
  const submit = d.getElementById("submit");
  d.elementFromPoint = (x, y) => (Math.hypot(x - 320, y - 120) <= 10 ? dot : x >= 600 && x <= 760 && y >= 200 && y <= 240 ? submit : y >= 70 && y <= 150 && x >= 40 && x <= 560 ? d.getElementById("slider") : d.body);
  const events = [];
  for (const type of ["mousedown", "mousemove", "mouseup", "click"]) d.addEventListener(type, (e) => events.push([type, e.target.id || e.target.tagName.toLowerCase(), e.clientX, e.clientY]), true);
  const card = () => $(".zai-approval");
  const toolText = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const images = (res) => res.content.filter((c) => c.type === "image");

  await zen.open();
  await zen.send("Set the slider to 0", { wait: false });
  await sleep(80);

  // --- No screenshot yet: points are refused ---
  let r = await zen.askPermission(CLICK, { point: { x: 320, y: 120 } });
  check("a point before any screenshot is refused, saying to take one", r.behavior === "deny" && /Take a browser_screenshot first/.test(r.message) && !card(), r);
  r = await zen.askPermission(CLICK, {});
  check("no ref and no point is refused", r.behavior === "deny" && /ref from browser_read, or a point/.test(r.message), r);

  // --- The screenshot: its size, and that points are in its pixels ---
  r = await zen.askPermission(SHOT, {});
  let res = await zen.callTool("browser_screenshot", r.updatedInput);
  check("screenshot: an image, with its size and what points mean", images(res).length === 1 && /1024×768 px/.test(toolText(res)) && /take points in this image's pixels/.test(toolText(res)), toolText(res));

  r = await zen.askPermission(CLICK, { point: { x: 2000, y: 10 } });
  check("a point outside the screenshot is refused", r.behavior === "deny" && /inside your latest screenshot \(1024×768 px\)/.test(r.message), r);
  r = await zen.askPermission(DRAG, { from_point: { x: 320, y: 120 }, to_point: { x: 320.5, y: 120 } });
  check("a drag that doesn't go anywhere is refused", r.behavior === "deny" && /same spot/.test(r.message), r);

  // --- A drag between two points: the card shows them on the screenshot ---
  let answer = zen.askPermission(DRAG, { from_point: { x: "320", y: 120 }, to_point: { x: 80, y: 120 } });
  await sleep(80);
  const c = card();
  check("drag card: says what it does and where (no labels: the marked spots)", c && /Drag between the marked spots/.test(c.textContent) && /circle#dot on example\.com/.test(c.textContent), c && c.textContent.slice(0, 120));
  const pic = c && c.querySelector(".zai-shot svg");
  const img = pic && pic.querySelector("image");
  check("drag card: a close-up of Claude's screenshot", !!pic && img && /^data:image\/jpeg;base64,/.test(img.getAttribute("href")) && img.getAttribute("width") === "1024", pic && pic.outerHTML.slice(0, 200));
  const from = pic && pic.querySelector(".zai-shot-from");
  const to = pic && pic.querySelector(".zai-shot-to");
  check("drag card: the press and release spots are marked, with the path between", from && to && from.getAttribute("cx") === "320" && to.getAttribute("cx") === "80" && pic.querySelectorAll("line").length === 2);
  const [vx, vy, vw, vh] = (pic ? pic.getAttribute("viewBox") : "0 0 0 0").split(" ").map(Number);
  check("drag card: the close-up holds both spots", vx <= 80 && vx + vw >= 320 && vy <= 120 && vy + vh >= 120 && vw === vh * 2, pic && pic.getAttribute("viewBox"));
  check("drag card: nothing risky, so it can be allowed for the site", !$(".zai-approval-warn") && !!$(".zai-allow-site"));
  click($(".zai-allow"));
  r = await answer;
  check("allowed, with the points as numbers", r.behavior === "allow" && r.updatedInput.from_point.x === 320 && r.updatedInput.to_point.x === 80, r.updatedInput);
  events.length = 0;
  res = await zen.callTool("browser_drag", r.updatedInput);
  const down = events.find((e) => e[0] === "mousedown");
  const up = events.filter((e) => e[0] === "mouseup").pop();
  check("the drag presses on the dot and lets go at the other point", down && down[1] === "dot" && down[2] === 320 && up && up[2] === 80 && up[3] === 120, events.slice(0, 3).concat(events.slice(-2)));
  check("the result says what was dragged, from where to where", /Dragged circle#dot from \(320, 120\) to \(80, 120\)/.test(toolText(res)), toolText(res).slice(0, 200));
  check("...and comes with a new screenshot, which later points refer to", images(res).length === 1 && /Later points refer to this screenshot/.test(toolText(res)));

  // --- A point on a submit button: named, warned, never "allow on this site" ---
  answer = zen.askPermission(CLICK, { point: { x: 650, y: 215 } });
  await sleep(80);
  check("click card: the button under the point is named", card() && /Click “Submit answer”/.test(card().textContent) && !!card().querySelector(".zai-shot-click"), card() && card().textContent.slice(0, 100));
  check("click card: it submits, so the warning shows and the site can't be allowed", /Submit answer/.test(($(".zai-approval-warn") || {}).textContent || "") && !$(".zai-allow-site"));
  click($(".zai-deny"));
  r = await answer;
  check("...Deny denies", r.behavior === "deny");

  // --- Any other action means the screenshot may be out of date ---
  const read = await zen.askPermission("mcp__zenai__browser_read", { full: true });
  const snap = toolText(await zen.callTool("browser_read", read.updatedInput));
  const help = (snap.split("\n").find((l) => /button "Help"/.test(l)) || "").match(/\[(e\d+)\]/)?.[1];
  answer = zen.askPermission(CLICK, { ref: help });
  await sleep(80);
  check("a ref click has no close-up", card() && !card().querySelector(".zai-shot"));
  click($(".zai-allow"));
  await zen.callTool("browser_click", (await answer).updatedInput);
  r = await zen.askPermission(CLICK, { point: { x: 320, y: 120 } });
  check("after another action, points need a new screenshot", r.behavior === "deny" && /Take a browser_screenshot first/.test(r.message), r);

  // --- Allow all: point actions go straight through, with a line in the chat ---
  r = await zen.askPermission(SHOT, {});
  await zen.callTool("browser_screenshot", r.updatedInput);
  answer = zen.askPermission(CLICK, { point: { x: 100, y: 100 } });
  await sleep(80);
  check("a point on the SVG's background: the marked spot", card() && /Click the marked spot/.test(card().textContent) && /svg#slider on example\.com/.test(card().textContent), card() && card().textContent.slice(0, 100));
  click($(".zai-allow-all"));
  await answer;
  r = await zen.askPermission(DRAG, { from_point: { x: 320, y: 120 }, by: { x: -240, y: 0 } });
  check("Allow all: a point drag goes through without a card", r.behavior === "allow" && !card() &&
    $$(".zai-thread .zai-toolline").some((l) => /Drag the marked spot by 240 px left · all actions allowed/.test(l.textContent)), $$(".zai-thread .zai-toolline").map((l) => l.textContent).slice(-2));

  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.finishReplies();
  await zen.close();
  done();
})().catch(crash);
