// Renders the built mod (dist/) in Chromium on a fake Zen window and saves
// screenshots of the main states, light and dark, to test/visual/out/.
// Claude Code is faked (replies, model list, usage), so this costs nothing.
// Fails if the mod logs any error. Look at the PNGs after UI changes.
//
//   node test/visual/shoot.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, dist, fixture, launchChromium } from "../helpers/common.mjs";

const OUT = join(ROOT, "test", "visual", "out");
mkdirSync(OUT, { recursive: true });
const files = Object.fromEntries(["secret.pdf", "lab3.docx", "budget.xlsx"].map((n) => [`/u/${n}`, readFileSync(fixture(n)).toString("base64")]));
const page = readFileSync(join(ROOT, "test", "visual", "page.template.html"), "utf8")
  .replace("__MOD__", () => JSON.stringify(readFileSync(dist(), "utf8")))
  .replace("__FILES__", () => JSON.stringify(files));
const pagePath = join(OUT, "panel.html");
writeFileSync(pagePath, page);

const browser = await launchChromium();
let errors = 0;
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  const p = await ctx.newPage();
  await p.goto(pathToFileURL(pagePath).href + "#snapshot");
  await p.waitForTimeout(300);
  const panelShot = async (name) => {
    const box = await p.locator("#zai-panel").boundingBox();
    await p.screenshot({ path: join(OUT, `${scheme}-${name}.png`), clip: { x: box.x - 20, y: Math.max(0, box.y - 20), width: box.width + 40, height: Math.min(900 - Math.max(0, box.y - 20), box.height + 40) } });
  };
  await p.evaluate("ZenAIChat.open()");
  await p.waitForTimeout(500);
  await panelShot("1-greeting");
  await p.locator(".zai-model-btn").click();
  await p.waitForTimeout(250);
  await panelShot("2-model-menu");
  await p.keyboard.press("Escape");
  // "/": skills grouped by folder
  await p.locator(".zai-input").fill("/");
  await p.waitForTimeout(300);
  await panelShot("13-skills");
  await p.evaluate(() => (document.querySelector(".zai-picker").scrollTop = 330));
  await p.waitForTimeout(150);
  await panelShot("13-skills-scrolled");
  await p.locator(".zai-input").fill("/sch");
  await p.waitForTimeout(250);
  await panelShot("14-skills-search");
  await p.locator(".zai-input").fill("");
  if (await p.locator(".zai-picker").isVisible()) await p.keyboard.press("Escape");
  // History: the popover, a row's trash on hover, then delete's confirm step
  await p.locator('.zai-header [aria-label="Chat history"]').click();
  await p.waitForTimeout(300);
  await panelShot("4-history");
  const lab = p.locator(".zai-hist-row", { hasText: "Lab 3 report outline" });
  await lab.hover();
  await p.waitForTimeout(150);
  await panelShot("5-history-hover");
  await lab.locator(".zai-hist-del").click();
  await p.waitForTimeout(250);
  await panelShot("6-history-confirm");
  // An expired chat: read-only, with "Continue in a new chat"
  await p.locator(".zai-hist-row", { hasText: "CSS grid" }).click();
  await p.waitForTimeout(400);
  await panelShot("7-expired");
  await p.locator('.zai-header [aria-label="New chat"]').click();
  await p.waitForTimeout(200);
  await p.locator(".zai-input").fill("Compare merge sort and quick sort");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(2500);
  await panelShot("3-reply");
  // The usage ring's tooltip: Send, then both limits after a second
  await p.locator(".zai-send").hover();
  await p.waitForTimeout(1250);
  await panelShot("15-usage-tip");
  await p.mouse.move(5, 5);
  // A reply that finishes while you look at another chat: dots on the button and its row
  await p.locator(".zai-input").fill("And heap sort?");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(60);
  await p.locator('.zai-header [aria-label="Chat history"]').click();
  await p.waitForTimeout(150);
  await p.locator(".zai-hist-row", { hasText: "Lab 3 report outline" }).click();
  await p.waitForTimeout(1200);
  await p.locator('.zai-header [aria-label="Chat history"]').click();
  await p.waitForTimeout(300);
  await panelShot("8-history-unread");
  // A browser action asking, then "Allow all actions in this chat" and the shield
  await p.keyboard.press("Escape");
  await p.locator('.zai-header [aria-label="New chat"]').click();
  await p.locator(".zai-input").fill("Book me a table for two at 7");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(300);
  await p.evaluate(() => __askPermission("mcp__zenai__browser_navigate", { url: "https://www.opentable.com/r/sushi-place-new-york" }));
  await p.waitForTimeout(400);
  await panelShot("9-approval");
  await p.locator(".zai-allow-all").click();
  await p.evaluate(() => __askPermission("mcp__zenai__browser_navigate", { url: "https://www.resy.com/cities/ny" }));
  await p.waitForTimeout(300);
  await p.locator(".zai-shield").click();
  await p.waitForTimeout(300);
  await panelShot("10-allow-all");
  // A drag at points from Claude's screenshot (a slider drawn in SVG): the card shows where
  await p.keyboard.press("Escape");
  await p.locator('.zai-header [aria-label="New chat"]').click();
  await p.locator(".zai-input").fill("Set the number of peaks to 0");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(300);
  await p.evaluate(() => __askPermission("mcp__zenai__browser_screenshot", {}));
  await p.waitForTimeout(150);
  await p.evaluate(() => __callTool("browser_screenshot", {}));
  await p.waitForTimeout(500);
  await p.evaluate(() => __askPermission("mcp__zenai__browser_drag", { from_point: { x: 320, y: 520 }, to_point: { x: 80, y: 520 } }));
  await p.waitForTimeout(500);
  await panelShot("11-point-drag");
  // Waiting (browser_wait): the line with a countdown and "Stop waiting"
  await p.locator(".zai-allow").click();
  await p.evaluate(() => __askPermission("mcp__zenai__browser_wait", { seconds: 240, reason: "for the video to finish", until_text: "Completed" }));
  await p.waitForTimeout(150);
  await p.evaluate(() => __callTool("browser_wait", { seconds: 240, reason: "for the video to finish", until_text: "Completed" }));
  await p.waitForTimeout(1300);
  await panelShot("12-waiting");
  await p.locator(".zai-wait-stop").click();
  await p.waitForTimeout(700);
  // A skill run that ends with Lessons: the update card, its review, saved
  await p.locator('.zai-header [aria-label="New chat"]').click();
  await p.waitForTimeout(200);
  await p.locator(".zai-input").fill("/grocery");
  await p.waitForTimeout(250);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(100);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(2200);
  await panelShot("16-update-offered");
  await p.locator(".zai-update button", { hasText: /^Merge$/ }).click();
  await p.waitForTimeout(900);
  await p.locator(".zai-update button", { hasText: "Show changes" }).click();
  await p.waitForTimeout(200);
  await p.evaluate(() => { const t = document.querySelector(".zai-thread:not([hidden])") || document.querySelector(".zai-thread"); t.scrollTop = t.scrollHeight; });
  await p.waitForTimeout(150);
  await panelShot("17-update-review");
  await p.locator(".zai-update button", { hasText: "Save…" }).click();
  await p.waitForTimeout(150);
  await p.locator(".zai-update button", { hasText: "Save, including" }).click();
  await p.waitForTimeout(500);
  await panelShot("18-update-saved");
  // Helper agents: boxes in a reply (one working, one done), a result, an agent's card
  await p.locator('.zai-header [aria-label="New chat"]').click();
  await p.waitForTimeout(200);
  await p.locator(".zai-input").fill("/compare");
  await p.waitForTimeout(250);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(100);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(600);
  await p.evaluate(() => __parentSay("I'll have two agents review the sources while I draft the outline."));
  await p.waitForTimeout(150);
  for (const task of [{ title: "Source review", instruction: "Compare the two articles' benchmark setups" }, { title: "Counterexamples", instruction: "Find cases where the claim fails" }]) {
    await p.evaluate((t) => __askPermission("mcp__zenai__agent_start", t), task);
    await p.waitForTimeout(120);
    await p.evaluate((t) => __callTool("agent_start", t), task);
    await p.waitForTimeout(250);
  }
  await p.waitForTimeout(900);
  await panelShot("19-agents");
  await p.locator(".zai-task", { hasText: "Counterexamples" }).locator(".zai-task-toggle").click();
  await p.waitForTimeout(250);
  await panelShot("20-agent-result");
  await p.locator(".zai-task", { hasText: "Counterexamples" }).locator(".zai-task-toggle").click();
  const venue = { title: "Check the venue", instruction: "Find the opening hours", browser: true };
  await p.evaluate((t) => __askPermission("mcp__zenai__agent_start", t), venue);
  await p.waitForTimeout(120);
  await p.evaluate((t) => __callTool("agent_start", t), venue);
  await p.waitForTimeout(500);
  await p.evaluate(() => __childAsk("Check the venue", "mcp__zenai__browser_navigate", { url: "https://www.example-venue.com/hours" }));
  await p.waitForTimeout(500);
  await p.evaluate(() => { const t = document.querySelector(".zai-thread"); t.scrollTop = t.scrollHeight; });
  await p.waitForTimeout(150);
  await panelShot("21-agent-approval");
  const errs = await p.evaluate("window.__errors");
  if (errs.length) { errors += errs.length; console.log(`${scheme} errors:`, errs); }
  await ctx.close();
}
await browser.close();
console.log(errors ? "FAIL  the mod logged errors" : `PASS  screenshots in ${OUT}`);
process.exit(errors ? 1 : 0);
