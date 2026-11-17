// Going to another open tab in real Zen (real tabs, Spaces and tab
// switching): the course page open in one tab, a drag page in another where
// the message is sent from. browser_switch_tab lists both, browser_navigate
// to the course switches to its tab instead of opening another (asks first:
// it's one of the user's tabs), Claude then acts there, and going back to
// the tab it started in needs no card. Claude Code is played by the test.
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ holdReplies: true });
  try {
    const course = zen.page("frames.html");
    await zen.openTab(course);
    await zen.openTab(zen.page("drag.html"));
    const tabs = () => zen.chrome(() => ({ count: gBrowser.tabs.length, selected: gBrowser.selectedBrowser.currentURI.spec }));
    const before = await tabs();
    await zen.open();
    await zen.send("Go back to my course and ask for help there", { wait: false });

    const list = textOf(await zen.tool("browser_switch_tab", {}));
    check("the list has both pages, and marks the one Claude is in", /“Lab Safety 101 · Module 2” 127\.0\.0\.1:\d+\/frames\.html/.test(list) && /t\d+ “[^”]*” 127\.0\.0\.1:\d+\/drag\.html · you're working here/.test(list), list);

    const perm = zen.askPermission("mcp__zenai__browser_navigate", { url: course });
    const card = await zen.approve("once");
    check("navigating to the open course: the card is about switching to that tab", /^Switch to “Lab Safety 101 · Module 2”$/.test(card.title) && /your open tab on 127\.0\.0\.1:\d+/.test(card.sub), card);
    const res = await zen.callTool("browser_navigate", (await perm).updatedInput);
    const after = await tabs();
    check("it switched to the course's tab and opened no new one", after.count === before.count && after.selected === course, { before, after });
    check("...and the result shows that page", /^That page was already open, so nothing new was opened\. Switched to the tab “Lab Safety 101 · Module 2”/.test(textOf(res)) && /button "Help"/.test(textOf(res)), textOf(res).slice(0, 300));

    const help = (textOf(res).match(/\[(e\d+)\] button "Help"/) || [])[1];
    const clickPerm = zen.askPermission("mcp__zenai__browser_click", { ref: help });
    await zen.approve("once");
    await zen.callTool("browser_click", (await clickPerm).updatedInput);
    const page = await zen.inPage((win) => win.document.getElementById("help").textContent);
    check("Claude then acts in that tab", page === "Help is on the way", page);

    const start = (list.match(/(t\d+) “[^”]*” 127\.0\.0\.1:\d+\/drag\.html/) || [])[1];
    const back = await zen.askPermission("mcp__zenai__browser_switch_tab", { tab: start });
    check("going back to the tab it started in needs no card", back.behavior === "allow" && !(await zen.card()));
    await zen.callTool("browser_switch_tab", back.updatedInput);
    check("...and that tab is showing again", /drag\.html$/.test((await tabs()).selected));
    check("no errors in Zen's console", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
