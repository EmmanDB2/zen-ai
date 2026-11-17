import { runAgentInPage } from "./browser-agent.mjs";
import { hostOf, nextFrameScriptId } from "./pages.mjs";
import { pageAgent } from "./page-agent.mjs";

// ---------------------------------------------------------------------------
// Frames from other sites. Firefox runs each site in its own process, so the
// tab's frame script can't see into a frame embedded from another site (a
// video player, a survey, a payment form). A process script, loaded once into
// every content process, runs the same page agent in any frame by its
// BrowsingContext id; arguments travel as message data, never as code.
// Refs inside such a frame carry its key: f2.e5 is e5 in frame f2. A key
// belongs to one document: a frame that loads a new page gets a new key, so
// an old ref can't land on something else.
// ---------------------------------------------------------------------------
const FRAME_RUN = "ZenAI:FrameRun";
const FRAME_RESULT = "ZenAI:FrameResult";
const FRAME_AGENT_URL = "data:application/javascript;charset=utf-8," + encodeURIComponent(`(function () {
  const agent = ${pageAgent.toString()};
  Services.cpmm.addMessageListener(${JSON.stringify(FRAME_RUN)}, (msg) => {
    const { id, bc, args } = msg.data || {};
    let ctx = null;
    try { ctx = BrowsingContext.get(bc); } catch (e) {}
    if (!ctx || !ctx.docShell) return; // another process has this frame
    const reply = (r) => Services.cpmm.sendAsyncMessage(${JSON.stringify(FRAME_RESULT)}, { id, result: r });
    const fail = (e) => reply({ error: String((e && e.message) || e) });
    let result;
    try { result = agent(ctx.window, args || {}, Components); }
    catch (e) { fail(e); return; }
    if (result && typeof result.then === "function") result.then(reply, fail);
    else reply(result);
  });
})();`);
const FRAME_UNREACHABLE = "Frame not accessible: Claude can't reach inside this embedded frame.";
// A frame is read along with the tab once this much of the screen is it
const BIG_FRAME_SHARE = 0.15;

let frameAgentLoaded = false;
// Once per browser session (every window checks; the first loads it)
export function ensureFrameAgent() {
  if (frameAgentLoaded) return true;
  try {
    const ppmm = Services.ppmm;
    if (!ppmm.getDelayedProcessScripts().some((s) => s[0] === FRAME_AGENT_URL)) ppmm.loadProcessScript(FRAME_AGENT_URL, true);
    frameAgentLoaded = true;
  } catch (e) {}
  return frameAgentLoaded;
}

// The content process a frame's document lives in (else null: send to all)
function processOf(wg) {
  try {
    const ppmm = Services.ppmm;
    for (let i = 0; i < ppmm.childCount; i++) {
      const p = ppmm.getChildAt(i);
      if (!p.isInProcess && p.osPid === wg.osPid) return p;
    }
  } catch (e) {}
  return null;
}

// Runs pageAgent in a frame from another site (bc: its BrowsingContext) and
// resolves with its result, like runAgentInPage does for the tab
export function runAgentInFrame(bc, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let wg = null;
    try { wg = bc.currentWindowGlobal; } catch (e) {}
    if (!wg || !ensureFrameAgent()) {
      resolve({ error: FRAME_UNREACHABLE });
      return;
    }
    const id = `${Date.now()}:${nextFrameScriptId()}`;
    let timer;
    const onResult = (msg) => { if (msg.data && msg.data.id === id) finish(msg.data.result); };
    const finish = (value) => {
      clearTimeout(timer);
      try { Services.ppmm.removeMessageListener(FRAME_RESULT, onResult); } catch (e) {}
      resolve(value || { error: "The frame sent nothing back." });
    };
    Services.ppmm.addMessageListener(FRAME_RESULT, onResult);
    timer = setTimeout(() => finish({ error: `${FRAME_UNREACHABLE} It didn't respond (it may be busy or still loading).` }), timeoutMs);
    const data = { id, bc: bc.id, args };
    try {
      const proc = processOf(wg);
      if (proc) proc.sendAsyncMessage(FRAME_RUN, data);
      else Services.ppmm.broadcastAsyncMessage(FRAME_RUN, data);
    } catch (e) {
      finish({ error: FRAME_UNREACHABLE });
    }
  });
}

