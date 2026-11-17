import { encodeForClaude, thumbnailUrl } from "./pages.mjs";

// ---------------------------------------------------------------------------
// Attachments: files added with +, drag and drop, or paste
// ---------------------------------------------------------------------------
export const MAX_ATTACHMENTS = 8;                  // per message
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;  // any one file
export const MAX_PDF_BYTES = 10 * 1024 * 1024;     // PDFs are sent whole
export const MAX_FILE_CHARS = 100000;              // text taken from one file (~25k tokens)
export const MAX_ATTACH_TEXT_CHARS = 200000;       // text across all files in one message
export const MAX_SEND_BASE64 = 28 * 1024 * 1024;   // images + PDFs in one message (the API allows 32 MB)
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]);
export const TEXT_EXTENSIONS = new Set((
  "txt text md markdown mdx rst org adoc rtf csv tsv json jsonl ndjson geojson xml html htm xhtml css scss sass less " +
  "js mjs cjs jsx ts tsx mts cts vue svelte astro py pyi pyw ipynb rb go rs java kt kts swift m mm c h cc cpp cxx hpp hh hxx " +
  "cs fs fsx vb php pl pm r jl lua dart scala sc clj cljs edn ex exs erl hrl hs elm ml mli nim zig v sv vhd vhdl asm s " +
  "sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto thrift yaml yml toml ini cfg conf config env properties plist " +
  "gradle make mk cmake dockerfile tf tfvars hcl nix log out err srt vtt sub tex bib sty cls svg diff patch gitignore lock"
).split(" "));
export const OFFICE_KINDS = { docx: "Word document", pptx: "PowerPoint", xlsx: "Spreadsheet" };
export const UNSUPPORTED_HINTS = {
  doc: "Save it as .docx or PDF first.",
  ppt: "Save it as .pptx or PDF first.",
  xls: "Save it as .xlsx or CSV first.",
  pages: "Export it as PDF or Word first.",
  key: "Export it as PDF or PowerPoint first.",
  numbers: "Export it as CSV or Excel first.",
  heic: "Export it as JPEG or PNG first.",
  heif: "Export it as JPEG or PNG first.",
};

export function extensionOf(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Raw DEFLATE → bytes, using the browser's own decompressor
export async function inflateRaw(bytes, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new Error("It's too big to read.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

// Minimal zip reader for Office files: Map(name → async () => bytes)
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("It looks damaged.");
  const count = view.getUint16(end + 10, true);
  let ptr = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count && ptr + 46 <= bytes.length && view.getUint32(ptr, true) === 0x02014b50; n++) {
    const method = view.getUint16(ptr + 10, true);
    const size = view.getUint32(ptr + 20, true);
    const nameLength = view.getUint16(ptr + 28, true);
    const local = view.getUint32(ptr + 42, true);
    const name = names.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLength));
    entries.set(name, async () => {
      if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error("It looks damaged.");
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data, 64 * 1024 * 1024);
      throw new Error("It's compressed in a way that can't be read.");
    });
    ptr += 46 + nameLength + view.getUint16(ptr + 30, true) + view.getUint16(ptr + 32, true);
  }
  return entries;
}

export async function zipText(entries, name) {
  const read = entries.get(name);
  return read ? new TextDecoder().decode(await read()) : "";
}

export function decodeXml(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] !== "#") return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k];
    const code = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try { return String.fromCodePoint(code); } catch (err) { return ""; }
  });
}

export function xmlAttrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

