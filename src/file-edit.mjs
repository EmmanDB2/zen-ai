import { decodeText, extensionOf, readZip } from "./attachments.mjs";
import { zipStore } from "./files.mjs";

// ---------------------------------------------------------------------------
// edit_file: changes a copy of a file the user attached (or one the AI made
// in this chat) and leaves everything else in it as it was. Word and
// PowerPoint: text replaced inside the existing runs (styles, spacing,
// headers, images untouched); a whole paragraph can be replaced by several
// (each a copy of it) or removed. Excel: cells set (keeping their format)
// and text replaced. Notebooks: cell text (outputs kept). Text and code:
// find and replace. Every edit must match exactly once (or all: true), or
// nothing is saved.
// ---------------------------------------------------------------------------
export const EDIT_MAX_EDITS = 200;
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NOT_EDITABLE = { pdf: "A PDF can't be edited reliably. Offer to make a new one with create_pdf instead.", doc: "Old .doc files can't be edited; ask the user to save it as .docx.", xls: "Old .xls files can't be edited; ask the user to save it as .xlsx.", ppt: "Old .ppt files can't be edited; ask the user to save it as .pptx." };

// The chat's editable files: what the user attached and what the AI made,
// by name (memory only, newest 20, never saved)
export function newFileStore() {
  const map = new Map();
  return {
    add(name, bytes, from) {
      if (!name || !bytes || !bytes.length) return;
      const key = String(name).toLowerCase();
      map.delete(key);
      map.set(key, { name: String(name), bytes, from });
      while (map.size > 20) map.delete(map.keys().next().value);
    },
    get(name) { return map.get(String(name || "").trim().toLowerCase()) || null; },
    list() { return [...map.values()]; },
  };
}

const short = (t, n = 60) => { const s = String(t).replace(/\s+/g, " "); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function checkEdits(edits) {
  if (!Array.isArray(edits)) return [];
  if (edits.length > EDIT_MAX_EDITS) throw new Error(`That's too many edits (${EDIT_MAX_EDITS} max).`);
  return edits.map((e, i) => {
    if (!e || typeof e.find !== "string" || !e.find) throw new Error(`Edit ${i + 1}: find must be some text from the file.`);
    if (typeof e.replace !== "string") throw new Error(`Edit ${i + 1}: replace must be text (empty to delete).`);
    return { find: e.find, replace: e.replace, all: e.all === true, n: i + 1 };
  });
}

// How many times find is in text (no overlaps)
function countIn(text, find) {
  let n = 0;
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) n++;
  return n;
}

function notFound(e, count, where) {
  return count === 0
    ? `Edit ${e.n}: “${short(e.find)}” isn't in the file. Use the exact text${where}, copied from the file.`
    : `Edit ${e.n}: “${short(e.find)}” is in the file ${count} times. Give more of the text around it so it's unique, or set all: true.`;
}

// ----- Plain text (and notebook cells) -----
export function editText(text, edits) {
  let out = text;
  const report = [];
  for (const e of checkEdits(edits)) {
    const count = countIn(out, e.find);
    if (count === 0 || (count > 1 && !e.all)) throw new Error(notFound(e, count, ""));
    out = out.split(e.find).join(e.replace);
    report.push(`“${short(e.find, 40)}” → “${short(e.replace, 40)}”${count > 1 ? ` (${count} times)` : ""}`);
  }
  return { text: out, report };
}

// ----- Word / PowerPoint / Excel strings: paragraphs of runs -----
// A paragraph's text is its t elements (plus tabs and line breaks), the way
// the AI read it; an edit lands in the runs it covers: the first keeps the
// new text (and its formatting), the rest lose what was matched.
function paragraphsOf(doc, ns, paraTag) {
  return [...doc.getElementsByTagNameNS(ns, paraTag)];
}

function segmentsOf(p, ns, paraTag) {
  const segs = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (child.namespaceURI === ns && child.localName === paraTag) continue; // a paragraph inside (text box): its own
      if (child.namespaceURI === ns && child.localName === "t") segs.push({ node: child, kind: "t", text: child.textContent });
      else if (child.namespaceURI === ns && child.localName === "tab" && ns !== S_NS) segs.push({ node: child, kind: "tab", text: "\t" });
      else if (child.namespaceURI === ns && child.localName === "br" && ns !== S_NS) segs.push({ node: child, kind: "br", text: "\n" });
      else if (!(ns === S_NS && child.localName === "rPh")) walk(child); // (Excel's phonetic hints aren't text)
    }
  };
  walk(p);
  return segs;
}