// "f2.e5" → { frame: "f2", ref: "e5" }; "e5" → { frame: "", ref: "e5" }
export function splitRef(ref) {
  const s = String(ref == null ? "" : ref).trim();
  const m = /^(f\d+)\.(e\d+)$/.exec(s);
  return m ? { frame: m[1], ref: m[2] } : { frame: "", ref: s };
}

// Web pages only: never a browser extension's frame or a built-in page
function isWebFrame(wg) {
  try {
    const p = wg.documentPrincipal;
    if (!p || !p.isContentPrincipal || p.addonId) return false;
    return /^(https?|file):/i.test(wg.documentURI ? wg.documentURI.spec : "");
  } catch (e) {
    return false;
  }
}

// Frame keys per tab: one for each document a frame has shown
const frameKeys = new WeakMap();

// The tab's frames from other sites, outer ones first: { key, bc, url,
// title, host (the frame whose page holds its <iframe>; null: the tab's) }.
// Frames from the same site aren't here: the agent around them reads them.
export function remoteFrames(browser) {
  let top = null;
  try { top = browser.browsingContext; } catch (e) {}
  if (!top || typeof top.getAllBrowsingContextsInSubtree !== "function") return [];
  if (!frameKeys.has(browser)) frameKeys.set(browser, { next: 1, byDoc: new Map() });
  const reg = frameKeys.get(browser);
  const depth = (bc) => { let n = 0; for (let b = bc; b && b !== top; b = b.parent) n++; return n; };
  const all = top.getAllBrowsingContextsInSubtree().filter((bc) => bc !== top).map((bc) => ({ bc, d: depth(bc) })).sort((a, b) => a.d - b.d);
  const byBc = new Map();
  const out = [];
  for (const { bc, d } of all) {
    const wg = bc.currentWindowGlobal;
    if (!wg || !wg.isProcessRoot || !isWebFrame(wg)) continue;
    // The nearest frame around it with a process of its own: its agent sees the <iframe>
    let host = null;
    let up = bc.parent;
    for (; up && up !== top; up = up.parent) {
      if (up.currentWindowGlobal && up.currentWindowGlobal.isProcessRoot) break;
    }
    if (up && up !== top) {
      host = byBc.get(up.id);
      if (!host) continue; // inside something we don't read (an extension's frame)
    }
    let key = reg.byDoc.get(wg.innerWindowId);
    if (!key) {
      key = "f" + reg.next++;
      reg.byDoc.set(wg.innerWindowId, key);
    }
    const f = { key, bc, url: wg.documentURI ? wg.documentURI.spec : "", title: String(wg.documentTitle || ""), host, depth: d };
    byBc.set(bc.id, f);
    out.push(f);
  }
  return out;
}

// The frame with this key, or an error Claude can act on
export function frameByKey(browser, key) {
  const f = remoteFrames(browser).find((x) => x.key === key);
  if (f) return f;
  const known = frameKeys.get(browser);
  const ever = known && [...known.byDoc.values()].includes(key);
  throw new Error(ever
    ? `Frame ${key} isn't on the page anymore (it closed, or a new page loaded in it). Call browser_read for fresh refs.`
    : `There's no frame ${key} on this page. Call browser_read to see its frames.`);
}

// Where a frame's window is in the tab (CSS px). show: scroll its <iframe>
// into view first (in every window around it).
export async function placeFrame(browser, f, show = false) {
  const outer = f.host ? await placeFrame(browser, f.host, show) : { x: 0, y: 0 };
  const args = { action: "frameBox", bc: f.bc.id, show };
  const box = f.host ? await runAgentInFrame(f.host.bc, args, 4000) : await runAgentInPage(browser, args, 4000);
  if (!box || box.error) throw new Error(`Frame ${f.key} couldn't be found on the page${box && box.error ? ` (${box.error})` : ""}.`);
  return { x: outer.x + box.x, y: outer.y + box.y, w: box.w, h: box.h, visible: box.visible };
}