// Word (w:) or PowerPoint (a:) text runs → plain text, a line per paragraph
export function officeRunsToText(xml, ns) {
  const re = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:tab\\s*/>|<${ns}:br\\b[^>]*/>|</${ns}:p>`, "g");
  let out = "";
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0].startsWith(`<${ns}:tab`)) out += "\t";
    else out += "\n";
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function docxToText(entries) {
  const xml = await zipText(entries, "word/document.xml");
  if (!xml) throw new Error("It doesn't look like a Word document.");
  return officeRunsToText(xml, "w");
}

export async function pptxToText(entries) {
  const slides = [...entries.keys()]
    .map((name) => ({ name, n: parseInt((name.match(/^ppt\/slides\/slide(\d+)\.xml$/) || [])[1], 10) }))
    .filter((s) => s.n > 0)
    .sort((a, b) => a.n - b.n);
  if (!slides.length) throw new Error("It doesn't look like a PowerPoint file.");
  const out = [];
  for (const slide of slides) {
    const text = officeRunsToText(await zipText(entries, slide.name), "a");
    out.push(`--- Slide ${slide.n} ---\n${text || "(no text)"}`);
  }
  return out.join("\n\n");
}

export function columnIndex(ref) {
  const m = /^([A-Z]+)\d*$/.exec(ref || "");
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Excel → tab-separated text, one block per sheet
export async function xlsxToText(entries) {
  const runsText = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join("");
  const shared = [];
  for (const si of (await zipText(entries, "xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(runsText(si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));
  }
  const targets = {};
  for (const rel of (await zipText(entries, "xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)) {
    const a = xmlAttrs(rel[0]);
    if (a.Id && a.Target) targets[a.Id] = a.Target.startsWith("/") ? a.Target.slice(1) : "xl/" + a.Target.replace(/^\.\//, "");
  }
  const sheets = [];
  for (const tag of (await zipText(entries, "xl/workbook.xml")).matchAll(/<sheet\b[^>]*>/g)) {
    const a = xmlAttrs(tag[0]);
    const rid = Object.keys(a).find((k) => /(^|:)id$/.test(k) && k !== "sheetId");
    if (rid && targets[a[rid]] && entries.has(targets[a[rid]])) sheets.push({ name: a.name || "Sheet", path: targets[a[rid]] });
  }
  if (!sheets.length) {
    for (const name of [...entries.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()) {
      sheets.push({ name: name.replace(/^.*\/|\.xml$/g, ""), path: name });
    }
  }
  if (!sheets.length) throw new Error("It doesn't look like an Excel file.");
  const out = [];
  for (const sheet of sheets) {
    const rows = [];
    const xml = await zipText(entries, sheet.path);
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = parseInt(xmlAttrs(row[1]).r, 10);
      while (r > rows.length + 1 && rows.length < 20000) rows.push("");
      if (rows.length >= 20000) break;
      const cells = [];
      for (const c of (row[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = xmlAttrs(c[1]);
        const body = c[2] || "";
        const v = (body.match(/<v>([^<]*)<\/v>/) || [])[1];
        let value;
        if (a.t === "s") value = shared[parseInt(v, 10)] || "";
        else if (a.t === "inlineStr") value = runsText(body);
        else if (a.t === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
        else value = v === undefined ? "" : decodeXml(v);
        const col = columnIndex(a.r);
        const index = col >= 0 ? col : cells.length;
        if (index < 200) cells[index] = value.replace(/[\t\r\n]+/g, " ");
      }
      rows.push(Array.from(cells, (value) => value || "").join("\t").replace(/\t+$/, ""));
    }
    out.push(`--- Sheet: ${sheet.name} ---\n${rows.join("\n").trim() || "(empty)"}`);
  }
  return out.join("\n\n");
}

// Bytes → text, or null when it looks like a binary file
export function decodeText(bytes, knownText) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const head = bytes.subarray(0, 8192);
  let control = 0;
  for (const b of head) {
    if (b === 0) return null;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) control++;
  }
  if (control > head.length / 50) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: head.length < bytes.length });
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    // Not UTF-8: old Windows/Mac text files are usually Windows-1252
    return knownText || control === 0 ? new TextDecoder("windows-1252").decode(bytes) : null;
  }
}

// A file the user added → { kind: "text", label, text } or { kind: "pdf", base64 }
// (images are handled separately, since they need a canvas)
export async function readDocument({ name, type, bytes }) {
  const ext = extensionOf(name);
  const mime = String(type || "").toLowerCase();
  if (ext === "pdf" || mime === "application/pdf") {
    if (bytes.length > MAX_PDF_BYTES) throw new Error(`${name} is over ${MAX_PDF_BYTES / 1048576} MB, too big to send.`);
    return { kind: "pdf", label: "PDF", base64: bytesToBase64(bytes) };
  }
  if (OFFICE_KINDS[ext]) {
    let text;
    try {
      const entries = readZip(bytes);
      text = await { docx: docxToText, pptx: pptxToText, xlsx: xlsxToText }[ext](entries);
    } catch (e) {
      throw new Error(`Couldn't read ${name}. ${(e && e.message) || ""}`.trim());
    }
    return { kind: "text", label: OFFICE_KINDS[ext], text: text || "(no text found)" };
  }
  if (UNSUPPORTED_HINTS[ext]) throw new Error(`Can't read .${ext} files. ${UNSUPPORTED_HINTS[ext]}`);
  const knownText = TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/") || /json|xml|javascript|yaml|toml|csv/.test(mime);
  const text = decodeText(bytes, knownText);
  if (text == null) {
    throw new Error(`Can't read ${ext ? `.${ext} files` : name}. Try a PDF, image, text or code file, or a Word, PowerPoint or Excel file.`);
  }
  return { kind: "text", label: "Text", text };
}

export function isImageFile(name, type) {
  const mime = String(type || "").toLowerCase();
  return IMAGE_EXTENSIONS.has(extensionOf(name)) || (/^image\//.test(mime) && mime !== "image/svg+xml" && !/hei[cf]/.test(mime));
}

// An image file → what Claude reads, a chip preview, and the original for copying
export async function readImage(blob, name) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    throw new Error(`Couldn't read the image ${name}.`);
  }
  try {
    return {
      kind: "image",
      label: "Image",
      image: encodeForClaude(bitmap, blob.type === "image/jpeg"),
      thumbUrl: thumbnailUrl(bitmap),
      blob,
    };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}
