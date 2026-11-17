import { prefs } from "./config.mjs";

// ---------------------------------------------------------------------------
// The plan's usage limits (5-hour and weekly), from Claude Code's
// rate_limit_event. Claude Code sends one when the numbers change (at most
// every 30 s), not with every reply, so the latest is kept in a pref: every
// window shows it, and it's still there after a restart. No DOM here.
// ---------------------------------------------------------------------------
export const USAGE_PREF = "usage";
export const USAGE_WINDOWS = [["five_hour", "5-hour limit"], ["seven_day", "Weekly limit"]];
// The ring turns amber, then red, at these fractions of the fuller limit
export const USAGE_AMBER = 0.5;
export const USAGE_RED = 0.8;

const fraction = (n) => Math.min(1, Math.max(0, Number(n)));

// rate_limit_info → what we keep, or null if there's nothing to show
export function usageFromEvent(info, now = Date.now()) {
  if (!info || typeof info !== "object") return null;
  const windows = {};
  const given = info.unifiedWindows || {};
  for (const [key] of USAGE_WINDOWS) {
    const w = given[key];
    if (w && Number.isFinite(w.utilization)) windows[key] = { utilization: fraction(w.utilization), resetsAt: Number(w.resetsAt) || null };
  }
  // The window the status is about (older Claude Code sends only this one)
  const type = info.rateLimitType;
  if (USAGE_WINDOWS.some(([k]) => k === type) && !windows[type]) {
    if (Number.isFinite(info.utilization)) windows[type] = { utilization: fraction(info.utilization), resetsAt: Number(info.resetsAt) || null };
    else if (info.status === "rejected") windows[type] = { utilization: 1, resetsAt: Number(info.resetsAt) || null };
  }
  if (!Object.keys(windows).length) return null;
  return { at: now, status: String(info.status || ""), limitedBy: USAGE_WINDOWS.some(([k]) => k === type) ? type : null, windows };
}

export function readUsage() {
  try {
    const u = JSON.parse(prefs.get(USAGE_PREF, ""));
    return u && u.windows && Number.isFinite(u.at) ? u : null;
  } catch (e) {
    return null;
  }
}

export function saveUsage(u) {
  if (u) prefs.set(USAGE_PREF, JSON.stringify(u));
}

// What the ring and its tooltip show: { fill (0–1), level, limitHit, rows, updated }
// or null. A window whose reset time has passed counts as empty: its new
// numbers come with Claude Code's next update.
export function usageView(u, now = Date.now()) {
  if (!u) return null;
  const rows = [];
  let fill = 0;
  let limitHit = false;
  for (const [key, label] of USAGE_WINDOWS) {
    const w = u.windows[key];
    if (!w) continue;
    const resets = w.resetsAt ? w.resetsAt * 1000 : null;
    const passed = resets !== null && resets <= now;
    const hit = !passed && u.status === "rejected" && u.limitedBy === key;
    const used = passed ? 0 : hit ? 1 : w.utilization;
    fill = Math.max(fill, used);
    limitHit = limitHit || hit;
    rows.push({ key, label, percent: Math.round(used * 100), resets, passed, hit });
  }
  if (!rows.length) return null;
  const level = limitHit || fill >= USAGE_RED ? "red" : fill >= USAGE_AMBER ? "amber" : "ok";
  return { fill, level, limitHit, rows, updated: u.at };
}

// "3:40 PM" today, "Thu 6:00 PM" later in the week, else "Nov 12"
export function formatReset(ms, now = Date.now()) {
  const d = new Date(ms);
  const today = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return time;
  if (ms - now < 6 * 86400000) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatAge(ms, now = Date.now()) {
  const min = Math.floor((now - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// One line per limit, for the tooltip and screen readers
export function usageLine(row, now = Date.now()) {
  if (row.passed) return `${row.label}: reset at ${formatReset(row.resets, now)}`;
  if (row.hit) return `${row.label} reached${row.resets ? `, resets ${formatReset(row.resets, now)}` : ""}`;
  return `${row.label}: ${row.percent}% used${row.resets ? `, resets ${formatReset(row.resets, now)}` : ""}`;
}
