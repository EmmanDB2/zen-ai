// Saved secrets (_secrets.md) end to end, offline: the built mod in a jsdom
// Zen window, the real page agent on a sign-up form, a fake Claude Code.
// Claude only ever sees labels; the value goes straight into the matching
// protected field. Passwords on their own sites follow the usual rules;
// card/bank/ID numbers and other sites always ask (even with Allow all);
// wrong kinds, plain fields, unknown labels and chats without access are
// refused; screenshots wait while a filled card number shows; nothing with
// a value is saved in the chat.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const DIR = "/profile/chrome/zenai-skills";
const PAGE = `<!doctype html><html><body style="height:3000px">
<form id="f">
  <label>Email <input id="email" type="email"></label>
  <label>Password <input id="pw" type="password"></label>
  <label>Card number <input id="card" autocomplete="cc-number"></label>
  <label>Social Security number <input id="ssn" name="ssn"></label>
  <label>Comments <textarea id="comments"></textarea></label>
  <button type="button" id="next">Next</button>
</form></body></html>`;
const SECRETS = "# My secrets\n- Main password (example.com, mailhub.org): hunter2-SECRET\n- Visa card: 4111111111111111\n- SSN: 123-45-6789\n- Other password (other.org): zzz-SECRET\n";
const VALUES = /hunter2|4111|123-45-6789|zzz-SECRET/;

