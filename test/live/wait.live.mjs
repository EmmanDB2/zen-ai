// Real Claude Code keeping an eye on a 4-minute lesson video: does it use
// browser_wait (not repeated reads), wait it out without clicking, and say
// when it's done? Also checks that Claude Code takes a tool call this long,
// and prints which prompt cache the requests used (cacheTtl: 5m or 1h),
// which is what WAIT_MAX_SECONDS is based on. Takes about 5 minutes; the
// waiting itself costs nothing.
import { checker, crash, launchChromium, pageUrl } from "../helpers/common.mjs";
import { runBrowserTask } from "../helpers/live-browser.mjs";

const { check, done } = checker();
const SECONDS = Number(process.env.LESSON_SECONDS) || 240;
(async () => {
  const browser = await launchChromium();
  const page = await browser.newPage();
  await page.goto(pageUrl("lesson.html") + `?seconds=${SECONDS}#autoplay`);
  const run = await runBrowserTask(page, "There's a lesson video on this page that's about to start. Keep an eye on it and tell me when it has finished. Don't click anything.", { timeoutMs: (SECONDS + 180) * 1000 });
  const v = await page.evaluate(() => ({ status: document.getElementById("status").textContent, nextClicks: log.nextClicks }));
  const said = String(run.result.result || "");
  const waited = run.waits.reduce((n, w) => n + (w.seconds || 0), 0);
  check("it finished without an error", !run.result.is_error, said.slice(0, 200));
  check("the lesson really ended", /Completed/.test(v.status), v);
  check("used browser_wait, and waited about the video's length", (run.calls.browser_wait || 0) >= 1 && waited >= SECONDS - 15, { waits: run.waits, calls: run.calls });
  check("didn't poll with repeated reads", (run.calls.browser_read || 0) <= 2 && !run.calls.browser_screenshot, run.calls);
  check("clicked nothing", v.nextClicks === 0 && !run.calls.browser_click);
  check("says it's done", /finish|complete|ended|done/i.test(said), said.slice(0, 300));
  console.log("BENCH", JSON.stringify({ requests: run.requests, calls: run.calls, waits: run.waits.map((w) => ({ asked: w.max, waited: w.seconds, until: Object.keys(w.args).filter((k) => k.startsWith("until")) })), seconds: run.seconds, tokens: run.tokens }));
  await browser.close();
  done();
})().catch(crash);
