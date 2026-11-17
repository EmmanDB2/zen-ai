// ---------------------------------------------------------------------------
// Watches (watch_page), without DOM: what a watch is, when it's due, whether
// a check meets its condition, how it's described, and the saved list
// (<profile>/zen-ai/watches.json; never page text, only what the card showed).
// Zen does the checking (watch-host.mjs); the AI is only asked when a watch
// with something to do fires.
// ---------------------------------------------------------------------------
export const WATCH_LIMITS = {
  active: 10,                 // watching at once
  minReloadMinutes: 5,        // reloading a page: no more often (sites notice)
  minLiveMinutes: 1,          // a page that updates itself (Gmail): just look
  maxMinutes: 180,
  days: 7,                    // then it stops on its own
  keepEnded: 20,              // ended ones kept in the list
};
export const WATCH_STATES = new Set(["watching", "fired", "acting", "stopped", "expired"]);

export function watchFile() {
  return PathUtils.join(PathUtils.profileDir, "zen-ai", "watches.json");
}

// The condition from the tool's arguments: text that appears, text that
// goes away, a button that can be clicked (all that are given must hold)
export function watchCondition(a) {
  const one = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : "");
  const until = { text: one(a.until_text), gone: one(a.until_text_gone), button: one(a.until_button) };
  for (const k of Object.keys(until)) if (!until[k]) delete until[k];
  if (!Object.keys(until).length) throw new Error("Say what to watch for: until_text (appears), until_text_gone (disappears) or until_button (a button that can be clicked).");
  return until;
}

// "“Add to cart” can be clicked and “Sold out” is gone"
export function describeCondition(until) {
  const parts = [];
  if (until.button) parts.push(`“${until.button}” can be clicked`);
  if (until.text) parts.push(`“${until.text}” shows up`);
  if (until.gone) parts.push(`“${until.gone}” is gone`);
  return parts.join(" and ");
}

// Minutes between checks: the AI's choice, kept within the limits
// (minimum: the hidden zenai.watchMinMinutes pref, for tests)
export function watchEvery(reload, minutes, minPref = null) {
  const min = minPref != null ? minPref : reload ? WATCH_LIMITS.minReloadMinutes : WATCH_LIMITS.minLiveMinutes;
  const n = Number(minutes);
  const want = Number.isFinite(n) && n > 0 ? n : reload ? 10 : 2;
  return Math.min(WATCH_LIMITS.maxMinutes, Math.max(min, want));
}

export function everyText(w) {
  const m = w.every;
  const when = m < 1 ? `${Math.round(m * 60)} s` : m === 1 ? "minute" : m < 60 ? `${Math.round(m)} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.round(m)} min`;
  return `every ${when}${w.reload ? ", reloading the page" : ", without reloading"}`;
}

export function newWatch({ chatId, spaceId, url, title, until, reload, every, then = "", what = "" }, now = Date.now()) {
  return {
    id: "w" + now.toString(36) + Math.random().toString(36).slice(2, 6),
    chatId, spaceId: spaceId || "", url, title: String(title || "").slice(0, 200),
    what: String(what || "").replace(/\s+/g, " ").trim().slice(0, 120),
    until, reload: !!reload, every,
    then: String(then || "").trim().slice(0, 2000),
    created: now, ends: now + WATCH_LIMITS.days * 86400000,
    state: "watching", lastCheck: 0, lastNote: "", firedAt: 0, checks: 0, failures: 0,
    allowAll: false, // set only by the card's checkbox (never by the AI)
  };
}

export function isDue(w, now = Date.now()) {
  return w.state === "watching" && now - (w.lastCheck || 0) >= w.every * 60000;
}

// A check's result (from watchTab) against the condition
export function conditionMet(until, res) {
  if (!res || res.error) return false;
  if (until.text && !res.text) return false;
  if (until.gone && !res.gone) return false;
  if (until.button && !(res.button && res.button.ready)) return false;
  return true;
}

// What the last check saw, for the list ("not yet: “Add to cart” isn't clickable")
export function checkNote(until, res) {
  if (!res || res.error) return (res && res.error) || "The page couldn't be read";
  if (conditionMet(until, res)) return "Happened";
  const why = [];
  if (until.button) why.push(res.button && res.button.found ? `“${until.button}” isn't clickable yet` : `no “${until.button}” button yet`);
  if (until.text && !res.text) why.push(`no “${until.text}” yet`);
  if (until.gone && !res.gone) why.push(`“${until.gone}” is still there`);
  return "Not yet: " + why.join("; ");
}

// The list as saved: only known fields; ended ones trimmed to the newest few
export function cleanWatches(list) {
  const out = [];
  for (const w of Array.isArray(list) ? list : []) {
    if (!w || typeof w.id !== "string" || typeof w.url !== "string" || !/^https?:/i.test(w.url) || !w.until) continue;
    const until = {};
    for (const k of ["text", "gone", "button"]) if (typeof w.until[k] === "string" && w.until[k]) until[k] = w.until[k].slice(0, 200);
    if (!Object.keys(until).length) continue;
    out.push({
      id: w.id.slice(0, 40), chatId: String(w.chatId || "").slice(0, 80), spaceId: String(w.spaceId || "").slice(0, 80),
      url: w.url.slice(0, 4000), title: String(w.title || "").slice(0, 200), what: String(w.what || "").slice(0, 120),
      until, reload: !!w.reload, every: Number(w.every) > 0 ? Number(w.every) : 10, then: String(w.then || "").slice(0, 2000),
      created: Number(w.created) || 0, ends: Number(w.ends) || 0,
      state: WATCH_STATES.has(w.state) ? (w.state === "acting" ? "fired" : w.state) : "stopped",
      lastCheck: Number(w.lastCheck) || 0, lastNote: String(w.lastNote || "").slice(0, 200),
      firedAt: Number(w.firedAt) || 0, checks: Number(w.checks) || 0, failures: Number(w.failures) || 0,
      allowAll: w.allowAll === true && !!w.then,
    });
  }
  const live = out.filter((w) => w.state === "watching");
  const ended = out.filter((w) => w.state !== "watching").sort((a, b) => (b.firedAt || b.lastCheck) - (a.firedAt || a.lastCheck)).slice(0, WATCH_LIMITS.keepEnded);
  return [...live, ...ended];
}

export async function readWatches() {
  try {
    return cleanWatches(JSON.parse(await IOUtils.readUTF8(watchFile())).watches);
  } catch (e) {
    return [];
  }
}

export async function writeWatches(list) {
  const path = watchFile();
  try {
    await IOUtils.makeDirectory(PathUtils.parent ? PathUtils.parent(path) : path.replace(/\/[^/]*$/, ""), { ignoreExisting: true });
    await IOUtils.writeUTF8(path, JSON.stringify({ version: 1, watches: cleanWatches(list) }, null, 1), { tmpPath: path + ".tmp" });
  } catch (e) {
    console.error("[Zen AI] Couldn't save the watches:", e);
  }
}

// The message the chat's AI gets when a watch with something to do fires
export function watchWakeText(w, title) {
  return `[Watch] The page you set a watch on is ready: ${describeCondition(w.until)}${w.what ? ` (${w.what})` : ""}, at ${w.url}. ` +
    `When this happened, the user asked you to: ${w.then}\n` +
    `Do it now. That page is your current tab${title ? ` (its title, from the page: “${title}”)` : ""}. Every action asks the user as usual, so keep going step by step.`;
}