const textOfSegs = (segs) => segs.map((s) => s.text).join("");

function setT(node, text) {
  node.textContent = text;
  if (/^\s|\s$/.test(text)) node.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
}

// Replaces [start, end) in a paragraph's segments with text
function replaceRange(segs, start, end, text) {
  let pos = 0;
  let placed = false;
  for (const s of segs) {
    const a = pos;
    const b = pos + s.text.length;
    pos = b;
    if (b <= start || a >= end) continue;
    if (s.kind !== "t") { s.node.remove(); continue; }
    const keepBefore = s.text.slice(0, Math.max(0, start - a));
    const keepAfter = s.text.slice(Math.max(0, end - a));
    setT(s.node, keepBefore + (placed ? "" : text) + keepAfter);
    placed = true;
  }
  if (!placed) throw new Error("only tabs or line breaks");
}

// A paragraph replaced by several (copies of it), or removed
function replaceParagraph(p, ns, paraTag, lines) {
  const parent = p.parentNode;
  const keepOne = [...parent.childNodes].filter((n) => n.nodeType === 1 && n.namespaceURI === ns && n.localName === paraTag).length === 1;
  const hasSection = p.getElementsByTagNameNS(W_NS, "sectPr").length > 0;
  const fill = (para, text) => {
    const segs = segmentsOf(para, ns, paraTag);
    const firstT = segs.find((s) => s.kind === "t");
    for (const s of segs) if (s !== firstT) { if (s.kind === "t") setT(s.node, ""); else s.node.remove(); }
    if (firstT) setT(firstT.node, text);
    else if (text) throw new Error("that paragraph has no text to copy the style from");
  };
  if (!lines.length) {
    if (keepOne || hasSection) fill(p, ""); // a cell or text box needs a paragraph; so does the section's end
    else p.remove();
    return;
  }
  const copies = lines.slice(1).map(() => p.cloneNode(true));
  fill(p, lines[0]);
  let after = p;
  copies.forEach((c, i) => {
    for (const sect of [...c.getElementsByTagNameNS(W_NS, "sectPr")]) sect.remove(); // only the original ends the section
    fill(c, lines[i + 1]);
    parent.insertBefore(c, after.nextSibling);
    after = c;
  });
  if (hasSection && copies.length) {
    // The section break belongs after the last paragraph: move it there
    const sect = p.getElementsByTagNameNS(W_NS, "sectPr")[0];
    const lastPr = after.getElementsByTagNameNS(W_NS, "pPr")[0];
    if (sect && lastPr) lastPr.append(sect);
  }
}

// edits over several XML parts (all of a document's text): each edit counted
// across all of them first, then applied
// touched: collects the documents that changed (only those are written again)
function editParts(docs, ns, paraTag, edits, touched = new Set()) {
  const report = [];
  for (const e of checkEdits(edits)) {
    const hits = [];
    for (const doc of docs) {
      for (const p of paragraphsOf(doc, ns, paraTag)) {
        const segs = segmentsOf(p, ns, paraTag);
        const text = textOfSegs(segs);
        const n = countIn(text, e.find);
        if (n) hits.push({ p, segs, text, n });
      }
    }
    const count = hits.reduce((s, h) => s + h.n, 0);
    if (count === 0 || (count > 1 && !e.all)) {
      const across = e.find.includes("\n") ? ` (one edit can't cross paragraphs: make one edit per paragraph)` : ` inside one ${paraTag === "si" || paraTag === "is" ? "cell" : "paragraph"}`;
      throw new Error(notFound(e, count, across));
    }
    for (const h of hits) {
      touched.add(h.p.ownerDocument);
      const whole = h.text === e.find;
      if (whole && paraTag === "p" && (e.replace.includes("\n") || e.replace === "")) {
        replaceParagraph(h.p, ns, paraTag, e.replace === "" ? [] : e.replace.split("\n"));
        continue;
      }
      if (e.replace.includes("\n")) {
        throw new Error(`Edit ${e.n}: a line break in replace only works when find is a whole paragraph (then each line becomes a paragraph like it).`);
      }
      // Right to left, so earlier offsets stay right
      const starts = [];
      for (let i = h.text.indexOf(e.find); i >= 0; i = h.text.indexOf(e.find, i + e.find.length)) starts.push(i);
      for (const s of starts.reverse()) {
        try {
          replaceRange(segmentsOf(h.p, ns, paraTag), s, s + e.find.length, e.replace);
        } catch (err) {
          throw new Error(`Edit ${e.n}: “${short(e.find)}” is ${err.message}; include some of the words next to it.`);
        }
      }
    }
    report.push(`“${short(e.find, 40)}” → ${e.replace === "" && hits.every((h) => h.text === e.find) ? "removed" : `“${short(e.replace, 40)}”`}${count > 1 ? ` (${count} times)` : ""}`);
  }
  return report;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("A part of the file couldn't be read.");
  return doc;
}

