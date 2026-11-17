// Real Claude Code on a page with drag and drop: does it find browser_drag
// and use it right (a kanban card to an empty column, reordering a list,
// a mouse-based list, a slider by an offset)?
import { checker, crash, launchChromium, pageUrl } from "../helpers/common.mjs";
import { runBrowserTask } from "../helpers/live-browser.mjs";

const { check, done } = checker();
(async () => {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(pageUrl("drag.html"));
  const run = await runBrowserTask(page, "On this page: move \"Write essay\" to the Done column, put Chapter 3 first in the reading order, move Sleep to the bottom of my priorities, and set the volume to about 60.");
  const v = await page.evaluate(() => ({
    done: [...document.querySelectorAll("#done .card")].map((c) => c.textContent),
    reading: [...document.querySelectorAll("#h5list li")].map((li) => li.textContent).join(","),
    priorities: [...document.querySelectorAll("#mlist li")].map((li) => li.textContent).join(","),
    volume: +document.getElementById("thumb").getAttribute("aria-valuenow"),
    trashed: log.trashed.length,
  }));
  check("card in Done", v.done.includes("Write essay"), v);
  check("Chapter 3 first", v.reading.startsWith("Chapter 3"), v.reading);
  check("Sleep last", v.priorities.endsWith("Sleep"), v.priorities);
  check("volume about 60", v.volume >= 50 && v.volume <= 70, v.volume);
  check("nothing trashed", v.trashed === 0);
  check("used browser_drag", (run.calls.browser_drag || 0) >= 3, run.calls);
  console.log("BENCH", JSON.stringify({ requests: run.requests, calls: run.calls, seconds: run.seconds, inTools: run.timing.inTools }));
  await browser.close();
  done();
})().catch(crash);
