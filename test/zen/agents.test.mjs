// A helper agent with the browser, in real Zen: it opens its OWN background
// tab (the user's tab stays selected and untouched), reads and clicks there
// with real mouse events after its own approval cards, the chat's AI can't
// list or switch to that tab while the agent works, and Stop ends the agent
// while its tab stays open for the user. Claude Code is played by the test.
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const refIn = (text, re) => ((text.split("\n").find((l) => re.test(l)) || "").match(/\[((?:f\d+\.)?e\d+)\]/) || [])[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ holdReplies: true });
  try {
    // A skill that allows agents, in the throwaway profile's skills folder
    await zen.chrome(async () => {
      const dir = PathUtils.join(PathUtils.profileDir, "chrome", "zenai-skills");
      await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
      await IOUtils.writeUTF8(PathUtils.join(dir, "browse.md"), "---\nname: browse\ndescription: Browse with a helper\nagents: 1\n---\nBODY-OF-browse");
      return true;
    });
    await zen.open();
    const userPage = zen.page("form.html");
    await zen.openTab(userPage);

    // Run /browse (the pill), like typing it
    await zen.chrome(() => {
      const input = document.querySelector(".zai-input");
      input.value = "/browse";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    });
    await sleep(400);
    await zen.chrome(() => {
      const input = document.querySelector(".zai-input");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return true;
    });
    await sleep(200);
    await zen.send("", { wait: false });
    await zen.until(() => zen.sent.some((s) => s.text.includes("BODY-OF-browse")), 15000, "the skill's message");
    const parent = zen.sent.find((s) => s.text.includes("BODY-OF-browse")).proc;
    check("the skill's message offers agents", zen.sent.find((s) => s.proc === parent).text.includes("<agent_context"));

    // The parent starts an agent with the browser
    const perm = await zen.askPermission("mcp__zenai__agent_start", { title: "Helper", instruction: "Open the help page and press Help", browser: true }, { proc: parent });
    const started = textOf(await zen.callTool("agent_start", perm.updatedInput, { proc: parent }));
    check("agent_start starts an agent", perm.behavior === "allow" && /Started agent a[0-9a-f]+/.test(started), started);
    await zen.until(() => zen.procs.some((p) => zen.isChildSpawn(p)), 15000, "the agent's process");
    const child = zen.procs.find((p) => zen.isChildSpawn(p));
    check("the agent is its own Claude Code process with no built-in tools", child !== parent && child.args[child.args.indexOf("--tools") + 1] === "");

    // Its first page: a card in its box, then a background tab of its own
    const agentPage = zen.page("frames.html");
    const navPerm = zen.askPermission("mcp__zenai__browser_navigate", { url: agentPage }, { proc: child });
    await zen.until(() => zen.chrome(() => !!document.querySelector(".zai-task .zai-approval")), 10000, "the agent's card");
    const cardText = (await zen.$$text(".zai-task .zai-approval"))[0] || "";
    check("the card is in the agent's box and names it", /Agent “Helper”/.test(cardText) && /background tab/.test(cardText), cardText.slice(0, 200));
    await zen.chrome(() => { document.querySelector(".zai-task .zai-approval .zai-allow").click(); return true; });
    const nav = await navPerm;
    const opened = textOf(await zen.callTool("browser_navigate", nav.updatedInput, { proc: child }));
    check("the agent's page opens in a new background tab", nav.behavior === "allow" && /in your own new background tab/.test(opened), opened.slice(0, 200));
    const tabs = await zen.chrome((page, own) => ({
      selected: gBrowser.selectedBrowser.currentURI.spec,
      agentTab: gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === own && t !== gBrowser.selectedTab),
      sameSpace: (() => {
        const a = gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === own);
        return !a || (a.getAttribute("zen-workspace-id") || "") === (gBrowser.selectedTab.getAttribute("zen-workspace-id") || "");
      })(),
    }), userPage, agentPage);
    check("the user's tab stays selected; the agent's tab is in the background, same Space", tabs.selected === userPage && tabs.agentTab && tabs.sameSpace, tabs);

    // Reading and clicking in its own tab (real mouse events in a background tab)
    let read = await zen.askPermission("mcp__zenai__browser_read", { full: true }, { proc: child });
    const page = textOf(await zen.callTool("browser_read", read.updatedInput || { full: true }, { proc: child }));
    check("the agent reads its own tab, not the user's", read.behavior === "allow" && /button "Help"/.test(page) && page.includes("frames.html") && !page.includes("form.html"), page.slice(0, 300));
    const clickPerm = zen.askPermission("mcp__zenai__browser_click", { ref: refIn(page, /button "Help"/) }, { proc: child });
    await zen.until(() => zen.chrome(() => !!document.querySelector(".zai-task .zai-approval")), 10000, "the click's card");
    await zen.chrome(() => { document.querySelector(".zai-task .zai-approval .zai-allow").click(); return true; });
    const cp = await clickPerm;
    const clicked = textOf(await zen.callTool("browser_click", cp.updatedInput, { proc: child }));
    check("a click in the agent's background tab works", /Clicked “Help”/.test(clicked) && /Help is on the way/.test(clicked), clicked.slice(0, 300));
    check("the user's tab was never switched", (await zen.chrome(() => gBrowser.selectedBrowser.currentURI.spec)) === userPage);

    // The chat's AI can't list or take over the agent's tab while it works
    const listPerm = await zen.askPermission("mcp__zenai__browser_switch_tab", {}, { proc: parent });
    const list = textOf(await zen.callTool("browser_switch_tab", listPerm.updatedInput || {}, { proc: parent }));
    check("the agent's tab isn't in the chat AI's tab list", !list.includes("frames.html") && list.includes("form.html"), list.slice(0, 400));
    // Navigating to a page that's open switches to its tab, but the agent's
    // tab isn't offered: the chat's AI gets an ordinary "Open" card instead
    const navParent = zen.askPermission("mcp__zenai__browser_navigate", { url: agentPage }, { proc: parent });
    await zen.until(async () => !!(await zen.card()), 10000, "the chat AI's card");
    const pc = await zen.card();
    check("browser_navigate to the agent's page doesn't switch into its tab", /^Open /.test(pc.title) && !/Switch to/.test(pc.title), pc);
    await zen.chrome(() => { [...document.querySelectorAll(".zai-approval")].pop().querySelector(".zai-deny").click(); return true; });
    await navParent;

    // Stop: the agent ends, its tab stays open for the user
    await zen.chrome(() => { document.querySelector(".zai-send").click(); return true; });
    await zen.until(() => zen.chrome(() => (document.querySelector(".zai-task") || {}).dataset?.state === "stopped"), 10000, "the agent to stop");
    const after = await zen.chrome((own) => ({
      open: gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === own),
      overlay: (document.getElementById("zai-agent") || {}).hidden,
    }), agentPage);
    check("Stop stops the agent; its tab stays open", after.open, after);
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
