// Real Claude Code in real Zen organizing tabs: "put my lab safety lesson and
// the Acme Internships application into a new folder called School, and
// close the drag and drop demo". Checks it lists the tabs, makes the folder
// with exactly those two, and that closing asked (the test allows it).
// Uses your Claude usage (Sonnet, a few short turns).
import { checker, crash } from "../helpers/common.mjs";
import { realZen, sleep, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ claude: "real", timeoutMs: 30000, prefs: { model: "sonnet", effort: "medium" } });
  const cards = [];
  try {
    for (const p of ["lesson.html", "form.html", "drag.html", "wizard.html"]) await zen.openTab(zen.page(p));
    await zen.open();
    const t0 = Date.now();
    await zen.send("Put my lab safety lesson and the Acme Internships application into a new folder called School, and close the drag and drop demo tab.", { wait: false });
    let finished = false;
    const answering = (async () => {
      while (!finished) {
        const card = await zen.card().catch(() => null);
        if (card) {
          cards.push(card);
          await zen.chrome(() => { const c = [...document.querySelectorAll(".zai-approval")].pop(); if (c) c.querySelector(".zai-allow").click(); }).catch(() => {});
        }
        await sleep(300);
      }
    })();
    await sleep(2000);
    await zen.idle(120000);
    finished = true;
    await answering;
    const w = await zen.chrome(() => [...gBrowser.tabs].filter((t) => /^http/.test(t.linkedBrowser.currentURI.spec)).map((t) => ({ page: t.linkedBrowser.currentURI.spec.split("/").pop(), folder: t.group && t.group.isZenFolder ? t.group.label : null })));
    const lines = await zen.lines();
    console.log(`(${Math.round((Date.now() - t0) / 1000)} s) cards: ${JSON.stringify(cards.map((c) => [c.title, c.warn]))}\ntabs: ${JSON.stringify(w)}\nlines: ${JSON.stringify(lines)}`);
    const inSchool = w.filter((x) => x.folder === "School").map((x) => x.page).sort().join();
    check("a School folder with exactly the lesson and the Acme Internships application", inSchool === "form.html,lesson.html", w);
    check("the drag and drop demo is closed, the other application left alone", !w.some((x) => x.page === "drag.html") && w.some((x) => x.page === "wizard.html" && !x.folder), w);
    check("it listed the tabs first", lines.some((l) => /Looked at the tabs open in this Space/.test(l)), lines);
    check("closing asked, with the warning", cards.some((c) => /This closes 1 tab/.test(c.warn)), cards);
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
