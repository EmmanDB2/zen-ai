import { HTML_NS, SVG_NS } from "./config.mjs";

// ---------------------------------------------------------------------------
// Tiny DOM helpers (no innerHTML in browser chrome)
// ---------------------------------------------------------------------------
export function h(tag, props = {}, ...children) {
  const el = document.createElementNS(HTML_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child != null) el.append(child);
  }
  return el;
}

export const ICONS = {
  compose: [["path", { d: "M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" }], ["path", { d: "M18.4 2.6a2 2 0 0 1 2.8 2.8L12 14.6 8.5 15.5l.9-3.5z" }]],
  dock: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 3 }], ["path", { d: "M15 4v16" }]],
  undock: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 3 }], ["rect", { x: 11, y: 11, width: 7, height: 6, rx: 1.5 }]],
  close: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  tabs: [["rect", { x: 3, y: 7, width: 14, height: 13, rx: 2.5 }], ["path", { d: "M7 4h11a3 3 0 0 1 3 3v10" }]],
  capture: [["path", { d: "M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" }], ["path", { d: "M12 9v6M9 12h6" }]],
  send: [["path", { d: "M12 19V5M5.5 11.5L12 5l6.5 6.5" }]],
  check: [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]],
  doc: [["path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }], ["path", { d: "M14 3v5h5M9 13h6M9 17h4" }]],
  explain: [["path", { d: "M4 7h10M4 12h16M4 17h7" }], ["path", { d: "M18 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" }]],
  spark: [["path", { d: "M12 2.5v7M12 14.5v7M2.5 12h7M14.5 12h7M5.3 5.3l4.9 4.9M13.8 13.8l4.9 4.9M18.7 5.3l-4.9 4.9M10.2 13.8l-4.9 4.9" }]],
  stop: [["rect", { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.5, fill: "currentColor", stroke: "none" }]],
  copy: [["rect", { x: 8, y: 8, width: 12, height: 12, rx: 2.5 }], ["path", { d: "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" }]],
  terminal: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }], ["path", { d: "M7 9.5l3 2.5-3 2.5M12 15h5" }]],
  lines: [["path", { d: "M4 6h16M4 11h16M4 16h10" }]],
  shield: [["path", { d: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" }], ["path", { d: "M12 8v5M12 16.5v.01" }]],
  shieldOff: [["path", { d: "M6.2 4.6L12 3l8 3v6c0 1.6-.4 3.1-1.2 4.4M16.9 19.2c-1.4.9-3 1.5-4.9 1.8-4.6-1-8-4.5-8-9V6" }], ["path", { d: "M3 3l18 18" }]],
  attach: [["path", { d: "M20.5 11.5l-8.1 8.1a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" }]],
  selection: [["path", { d: "M5 4h3M5 20h3M16 4h3M16 20h3M5 4v16M19 4v16" }], ["path", { d: "M9 9h6M9 12h6M9 15h4" }]],
  folder: [["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }]],
  image: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }], ["path", { d: "M3 16l5-5 4 4 3-3 6 6" }], ["circle", { cx: 15.5, cy: 9.5, r: 1.5 }]],
  globe: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" }]],
  search: [["circle", { cx: 11, cy: 11, r: 6.5 }], ["path", { d: "M20 20l-4.2-4.2" }]],
  edit: [["path", { d: "M4 20h4L19 9l-4-4L4 16z" }], ["path", { d: "M13.5 6.5l4 4" }]],
  external: [["path", { d: "M14 4h6v6M20 4l-9 9" }], ["path", { d: "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" }]],
  x: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  pointer: [["path", { d: "M5 3.5l13.5 7-6 1.6-2.4 5.9z" }], ["path", { d: "M13 13.5l5 5" }]],
  keyboard: [["rect", { x: 2.5, y: 6, width: 19, height: 12, rx: 2.5 }], ["path", { d: "M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9" }]],
  form: [["rect", { x: 4, y: 3.5, width: 16, height: 17, rx: 2.5 }], ["path", { d: "M8 8.5h8M8 12.5h8M8 16.5h4.5" }]],
  list: [["rect", { x: 3.5, y: 6, width: 17, height: 12, rx: 3 }], ["path", { d: "M9.5 11l2.5 2.5 2.5-2.5" }]],
  stack: [["path", { d: "M12 4l8 4-8 4-8-4z" }], ["path", { d: "M4 12l8 4 8-4" }], ["path", { d: "M4 16l8 4 8-4" }]],
  eye: [["path", { d: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" }], ["circle", { cx: 12, cy: 12, r: 2.8 }]],
  history: [["path", { d: "M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" }], ["path", { d: "M3.5 4v4.5H8" }], ["path", { d: "M12 7.5V12l3 1.8" }]],
  sliders: [["path", { d: "M4 7h9M17 7h3M4 17h3M11 17h9" }], ["circle", { cx: 15, cy: 7, r: 2 }], ["circle", { cx: 9, cy: 17, r: 2 }]],
  trash: [["path", { d: "M4.5 7h15" }], ["path", { d: "M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2" }], ["path", { d: "M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7" }], ["path", { d: "M10.25 11v5M13.75 11v5" }]],
  move: [["path", { d: "M12 3v18M3 12h18" }], ["path", { d: "M9 5.5L12 2.5l3 3M9 18.5l3 3 3-3M5.5 9L2.5 12l3 3M18.5 9l3 3-3 3" }]],
  chevronDown: [["path", { d: "M6.5 9.5l5.5 5.5 5.5-5.5" }]],
  chevronUp: [["path", { d: "M6.5 14.5L12 9l5.5 5.5" }]],
  clock: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.5V12l3 2" }]],
  chat: [["path", { d: "M20 11.5c0 4.1-3.6 7.5-8 7.5-1.2 0-2.4-.3-3.4-.7L4 19.5l1.3-3.6A7.2 7.2 0 0 1 4 11.5C4 7.4 7.6 4 12 4s8 3.4 8 7.5z" }]],
};

export function icon(name, size = 18, strokeWidth = 1.8, extraClass) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", strokeWidth);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (extraClass) svg.setAttribute("class", extraClass);
  for (const [tag, attrs] of ICONS[name]) {
    const part = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) part.setAttribute(k, v);
    svg.append(part);
  }
  return svg;
}

export function gripIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 10 16");
  svg.setAttribute("width", 10);
  svg.setAttribute("height", 16);
  svg.setAttribute("aria-hidden", "true");
  for (const [cx, cy] of [[2.5, 3], [7.5, 3], [2.5, 8], [7.5, 8], [2.5, 13], [7.5, 13]]) {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", cx);
    c.setAttribute("cy", cy);
    c.setAttribute("r", 1.4);
    c.setAttribute("fill", "currentColor");
    svg.append(c);
  }
  return svg;
}

export const EFFORTS = {
  low: { bars: 1, title: "Low", desc: "Quick answers, uses less of your limit" },
  medium: { bars: 2, title: "Medium", desc: "Default" },
  high: { bars: 3, title: "High", desc: "Thinks longer, uses more limit" },
};

// Until Claude Code reports this account's models (it does on start)
export const FALLBACK_MODELS = [
  { value: "default", displayName: "Default", description: "" },
  { value: "haiku", displayName: "Haiku", description: "Haiku · Fastest for quick answers" },
  { value: "sonnet", displayName: "Sonnet", description: "Sonnet · Efficient for routine tasks" },
  { value: "opus", displayName: "Opus", description: "Opus · Best for complex tasks" },
];

// "Sonnet 5.5 · Efficient for routine tasks" → { name: "Sonnet 5.5", blurb: "Efficient for routine tasks" }
export function modelInfo(m) {
  const parts = String((m && m.description) || "").split(" · ").map((s) => s.trim()).filter(Boolean);
  const looksLikeName = parts.length > 1 && /^[A-Z][\w.-]*( [\d.]+)?$/.test(parts[0]);
  const alias = String((m && m.value) || "");
  const name = looksLikeName ? parts[0] : String((m && m.displayName) || alias.charAt(0).toUpperCase() + alias.slice(1)).replace(/\s*\(.*\)$/, "");
  // A catch like "Requires usage credits" goes first, so it's never cut off
  const rest = looksLikeName ? parts.slice(1) : parts;
  rest.sort((a, b) => /^requires/i.test(b) - /^requires/i.test(a));
  return { name, blurb: rest.join(" · ") };
}

export function gaugeIcon(level) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", 18);
  svg.setAttribute("height", 18);
  svg.setAttribute("aria-hidden", "true");
  const bars = [[4, 13, 7], [10, 9, 11], [16, 5, 15]];
  bars.forEach(([x, y, height], i) => {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("x", x);
    r.setAttribute("y", y);
    r.setAttribute("width", 4);
    r.setAttribute("height", height);
    r.setAttribute("rx", 1.5);
    r.setAttribute("fill", "currentColor");
    if (i >= EFFORTS[level].bars) r.setAttribute("opacity", "0.25");
    svg.append(r);
  });
  return svg;
}

export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function copyToClipboard(text) {
  try {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
    return true;
  } catch (e) {
    return false;
  }
}

export function openLink(url) {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    openLinkIn(url, "tab", { triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}) });
  } catch (e) {
    console.error("[Zen AI] Couldn't open link:", e);
  }
}