function writeXml(doc, original) {
  let out = new XMLSerializer().serializeToString(doc);
  const decl = (original.match(/^<\?xml[^>]*\?>\s*/) || [""])[0];
  if (decl && !out.startsWith("<?xml")) out = decl.trim() + "\r\n" + out;
  return new TextEncoder().encode(out);
}

async function unzip(bytes) {
  let entries;
  try { entries = readZip(bytes); } catch (e) { throw new Error("The file looks damaged."); }
  const files = [];
  for (const [name, read] of entries) files.push({ name, data: await read() });
  return files;
}

const textOfFile = (f) => new TextDecoder().decode(f.data);

// ----- Excel cells -----
function colNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function sheetPaths(files) {
  const get = (name) => { const f = files.find((x) => x.name === name); return f ? textOfFile(f) : ""; };
  const targets = {};
  for (const rel of get("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = (rel[0].match(/\bId="([^"]+)"/) || [])[1];
    const target = (rel[0].match(/\bTarget="([^"]+)"/) || [])[1];
    if (id && target) targets[id] = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  }
  const out = [];
  for (const tag of get("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const name = (tag[0].match(/\bname="([^"]*)"/) || [])[1] || "";
    const rid = (tag[0].match(/\br:id="([^"]+)"/) || tag[0].match(/\b\w+:id="([^"]+)"/) || [])[1];
    if (rid && targets[rid]) out.push({ name: name.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">"), path: targets[rid] });
  }
  return out;
}

function setCell(doc, ref, value) {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(ref);
  const sheetData = doc.getElementsByTagNameNS(S_NS, "sheetData")[0];
  if (!sheetData) throw new Error("that sheet has no cells");
  const rowN = Number(m[2]);
  const el = (tag) => doc.createElementNS(S_NS, tag);
  let row = [...sheetData.getElementsByTagNameNS(S_NS, "row")].find((r) => Number(r.getAttribute("r")) === rowN);
  if (!row) {
    row = el("row");
    row.setAttribute("r", String(rowN));
    const next = [...sheetData.getElementsByTagNameNS(S_NS, "row")].find((r) => Number(r.getAttribute("r")) > rowN);
    sheetData.insertBefore(row, next || null);
  }
  let c = [...row.getElementsByTagNameNS(S_NS, "c")].find((x) => x.getAttribute("r") === ref);
  if (!c) {
    c = el("c");
    c.setAttribute("r", ref);
    const col = colNumber(m[1]);
    const next = [...row.getElementsByTagNameNS(S_NS, "c")].find((x) => colNumber((x.getAttribute("r") || "").replace(/\d+$/, "")) > col);
    row.insertBefore(c, next || null);
  }
  // Its style (s) stays; its value goes
  while (c.firstChild) c.firstChild.remove();
  c.removeAttribute("t");
  if (value === null || value === "") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("that number isn't finite");
    const v = el("v"); v.textContent = String(value); c.append(v);
  } else if (typeof value === "boolean") {
    c.setAttribute("t", "b");
    const v = el("v"); v.textContent = value ? "1" : "0"; c.append(v);
  } else if (String(value).length > 1 && String(value).startsWith("=")) {
    const f = el("f"); f.textContent = String(value).slice(1); c.append(f);
  } else {
    c.setAttribute("t", "inlineStr");
    const is = el("is"); const t = el("t");
    setT(t, String(value).slice(0, 32767));
    is.append(t); c.append(is);
  }
}

