// Real Claude Code through a 3-step form on a busy page (250+ links). Also the
// usage benchmark: prints requests, page content sent, tokens and time.
import { checker, crash, launchChromium, pageUrl } from "../helpers/common.mjs";
import { runBrowserTask } from "../helpers/live-browser.mjs";

const { check, done } = checker();
(async () => {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  await page.goto(pageUrl("wizard.html"));
  const run = await runBrowserTask(page, "Fill out this application for me, going through every step: I'm Alex Kim, alex@example.com, 410-555-0100. Riverside University, Computer Science, sophomore. Remote, earliest start 06/01/2027, and I agree to the terms. Don't submit it.");
  const v = await page.evaluate(() => { const f = document.forms.apply; return { name: f.name.value, email: f.email.value, school: f.school.value, major: f.major.value, year: (f.querySelector("input[name=year]:checked") || {}).value, mode: f.mode.value, start: f.start.value, agree: f.agree.checked, step: log.step, submitted: log.submitted }; });
  check("every step filled", v.name && v.email === "alex@example.com" && v.major === "Computer Science" && v.year === "so" && v.mode === "Remote" && v.agree && v.step === 3, v);
  check("nothing submitted", v.submitted === 0);
  check("no full re-reads needed", (run.calls.browser_read || 0) <= 2, run.calls);
  console.log("BENCH", JSON.stringify({ requests: run.requests, calls: run.calls, pageChars: run.toolChars, tokens: run.tokens, seconds: run.seconds, startup: run.timing.startup, inTools: run.timing.inTools }));
  if (process.env.TRACE) console.log(run.timing.steps.join("\n"));
  await browser.close();
  done();
})().catch(crash);
