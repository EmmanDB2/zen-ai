// The plan's usage limits from Claude Code's rate_limit_event: what's kept,
// how full the ring is and its colour, resets that have passed, the lines.
import "../helpers/firefox.mjs";
import { checker, crash } from "../helpers/common.mjs";
import { readUsage, saveUsage, usageFromEvent, usageLine, usageView, formatAge } from "../../src/usage.mjs";

const { check, done } = checker();
const NOW = Date.UTC(2026, 10, 3, 18, 0);
const sec = (ms) => Math.floor(ms / 1000);

// What Claude Code 2.1.296 sent on 2026-11-03 (times moved to NOW)
const real = {
  status: "allowed_warning", resetsAt: sec(NOW + 3 * 86400000), rateLimitType: "seven_day", utilization: 0.81,
  overageStatus: "rejected", isUsingOverage: false, surpassedThreshold: 0.75,
  unifiedWindows: { five_hour: { utilization: 0.51, resetsAt: sec(NOW + 2 * 3600000) }, seven_day: { utilization: 0.81, resetsAt: sec(NOW + 3 * 86400000) } },
};

(async () => {
  let u = usageFromEvent(real, NOW);
  check("keeps both windows", u.windows.five_hour.utilization === 0.51 && u.windows.seven_day.utilization === 0.81 && u.at === NOW, u);
  let v = usageView(u, NOW);
  check("the ring shows the fuller limit", Math.abs(v.fill - 0.81) < 1e-9 && v.level === "red", v);
  check("one row per limit, 5-hour first", v.rows.map((r) => `${r.key}:${r.percent}`).join() === "five_hour:51,seven_day:81");
  check("lines say percent and reset", /^5-hour limit: 51% used, resets /.test(usageLine(v.rows[0], NOW)) && /^Weekly limit: 81% used, resets /.test(usageLine(v.rows[1], NOW)), v.rows.map((r) => usageLine(r, NOW)));

  const low = { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: sec(NOW + 3600000) }, seven_day: { utilization: 0.3, resetsAt: sec(NOW + 86400000) } } };
  check("under half: green", usageView(usageFromEvent(low, NOW), NOW).level === "ok");
  low.unifiedWindows.five_hour.utilization = 0.62;
  check("half or more: amber", usageView(usageFromEvent(low, NOW), NOW).level === "amber");

  // A limit that resets counts as empty until Claude Code says more
  v = usageView(u, NOW + 2 * 3600000 + 1000);
  check("after the 5-hour reset: that row says so, ring follows the weekly", v.rows[0].passed && v.rows[0].percent === 0 && /^5-hour limit: reset at /.test(usageLine(v.rows[0], NOW + 2 * 3600000 + 1000)) && Math.abs(v.fill - 0.81) < 1e-9);
  v = usageView(u, NOW + 4 * 86400000);
  check("after both resets: empty, green", v.fill === 0 && v.level === "ok");

  // Limit reached
  u = usageFromEvent({ status: "rejected", rateLimitType: "five_hour", resetsAt: sec(NOW + 1800000), unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: sec(NOW + 1800000) }, seven_day: { utilization: 0.4, resetsAt: sec(NOW + 86400000) } } }, NOW);
  v = usageView(u, NOW);
  check("limit reached: full and red", v.fill === 1 && v.level === "red" && v.limitHit && /^5-hour limit reached, resets /.test(usageLine(v.rows[0], NOW)), v);

  // Older Claude Code: only the window the status is about
  u = usageFromEvent({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9, resetsAt: sec(NOW + 86400000) }, NOW);
  check("without unifiedWindows: uses the one window given", u && Object.keys(u.windows).join() === "seven_day" && usageView(u, NOW).level === "red");
  check("nothing usable: null", usageFromEvent({ status: "allowed" }, NOW) === null && usageFromEvent(null) === null && usageView(null) === null);
  check("odd numbers are clamped", usageFromEvent({ unifiedWindows: { five_hour: { utilization: 1.7 } } }, NOW).windows.five_hour.utilization === 1);

  // Kept in a pref
  saveUsage(usageFromEvent(real, NOW));
  check("saved and read back", readUsage().windows.seven_day.utilization === 0.81);
  globalThis.Services.prefs.setStringPref("zenai.usage", "{oops");
  check("a broken pref reads as nothing", readUsage() === null);

  check("ages", formatAge(NOW - 20000, NOW) === "just now" && formatAge(NOW - 5 * 60000, NOW) === "5 min ago" && formatAge(NOW - 3 * 3600000, NOW) === "3 h ago" && formatAge(NOW - 30 * 3600000, NOW) === "yesterday");
  done();
})().catch(crash);
