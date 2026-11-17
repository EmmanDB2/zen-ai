import { parseTable } from "./markdown.mjs";
import { IMAGE_LINE, fitImage } from "./files.mjs";

// ---------------------------------------------------------------------------
// PDFs (create_pdf): Markdown → a document in a hidden, in-process browser
// (built with DOM calls, no scripts), printed by Gecko's own PDF printer to
// a stream, the way Firefox's WebDriver prints. Real fonts and Unicode (math
// symbols, accents), tables that repeat their header, page numbers.
// ---------------------------------------------------------------------------

export const PDF_CSS = `
html { color: #1d1d1f; background: #fff; }
body { margin: 0; font: 11pt/1.45 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; }
.doc-title { font-size: 22pt; line-height: 1.2; font-weight: 700; margin: 0 0 14pt; padding-bottom: 8pt; border-bottom: 1px solid #d2d2d7; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 16pt 0 6pt; break-after: avoid; }
h1 { font-size: 18pt; } h2 { font-size: 14.5pt; } h3 { font-size: 12.5pt; } h4, h5, h6 { font-size: 11pt; }
:is(h1, h2, h3, h4, h5, h6, .doc-title) + * { break-before: avoid; }
body > :first-child { margin-top: 0; }
p { margin: 0 0 8pt; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 8pt; padding-left: 20pt; }
li { margin: 2pt 0; }
li > ul, li > ol { margin: 2pt 0 0; }
code { font: 9.5pt ui-monospace, Menlo, monospace; background: #f2f2f4; border-radius: 3px; padding: 0 2pt; }
pre { font: 9pt/1.4 ui-monospace, Menlo, monospace; background: #f5f5f7; border: 1px solid #e3e3e8; border-radius: 6px; padding: 8pt 10pt; margin: 0 0 10pt; white-space: pre-wrap; overflow-wrap: anywhere; }
pre code { background: none; padding: 0; font: inherit; }
blockquote { margin: 0 0 8pt; padding: 2pt 0 2pt 10pt; border-left: 3px solid #d2d2d7; color: #424245; }
blockquote p { margin: 0 0 4pt; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0 12pt; font-size: 9.5pt; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td { border: 1px solid #c7c7cc; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f2f2f4; font-weight: 600; }
.al-center { text-align: center; } .al-right { text-align: right; }
figure { margin: 10pt 0 12pt; text-align: center; break-inside: avoid; }
figure img { display: block; margin: 0 auto; border: 1px solid #e3e3e8; border-radius: 4px; }
figcaption { margin-top: 5pt; font-size: 9.5pt; font-style: italic; color: #6e6e73; }
hr { border: none; border-top: 1px solid #d2d2d7; margin: 12pt 0; }
.page-break { break-after: page; height: 0; }
a { color: #0b57d0; text-decoration: none; }
`;

// Markdown → blocks: { type: "h", level, text } | "p" (lines) | "list" (items:
// { depth, ordered, text }) | "quote" (lines) | "code" (text) | "table" (t) | "hr" | "break"
// | "img" (id, caption: ![caption](shot3) on its own line)
export function pdfBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = null;
  const endPara = () => { para = null; };
  const LIST = /^(\s*)([-*•+]|\d+[.)])\s+(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      endPara();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { endPara(); continue; }
    if (/^\s*\\(newpage|pagebreak)\s*$/.test(line)) { endPara(); blocks.push({ type: "break" }); continue; }
    const pic = line.match(IMAGE_LINE);
    if (pic) { endPara(); blocks.push({ type: "img", id: pic[2].toLowerCase(), caption: pic[1].trim() }); continue; }
    const t = parseTable(lines, i);
    if (t) { endPara(); blocks.push({ type: "table", t }); i = t.end - 1; continue; }
    let m;
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { endPara(); blocks.push({ type: "h", level: m[1].length, text: m[2] }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { endPara(); blocks.push({ type: "hr" }); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      endPara();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === "quote" && /^\s*>/.test(lines[i - 1] || "")) prev.lines.push(m[1]);
      else blocks.push({ type: "quote", lines: [m[1]] });
      continue;
    }
    if ((m = line.match(LIST))) {
      endPara();
      const item = { depth: Math.min(5, Math.floor(m[1].replace(/\t/g, "  ").length / 2)), ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: m[3] };
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === "list" && (LIST.test(lines[i - 1] || "") || prev.cont === i - 1)) prev.items.push(item);
      else blocks.push({ type: "list", items: [item] });
      continue;
    }
    // A line under a list item, indented: more of that item
    const prev = blocks[blocks.length - 1];
    if (!para && prev && prev.type === "list" && /^\s{2,}\S/.test(line) && (LIST.test(lines[i - 1] || "") || prev.cont === i - 1)) {
      prev.items[prev.items.length - 1].text += " " + line.trim();
      prev.cont = i;
      continue;
    }
    if (!para) { para = { type: "p", lines: [] }; blocks.push(para); }
    para.lines.push(line.trim());
  }
  for (const b of blocks) delete b.cont;
  return blocks;
}