async function editXlsx(bytes, edits, cells) {
  const files = await unzip(bytes);
  const sheets = sheetPaths(files);
  if (!sheets.length) throw new Error("It doesn't look like an Excel file.");
  const parsed = new Map(); // name → { doc, original }
  const load = (name) => {
    if (!parsed.has(name)) {
      const f = files.find((x) => x.name === name);
      if (!f) return null;
      const original = textOfFile(f);
      parsed.set(name, { doc: parseXml(original), original });
    }
    return parsed.get(name).doc;
  };
  const report = [];
  const touched = new Set();
  // Text: shared strings and inline strings in every sheet
  if (edits && edits.length) {
    // A cell's text is in the shared strings (si) or in the sheet itself (is)
    const pairs = [];
    const ss = load("xl/sharedStrings.xml");
    if (ss) pairs.push([ss, "si"]);
    for (const sh of sheets) { const d = load(sh.path); if (d) pairs.push([d, "is"]); }
    report.push(...editPartsMulti(pairs, checkEdits(edits), touched));
  }
  let formulas = false;
  for (const [i, cell] of (Array.isArray(cells) ? cells : []).entries()) {
    const raw = String((cell && cell.cell) || "").trim();
    const m = /^(?:(?:'([^']+)'|([^!]+))!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(raw);
    if (!m) throw new Error(`Cell ${i + 1}: “${short(raw)}” isn't a cell like B3 or Sheet1!B3.`);
    const sheetName = m[1] || m[2] || (cell.sheet ? String(cell.sheet) : "");
    const sheet = sheetName ? sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase()) : sheets[0];
    if (!sheet) throw new Error(`Cell ${i + 1}: there's no sheet “${short(sheetName)}”. Sheets: ${sheets.map((s) => s.name).join(", ")}.`);
    const value = cell.value === undefined ? null : cell.value;
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error(`Cell ${i + 1}: value must be a number, text, true/false or null.`);
    const ref = m[3].toUpperCase() + m[4];
    try {
      const sheetDoc = load(sheet.path);
      setCell(sheetDoc, ref, value);
      touched.add(sheetDoc);
    } catch (e) {
      throw new Error(`Cell ${i + 1} (${sheet.name}!${ref}): ${e.message}.`);
    }
    if (typeof value === "string" && value.startsWith("=")) formulas = true;
    report.push(`${sheet.name}!${ref} = ${value === null ? "(empty)" : typeof value === "string" ? `“${short(value, 40)}”` : String(value)}`);
  }
  if (!report.length) throw new Error("Give edits (text to replace) or cells (values to set).");
  // Worked out again when it opens (formulas and anything that depends on a changed cell)
  const wb = load("xl/workbook.xml");
  if (wb) {
    let calc = wb.getElementsByTagNameNS(S_NS, "calcPr")[0];
    if (!calc) {
      calc = wb.createElementNS(S_NS, "calcPr");
      const root = wb.documentElement;
      const before = [...root.childNodes].find((n) => n.nodeType === 1 && ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"].includes(n.localName));
      root.insertBefore(calc, before || null);
    }
    calc.setAttribute("fullCalcOnLoad", "1");
    touched.add(wb);
  }
  let out = files;
  if (formulas || (cells && cells.length)) {
    // A stale calculation chain can make Excel "repair" the file: leave it out
    out = out.filter((f) => f.name !== "xl/calcChain.xml");
    for (const name of ["[Content_Types].xml", "xl/_rels/workbook.xml.rels"]) {
      const f = out.find((x) => x.name === name);
      if (f && textOfFile(f).includes("calcChain")) f.data = new TextEncoder().encode(textOfFile(f).replace(/<(Override|Relationship)\b[^>]*calcChain[^>]*\/>/g, ""));
    }
  }
  const changed = (name) => parsed.has(name) && touched.has(parsed.get(name).doc);
  return { bytes: zipStore(out.map((f) => (changed(f.name) ? { name: f.name, data: writeXml(parsed.get(f.name).doc, parsed.get(f.name).original) } : f))), report };
}

