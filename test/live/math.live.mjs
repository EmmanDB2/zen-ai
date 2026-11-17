// Real Claude Code types math into MathQuill boxes (API hidden: key mode).
import { checker, crash, launchChromium, pageUrl } from "../helpers/common.mjs";
import { runBrowserTask } from "../helpers/live-browser.mjs";

const { check, done } = checker();
(async () => {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(pageUrl("math-noapi.html"));
  const run = await runBrowserTask(page, "Type 3/4 into the first answer box and the square root of 2, all over 3, into the second one. Don't submit anything.", { effort: "low" });
  const answers = await page.evaluate(() => readAnswers());
  check("Claude finished", !run.result.is_error, String(run.result.result).slice(0, 200));
  check("first box: 3/4", /\\frac\{3\}\{4\}/.test(answers[0]), answers[0]);
  check("second box: √2 / 3", /\\frac\{\\sqrt\{2\}\}\{3\}/.test(answers[1]), answers[1]);
  await browser.close();
  done();
})().catch(crash);