// **bold**, *italic*, `code`, [text](https://…) → nodes in doc
export function pdfInline(doc, text) {
  const out = [];
  const re = /(\*\*(?=\S).+?\*\*(?!\*)|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s](?:[^*]*[^*\s])?\*)/g;
  let last = 0;
  let m;
  const s = String(text || "");
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(doc.createTextNode(s.slice(last, m.index)));
    const tok = m[0];
    let el;
    if (tok.startsWith("**")) { el = doc.createElement("strong"); el.append(...pdfInline(doc, tok.slice(2, -2))); }
    else if (tok.startsWith("`")) { el = doc.createElement("code"); el.textContent = tok.slice(1, -1); }
    else if (tok.startsWith("[")) {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (/^(https?:|mailto:)/i.test(href)) { el = doc.createElement("a"); el.setAttribute("href", href); el.textContent = label; }
      else el = doc.createTextNode(label);
    } else { el = doc.createElement("em"); el.append(...pdfInline(doc, tok.slice(1, -1))); }
    out.push(el);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(doc.createTextNode(s.slice(last)));
  return out;
}

// Builds the document's body (title, then the Markdown) in doc. images: id →
// image (from imagesFor), drawn at their own size within the page
export function fillPdfDocument(doc, title, markdown, images = new Map(), landscape = false) {
  const el = (tag, cls) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  const style = el("style");
  style.textContent = PDF_CSS;
  doc.head.append(style);
  if (title && String(title).trim()) {
    doc.title = String(title).trim();
    const t = el("div", "doc-title");
    t.textContent = doc.title;
    doc.body.append(t);
  }
  const withBreaks = (parent, lines) => {
    lines.forEach((line, i) => {
      if (i) parent.append(el("br"));
      parent.append(...pdfInline(doc, line));
    });
    return parent;
  };
  for (const b of pdfBlocks(markdown)) {
    if (b.type === "h") { const e = el("h" + b.level); e.append(...pdfInline(doc, b.text)); doc.body.append(e); }
    else if (b.type === "p") doc.body.append(withBreaks(el("p"), b.lines));
    else if (b.type === "quote") doc.body.append(withBreaks(el("blockquote"), b.lines));
    else if (b.type === "code") { const pre = el("pre"); const c = el("code"); c.textContent = b.text; pre.append(c); doc.body.append(pre); }
    else if (b.type === "hr") doc.body.append(el("hr"));
    else if (b.type === "img") {
      const img = images.get(b.id);
      if (!img) { const p = el("p"); p.textContent = `[${b.caption || b.id}]`; doc.body.append(p); continue; }
      // The page's text area: 6.9 × 9.5 in portrait, 9.4 × 7 in landscape (96 px per inch)
      const { w, h } = landscape ? fitImage(img, 900, 640) : fitImage(img, 660, 860);
      const fig = el("figure");
      const pic = el("img");
      pic.setAttribute("src", `data:${img.mediaType};base64,${img.base64}`);
      pic.setAttribute("alt", b.caption || "");
      pic.setAttribute("style", `width: ${w}px; height: ${h}px;`);
      fig.append(pic);
      if (b.caption) { const cap = el("figcaption"); cap.append(...pdfInline(doc, b.caption)); fig.append(cap); }
      doc.body.append(fig);
    }
    else if (b.type === "break") doc.body.append(el("div", "page-break"));
    else if (b.type === "table") {
      const { header, aligns, rows } = b.t;
      const cols = header.length;
      const table = el("table");
      const cell = (tag, text, i) => {
        const c = el(tag, aligns[i] && aligns[i] !== "left" ? `al-${aligns[i]}` : null);
        c.append(...pdfInline(doc, text || ""));
        return c;
      };
      const head = el("thead");
      const hr = el("tr");
      header.forEach((c, i) => hr.append(cell("th", c, i)));
      head.append(hr);
      const body = el("tbody");
      for (const r of rows) {
        const tr = el("tr");
        for (let i = 0; i < cols; i++) tr.append(cell("td", r[i], i));
        body.append(tr);
      }
      table.append(head, body);
      doc.body.append(table);
    } else if (b.type === "list") {
      // Nested lists from each item's depth
      const stack = [];
      for (const item of b.items) {
        while (stack.length > item.depth + 1) stack.pop();
        while (stack.length < item.depth + 1) {
          const list = el(item.ordered ? "ol" : "ul");
          if (item.ordered && item.start !== 1) list.setAttribute("start", String(item.start));
          const parentLi = stack.length ? stack[stack.length - 1].lastElementChild : null;
          if (parentLi) parentLi.append(list);
          else if (stack.length) stack[stack.length - 1].append(list);
          else doc.body.append(list);
          stack.push(list);
        }
        const li = el("li");
        li.append(...pdfInline(doc, item.text));
        stack[stack.length - 1].append(li);
      }
    }
  }
}

