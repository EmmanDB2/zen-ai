// Going to another open tab instead of opening a page again: the built mod
// in a jsdom Zen window with a course tab (where the message is sent from), a
// mail tab, a gradebook tab on the course's site and a settings page. Covers
// browser_switch_tab's list (ids, which tab Claude is in, only web pages,
// untrusted), switching to one of the user's tabs (asks; deny keeps Claude
// where it was), browser_navigate to a page that's open already (switches
// instead of opening another; tab: "new" still opens one), going back to a
// tab Claude worked in (no card), and acting in the tab it switched to.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const COURSE = `<!doctype html><html><body><h1>Module 2</h1><button id="next">Next</button></body></html>`;
const GRADES = `<!doctype html><html><head><title>Grades</title></head><body><h1>Your grades</h1><a href="/course">Back to course</a></body></html>`;

(async () => {
  const zen = await fakeZen({
    holdReplies: true,
    page: COURSE,
    moreTabs: [
      { url: "https://mail.example.org/inbox", title: "Inbox (3)" },
      { url: "https://example.com/grades#top", title: "Grades", page: GRADES },
      { url: "about:preferences", title: "Settings" },
    ],
  });
  const { w, $, $$, click } = zen;
  const [course, mail, grades] = zen.tabs;
  let opens = 0;
  w.openLinkIn = () => opens++;
  const textOf = (res) => (res.content || []).map((c) => c.text || "").join("\n");
  const lines = () => $$(".zai-thread .zai-toolline").map((l) => l.textContent);
  // Asks; if a card comes up, answers it with the button `answer` (a class)
  const ask = async (tool, input, answer = null) => {
    const p = zen.askPermission("mcp__zenai__" + tool, input);
    await sleep(60);
    const card = $(".zai-approval");
    const seen = card ? card.textContent : null;
    if (card && answer) click(card.querySelector(answer));
    return { perm: await p, card: seen };
  };

  await zen.open();
  await zen.send("Check my grades, then finish the module", { wait: false });
  await sleep(80);

  // --- The list ---
  let r = await ask("browser_switch_tab", {});
  check("listing the tabs needs no card", r.perm.behavior === "allow" && !r.card);
  const list = textOf(await zen.callTool("browser_switch_tab", r.perm.updatedInput));
  const idOf = (title) => (list.match(new RegExp(`(t\\d+) “${title}”`)) || [])[1];
  check("it lists the web pages open in this Space, with ids, and marks Claude's tab", /t\d+ “Example page” example\.com\/ · you're working here/.test(list) && !!idOf("Inbox \\(3\\)") && !!idOf("Grades"), list);
  check("...not built-in pages", !/Settings|about:/.test(list));
  check("...as untrusted content (titles come from the pages)", /<untrusted_content>\n/.test(list));
  check("the chat says Claude looked at the tabs", lines().includes("Looked at the tabs open in this Space"), lines());

  // --- One of the user's tabs: asks ---
  r = await ask("browser_switch_tab", { tab: idOf("Inbox \\(3\\)") }, ".zai-deny");
  check("switching to one of the user's tabs asks", /Switch to “Inbox \(3\)”/.test(r.card || "") && /your open tab on mail\.example\.org · Claude works there next/.test(r.card || ""), r.card);
  check("...denied: Claude stays where it was", r.perm.behavior === "deny" && w.gBrowser.selectedTab === course);

  // --- Navigating to a page that's open already switches to it ---
  r = await ask("browser_navigate", { url: "https://example.com/grades" }, ".zai-allow");
  check("browser_navigate to a page open in another tab: the card is about switching", /Switch to “Grades”/.test(r.card || "") && r.perm.behavior === "allow", r.card);
  let res = await zen.callTool("browser_navigate", r.perm.updatedInput);
  check("...it switches to that tab and opens nothing new", w.gBrowser.selectedTab === grades && opens === 0, { opens, selected: w.gBrowser.selectedTab === grades });
  check("...and says so, with that tab's page", /^That page was already open, so nothing new was opened\. Switched to the tab “Grades” \(https:\/\/example\.com\/grades#top\)\. You're now working in it\./.test(textOf(res)) && /# Your grades/.test(textOf(res)) && /link "Back to course"/.test(textOf(res)), textOf(res).slice(0, 400));
  r = await ask("browser_read", {});
  check("from then on Claude works in that tab", /Title: Grades/.test(textOf(await zen.callTool("browser_read", r.perm.updatedInput))));

  // --- Back to the tab it started in: no card ---
  const courseId = idOf("Example page");
  r = await ask("browser_switch_tab", { tab: courseId });
  check("going back to the tab the user asked from needs no card", r.perm.behavior === "allow" && !r.card && lines().includes("Back to “Example page”"), lines().slice(-2));
  res = await zen.callTool("browser_switch_tab", r.perm.updatedInput);
  check("...and Claude is back in it", w.gBrowser.selectedTab === course && /Switched to the tab/.test(textOf(res)) && /button "Next"/.test(textOf(res)), textOf(res).slice(0, 200));
  r = await ask("browser_switch_tab", { tab: idOf("Grades") });
  check("a tab Claude worked in earlier: no card either", r.perm.behavior === "allow" && !r.card);
  await zen.callTool("browser_switch_tab", r.perm.updatedInput);
  r = await ask("browser_switch_tab", { tab: courseId });
  await zen.callTool("browser_switch_tab", r.perm.updatedInput);

  // --- Odd cases ---
  r = await ask("browser_switch_tab", { tab: "t99" });
  check("a tab that isn't there: refused with how to list them", r.perm.behavior === "deny" && /There's no tab t99 in this Space\. Call browser_switch_tab without tab/.test(r.perm.message), r.perm);
  r = await ask("browser_switch_tab", { tab: courseId });
  res = await zen.callTool("browser_switch_tab", r.perm.updatedInput);
  check("the tab it's in already: says so", /You're already working in t\d+/.test(textOf(res)), textOf(res));
  r = await ask("browser_navigate", { url: "https://example.com/grades", tab: "new" }, ".zai-allow");
  check("tab: \"new\" (the user asked for a new tab) still opens one", /Open example\.com/.test(r.card || "") && r.perm.behavior === "allow", r.card);
  await zen.callTool("browser_navigate", r.perm.updatedInput);
  check("...and nothing switched", opens === 1, opens);

  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  void mail;

  // --- Spaces: only the tabs of the Space Claude is working in ---
  const spaces = [{ uuid: "{a}", name: "School" }, { uuid: "{b}", name: "Personal" }];
  const z2 = await fakeZen({ holdReplies: true, spaces, moreTabs: [{ url: "https://bank.example.net/", title: "My bank", spaceId: "{b}" }, { url: "https://notes.example.edu/", title: "Class notes", spaceId: "{a}" }] });
  await z2.open();
  await z2.send("Which tabs do I have open?", { wait: false });
  await sleep(80);
  const p2 = await z2.askPermission("mcp__zenai__browser_switch_tab", {});
  const list2 = textOf(await z2.callTool("browser_switch_tab", p2.updatedInput));
  check("with Spaces: the School Space's tabs, not the Personal one's", /“School page”/.test(list2) && /“Class notes”/.test(list2) && !/bank|Personal/.test(list2), list2);
  check("no errors (Spaces)", z2.errors.length === 0, z2.errors);
  await z2.close();

  // --- A long list: every tab gets a line and an id (not just the first 40) ---
  const many = Array.from({ length: 60 }, (_, i) => ({ url: `https://site${i}.example.org/`, title: `Page ${i}` }));
  const z3 = await fakeZen({ holdReplies: true, moreTabs: many });
  await z3.open();
  await z3.send("Close all my tabs", { wait: false });
  await sleep(80);
  const p3 = await z3.askPermission("mcp__zenai__browser_switch_tab", {});
  const list3 = textOf(await z3.callTool("browser_switch_tab", p3.updatedInput));
  const ids3 = list3.match(/^t\d+ /gm) || [];
  check("61 tabs: all 61 listed with ids, nothing left as “more”", ids3.length === 61 && /“Page 59”/.test(list3) && !/more \(not listed\)/.test(list3), { n: ids3.length, tail: list3.slice(-200) });
  check("no errors (many tabs)", z3.errors.length === 0, z3.errors);
  await z3.close();
  done();
})().catch(crash);
