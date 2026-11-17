import { HTML_NS, MAX_SELECTION_CHARS, SCREENSHOT_MAX_EDGE, SCREENSHOT_MAX_PIXELS } from "./config.mjs";

// ---------------------------------------------------------------------------
// Reading pages
// ---------------------------------------------------------------------------
export let frameScriptCounter = 0;
// Unique ids for the message channels our frame scripts answer on
export function nextFrameScriptId() {
  return ++frameScriptCounter;
}

// Runs one of OUR fixed snippets in the page's process and returns its result.
// (Never pass page or user text in as code.)
export function runInPage(browser, snippet, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let mm;
    try { mm = browser.messageManager; } catch (e) {}
    if (!mm) return resolve(null);
    const channel = `ZenAI:Result:${Date.now()}:${nextFrameScriptId()}`;
    let timer;
    const finish = (value) => {
      clearTimeout(timer);
      try { mm.removeMessageListener(channel, listener); } catch (e) {}
      resolve(value);
    };
    const listener = (msg) => finish(msg.data);
    mm.addMessageListener(channel, listener);
    timer = setTimeout(() => finish(null), timeoutMs);
    const code = `(function () {
        let value = null;
        try { value = (function () { ${snippet} })(); } catch (e) {}
        sendAsyncMessage(${JSON.stringify(channel)}, value);
      })();`;
    try {
      mm.loadFrameScript("data:application/javascript;charset=utf-8," + encodeURIComponent(code), false);
    } catch (e) {
      finish(null);
    }
  });
}

export function browserInfo(browser) {
  let url = "";
  let title = "";
  try { url = browser.currentURI.spec; } catch (e) {}
  try { title = browser.contentTitle || ""; } catch (e) {}
  return { url, title };
}

export async function getPageText(browser, maxChars) {
  const { url } = browserInfo(browser);
  // 1. Firefox's own extractor (removes menus/ads, also reads PDFs)
  try {
    const windowGlobal = browser.browsingContext && browser.browsingContext.currentWindowGlobal;
    const actor = windowGlobal && windowGlobal.getActor("PageExtractor");
    if (actor) {
      const result = await actor.getText({ removeBoilerplate: true, sufficientLength: maxChars, sourceUrl: url });
      const text = typeof result === "string" ? result : result && result.text;
      if (text && text.trim()) return text.slice(0, maxChars);
    }
  } catch (e) {}
  // 2. Fallback: the page's visible text
  const text = await runInPage(browser, `return String((content.document.body && content.document.body.innerText) || "").slice(0, ${maxChars});`);
  return text && String(text).trim() ? String(text) : null;
}

export async function getSelectionText(browser) {
  const text = await runInPage(browser, `
      let t = String(content.getSelection() || "");
      const a = content.document.activeElement;
      if (!t.trim() && a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && typeof a.selectionStart === "number") {
        t = a.value.slice(a.selectionStart, a.selectionEnd);
      }
      return t.slice(0, ${MAX_SELECTION_CHARS});
    `, 1200);
  return text && String(text).trim() ? String(text).trim() : "";
}