// A rect from inside a frame, in the tab's coordinates
export const shiftRect = (r, at) => (r && at ? { x: r.x + at.x, y: r.y + at.y, w: r.w, h: r.h } : r);

// “Survey” from survey.example.com
function frameLabel(f, name) {
  const host = hostOf(f.url) || f.url.split("?")[0].slice(0, 60);
  const title = name || f.title;
  return `${title ? `“${title}” ` : ""}from ${host}`;
}

// The tab's snapshot (see pageAgent's "snapshot") with frames from other
// sites read into it: the ones taking up a good part of the screen (a video
// player, a survey), and any in `open` (Claude read or acted in it, or it
// was read before), which this adds to. Smaller ones are only listed.
// withText: also each read frame's words (as frameText).
export async function snapshotTab(browser, { open = new Set(), timeoutMs = 6000, withText = false } = {}) {
  const snap = await runAgentInPage(browser, { action: "snapshot" }, timeoutMs);
  if (!snap || snap.error) return snap;
  const frames = remoteFrames(browser);
  if (!frames.length) return snap;
  const vw = Number(snap.vw) || 1;
  const vh = Number(snap.vh) || 1;
  // Each frame's box in the tab: from the snapshot of the page around it
  const boxes = new Map();
  const addBoxes = (s, at) => { for (const b of s.frames || []) boxes.set(b.bc, Object.assign({}, b, { x: b.x + at.x, y: b.y + at.y })); };
  addBoxes(snap, { x: 0, y: 0 });
  const read = [];
  const listed = [];
  for (const d of [...new Set(frames.map((f) => f.depth))]) {
    await Promise.all(frames.filter((f) => f.depth === d).map(async (f) => {
      const box = boxes.get(f.bc.id);
      if (!box || !box.visible || box.w < 2 || box.h < 2) return; // hidden, or inside a frame that isn't read
      const seen = Math.max(0, Math.min(box.x + box.w, vw) - Math.max(box.x, 0)) * Math.max(0, Math.min(box.y + box.h, vh) - Math.max(box.y, 0));
      if (!open.has(f.key) && seen < BIG_FRAME_SHARE * vw * vh) {
        listed.push({ f, box });
        return;
      }
      const s = await runAgentInFrame(f.bc, { action: "snapshot", prefix: f.key + ".", offset: { x: box.x, y: box.y }, vh, withText }, timeoutMs);
      if (!s || s.error) {
        read.push({ f, box, error: (s && s.error) || "it didn't answer" });
        return;
      }
      open.add(f.key);
      addBoxes(s, box);
      read.push({ f, box, s });
    }));
  }
  if (!read.length && !listed.length) return snap;
  const order = (a, b) => frames.indexOf(a.f) - frames.indexOf(b.f);
  read.sort(order);
  listed.sort(order);
  const rows = snap.rows.slice();
  const headings = snap.headings.slice();
  const dialogs = snap.dialogs.slice();
  const sections = [];
  const where = (box) => (box.y > vh ? " (below view)" : box.y + box.h < 0 ? " (above view)" : "");
  read.forEach(({ f, box, s, error }, i) => {
    const head = `Embedded frame ${f.key}: ${frameLabel(f, box.name)}, ${Math.round(box.w)}×${Math.round(box.h)}${where(box)}`;
    if (error) {
      sections.push(`${head}. It couldn't be read: ${error}`);
      return;
    }
    // (groups are per document: keep each frame's apart)
    for (const [ref, line, at, group] of s.rows) rows.push([ref, line, at, group >= 0 ? group + 1000 * (i + 1) : -1]);
    for (const x of s.headings || []) headings.push(`${x} (in ${f.key})`);
    for (const x of s.dialogs || []) dialogs.push(`${x} (in ${f.key})`);
    sections.push(`${head}. Refs inside it start with ${f.key}.\n${s.text}`);
  });
  if (listed.length) {
    sections.push(`Other embedded frames (not read; browser_read with frame: "${listed[0].f.key}" reads one): ` +
      listed.slice(0, 8).map(({ f, box }) => `${f.key} ${frameLabel(f, box.name)} (${Math.round(box.w)}×${Math.round(box.h)}${where(box)})`).join(", "));
  }
  // The frames go before the tab's last line ("Scrolled 40% down the page.")
  const parts = String(snap.text).split("\n\n");
  const last = parts.length > 1 && /^Scrolled /.test(parts[parts.length - 1]) ? parts.pop() : null;
  const text = [...parts, ...sections, ...(last ? [last] : [])].join("\n\n");
  const frameText = read.filter((x) => x.s && x.s.bodyText).map(({ f, s }) => `Text in frame ${f.key}:\n${s.bodyText}`).join("\n\n");
  const frameSummary = [...read.map(({ f, box }) => `${f.key} ${frameLabel(f, box.name)}`), ...listed.map(({ f, box }) => `${f.key} ${frameLabel(f, box.name)} (not read)`)].join(", ");
  return Object.assign({}, snap, { text, rows, headings, dialogs, frameSummary, frameText });
}