// One PDF at a time per window
let pdfQueue = Promise.resolve();
export function makePdf(opts) {
  const run = pdfQueue.then(() => printPdf(opts));
  pdfQueue = run.catch(() => {});
  return run;
}

async function printPdf({ title = "", content = "", landscape = false, images = new Map(), fallbackTitle = "" }) {
  if (typeof document === "undefined" || typeof document.createXULElement !== "function") {
    throw new Error("PDFs can only be made in Zen.");
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b = document.createXULElement("browser");
  b.setAttribute("type", "content");
  b.setAttribute("disableglobalhistory", "true");
  b.setAttribute("style", "position: fixed; left: -30000px; top: 0; width: 816px; height: 1056px; pointer-events: none;");
  document.documentElement.append(b);
  try {
    let doc = null;
    for (let i = 0; i < 150 && !(doc && doc.body); i++) {
      await sleep(20);
      try { doc = b.contentDocument; } catch (e) {}
    }
    if (!doc || !doc.body) throw new Error("Couldn't set up the page to print.");
    try { b.browsingContext.allowJavascript = false; } catch (e) {}
    fillPdfDocument(doc, title, content, images, landscape);
    if (!doc.title) doc.title = fallbackTitle;
    // Pictures decoded before printing (a broken one is left out, not waited for)
    await Promise.all([...doc.images].map((i) => (i.decode ? i.decode().catch(() => i.remove()) : null)));
    await sleep(50); // let it lay out

    const ps = Cc["@mozilla.org/gfx/printsettings-service;1"].getService(Ci.nsIPrintSettingsService);
    const s = ps.createNewPrintSettings();
    s.isInitializedFromPrinter = true;
    s.isInitializedFromPrefs = true;
    s.outputFormat = Ci.nsIPrintSettings.kOutputFormatPDF;
    s.printerName = "zenai";
    s.printSilent = true;
    s.paperSizeUnit = Ci.nsIPrintSettings.kPaperSizeInches;
    s.paperWidth = 8.5;
    s.paperHeight = 11;
    s.orientation = landscape ? Ci.nsIPrintSettings.kLandscapeOrientation : Ci.nsIPrintSettings.kPortraitOrientation;
    s.marginTop = s.marginBottom = 0.75;
    s.marginLeft = s.marginRight = 0.8;
    s.headerStrLeft = s.headerStrCenter = s.headerStrRight = "";
    s.footerStrLeft = s.footerStrRight = "";
    s.footerStrCenter = "&P";
    s.printBGColors = true;
    s.printBGImages = true;
    s.scaling = 1;
    s.shrinkToFit = false;

    const stream = Cc["@mozilla.org/storagestream;1"].createInstance(Ci.nsIStorageStream);
    stream.init(4096, 0xffffffff);
    s.outputDestination = Ci.nsIPrintSettings.kOutputDestinationStream;
    s.outputStream = stream.getOutputStream(0);
    let timer;
    await Promise.race([
      b.browsingContext.print(s),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Printing the PDF took too long.")), 30000); }),
    ]).finally(() => clearTimeout(timer));
    const input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    input.setInputStream(stream.newInputStream(0));
    const n = input.available();
    const buf = new ArrayBuffer(n);
    input.readArrayBuffer(n, buf);
    const bytes = new Uint8Array(buf);
    if (n < 8 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("The printer didn't make a PDF.");
    return bytes;
  } finally {
    b.remove();
  }
}
