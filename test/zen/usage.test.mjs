// The usage ring around Send in real Zen: the SVG draws around the button
// (pathLength, the colours from light-dark()), and a change to the pref from
// elsewhere (another window) redraws it.
import { checker, crash } from "../helpers/common.mjs";
import { realZen, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const sec = (ms) => Math.floor(ms / 1000);
const usage = (five, week) => JSON.stringify({ at: Date.now(), status: "allowed", limitedBy: null, windows: { five_hour: { utilization: five, resetsAt: sec(Date.now() + 3600000) }, seven_day: { utilization: week, resetsAt: sec(Date.now() + 86400000) } } });

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen();
  try {
    await zen.open();
    const ring = () => zen.chrome(() => {
      const wrap = document.querySelector(".zai-send-wrap");
      const svg = wrap.querySelector(".zai-usage-ring");
      const value = svg.querySelector(".zai-usage-value");
      const b = wrap.querySelector(".zai-send").getBoundingClientRect();
      const r = svg.getBoundingClientRect();
      const cs = getComputedStyle(value);
      return { shown: getComputedStyle(svg).display !== "none", level: wrap.getAttribute("data-level"), button: [b.left, b.top, b.width], ring: [r.left, r.top, r.width], stroke: cs.stroke, dash: cs.strokeDasharray, length: value.getTotalLength() };
    });
    let r = await ring();
    check("no numbers: no ring", !r.shown, r);

    await zen.chrome((u) => Services.prefs.setStringPref("zenai.usage", u), usage(0.3, 0.62));
    await new Promise((res) => setTimeout(res, 900));
    r = await ring();
    check("numbers in the pref: the ring shows, amber", r.shown && r.level === "amber", r);
    check("it sits 4px around Send", Math.abs(r.ring[0] - (r.button[0] - 4)) < 0.6 && Math.abs(r.ring[1] - (r.button[1] - 4)) < 0.6 && Math.abs(r.ring[2] - (r.button[2] + 8)) < 0.6, r);
    check("filled to 62% of the way round", /^62(px)?,? 100(px)?$/.test(r.dash), r.dash);
    check("coloured (not the default black)", r.stroke && r.stroke !== "none" && !/rgb\(0, 0, 0\)/.test(r.stroke), r.stroke);

    await zen.chrome((u) => Services.prefs.setStringPref("zenai.usage", u), usage(0.9, 0.4));
    await new Promise((res) => setTimeout(res, 900)); // past the 500 ms transition
    const red = await ring();
    check("a change from another window redraws it: red, 90%", red.level === "red" && /^90(px)?,? 100(px)?$/.test(red.dash) && red.stroke !== r.stroke, red);

    check("no errors from the mod", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