// One frame, fully (browser_read with frame): its section as a page read shows it
export async function snapshotFrame(browser, key, { withText = false } = {}) {
  const f = frameByKey(browser, key);
  let box = null;
  try { box = await placeFrame(browser, f); } catch (e) {}
  const view = await runAgentInPage(browser, { action: "viewport" }, 3000);
  const s = await runAgentInFrame(f.bc, { action: "snapshot", prefix: key + ".", offset: box ? { x: box.x, y: box.y } : null, vh: view && view.h, withText }, 15000);
  if (!s || s.error) throw new Error((s && s.error) || FRAME_UNREACHABLE);
  const size = box ? `, ${Math.round(box.w)}×${Math.round(box.h)}${box.visible ? "" : ", hidden"}` : "";
  let text = `Embedded frame ${key}: ${frameLabel(f, box && box.name)} (${f.url.slice(0, 200)})${size}. Refs inside it start with ${key}.\n${s.text}`;
  if (withText && s.bodyText) text += `\n\nText in the frame:\n${s.bodyText}`;
  return { text, rows: s.rows };
}

// Describes refs anywhere in the tab (and points from Claude's screenshot),
// like pageAgent's "describe": items in the order of refs, each with its
// frame's key and site if it's in one, rects in the tab's coordinates.
export async function describeTab(browser, refs, { focus = false, points = [], shot = null } = {}) {
  const parts = refs.map(splitRef);
  const items = new Array(refs.length);
  const inTab = parts.map((p, i) => i).filter((i) => !parts[i].frame);
  const first = parts[0] && parts[0].frame;
  const info = await runAgentInPage(browser, { action: "describe", refs: inTab.map((i) => parts[i].ref), focus: focus && !first, points, shot }, 10000);
  if (!info || info.error) return info || { error: "The page couldn't be read." };
  inTab.forEach((i, j) => (items[i] = info.items[j]));
  for (const key of [...new Set(parts.map((p) => p.frame).filter(Boolean))]) {
    const mine = parts.map((p, i) => i).filter((i) => parts[i].frame === key);
    const lost = (error) => mine.forEach((i) => (items[i] = { ref: refs[i], found: false, error }));
    let f;
    try { f = frameByKey(browser, key); } catch (e) { lost(e.message); continue; }
    const r = await runAgentInFrame(f.bc, { action: "describe", refs: mine.map((i) => parts[i].ref), focus: focus && key === first }, 10000);
    if (!r || r.error) { lost((r && r.error) || FRAME_UNREACHABLE); continue; }
    let at = null;
    try { at = await placeFrame(browser, f, focus && key === first); } catch (e) {}
    mine.forEach((i, j) => (items[i] = Object.assign({}, r.items[j], { ref: refs[i], frame: key, frameHost: hostOf(f.url), rect: shiftRect(r.items[j].rect, at) })));
  }
  // A point over a frame from another site: ask that frame what's there
  const spots = [];
  for (const s of info.spots || []) spots.push(s.remote ? await spotInFrame(browser, s) : s);
  return Object.assign({}, info, { items, spots });
}

