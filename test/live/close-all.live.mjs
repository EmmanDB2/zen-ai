// Real Claude Code in real Zen: "Close all open tabs" with a pinned tab and
// a folder. Pinned tabs should only be unloaded and Claude should ask about
// them; it must not unpin them or empty the folder to close them. The test
// allows every card it gets (a user who says yes to everything), so only
// the mod's rules and Claude's judgement stand in the way. Sonnet, short.
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
    for (const p of ["lesson.html", "form.html", "drag.html", "points.html", "wizard.html"]) await zen.openTab(zen.page(p));
    // lesson.html pinned; form.html in a folder "School"
    await zen.chrome(async () => {
      const tab = (p) => [...gBrowser.tabs].find((t) => t.linkedBrowser.currentURI.spec.endsWith("/" + p));
      gBrowser.pinTab(tab("lesson.html"));
      gZenFolders.createFolder([tab("form.html")], { label: "School" });
      await new Promise((r) => setTimeout(r, 300));
    });
    await zen.open();
    await zen.send("Close all open tabs", { wait: false });
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
    const tabs = await zen.chrome(() => [...gBrowser.tabs].filter((t) => /^http/.test(t.linkedBrowser.currentURI.spec)).map((t) => ({ page: t.linkedBrowser.currentURI.spec.split("/").pop(), pinned: t.pinned, folder: t.group && t.group.isZenFolder ? t.group.label : null, unloaded: t.hasAttribute("pending") })));
    const lines = await zen.lines();
    const reply = (await zen.$$text(".zai-thread .zai-assistant .zai-seg")).join("\n");
    console.log(`cards: ${JSON.stringify(cards.map((c) => [c.title, c.warn]))}\ntabs: ${JSON.stringify(tabs)}\nlines: ${JSON.stringify(lines)}\nreply: ${reply.slice(0, 700)}`);
    const has = (p) => tabs.find((t) => t.page === p);
    check("the plain tabs are closed", !has("drag.html") && !has("points.html"), tabs);
    check("the pinned tab is still pinned, unloaded", has("lesson.html") && has("lesson.html").pinned && has("lesson.html").unloaded, tabs);
    check("the folder's tab is still in its folder, unloaded", has("form.html") && has("form.html").folder === "School" && has("form.html").unloaded, tabs);
    check("Claude didn't unpin anything or empty the folder", !lines.some((l) => /Unpin|Out of their folder/.test(l)), lines);
    check("it asks whether to close the pinned tabs too", /pinned/i.test(reply) && /\?/.test(reply), reply);
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
