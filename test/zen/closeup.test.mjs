// Close-up screenshots (browser_screenshot with ref) in real Zen: just the
// element or frame, drawn at 2× so small text stays readable, much smaller
// than a whole view; and a point in the close-up lands on the right thing
// (the crop's offset and scale are carried through to the page agent).
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const refIn = (text, re) => ((text.split("\n").find((l) => re.test(l)) || "").match(/\[((?:f\d+\.)?e\d+)\]/) || [])[1];
const sizeOf = (res) => {
  const m = textOf(res).match(/(\d+)×(\d+) px/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
};

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ holdReplies: true });
  try {
    await zen.open();
    await zen.openTab(zen.page("frames.html"));
    await zen.send("Look closely", { wait: false });
    const page = textOf(await zen.tool("browser_read", { full: true }));
    const help = refIn(page, /button "Help"/);
    check("the page has the Help button", !!help, page.slice(0, 300));

    const full = await zen.tool("browser_screenshot", {});
    const fullSize = sizeOf(full);
    const close = await zen.tool("browser_screenshot", { ref: help });
    const closeSize = sizeOf(close);
    const rect = await zen.inPage((win) => { const r = win.document.getElementById("help").getBoundingClientRect(); return { w: r.width, h: r.height }; });
    check("a close-up is an image of about the element's size, at 2×", closeSize && Math.abs(closeSize.w - 2 * (rect.w + 24)) <= 4 && Math.abs(closeSize.h - 2 * (rect.h + 24)) <= 4, { closeSize, rect });
    check("...far smaller than the whole view", closeSize && fullSize && closeSize.w * closeSize.h < (fullSize.w * fullSize.h) / 10, { closeSize, fullSize });
    check("...and says what it is", /A close-up of e\d+/.test(textOf(close)), textOf(close).slice(0, 120));

    // A point in the close-up: its middle is the button
    const perm = zen.askPermission("mcp__zenai__browser_click", { point: { x: Math.round(closeSize.w / 2), y: Math.round(closeSize.h / 2) } });
    const card = await zen.approve("once");
    const p = await perm;
    check("the card names the button under the point", /Help/.test(card.title), card);
    const res = await zen.callTool("browser_click", p.updatedInput);
    const label = await zen.inPage((win) => win.document.getElementById("help").textContent);
    check("clicking the middle of the close-up clicks the button", label === "Help is on the way", { label, res: textOf(res).slice(0, 200) });

    // A frame from another site, by its key
    const frameKey = (page.match(/\b(f\d+)\b[^\n]*Course player|Course player[^\n]*\b(f\d+)\b/) || []).slice(1).find(Boolean) || "f1";
    const frameShot = await zen.tool("browser_screenshot", { ref: frameKey });
    const frameSize = sizeOf(frameShot);
    check("a frame's close-up works too", !!frameSize && /A close-up of f\d+/.test(textOf(frameShot)), textOf(frameShot).slice(0, 160));
    const bad = await zen.tool("browser_screenshot", { ref: "e99999" });
    check("a ref that isn't there says so", (bad.isError || bad.denied) && /isn't on the page|couldn't/i.test(textOf(bad) || bad.denied || ""), bad);
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
    await zen.finishReplies();
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