async function spotInFrame(browser, spot) {
  let s = spot;
  for (let i = 0; s && s.found && s.remote && i < 4; i++) {
    const f = remoteFrames(browser).find((x) => x.bc.id === s.remote.bc);
    if (!f) return { found: false, error: FRAME_UNREACHABLE };
    const r = await runAgentInFrame(f.bc, { action: "describe", refs: [], points: [{ x: s.remote.x, y: s.remote.y }], local: true }, 10000);
    if (!r || r.error) return { found: false, error: (r && r.error) || FRAME_UNREACHABLE };
    let at = null;
    try { at = await placeFrame(browser, f); } catch (e) {}
    s = Object.assign({}, r.spots[0], { frame: f.key, frameHost: hostOf(f.url) });
    if (s.rect) s.rect = shiftRect(s.rect, at);
  }
  return s;
}

// An action the page agent passed on ({ forward: { bc, … } }: it landed in a
// frame from another site) → run it there, as often as frames are nested.
// args(forward) gives the frame's arguments. Resolves { result, frame }.
export async function followFrames(browser, result, args, timeoutMs = 10000) {
  let r = result;
  let frame = null;
  for (let i = 0; r && r.forward && i < 4; i++) {
    const f = remoteFrames(browser).find((x) => x.bc.id === r.forward.bc);
    if (!f) throw new Error(FRAME_UNREACHABLE);
    frame = f;
    r = await runAgentInFrame(f.bc, args(r.forward), timeoutMs);
    if (r && r.error) throw new Error(r.error);
  }
  if (r && r.forward) throw new Error(FRAME_UNREACHABLE);
  return { result: r, frame };
}

// browser_wait's check across the tab and its frames from other sites: text
// anywhere, gone everywhere, the ref where it lives, and the main video
// (one that's playing, else the biggest)
export async function watchTab(browser, { text = "", gone = "", ref = "", button = "" } = {}) {
  const want = splitRef(ref);
  const top = await runAgentInPage(browser, { action: "watch", text, gone, button, ref: want.frame ? "" : want.ref }, 5000);
  if (!top || top.error) return top || { error: "The page couldn't be read." };
  const frames = remoteFrames(browser).slice(0, 12);
  if (!frames.length) return top;
  const res = await Promise.all(frames.map((f) => runAgentInFrame(f.bc, { action: "watch", text, gone, button, ref: f.key === want.frame ? want.ref : "" }, 4000)));
  const ok = res.filter((r) => r && !r.error);
  const out = Object.assign({}, top);
  if (button) {
    const all = [top.button, ...ok.map((r) => r.button)].filter(Boolean);
    out.button = { found: all.some((b) => b.found), ready: all.some((b) => b.ready) };
  }
  if (text) out.text = !!top.text || ok.some((r) => r.text);
  if (gone) out.gone = !!top.gone && ok.every((r) => r.gone);
  if (ref && want.frame) {
    const i = frames.findIndex((f) => f.key === want.frame);
    out.ref = i >= 0 && res[i] && !res[i].error ? res[i].ref : null;
  }
  const videos = [top.video, ...ok.map((r) => r.video)].filter(Boolean);
  const main = videos.find((v) => !v.paused && !v.ended) || videos.slice().sort((a, b) => (b.area || 0) - (a.area || 0))[0] || null;
  out.video = main ? Object.assign({}, main, { count: videos.reduce((n, v) => n + (v.count || 1), 0) }) : null;
  return out;
}
