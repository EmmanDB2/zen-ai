// Watches in real Zen: the card (with "Then" only when there's something to
// do), Zen checking a product page by reloading it with no AI involved, a
// watch that only tells (a line in the chat), one that wakes the chat's AI in
// the watched tab, "already the case", and saved watches picking up after a
// restart (a background tab opened for them) with Stop and Remove in the list.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const fast = { "zenai.watchTickMs": "300", "zenai.watchMinMinutes": "0" };

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  let zen = await realZen({ holdReplies: true, prefs: fast });
  const watches = () => zen.chrome(async () => window.ZenAIChat.watchHost.leader().all());
  const selectTab = (part) => zen.chrome((part) => { const t = gBrowser.tabs.find((x) => x.linkedBrowser.currentURI.spec.includes(part)); gBrowser.selectedTab = t; return !!t; }, part);
  const cardInfo = () => zen.chrome(() => {
    const c = [...document.querySelectorAll(".zai-watch-card:not(.zai-decided)")].pop();
    if (!c) return null;
    return { title: c.querySelector(".zai-approval-title").textContent, rows: [...c.querySelectorAll(".zai-wc-row")].map((r) => r.textContent), note: c.querySelector(".zai-wc-note").textContent, allow: !!c.querySelector(".zai-wc-allow") };
  });
  try {
    await zen.open();
    await zen.openTab(zen.page("stock.html"));
    await zen.inPage((win) => { win.localStorage.removeItem("stock"); win.location.reload(); return true; });
    await new Promise((r) => setTimeout(r, 500));
    await zen.send("Tell me when these are in stock", { wait: false });

    // Notify only: no "Then" on the card
    let call = zen.callTool("watch_page", { what: "Studio Headphones in stock", until_button: "Add to cart", every_minutes: 0.005 });
    await zen.until(cardInfo, 8000, "the watch card");
    const card = await cardInfo();
    check("the card: until, how often, and no Then (nothing to do)", card.title === "Watch this page?" && card.rows[0] === "Until“Add to cart” can be clicked" && /^Checks.*reloading the page/.test(card.rows[1]) && card.rows.length === 2 && /Zen has to be open/.test(card.note) && !card.allow, card);
    await zen.chrome(() => [...document.querySelectorAll(".zai-watch-card .zai-allow")].pop().click());
    let res = await call;
    check("started: Claude is told not to wait", /^Watching\. Zen checks the page/.test(textOf(res)) && /finish your reply now/.test(textOf(res)), textOf(res));
    await zen.finishReplies();

    // The user goes elsewhere; Zen keeps checking (reloading) on its own
    await zen.openTab(zen.page("form.html"));
    await zen.until(async () => (await watches())[0]?.checks >= 2, 10000, "two checks");
    let list = await watches();
    check("Zen checks it: not yet", list[0].state === "watching" && /^Not yet: “Add to cart” isn't clickable yet/.test(list[0].lastNote), list[0]);
    check("...saved in the profile", existsSync(join(zen.profile, "zen-ai", "watches.json")) && JSON.parse(readFileSync(join(zen.profile, "zen-ai", "watches.json"), "utf8")).watches[0].until.button === "Add to cart");
    const before = zen.sent.length;
    await zen.inPage((win) => { win.localStorage.setItem("stock", "1"); return true; }); // same site, so the product page sees it on its next reload
    await zen.until(async () => (await watches())[0].state === "fired", 10000, "the watch to fire");
    const line = await zen.chrome(() => [...document.querySelectorAll(".zai-thread .zai-toolline")].map((l) => l.textContent).find((t) => /Watch done/.test(t)) || "");
    check("in stock: the watch fires, with a line in the chat", /Watch done: “Add to cart” can be clicked/.test(line), line);
    check("...and no AI request (it only tells)", zen.sent.length === before);

    // With something to do: Then on the card; when it happens, the AI gets a message in the watched tab
    await zen.inPage((win) => { win.localStorage.setItem("stock", "0"); return true; });
    await selectTab("stock.html");
    await zen.inPage((win) => { win.location.reload(); return true; });
    await new Promise((r) => setTimeout(r, 500));
    await zen.send("When it's back, add it to the cart then remove it", { wait: false });
    call = zen.callTool("watch_page", { what: "Headphones back", until_text_gone: "Sold out", every_minutes: 0.005, then: "add it to the cart, then remove it" });
    await zen.until(cardInfo, 8000, "the second card");
    const card2 = await cardInfo();
    check("the card shows what Claude will do, and offers not to ask", card2.rows.includes("ThenClaude will: add it to the cart, then remove it") && /Actions still ask you/.test(card2.note) && card2.allow, card2);
    const ticked = await zen.chrome(() => {
      const c = [...document.querySelectorAll(".zai-watch-card:not(.zai-decided)")].pop();
      c.querySelector(".zai-wc-allow input").click();
      const out = { warn: !c.querySelector(".zai-wc-warn").hidden && c.querySelector(".zai-wc-warn").textContent, note: c.querySelector(".zai-wc-note").textContent };
      c.querySelector(".zai-allow").click();
      return out;
    });
    check("ticked: the warning shows, the “still ask” note goes", /won't ask before clicking, typing, submitting, paying/.test(ticked.warn) && /ends when that reply is done/.test(ticked.warn) && !/still ask/.test(ticked.note), ticked);
    res = await call;
    check("...Claude is told the user allowed that run", /allowed all your actions for that run/.test(textOf(res)), textOf(res));
    check("...saved with the watch", JSON.parse(readFileSync(join(zen.profile, "zen-ai", "watches.json"), "utf8")).watches.find((w) => w.then).allowAll === true);
    await zen.finishReplies();
    await selectTab("form.html");
    const sentBefore = zen.sent.length;
    await zen.inPage((win) => { win.localStorage.setItem("stock", "1"); return true; });
    await zen.until(() => zen.sent.length > sentBefore, 15000, "the wake-up message");
    const wake = zen.sent.at(-1).text;
    check("it happens: the chat's AI gets one message with what to do", /\[Watch\] The page you set a watch on is ready: “Sold out” is gone/.test(wake) && /the user asked you to: add it to the cart, then remove it/.test(wake), wake.slice(0, 300));
    const bubble = await zen.chrome(() => { const m = [...document.querySelectorAll(".zai-thread .zai-user")].pop(); return m ? m.textContent : ""; });
    check("...shown short in the chat, marked as the watch", /watch/.test(bubble) && /Watch: “Sold out” is gone\. Now: add it to the cart, then remove it/.test(bubble), bubble);
    check("...told once that its actions won't ask, for this task", /allowed all your actions for this one task/.test(wake));
    const read = await zen.tool("browser_read", {});
    const addRef = (textOf(read).split("\n").find((l) => /button "Add to cart"/.test(l)) || "").match(/\[(e\d+)\]/)?.[1];
    const browserCard = () => zen.chrome(() => !!document.querySelector(".zai-approval .zai-allow-all"));
    const click = await zen.askPermission("mcp__zenai__browser_click", { ref: addRef });
    check("...and they don't: no card while it acts", !!addRef && click.behavior === "allow" && !(await browserCard()), { addRef, click });
    check("...and the AI works in the watched tab", /Studio Headphones/.test(textOf(read)) && /Add to cart/.test(textOf(read)), textOf(read).slice(0, 200));
    res = await zen.tool("watch_page", { what: "x", until_text: "In stock" });
    check("already the case: no card, nothing to watch", /already the case/.test(textOf(res)) && !(await cardInfo()), textOf(res));
    await zen.finishReplies();
    await zen.send("Anything else?", { wait: false });
    await zen.tool("browser_read", {});
    const later = zen.askPermission("mcp__zenai__browser_click", { ref: addRef });
    await zen.until(browserCard, 8000, "an action card");
    check("after that reply, actions ask again", await browserCard());
    await zen.chrome(() => document.querySelector(".zai-approval .zai-allow-all").closest(".zai-approval").querySelector(".zai-deny").click());
    await later;
    await zen.finishReplies();
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
    await zen.quit();

    // A restart: saved watches pick up (the page opens in a background tab)
    const saved = { version: 1, watches: [{ id: "wsaved1", chatId: "", spaceId: "", url: zen.page("stock.html"), title: "Studio Headphones", what: "Saved watch", until: { button: "Add to cart" }, reload: true, every: 0.005, then: "", created: Date.now(), ends: Date.now() + 86400000, state: "watching", lastCheck: 0, lastNote: "", firedAt: 0, checks: 0, failures: 0 }] };
    zen = await realZen({ holdReplies: true, prefs: fast, profileFiles: { "zen-ai/watches.json": JSON.stringify(saved) } });
    await zen.open();
    await zen.until(async () => (await watches())[0]?.checks >= 1, 15000, "the saved watch's first check");
    list = await watches();
    const tabs = await zen.chrome(() => gBrowser.tabs.map((t) => t.linkedBrowser.currentURI.spec));
    check("after a restart the saved watch runs (in a background tab it opened)", list[0].id === "wsaved1" && list[0].state === "watching" && tabs.some((u) => u.includes("stock.html")), { list, tabs });
    const ui = await zen.chrome(async () => {
      await new Promise((r) => setTimeout(r, 300));
      const btn = document.querySelector(".zai-watch-btn");
      const out = { shown: !btn.hidden, count: btn.querySelector(".zai-watch-count").textContent };
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      out.rows = [...document.querySelectorAll(".zai-watch-row")].map((r) => r.textContent);
      document.querySelector(".zai-watch-stop").click();
      await new Promise((r) => setTimeout(r, 400));
      out.after = [...document.querySelectorAll(".zai-watch-row")].map((r) => r.textContent);
      document.querySelector(".zai-watch-x").click();
      await new Promise((r) => setTimeout(r, 400));
      out.removed = document.querySelectorAll(".zai-watch-row").length;
      out.hiddenAfter = btn.hidden;
      return out;
    });
    check("the eye button shows the count; the list has the watch", ui.shown && ui.count === "1" && /Saved watch/.test(ui.rows[0]) && /Not yet/.test(ui.rows[0]), ui);
    check("Stop, then Remove", /Stopped/.test(ui.after[0]) && ui.removed === 0 && ui.hiddenAfter && (await watches()).length === 0, ui);
    check("no errors from the mod (after the restart)", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