// editParts over parts that may use different paragraph tags (Excel: si / is)
function editPartsMulti(pairs, edits, touched) {
  const report = [];
  const inDoc = (doc, tag, find) => paragraphsOf(doc, S_NS, tag).reduce((n, p) => n + countIn(textOfSegs(segmentsOf(p, S_NS, tag)), find), 0);
  for (const e of edits) {
    const counts = pairs.map(([doc, tag]) => inDoc(doc, tag, e.find));
    const count = counts.reduce((a, b) => a + b, 0);
    if (count === 0 || (count > 1 && !e.all)) throw new Error(notFound(e, count, " inside one cell"));
    if (e.replace.includes("\n")) throw new Error(`Edit ${e.n}: put line breaks in a cell with cells instead.`);
    pairs.forEach(([doc, tag], i) => { if (counts[i]) editParts([doc], S_NS, tag, [{ find: e.find, replace: e.replace, all: true }], touched); });
    report.push(`“${short(e.find, 40)}” → “${short(e.replace, 40)}”${count > 1 ? ` (${count} times)` : ""}`);
  }
  return report;
}

async function editOffice(bytes, kind, edits) {
  const files = await unzip(bytes);
  const isWord = kind === "docx";
  const parts = files.filter((f) => isWord
    ? /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(f.name)
    : /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(f.name));
  if (!parts.length) throw new Error(isWord ? "It doesn't look like a Word document." : "It doesn't look like a PowerPoint file.");
  // The main text first, so "exactly once" means what the AI read
  parts.sort((a, b) => (a.name === "word/document.xml" ? -1 : b.name === "word/document.xml" ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true })));
  const parsed = parts.map((f) => { const original = textOfFile(f); return { f, original, doc: parseXml(original) }; });
  const touched = new Set();
  const report = editParts(parsed.map((x) => x.doc), isWord ? W_NS : A_NS, "p", edits, touched);
  for (const x of parsed) if (touched.has(x.doc)) x.f.data = writeXml(x.doc, x.original);
  return { bytes: zipStore(files), report };
}

function editNotebook(bytes, edits) {
  let nb;
  try { nb = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { throw new Error("It isn't a valid notebook."); }
  if (!Array.isArray(nb.cells)) throw new Error("It isn't a valid notebook.");
  const report = [];
  const srcOf = (c) => (Array.isArray(c.source) ? c.source.join("") : String(c.source || ""));
  for (const e of checkEdits(edits)) {
    const count = nb.cells.reduce((s, c) => s + countIn(srcOf(c), e.find), 0);
    if (count === 0 || (count > 1 && !e.all)) throw new Error(notFound(e, count, " inside one cell"));
    for (const c of nb.cells) {
      const src = srcOf(c);
      if (!src.includes(e.find)) continue;
      const parts = src.split(e.find).join(e.replace).split("\n");
      c.source = parts.map((l, i) => (i < parts.length - 1 ? l + "\n" : l)).filter((l, i) => !(i === parts.length - 1 && l === ""));
    }
    report.push(`“${short(e.find, 40)}” → “${short(e.replace, 40)}”${count > 1 ? ` (${count} times)` : ""}`);
  }
  return { bytes: new TextEncoder().encode(JSON.stringify(nb, null, 1) + "\n"), report };
}

// name: the file's name (its type); → { bytes, report }
export async function editFileBytes(name, bytes, { edits = [], cells = [] } = {}) {
  const ext = extensionOf(name);
  if (NOT_EDITABLE[ext]) throw new Error(NOT_EDITABLE[ext]);
  const hasEdits = Array.isArray(edits) && edits.length > 0;
  if (cells && cells.length && ext !== "xlsx") throw new Error("cells only works for Excel files (.xlsx). Use edits for this one.");
  if (ext === "xlsx") return editXlsx(bytes, hasEdits ? edits : [], cells);
  if (!hasEdits) throw new Error("Give at least one edit (find and replace).");
  if (ext === "docx" || ext === "pptx") return editOffice(bytes, ext, edits);
  if (ext === "ipynb") return editNotebook(bytes, edits);
  const text = decodeText(bytes, true);
  if (text == null) throw new Error(`.${ext || "?"} files can't be edited (they aren't text).`);
  const out = editText(text, edits);
  return { bytes: new TextEncoder().encode(out.text), report: out.report };
}
