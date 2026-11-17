// Math answer boxes (MathQuill with and without its API exposed), as on
// online math editors and graphing sites.
import { checker, crash, launchChromium, pageAgentRunner, pageUrl } from "../helpers/common.mjs";

const { check, done } = checker();
(async () => {
  const b = await launchChromium();
  for (const mode of ["api", "noapi"]) {
    const page = await b.newPage();
    page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
    await page.goto(pageUrl(`math-${mode}.html`));
    await page.waitForTimeout(300);
    const agent = await pageAgentRunner(page);
    const snap = await agent({ action: "snapshot" });
    const ref = (re) => (snap.text.split("\n").find((l) => re.test(l)) || "").match(/\[(e\d+)\]/)?.[1];
    const a1 = ref(/math box "Answer"/), a2 = ref(/math box "Second answer"/);
    check(`${mode}: both math boxes listed, hidden textareas not`, a1 && a2 && !/textbox "Math Input"/i.test(snap.text), { a1, a2 });
    check(`${mode}: input hint`, mode === "api" ? /input=LaTeX/.test(snap.text) : /input=keys/.test(snap.text));
    const d = await agent({ action: "describe", refs: [a1] });
    check(`${mode}: describe says math box`, d.items[0].role === "math box" && d.items[0].math === "MathQuill" && d.items[0].textField);
    if (mode === "api") {
      const r = await agent({ action: "type", ref: a1, text: "\\frac{3x^{2}}{4}" });
      const f = await agent({ action: "fill", fields: [{ ref: a2, value: "\\frac{\\sqrt{2}}{3}" }] });
      const ans = await page.evaluate(() => [readAnswers(), log]);
      check("api: LaTeX set exactly", ans[0][0] === "\\frac{3x^2}{4}" && ans[0][1] === "\\frac{\\sqrt{2}}{3}", ans);
      check("api: page's edit handler saw it", ans[1].edits > 0 && ans[1].latex === "\\frac{3x^2}{4}");
      const again = await agent({ action: "type", ref: a1, text: "\\frac{3}{4}x^{2}" });
      check("api: replace works", (await page.evaluate(() => readAnswers()[0])) === "\\frac{3}{4}x^2", await page.evaluate(() => readAnswers()[0]));
    } else {
      const r = await agent({ action: "type", ref: a1, text: "3x^2{Right}/4" });
      const ans1 = await page.evaluate(() => readAnswers());
      check("keys: typed like a calculator", /3x\^2/.test(ans1[0]) && /4/.test(ans1[0]), ans1[0]);
      const r2 = await agent({ action: "type", ref: a1, text: "x+1" });
      check("keys: replacing clears the old answer", (await page.evaluate(() => readAnswers()[0])) === "x+1", await page.evaluate(() => readAnswers()[0]));
      await agent({ action: "fill", fields: [{ ref: a2, value: "\\sqrt2{Right}/3" }] });
      const ans2 = await page.evaluate(() => [readAnswers()[1], log.latex2]);
      check("keys: sqrt auto-command + fraction", /\\sqrt\{2\}/.test(ans2[0]) && /3/.test(ans2[0]) && ans2[1] === ans2[0], ans2);
    }
    await page.close();
  }
  await b.close();
  done();
})().catch(crash);
