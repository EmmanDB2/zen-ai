// Saved secrets in the page agent, in real Chromium (test/fixtures/pages/form.html):
// a secret only goes into a protected field of its own kind, the result never
// repeats the value, Claude's own text still can't go into a protected field,
// and a card number that shows in plain text is reported while it's on screen
// (not once it's scrolled away or cleared; never for a hidden password).
import { checker, crash, launchChromium, pageAgentRunner, pageUrl } from "../helpers/common.mjs";

const { check, done } = checker();
(async () => {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await page.goto(pageUrl("form.html"));
  await page.waitForTimeout(300);
  const agent = await pageAgentRunner(page);
  const t = (await agent({ action: "snapshot" })).text;
  const refOf = (re) => { const m = t.split("\n").find((l) => re.test(l)); return m ? m.match(/\[(e\d+)\]/)[1] : null; };
  const R = { pw: refOf(/"Password"/), card: refOf(/"Card number"/), first: refOf(/"First name"/) };
  const val = (label) => page.evaluate((l) => { const el = [...document.querySelectorAll("input")].find((i) => (i.labels && [...i.labels].some((x) => x.textContent.includes(l))) || i.getAttribute("aria-label") === l); return el ? el.value : null; }, label);

  let r = await agent({ action: "type", ref: R.pw, secret: { value: "hunter2-SECRET", kind: "password" } });
  check("a saved password goes into the password field", !r.error && (await val("Password")) === "hunter2-SECRET", r);
  check("...and the result doesn't repeat it", !JSON.stringify(r).includes("hunter2"), r);
  r = await agent({ action: "type", ref: R.card, secret: { value: "hunter2-SECRET", kind: "password" } });
  check("a password can't go into a card field", /payment card field, not a password field/.test(r.error || ""), r);
  r = await agent({ action: "type", ref: R.first, secret: { value: "hunter2-SECRET", kind: "password" } });
  check("a secret can't go into a plain field", /isn't a protected password field/.test(r.error || "") && (await val("First name")) !== "hunter2-SECRET", r);
  r = await agent({ action: "type", ref: R.pw, text: "typed-by-claude" });
  check("Claude's own text still can't go into a protected field", /password field/.test(r.error || "") && (await val("Password")) === "hunter2-SECRET", r);

  r = await agent({ action: "fill", fields: [{ ref: R.card, secret: { value: "4111111111111111", kind: "payment card" } }, { ref: R.first, value: "Alex" }] });
  check("fill: the card number from secrets plus an ordinary field", r.results.map((x) => x.status).join() === "filled,filled" && (await val("Card number")) === "4111111111111111" && !JSON.stringify(r).includes("4111"), r);
  check("a password field isn't marked (it's hidden); the card field is", (await page.evaluate(() => [...document.querySelectorAll("[data-zai-secret]")].map((e) => e.getAttribute("data-zai-secret")).join())) === "payment card");

  // On screen or not
  await page.evaluate(() => [...document.querySelectorAll("[data-zai-secret]")][0].scrollIntoView({ block: "center" }));
  check("the filled card number is reported while it's on screen", (await agent({ action: "secretShown" })).shown === "payment card");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const off = await page.evaluate(() => { const r = document.querySelector("[data-zai-secret]").getBoundingClientRect(); return r.bottom < 0 || r.top > innerHeight; });
  if (off) check("...not once it's scrolled away", (await agent({ action: "secretShown" })).shown === "");
  await page.evaluate(() => { const el = document.querySelector("[data-zai-secret]"); el.scrollIntoView({ block: "center" }); el.value = ""; });
  check("...not once it's cleared", (await agent({ action: "secretShown" })).shown === "");
  await browser.close();
  done();
})().catch(crash);