(async () => {
  const zen = await fakeZen({ holdReplies: true, page: PAGE });
  const { w, $, $$, click } = zen;
  const web = zen.webPage();
  const files = new Map(Object.entries({
    "apply.md": "---\nname: apply\ndescription: Apply\naccess:\n  - about-me\n  - secrets\n---\nFill the application.",
    "plain.md": "---\nname: plain\ndescription: Plain\n---\nDo it.",
    "_about-me.md": "# About me\nName: Alex Kim\n",
    "_secrets.md": SECRETS,
  }).map(([k, v]) => [`${DIR}/${k}`, v]));
  const io = w.IOUtils;
  const { getChildren, readUTF8 } = io;
  io.getChildren = async (d) => (d.startsWith(DIR) ? [...new Set([...files.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))] : getChildren(d));
  io.readUTF8 = async (p) => { if (files.has(p)) return files.get(p); if (p.startsWith(DIR)) throw new Error("not found"); return readUTF8(p); };
  io.stat = async () => ({ type: "regular" });
  w.Services.prefs.setStringPref("zenai.skillsVersion", "3");

  await zen.open();
  const input = $(".zai-input");
  const runSkill = async (name) => {
    input.value = "/" + name;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(80);
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(30);
    await zen.send("", { wait: false });
    await sleep(120);
  };
  const card = () => $(".zai-approval");
  const text = (res) => (res.content || []).map((c) => c.text || "").join("");
  const lines = () => $$(".zai-thread .zai-toolline").map((l) => l.textContent).join(" | ");

  // --- The skill lists secrets: Claude gets labels, never values ---
  await runSkill("apply");
  const sent = zen.sent[zen.sent.length - 1].text;
  check("Claude gets the labels, kinds and sites", sent.includes("<saved_secrets") && sent.includes("- “Main password”: password, for example.com, mailhub.org") && sent.includes("- “Visa card”: payment card, no sites listed") && sent.includes("- “SSN”: ID number, no sites listed"), sent.slice(sent.indexOf("<saved_secrets"), sent.indexOf("</saved_secrets>")));
  check("...and never a value", !VALUES.test(sent));

  const read = await zen.askPermission("mcp__zenai__browser_read", {});
  const snap = text(await zen.callTool("browser_read", read.updatedInput));
  const refOf = (re) => (snap.split("\n").find((l) => re.test(l)) || "").match(/\[(e\d+)\]/)?.[1];
  const R = { email: refOf(/"Email"/), pw: refOf(/"Password"/), card: refOf(/"Card number"/), ssn: refOf(/"Social Security number"/), comments: refOf(/"Comments"/) };
  check("page reads mark protected fields and point to saved secrets", Object.values(R).every(Boolean) && /\[e\d+\] textbox "Password" type=password PROTECTED password: never type it; use a matching saved secret/.test(snap), snap.slice(0, 500));

  // --- A password on one of its own sites: the usual card ---
  let answer = zen.askPermission("mcp__zenai__browser_type", { ref: R.pw, secret: "Main password" });
  await sleep(80);
  check("a saved password on its own site: a card naming the secret, not its value", card() && /Fill your saved “Main password” into “Password”/.test(card().textContent) && !VALUES.test(card().textContent), card() && card().textContent);
  check("...with Allow on this site (and Allow all), no warning", $(".zai-allow-site") && $(".zai-allow-all") && !$(".zai-approval-warn"));
  click($(".zai-allow"));
  let r = await answer;
  check("what goes back to Claude Code has the label only", r.behavior === "allow" && r.updatedInput.secret === "Main password" && !VALUES.test(JSON.stringify(r.updatedInput)), r.updatedInput);
  let res = await zen.callTool("browser_type", r.updatedInput);
  check("the page's password field gets the value", web.document.getElementById("pw").value === "hunter2-SECRET");
  check("the result says which secret went where, no value", /Filled the saved “Main password” into “Password”/.test(text(res)) && !VALUES.test(text(res)), text(res).slice(0, 200));
  check("the password field isn't marked for the screenshot guard (it's hidden)", !web.document.getElementById("pw").hasAttribute("data-zai-secret"));

  // Allowed on this site: the next password fill goes straight through
  answer = zen.askPermission("mcp__zenai__browser_type", { ref: R.pw, secret: "Main password" });
  await sleep(80);
  click($(".zai-allow-site"));
  await answer;
  r = await zen.askPermission("mcp__zenai__browser_type", { ref: R.pw, secret: "Main password" });
  check("allowed on this site: a saved password goes through with a line", r.behavior === "allow" && !card() && /Fill your saved “Main password” into “Password” · allowed on this site/.test(lines()));
  await zen.callTool("browser_type", r.updatedInput);

  // --- Allow all, then a card number: still asks, no Allow all on that card ---
  // (Enter always asks, so its card is where Allow all gets chosen here)
  answer = zen.askPermission("mcp__zenai__browser_press_key", { ref: R.email, key: "Enter" });
  await sleep(80);
  click($(".zai-allow-all"));
  r = await answer;
  check("Allow all chosen", r.behavior === "allow");
  answer = zen.askPermission("mcp__zenai__browser_fill_form", { fields: [{ ref: R.card, secret: "Visa card" }, { ref: R.comments, value: "Thanks" }] });
  await sleep(80);
  const rows = $$(".zai-approval .zai-fields span").map((x) => x.textContent);
  check("a saved card number asks even with Allow all", card() && /This fills your saved payment card\. That always asks first\./.test(card().textContent), card() && card().textContent);
  check("...and its card has no Allow on this site / Allow all", !$(".zai-allow-site") && !$(".zai-allow-all"));
  check("...the field rows name the secret, not the number", rows.join("|") === "Card number|Your saved “Visa card”|Comments|Thanks" && !VALUES.test(card().textContent), rows);
  click($(".zai-allow"));
  r = await answer;
  res = await zen.callTool("browser_fill_form", r.updatedInput);
  check("both filled: the card number from _secrets.md", web.document.getElementById("card").value === "4111111111111111" && web.document.getElementById("comments").value === "Thanks" && /Filled 2 of 2 fields/.test(text(res)) && !VALUES.test(text(res)), text(res).slice(0, 300));
  check("the card field is marked for the screenshot guard", web.document.getElementById("card").getAttribute("data-zai-secret") === "payment card");

  // --- Screenshots wait while the card number shows ---
  r = await zen.askPermission("mcp__zenai__browser_screenshot", {});
  res = await zen.callTool("browser_screenshot", r.updatedInput);
  check("a screenshot is refused while the filled card number is on screen", /screenshots are off until it's gone/.test(text(res)) && !(res.content || []).some((c) => c.type === "image"), text(res));
  click($('[aria-label="Screenshot an area"]'));
  await sleep(80);
  check("your own screenshot button waits too, and says why", /Your saved payment card is showing on the page/.test($(".zai-flash") ? $(".zai-flash").textContent : "") && !$("#zai-capture"));
  web.document.getElementById("card").value = "";
  r = await zen.askPermission("mcp__zenai__browser_screenshot", {});
  res = await zen.callTool("browser_screenshot", r.updatedInput);
  check("once it's cleared, screenshots work again", !/screenshots are off/.test(text(res)), text(res).slice(0, 120));

  // --- Refusals ---
  r = await zen.askPermission("mcp__zenai__browser_type", { ref: R.pw, secret: "SSN" });
  check("a secret of another kind is refused", r.behavior === "deny" && /“Password” is a password field and “SSN” is an ID number/.test(r.message), r.message);
  r = await zen.askPermission("mcp__zenai__browser_type", { ref: R.comments, secret: "Main password" });
  check("a plain field never gets a secret", r.behavior === "deny" && /isn't a protected field/.test(r.message), r.message);
  r = await zen.askPermission("mcp__zenai__browser_type", { ref: R.pw, secret: "Bank login" });
  check("an unknown label is refused, listing the saved ones", r.behavior === "deny" && /no saved secret called “Bank login”.*“Main password”, “Visa card”, “SSN”, “Other password”/.test(r.message), r.message);
  r = await zen.askPermission("mcp__zenai__browser_type", { ref: R.pw, text: "hunter2" });
  check("Claude typing into a protected field itself is still refused", r.behavior === "deny");

  // A password for another site: always asks, with the warning
  answer = zen.askPermission("mcp__zenai__browser_type", { ref: R.pw, secret: "Other password" });
  await sleep(80);
  check("a password off its own sites asks (even with Allow all), and warns", card() && /example\.com isn't on this secret's list \(other\.org\)/.test(card().textContent) && !$(".zai-allow-all"), card() && card().textContent);
  click($(".zai-deny"));
  r = await answer;
  check("...and Deny denies it", r.behavior === "deny" && web.document.getElementById("pw").value === "hunter2-SECRET");

  // SSN: always asks
  answer = zen.askPermission("mcp__zenai__browser_type", { ref: R.ssn, secret: "SSN" });
  await sleep(80);
  check("a saved ID number asks", card() && /This fills your saved ID number/.test(card().textContent));
  click($(".zai-allow"));
  r = await answer;
  res = await zen.callTool("browser_type", r.updatedInput);
  check("...and fills the SSN field", web.document.getElementById("ssn").value === "123-45-6789" && !VALUES.test(text(res)));

  // --- A chat whose skill doesn't list secrets ---
  await zen.finishReplies();
  zen.newChat();
  await sleep(40);
  await runSkill("plain");
  check("no <saved_secrets> for a skill without access to them", !zen.sent[zen.sent.length - 1].text.includes("saved_secrets"));
  r = await zen.askPermission("mcp__zenai__browser_type", { ref: R.pw, secret: "Main password" });
  check("...and secrets can't be filled in that chat", r.behavior === "deny" && /only a skill that lists secrets under access: can use them/.test(r.message), r.message);
  await zen.finishReplies();

  // --- Nothing with a value is saved ---
  await sleep(400);
  const saved = [...zen.disk.entries()].filter(([k]) => /\/chats\//.test(k)).map(([, v]) => v).join("\n");
  check("the saved chats hold labels, never values", saved.includes("Main password") && !VALUES.test(saved));
  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  done();
})().catch(crash);
