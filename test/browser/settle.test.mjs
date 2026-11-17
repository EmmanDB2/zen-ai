// The page agent's "settle" action (the wait after each browser action): it
// ends once the page has been quiet for a moment, instead of a fixed sleep.
// Real Chromium; in Zen the same code runs with Firefox's timers.
import { checker, crash, launchChromium, pageAgentRunner, pageUrl } from "../helpers/common.mjs";

const { check, done } = checker();
(async () => {
  const browser = await launchChromium();
  const page = await browser.newPage();
  await page.goto(pageUrl("form.html"));
  const agent = await pageAgentRunner(page);
  const timed = async (args) => { const t0 = Date.now(); const r = await agent(args); return { ...r, ms: Date.now() - t0 }; };

  let r = await timed({ action: "settle", quietMs: 150, maxMs: 1200 });
  check("a still page: done after the quiet window, well under the old fixed waits", r.quiet && r.changes === 0 && r.ms < 300, r);

  // After a click (an SPA waiting on the network): at least 350 ms in the page
  // (450 ms with Zen's settle, as before), and longer while it keeps re-rendering
  const render = (ms) => page.evaluate((ms) => setTimeout(() => document.body.append(Object.assign(document.createElement("p"), { textContent: "Step 2" })), ms), ms);
  await render(300);
  r = await timed({ action: "settle", minMs: 350, quietMs: 150, maxMs: 1500 });
  check("after a click: a re-render 0.4 s after the click is waited for", r.quiet && r.changes >= 1 && r.ms >= 440 && r.ms < 800, r);
  await render(100); await render(250); await render(400); await render(550);
  r = await timed({ action: "settle", minMs: 350, quietMs: 150, maxMs: 1500 });
  check("...and a burst of re-renders is waited out (the old fixed wait cut it short)", r.changes >= 4 && r.ms >= 690 && r.ms < 1100, r);
  // Typing changes the page at once: no minimum
  r = await timed({ action: "settle", minMs: 0, quietMs: 150, maxMs: 1500 });
  check("after typing: just the quiet window", r.quiet && r.ms < 300, r);

  // A page that never stops changing (a ticker): capped
  await page.evaluate(() => { window.tick = setInterval(() => (document.title = String(Date.now())), 40); document.body.dataset.t = "x"; setInterval(() => (document.body.dataset.t = String(Date.now())), 40); });
  r = await timed({ action: "settle", quietMs: 150, maxMs: 600 });
  check("a page that never goes quiet: gives up at the cap", !r.quiet && r.ms >= 600 && r.ms < 900, r);

  await browser.close();
  done();
})().catch(crash);
