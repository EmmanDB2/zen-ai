// Real Claude Code on controls a page read can't list: a slider drawn in SVG
// (no roles, no labels) and a point on a canvas graph. Does it take a
// screenshot, pick the right points in it and drag there, then check?
import { checker, crash, launchChromium, pageUrl } from "../helpers/common.mjs";
import { runBrowserTask } from "../helpers/live-browser.mjs";

const { check, done } = checker();
(async () => {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(pageUrl("points.html"));
  const run = await runBrowserTask(page, "On this page, set the \"Number of peaks\" slider to 0, then drag the red point on the graph into the green ring. Don't submit anything.");
  const v = await page.evaluate(() => ({ peaks: log.peaks, shown: document.getElementById("val").textContent, point: log.point, submits: log.submits }));
  const off = Math.hypot(v.point.x - 320, v.point.y - 70);
  check("slider at 0", v.peaks === 0 && v.shown === "0", v);
  check("red point inside the green ring (within 16 px of its centre)", off <= 16, { point: v.point, off: Math.round(off) });
  check("nothing submitted", v.submits === 0);
  check("used a screenshot and points", (run.calls.browser_screenshot || 0) >= 1 && (run.calls.points || 0) >= 2, run.calls);
  console.log("BENCH", JSON.stringify({ requests: run.requests, calls: run.calls, seconds: run.seconds, inTools: run.timing.inTools }));
  await browser.close();
  done();
})().catch(crash);
