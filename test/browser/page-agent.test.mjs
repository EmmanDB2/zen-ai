// The page agent (src/page-agent.mjs) in real Chromium against a tricky form:
// labels, shadow DOM, iframes, React, protected fields, submit detection.
import { checker, crash, launchChromium, pageAgentRunner, pageUrl } from "../helpers/common.mjs";

const { check, done } = checker();
(async () => {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await page.goto(pageUrl("form.html"));
  await page.waitForTimeout(300);
  const agent = await pageAgentRunner(page);
  const snap = await agent({ action: "snapshot" });
  const t = snap.text;
  const refOf = (re) => { const m = t.split("\n").find((l) => re.test(l)); return m ? m.match(/\[(e\d+)\]/)[1] : null; };
  check("title/url", snap.title.startsWith("Apply") && snap.url.endsWith("form.html"));
  check("label via for=", /textbox "First name" autocomplete=given-name required value=""/.test(t));
  check("aria-label field", /textbox "Last name"/.test(t));
  check("wrapping label + type", /textbox "Email" type=email autocomplete=email required/.test(t));
  check("placeholder as label", /textbox "Phone number" type=tel/.test(t));
  check("password protected", /textbox "Password" type=password PROTECTED password/.test(t));
  check("card protected", /"Card number" PROTECTED payment card/.test(t));
  check("select with options", /dropdown "School year" selected="Choose…" options: Choose… \| Freshman/.test(t));
  check("radio with group", /radio "Yes" unchecked group="Are you authorized to work in the US\?"/.test(t));
  check("hidden checkbox behind label", /checkbox "I agree to the terms" unchecked/.test(t));
  check("contenteditable textbox", /textbox "Cover letter"/.test(t));
  check("shadow DOM button", /button "Shadow action"/.test(t));
  check("same-origin iframe field", /textbox "Portfolio URL"/.test(t));
  check("submit marked", /button "Submit application" \(submits form\)/.test(t));
  check("link paths", /link "Jobs" → \/jobs/.test(t) && /link "Help center" → other.example.com\/help/.test(t));
  check("offscreen marked", /link "Benefits" → \/careers\/benefits \(below view\)/.test(t));
  check("form section", /— form "Application" —/.test(t));
  check("headings", /# Software Engineering Intern/.test(t));

  const R = {
    first: refOf(/"First name"/), last: refOf(/"Last name"/), email: refOf(/"Email"/), phone: refOf(/"Phone number"/), pw: refOf(/"Password"/),
    year: refOf(/"School year"/), major: refOf(/"Major/), card: refOf(/"Card number"/), yes: refOf(/radio "Yes"/), agree: refOf(/"I agree/),
    cover: refOf(/"Cover letter"/), port: refOf(/"Portfolio URL"/), submit: refOf(/"Submit application"/), covered: refOf(/"Covered thing"/),
    shadow: refOf(/"Shadow action"/), search: refOf(/"Search jobs"/), cancel: refOf(/"Cancel"/),
  };
  const desc = await agent({ action: "describe", refs: [R.submit, R.pw, R.cancel, "e999"] });
  check("describe: submit detected", desc.items[0].submits === "submits a form", desc.items[0]);
  check("describe: protected", desc.items[1].protected === "password");
  check("describe: cancel button flagged as risky word", /cancel/i.test(desc.items[2].submits), desc.items[2].submits);
  check("describe: missing ref", desc.items[3].found === false);

  const fill = await agent({ action: "fill", fields: [
    { ref: R.first, value: "Alex" }, { ref: R.last, value: "Kim" }, { ref: R.email, value: "alex@example.com" },
    { ref: R.phone, value: "410-555-0100" }, { ref: R.pw, value: "hunter2" }, { ref: R.year, value: "Junior" },
    { ref: R.major, value: "Computer Science" }, { ref: R.card, value: "4111111111111111" }, { ref: R.yes, value: "true" },
    { ref: R.agree, value: "yes" }, { ref: R.cover, value: "I love building browsers." }, { ref: R.port, value: "https://alexkim.dev" },
  ] });
  const vals = await page.evaluate(() => {
    const f = document.forms.apply;
    return { first: f.first.value, last: f.last.value, email: f.email.value, phone: f.phone.value, pw: f.pw.value, year: f.year.value,
      major: f.major.value, reactMajor: log.reactMajor, echo: document.getElementById("major-echo").textContent, card: f.cardnumber.value,
      yes: f.querySelector("input[value=yes]").checked, agree: document.getElementById("agree").checked,
      cover: document.getElementById("cover").textContent, port: document.getElementById("frame").contentDocument.getElementById("port").value, submitted: log.submitted };
  });
  check("text fields filled", vals.first === "Alex" && vals.last === "Kim" && vals.email === "alex@example.com" && vals.phone === "410-555-0100");
  check("password + card untouched", vals.pw === "" && vals.card === "");
  check("select by label", vals.year === "jr");
  check("React state updated", vals.reactMajor === "Computer Science" && vals.echo === "You typed: Computer Science", vals);
  check("radio + hidden checkbox", vals.yes && vals.agree);
  check("contenteditable", vals.cover === "I love building browsers.");
  check("iframe field", vals.port === "https://alexkim.dev");
  check("fill never submits", vals.submitted === 0);
  check("skips reported", fill.results.filter((r) => r.status === "skipped").length === 2);

  const typed = await agent({ action: "type", ref: R.pw, text: "x" });
  check("type refuses password", /password field/.test(typed.error || ""), typed);
  const app = await agent({ action: "type", ref: R.first, text: " Jr", append: true });
  const firstNow = await page.evaluate(() => document.forms.apply.first.value);
  check("append typing", firstNow === "Alex Jr", firstNow);
  const sel = await agent({ action: "select", ref: R.year, option: "nope" });
  check("bad option lists choices", /No option "nope". The options are: Choose… \| Freshman/.test(sel.error || ""), sel.error);

  const cov = await agent({ action: "click", ref: R.covered });
  const sh = await agent({ action: "click", ref: R.shadow });
  const cl = await page.evaluate(() => ({ c: log.coveredClicks, s: log.shadowClicks }));
  check("covered click still lands + note", cl.c === 1 && /on top of it/.test(cov.note), cov.note);
  check("shadow DOM click", cl.s === 1 && sh.label === "Shadow action");

  await agent({ action: "key", key: "Enter", ref: R.search });
  check("Enter outside a form → keydown only", (await page.evaluate(() => log)).searchEnter === 1 && (await page.evaluate(() => log.submitted)) === 0);
  await agent({ action: "key", key: "Enter", ref: R.email });
  check("Enter in a form field submits (like a real Enter)", (await page.evaluate(() => log.submitted)) === 1);

  const sc = await agent({ action: "scroll", direction: "down" });
  check("scroll", sc.percent > 0, sc);
  const sub = await agent({ action: "click", ref: R.submit });
  check("click submit", (await page.evaluate(() => log.submitted)) === 2 && sub.label === "Submit application");

  // refs are refreshed on every read
  const snap2 = await agent({ action: "snapshot" });
  check("values show in a fresh read", /"First name" autocomplete=given-name required value="Alex Jr"/.test(snap2.text) && /checkbox "I agree to the terms" checked/.test(snap2.text));
  const listed = (snap2.text.match(/^\[e\d+\]/gm) || []).length;
  const tagged = await page.evaluate(() => {
    let n = document.querySelectorAll("[data-zai-ref]").length;
    n += document.getElementById("frame").contentDocument.querySelectorAll("[data-zai-ref]").length;
    n += document.querySelector("zai-widget").shadowRoot.querySelectorAll("[data-zai-ref]").length;
    return n;
  });
  check("one ref per listed element", tagged === listed, { tagged, listed });
  await browser.close();
  done();
})().catch(crash);
