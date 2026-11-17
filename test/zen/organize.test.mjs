// Zen's folders, pinned tabs and Essentials in real Zen, through the panel
// (Claude Code played by the test): the tab list shows where each tab is and
// the Space's folders; browser_organize_tabs creates, renames and fills a
// folder, takes a tab out, pins and unpins (one card for all its steps);
// Allow all covers that, but closing always asks; Essentials, the tab Claude
// works in and unknown ids are refused.
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const idIn = (list, file) => ((list.split("\n").find((l) => l.includes(file)) || "").match(/^(t\d+)/) || [])[1];

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ holdReplies: true });
  try {
    for (const p of ["math-api.html", "form.html", "drag.html", "points.html", "lesson.html", "wizard.html"]) await zen.openTab(zen.page(p));
    await zen.open();
    await zen.send("Tidy up my tabs", { wait: false });
    const list = async () => textOf(await zen.tool("browser_switch_tab", {}));
    let tabs = await list();
    const T = { extra: idIn(tabs, "math-api.html"), form: idIn(tabs, "form.html"), drag: idIn(tabs, "drag.html"), points: idIn(tabs, "points.html"), lesson: idIn(tabs, "lesson.html"), wizard: idIn(tabs, "wizard.html") };
    check("the list has every tab, the working one marked, no folders yet", Object.values(T).every(Boolean) && /wizard\.html · you're working here/.test(tabs) && !/Folders in this Space/.test(tabs), tabs);

    const where = () => zen.chrome(() => [...gBrowser.tabs].filter((t) => /^http/.test(t.linkedBrowser.currentURI.spec)).map((t) => ({
      page: t.linkedBrowser.currentURI.spec.split("/").pop(), pinned: t.pinned, folder: t.group && t.group.isZenFolder ? t.group.label : null, essential: t.hasAttribute("zen-essential"),
    })));
    const of = (w, page) => w.find((x) => x.page === page) || {};

    // --- A new folder: one card, the tabs pinned into it ---
    let perm = zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "create_folder", name: "Research", tabs: [T.form, T.drag] }] });
    let card = await zen.approve("once");
    check("one card: the new folder and its tabs", card.title === "New folder “Research”" && /in this Space · 1 step/.test(card.sub) && card.buttons.join() === "Deny,Allow once,Allow all actions in this chat", card);
    let res = textOf(await zen.callTool("browser_organize_tabs", (await perm).updatedInput));
    let w = await where();
    check("Zen made the folder, with both tabs pinned in it", of(w, "form.html").folder === "Research" && of(w, "drag.html").folder === "Research" && of(w, "form.html").pinned, w);
    const g = (res.match(/Created folder (g\d+) “Research”/) || [])[1];
    check("the result names it and lists the Space's folders", g && new RegExp(`${g} folder “Research”: 2 tabs`).test(res), res);

    tabs = await list();
    check("the tab list now shows the folder, per tab and in a list", new RegExp(`${T.form} “[^”]*” [^\\n]*in folder ${g} “Research”`).test(tabs) && new RegExp(`Folders in this Space[^]*${g} folder “Research”: 2 tabs`).test(tabs), tabs);

    // --- Several steps on one card; Allow all for the rest of the chat ---
    perm = zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [
      { do: "rename_folder", folder: g, name: "Papers" },
      { do: "move_to_folder", folder: g, tabs: [T.points] },
      { do: "pin", tabs: [T.lesson] },
    ] });
    card = await zen.approve("all");
    check("three steps, one card", card.title === "Organize your tabs" && /3 steps/.test(card.sub), card);
    res = textOf(await zen.callTool("browser_organize_tabs", (await perm).updatedInput));
    w = await where();
    check("renamed, a third tab moved in, another pinned on its own", of(w, "points.html").folder === "Papers" && of(w, "form.html").folder === "Papers" && of(w, "lesson.html").pinned && !of(w, "lesson.html").folder, { w, res });

    // With Allow all: no card
    const r1 = await zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "remove_from_folder", tabs: [T.form] }, { do: "unpin", tabs: [T.lesson] }] });
    check("Allow all covers organizing (a line, no card)", r1.behavior === "allow" && (await zen.lines()).some((l) => /^Organize tabs: Out of their folder “[^”]+”; Unpin “[^”]+” · all actions allowed$/.test(l)), await zen.lines());
    await zen.callTool("browser_organize_tabs", r1.updatedInput);
    w = await where();
    check("out of the folder but still pinned; the other unpinned", of(w, "form.html").pinned && !of(w, "form.html").folder && !of(w, "lesson.html").pinned, w);

    // --- Closing always asks, even with Allow all; pinned tabs are unloaded instead ---
    // (form.html is pinned, drag.html is in the folder, math-api.html was never pinned,
    // lesson.html was unpinned by Claude above, so it still counts as pinned)
    perm = zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "close", tabs: [T.extra, T.form, T.drag, T.lesson] }] });
    await zen.until(() => zen.card(), 10000, "the close card");
    const full = await zen.chrome(() => { const c = [...document.querySelectorAll(".zai-approval")].pop(); const pre = c.querySelector("pre"); return { pre: pre ? pre.textContent : "", rows: [...c.querySelectorAll(".zai-fields span")].map((x) => x.textContent) }; });
    check("the card lists every tab: what closes, what's only unloaded", /^Closes \(1\):\n/.test(full.pre) && /Unloads, staying in the sidebar \(3\):\n/.test(full.pre) && /Lesson 4: Lab safety/.test(full.pre.split("Unloads")[1]) && full.rows.includes("Close") && full.rows.includes("Unload, not close (pinned)"), full);
    card = await zen.approve("once");
    check("closing asks anyway, says pinned ones are only unloaded, no Allow all", /This closes 1 tab \(pinned ones are only unloaded\)\. Closing always asks/.test(card.warn) && !card.buttons.includes("Allow all actions in this chat") && card.title === "Organize your tabs", card);
    res = textOf(await zen.callTool("browser_organize_tabs", (await perm).updatedInput));
    w = await where();
    const unloaded = await zen.chrome(() => [...gBrowser.tabs].filter((t) => /(form|drag)\.html/.test(t.linkedBrowser.currentURI.spec) || t.hasAttribute("pending")).map((t) => ({ label: t.label, pending: t.hasAttribute("pending"), pinned: t.pinned, folder: t.group && t.group.isZenFolder ? t.group.label : null })));
    check("the never-pinned tab is closed; the one Claude unpinned earlier is only unloaded", !w.some((x) => x.page === "math-api.html") && w.some((x) => x.page === "lesson.html"), w);
    check("the pinned tab and the folder's tab are still there, unloaded, in place", unloaded.filter((x) => x.pending && x.pinned).length >= 2 && unloaded.some((x) => x.folder === "Papers" && x.pending), unloaded);
    check("the result says which were closed and which unloaded, and to ask about the pinned ones", new RegExp(`Closed ${T.extra}\\.`).test(res) && /Unloaded the pinned .* instead of closing them: they stay in the user's sidebar\. Don't unpin them/.test(res) && /Ask the user whether they want the pinned tabs closed too/.test(res), res);

    // --- The way around it (unpin, then close) doesn't work ---
    const there = async (page) => (await zen.chrome((p) => [...gBrowser.tabs].some((t) => t.linkedBrowser.currentURI.spec.endsWith("/" + p)), page));
    // (Allow all is on, and nothing here really closes, so no cards)
    let p2 = await zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "unpin", tabs: [T.form] }, { do: "close", tabs: [T.form] }] });
    res = textOf(await zen.callTool("browser_organize_tabs", p2.updatedInput));
    check("unpin + close in one call: the tab is still there (unloaded, not closed)", p2.behavior === "allow" && (await there("form.html")) && /Unloaded the pinned/.test(res), res);
    p2 = await zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "close", tabs: [T.form] }] });
    res = textOf(await zen.callTool("browser_organize_tabs", p2.updatedInput));
    check("closing it later in the chat: still unloaded, since Claude unpinned it", (await there("form.html")) && /Unloaded the pinned/.test(res), res);

    // --- Closing pinned tabs only with pinned: true, on a card that says so ---
    perm = zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "close", tabs: [T.form], pinned: true }] });
    card = await zen.approve("once");
    check("pinned: true: the card warns they'll be gone from the sidebar", /including 1 pinned: they'll be gone from your sidebar, not just unloaded/.test(card.warn) && /^Close pinned \(leaves your sidebar\)/.test(card.title), card);
    await zen.callTool("browser_organize_tabs", (await perm).updatedInput);
    check("...and then it's closed", !(await there("form.html")));

    // --- Refusals ---
    let r = await zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "close", tabs: [T.wizard] }] });
    check("not the tab Claude is working in", r.behavior === "deny" && /the tab you're working in/.test(r.message), r);
    r = await zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "pin", tabs: ["t999"] }] });
    check("unknown tab ids are refused", r.behavior === "deny" && /no tab t999 in this Space/.test(r.message), r);
    r = await zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "rename_folder", folder: "g999", name: "x" }] });
    check("unknown folders too", r.behavior === "deny" && /no folder g999/.test(r.message), r);
    await zen.chrome(() => { const t = [...gBrowser.tabs].find((x) => /points\.html/.test(x.linkedBrowser.currentURI.spec)); gZenPinnedTabManager.addToEssentials(t); });
    tabs = await list();
    check("an Essential shows as one in the list", new RegExp(`${T.points} [^\\n]*Essential \\(in every Space\\)`).test(tabs), tabs);
    r = await zen.askPermission("mcp__zenai__browser_organize_tabs", { steps: [{ do: "unpin", tabs: [T.points] }] });
    check("...and Claude leaves Essentials alone", r.behavior === "deny" && /is an Essential, shared by every Space/.test(r.message), r);

    check("no errors from the mod", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
