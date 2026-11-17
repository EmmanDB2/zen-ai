// "Allow all actions in this chat" on browser approval cards, on the built
// mod (dist/) in jsdom with a fake Claude Code asking to use browser tools:
// one click and nothing asks again in that chat (even other sites), but it's
// visible, can be undone, doesn't touch Claude Code's own tools, doesn't
// survive New chat, and nothing acts after Stop.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const NAV = "mcp__zenai__browser_navigate";

(async () => {
  const zen = await fakeZen({ holdReplies: true });
  const { $, $$, click } = zen;
  const lines = () => $$(".zai-thread .zai-toolline").map((l) => l.textContent);
  await zen.open();
  await zen.send("Book me a table for two", { wait: false });
  await sleep(80);

  // The first action asks, with the new option under the usual buttons
  let answer = zen.askPermission(NAV, { url: "https://www.opentable.com/r/sushi-place" });
  await sleep(50);
  const card = $(".zai-approval");
  check("an action still asks first", !!card && /Open opentable\.com/.test(card.textContent));
  check("the card offers Deny, Allow on this site, Allow once", $$(".zai-approval-actions button").map((b) => b.textContent).join("|") === "Deny|Allow on this site|Allow once");
  const allowAll = card.querySelector(".zai-allow-all");
  check("...and 'Allow all actions in this chat' under them, saying what it means", allowAll && allowAll.textContent === "Allow all actions in this chat" &&
    /submit, pay, send, delete or open other sites/.test(allowAll.getAttribute("data-tip")));
  click(allowAll);
  let r = await answer;
  check("clicking it allows this action", r.behavior === "allow");
  check("the card becomes a line that says all actions are allowed now", !$(".zai-approval") && lines().some((l) => /Open opentable\.com · all actions allowed in this chat from now on/.test(l)), lines());

  // From now on nothing asks: other sites included (the user's choice)
  answer = zen.askPermission(NAV, { url: "https://www.bank.example/transfer" });
  r = await answer;
  await sleep(30);
  check("another site: allowed without a card", r.behavior === "allow" && !$(".zai-approval"));
  const bankLine = $$(".zai-thread .zai-toolline").find((l) => /bank\.example/.test(l.textContent));
  check("...but it's shown, in the warning colour", bankLine && /Open bank\.example in a new tab · all actions allowed/.test(bankLine.textContent) && bankLine.classList.contains("zai-warned"));
  r = await zen.askPermission(NAV, { url: "back" });
  check("going back: allowed", r.behavior === "allow" && !$(".zai-approval"));
  r = await zen.askPermission(NAV, { url: "javascript:alert(1)" });
  check("still only http(s) addresses", r.behavior === "deny");

  // It's about browser actions only: Claude Code's own tools keep their rules
  r = await zen.askPermission("Bash", { command: "ls ~" });
  check("Claude Code's own tools aren't covered (still off with web content)", r.behavior === "deny" && /web content/.test(r.message));

  // Visible: the shield, the agent pill, the shield popover
  const shield = $(".zai-shield");
  check("the shield shows it's on", !shield.hidden && shield.classList.contains("zai-unlocked") && /browser actions don't ask/.test(shield.getAttribute("aria-label")));
  check("the agent pill says Claude is acting without asking", /acting without asking/.test($("#zai-agent").textContent));
  click(shield);
  const pop = $(".zai-popover");
  check("the shield popover explains it", !pop.hidden && /Browser actions don't ask/.test(pop.textContent) && /Passwords, card numbers and codes are still never filled/.test(pop.textContent));
  const undo = [...pop.querySelectorAll(".zai-pop-btn")].find((b) => b.textContent === "Ask before each action again");
  check("...with a way back", !!undo);

  // Claude is told (once) that nothing asks any more
  await zen.finishReplies();
  await zen.send("Also check the reviews", { wait: false });
  await sleep(80);
  check("the next message tells Claude actions no longer ask", /chose "Allow all actions"/.test(zen.sent.at(-1).text));

  // Undo: asking is back
  click(shield);
  click([...$(".zai-popover").querySelectorAll(".zai-pop-btn")].find((b) => b.textContent === "Ask before each action again"));
  answer = zen.askPermission(NAV, { url: "https://www.yelp.com/biz/sushi-place" });
  await sleep(50);
  check("after 'Ask before each action again', actions ask again", !!$(".zai-approval"));
  click($(".zai-deny"));
  r = await answer;
  check("...and Deny still denies", r.behavior === "deny");
  check("the shield is back to normal", !shield.classList.contains("zai-unlocked"));

  // Other cards waiting at the same time are covered by the click
  answer = zen.askPermission(NAV, { url: "https://a.example/" });
  const answer2 = zen.askPermission(NAV, { url: "https://b.example/" });
  await sleep(60);
  check("two cards waiting", $$(".zai-approval").length === 2);
  click($(".zai-allow-all"));
  const [r1, r2] = await Promise.all([answer, answer2]);
  check("'Allow all' on one answers both", r1.behavior === "allow" && r2.behavior === "allow" && $$(".zai-approval").length === 0);

  // Nothing acts after Stop, even with all actions allowed
  click($(".zai-send")); // Stop
  await sleep(60);
  r = await zen.askPermission(NAV, { url: "https://c.example/" });
  check("after Stop: denied, even with all actions allowed", r.behavior === "deny" && !$(".zai-approval"));

  // New chat: back to asking (it's never saved)
  zen.newChat();
  await zen.send("New task", { wait: false });
  await sleep(80);
  answer = zen.askPermission(NAV, { url: "https://www.opentable.com/" });
  await sleep(50);
  check("a new chat asks again", !!$(".zai-approval") && !$(".zai-shield").classList.contains("zai-unlocked"));
  click($(".zai-deny"));
  await answer;
  await zen.finishReplies();
  await sleep(400);
  check("'Allow all' isn't saved with the chat", ![...zen.disk.values()].some((v) => /allowAll/.test(v)));

  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  done();
})().catch(crash);
