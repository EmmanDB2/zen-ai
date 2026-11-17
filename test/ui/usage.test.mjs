// The usage ring around Send: hidden until Claude Code reports the plan's
// limits, then filled and coloured by the fuller one; Send's tooltip lists
// both after a second's hover; another window's numbers show up too (pref).
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const sec = (ms) => Math.floor(ms / 1000);

(async () => {
  const zen = await fakeZen();
  const { w, $ } = zen;
  await zen.open();
  const wrap = $(".zai-send-wrap");
  const send = $(".zai-send");
  const value = () => $(".zai-usage-value").getAttribute("stroke-dasharray");
  const tipText = () => { const t = w.document.getElementById("zai-tooltip"); return t.hidden ? "" : t.textContent; };

  check("no numbers yet: no ring", !wrap.classList.contains("zai-has-usage") && !send.hasAttribute("aria-description"));

  await zen.send("hello");
  const now = Date.now();
  zen.rateLimit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, unifiedWindows: { five_hour: { utilization: 0.51, resetsAt: sec(now + 2 * 3600000) }, seven_day: { utilization: 0.81, resetsAt: sec(now + 3 * 86400000) } } });
  await sleep(40);
  check("Claude Code's numbers: the ring shows", wrap.classList.contains("zai-has-usage"));
  check("filled to the fuller limit (weekly, 81%)", value() === "81.0 100", value());
  check("red at 80% or more", wrap.getAttribute("data-level") === "red");
  check("screen readers get both limits", /5-hour limit: 51% used.*Weekly limit: 81% used/.test(send.getAttribute("aria-description") || ""), send.getAttribute("aria-description"));
  check("kept in a pref for other windows and restarts", JSON.parse(zen.prefStore.get("zenai.usage")).windows.five_hour.utilization === 0.51);

  // Hover: "Send" first, the limits after a second
  send.dispatchEvent(new w.MouseEvent("mouseover", { bubbles: true }));
  await sleep(700);
  check("a short hover: just Send", tipText() === "Send", tipText());
  await sleep(450);
  check("after a second: both limits and how old the numbers are", /^Send5-hour limit: 51% used, resets .+Weekly limit: 81% used, resets .+Updated just now$/.test(tipText()), tipText());
  wrap.closest(".zai-panel, #zai-panel, body").dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true }));
  w.document.querySelector(".zai-input").dispatchEvent(new w.MouseEvent("mouseover", { bubbles: true }));
  await sleep(30);

  // Lower numbers from another window (the pref changes): follows them
  w.Services.prefs.setStringPref("zenai.usage", JSON.stringify({ at: Date.now(), status: "allowed", limitedBy: null, windows: { five_hour: { utilization: 0.2, resetsAt: sec(now + 3600000) }, seven_day: { utilization: 0.35, resetsAt: sec(now + 86400000) } } }));
  await sleep(20);
  check("another window's numbers show here too, green under half", value() === "35.0 100" && wrap.getAttribute("data-level") === "ok", value());

  // Limit reached
  zen.rateLimit({ status: "rejected", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 1, resetsAt: sec(now + 1800000) }, seven_day: { utilization: 0.4, resetsAt: sec(now + 86400000) } } });
  await sleep(40);
  check("limit reached: full and red", value() === "100.0 100" && wrap.getAttribute("data-level") === "red" && /5-hour limit reached/.test(send.getAttribute("aria-description")));

  // A new window starts with the saved numbers
  const zen2 = await fakeZen({ prefs: { usage: zen.prefStore.get("zenai.usage") } });
  await zen2.open();
  check("a new window shows the saved numbers right away", zen2.$(".zai-send-wrap").classList.contains("zai-has-usage") && zen2.$(".zai-usage-value").getAttribute("stroke-dasharray") === "100.0 100");

  check("the Send button still sends", zen.sent.length === 1);
  check("no errors", zen.errors.length === 0 && zen2.errors.length === 0, [...zen.errors, ...zen2.errors]);
  done();
})().catch(crash);
