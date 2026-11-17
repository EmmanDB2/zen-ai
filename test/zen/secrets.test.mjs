// Saved secrets in real Zen: a sign-in page on 127.0.0.1 with a school
// sign-in frame from localhost (another site, its own process). A saved
// password goes into the real password field on its own site; the frame's
// field takes the secret listed for the frame's site, not the tab's; a
// password listed for the tab's site asks (with a warning) in the frame;
// a filled card number blocks screenshots; Claude never sees a value.
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const refIn = (text, re) => ((text.split("\n").find((l) => re.test(l)) || "").match(/\[((?:f\d+\.)?e\d+)\]/) || [])[1];
const FILES = {
  "apply.md": "---\nname: apply\ndescription: Apply\naccess:\n  - secrets\n---\nSign in and apply.",
  "_secrets.md": "- Portal password (127.0.0.1): portal-SECRET-1\n- School password (localhost): school-SECRET-2\n- Visa card: 4111111111111111\n",
};
const VALUES = /SECRET-1|SECRET-2|4111/;

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ holdReplies: true });
  try {
    await zen.chrome(async (files) => {
      const dir = PathUtils.join(PathUtils.profileDir, "chrome", "zenai-skills");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      for (const [name, text] of Object.entries(files)) await IOUtils.writeUTF8(PathUtils.join(dir, name), text);
      Services.prefs.setStringPref("zenai.skillsVersion", "2");
    }, FILES);
    await zen.openTab(zen.page("login.html"));
    await zen.open();
    // Pick /apply in the "/" menu, then send
    await zen.chrome(async () => {
      const input = document.querySelector(".zai-input");
      input.value = "/apply";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await zen.send("", { wait: false });
    const msg = zen.sent[zen.sent.length - 1].text;
    check("Claude gets the secrets' labels and sites, no values", msg.includes("- “Portal password”: password, for 127.0.0.1") && msg.includes("- “School password”: password, for localhost") && !VALUES.test(msg), msg.slice(msg.indexOf("<saved_secrets"), msg.indexOf("</saved_secrets>")));

    // The page and the frame from the other site (read along with the tab once it's big enough)
    let page = textOf(await zen.tool("browser_read", { full: true }));
    const frameKey = (page.match(/\b(f\d+)\b[^\n]*School sign-in/) || page.match(/\b(f\d+)\b/) || [])[1];
    if (frameKey && !/f\d+\.e\d+\] textbox "School password"/.test(page)) page += "\n" + textOf(await zen.tool("browser_read", { frame: frameKey }));
    const R = { pw: refIn(page, /textbox "Password"/), card: refIn(page, /"Card number"/), spw: refIn(page, /textbox "School password"/) };
    check("refs for the page's password, card and the frame's password", R.pw && R.card && /^f\d+\.e\d+$/.test(R.spw || ""), { R, page: page.slice(0, 900) });

    // A saved password on its own site, into the real password field
    let perm = zen.askPermission("mcp__zenai__browser_type", { ref: R.pw, secret: "Portal password" });
    let card = await zen.approve("once");
    check("its card names the secret, on 127.0.0.1, no warning", /^Fill your saved “Portal password” into “Password”$/.test(card.title) && /127\.0\.0\.1/.test(card.sub) && !card.warn && card.buttons.includes("Allow on this site"), card);
    let res = await zen.callTool("browser_type", (await perm).updatedInput);
    const pw = await zen.inPage((win) => win.document.getElementById("pw").value);
    check("Zen typed it into the real password field", pw === "portal-SECRET-1" && /Filled the saved “Portal password” into “Password”/.test(textOf(res)) && !VALUES.test(textOf(res)), { pw, res: textOf(res) });

    // The frame's own site decides: the school password goes in there
    perm = zen.askPermission("mcp__zenai__browser_type", { ref: R.spw, secret: "School password" });
    card = await zen.approve("once");
    check("in the frame from localhost: the localhost password, no warning", /Fill your saved “School password” into “School password”/.test(card.title) && /in a frame from localhost/.test(card.sub) && !card.warn, card);
    res = await zen.callTool("browser_type", (await perm).updatedInput);
    const spw = await zen.inPage((win) => win.document.getElementById("spw").value, { frame: "login-frame" });
    check("...and it's typed into the frame's own field (its own process)", spw === "school-SECRET-2" && !VALUES.test(textOf(res)), { spw, res: textOf(res) });

    // The tab's password in the frame from another site: asks, with the warning
    perm = zen.askPermission("mcp__zenai__browser_type", { ref: R.spw, secret: "Portal password" });
    card = await zen.approve("deny");
    check("the portal password in the localhost frame: warned it isn't on its list", /localhost(:\d+)? isn't on this secret's list \(127\.0\.0\.1\)/.test(card.warn) && !card.buttons.includes("Allow all actions in this chat"), card);
    check("...denied, so the frame's field keeps the school password", (await perm).behavior === "deny" && (await zen.inPage((win) => win.document.getElementById("spw").value, { frame: "login-frame" })) === "school-SECRET-2");

    // A card number: always asks; then screenshots wait while it shows
    perm = zen.askPermission("mcp__zenai__browser_type", { ref: R.card, secret: "Visa card" });
    card = await zen.approve("once");
    check("a saved card number asks, saying so", /always asks first/.test(card.warn), card);
    await zen.callTool("browser_type", (await perm).updatedInput);
    check("the card number is in the page", (await zen.inPage((win) => win.document.getElementById("card").value)) === "4111111111111111");
    res = await zen.tool("browser_screenshot", {});
    check("a screenshot is refused while it shows (real page, real check)", /screenshots are off until it's gone/.test(textOf(res)) && !(res.content || []).some((c) => c.type === "image"), textOf(res));
    await zen.inPage((win) => { win.document.getElementById("card").value = ""; });
    res = await zen.tool("browser_screenshot", {});
    check("cleared: screenshots work again", (res.content || []).some((c) => c.type === "image"), textOf(res));

    const saved = await zen.chrome(async () => {
      await new Promise((r) => setTimeout(r, 500));
      const dir = PathUtils.join(PathUtils.profileDir, "zen-ai", "chats");
      if (!(await IOUtils.exists(dir))) return "";
      const out = [];
      for (const p of await IOUtils.getChildren(dir)) out.push(await IOUtils.readUTF8(p));
      return out.join("\n");
    });
    const lines = (await zen.lines()).join(" | ");
    check("nothing in the chat window or saved chats holds a value", !VALUES.test(lines) && !VALUES.test(saved), lines);
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