// Screenshot of the visible part of a tab, as base64 JPEG. drawSnapshot at
// scale 1 draws one pixel per CSS pixel; it's then shrunk to a size Claude
// reads as is (no resizing on Anthropic's side), so a point Claude picks in
// it maps back to the page: CSS px = image px / ratio.
// crop: { x, y, w, h } in the tab's CSS pixels: just that part, drawn at up to
// 2 image px per CSS px (small text stays readable) and costing a fraction of
// a whole view. ratio: image px per CSS px; ox, oy: where the crop starts.
// sharp: for a document, not for Claude: drawn at 2× and only kept under
// 3200 px (Claude's own screenshots stay within what it takes unresized)
export async function captureVisible(browser, crop = null, { sharp = false } = {}) {
  const windowGlobal = browser.browsingContext && browser.browsingContext.currentWindowGlobal;
  if (!windowGlobal) throw new Error("This page can't be captured.");
  const scale = crop || sharp ? 2 : 1;
  const bitmap = await windowGlobal.drawSnapshot(null, scale, "white");
  try {
    // The part to draw, in the bitmap's pixels (scale per CSS px)
    const src = crop
      ? { x: crop.x * scale, y: crop.y * scale, w: Math.min(crop.w * scale, bitmap.width - crop.x * scale), h: Math.min(crop.h * scale, bitmap.height - crop.y * scale) }
      : { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
    if (!(src.w > 0 && src.h > 0)) throw new Error("That part of the page isn't on screen.");
    const shrink = sharp ? Math.min(1, 3200 / Math.max(src.w, src.h, 1)) : shotRatio(src.w, src.h);
    const canvas = document.createElementNS(HTML_NS, "canvas");
    canvas.width = Math.max(1, Math.round(src.w * shrink));
    canvas.height = Math.max(1, Math.round(src.h * shrink));
    canvas.getContext("2d").drawImage(bitmap, src.x, src.y, src.w, src.h, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    return {
      dataUrl, base64: dataUrl.split(",")[1], mediaType: "image/jpeg", width: canvas.width, height: canvas.height,
      ratio: canvas.width / (src.w / scale), ox: crop ? crop.x : 0, oy: crop ? crop.y : 0,
    };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

// How much to shrink a w×h screenshot: to the longest edge and the pixel
// count Claude takes without resizing
export function shotRatio(w, h) {
  return Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(w, h, 1), Math.sqrt(SCREENSHOT_MAX_PIXELS / Math.max(1, w * h)));
}

// The part of a w×h screenshot to show around some marks (image px): a 2:1
// box (up to square for a tall drag), with room around them, inside the image
export function cropAround(marks, w, h, { minWidth = 320, pad = 70 } = {}) {
  const xs = marks.map((m) => m.x);
  const ys = marks.map((m) => m.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  let cw = Math.max(minWidth, x1 - x0 + pad * 2);
  let ch = Math.max(cw / 2, y1 - y0 + pad * 2);
  if (ch > cw) cw = ch;
  cw = Math.min(cw, w);
  ch = Math.min(ch, h);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const x = clamp((x0 + x1) / 2 - cw / 2, 0, w - cw);
  const y = clamp((y0 + y1) / 2 - ch / 2, 0, h - ch);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(cw), h: Math.round(ch) };
}

// Any image (canvas or bitmap) → what Claude reads: downscaled, PNG unless
// it's a photo or too big, then JPEG
export function encodeForClaude(source, preferJpeg = false) {
  const ratio = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(source.width, source.height));
  let canvas = source;
  if (ratio < 1 || typeof source.toDataURL !== "function") {
    canvas = document.createElementNS(HTML_NS, "canvas");
    canvas.width = Math.max(1, Math.round(source.width * ratio));
    canvas.height = Math.max(1, Math.round(source.height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // transparent areas → white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  let mediaType = preferJpeg ? "image/jpeg" : "image/png";
  let dataUrl = canvas.toDataURL(mediaType, 0.9);
  if (mediaType === "image/png" && dataUrl.length > 4500000) {
    mediaType = "image/jpeg";
    dataUrl = canvas.toDataURL(mediaType, 0.9);
  }
  return { dataUrl, base64: dataUrl.split(",")[1], mediaType, width: canvas.width, height: canvas.height };
}

// Small preview for chips (sharp on Retina)
export function thumbnailUrl(source, height = 48) {
  const ratio = Math.min(1, height / source.height);
  const canvas = document.createElementNS(HTML_NS, "canvas");
  canvas.width = Math.max(1, Math.min(400, Math.round(source.width * ratio)));
  canvas.height = Math.max(1, Math.round(source.height * ratio));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export function dataUrlToBlob(dataUrl) {
  const [head, data] = String(dataUrl).split(",");
  const type = (head.match(/^data:([^;,]+)/) || [])[1] || "image/png";
  const binary = atob(data || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

// The clipboard wants PNG bytes; convert anything else first
export async function pngBytes(blob) {
  if (blob.type === "image/png") return blob.arrayBuffer();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElementNS(HTML_NS, "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png) throw new Error("Couldn't convert the image.");
  return png.arrayBuffer();
}

// Same clipboard path Firefox's own screenshot tool uses
export function copyImageToClipboard(arrayBuffer) {
  try {
    const { BrowserUtils } = ChromeUtils.importESModule("resource://gre/modules/BrowserUtils.sys.mjs");
    BrowserUtils.copyImageToClipboard(arrayBuffer);
    return true;
  } catch (e) {
    try {
      const imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
      const image = imgTools.decodeImageFromArrayBuffer(arrayBuffer, "image/png");
      const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      transferable.init(null);
      transferable.addDataFlavor("image/png");
      transferable.setTransferData("image/png", image);
      Services.clipboard.setData(transferable, null, Services.clipboard.kGlobalClipboard);
      return true;
    } catch (err) {
      console.error("[Zen AI] Couldn't copy the image:", err);
      return false;
    }
  }
}

// Keep page text from closing our tags early
export function sanitizeUntrusted(text) {
  return String(text).replace(/<(\/?)(untrusted_content|web_page|web_tab|selection|skill|attached_file)\b/gi, "‹$1$2");
}

export function attr(value) {
  return String(value || "").replace(/["<>\n]/g, " ").slice(0, 300);
}

export function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch (e) { return ""; }
}
