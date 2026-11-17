import { AGENT_TOOL_NAMES, AGENT_TOOLS, BLOCKED_EXTENSIONS, BROWSER_TOOL_NAMES, BROWSER_TOOLS, MAX_FILE_BYTES, OUTPUT_FOLDER, ZEN_SERVER, ZEN_TOOLS, prefs } from "./config.mjs";
import { parseTable } from "./markdown.mjs";
import { makePdf } from "./pdf.mjs";
import { editFileBytes } from "./file-edit.mjs";
import { extensionOf } from "./attachments.mjs";

// ---------------------------------------------------------------------------
// Files: tiny zip writer + .docx builder (no dependencies)
// ---------------------------------------------------------------------------
export const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Uint8Array }] → zip bytes (stored, uncompressed)
export function zipStore(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);      // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, file.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function xmlEscape(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Images for documents: every screenshot Claude takes (shot1, shot2…) and
// every image the user attaches (image1…) is kept, in memory only, for this
// chat, so ![caption](shot3) on its own line puts it in a PDF, Word file or
// notebook. Never saved with the chat; the oldest go first.
// ---------------------------------------------------------------------------
export const DOC_IMAGE_LIMIT = 40;
export const DOC_MAX_BYTES = 30 * 1024 * 1024; // a document with images
export const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(\s*([A-Za-z]+\d+)\s*\)\s*$/;

export function newImageStore() {
  const map = new Map();
  const counters = {};
  return {
    // img: { base64, mediaType (png/jpeg), width, height }; cssWidth: its size on the page (CSS px)
    add(kind, img, label = "", cssWidth = 0) {
      if (!img || !img.base64 || !/^image\/(png|jpeg)$/.test(img.mediaType)) return null;
      counters[kind] = (counters[kind] || 0) + 1;
      const id = `${kind}${counters[kind]}`;
      map.set(id, { id, base64: img.base64, mediaType: img.mediaType, width: img.width, height: img.height, cssWidth: cssWidth || img.width, label: String(label).slice(0, 120) });
      while (map.size > DOC_IMAGE_LIMIT) map.delete(map.keys().next().value);
      return id;
    },
    get(id) { return map.get(String(id || "").trim().toLowerCase()) || null; },
    list() { return [...map.values()]; },
  };
}

// The images a document's text asks for (by id), or an error that lists the ones there are
export function imagesFor(texts, store) {
  const found = new Map();
  const missing = [];
  for (const text of texts) {
    for (const m of String(text || "").matchAll(/!\[[^\]]*\]\(\s*([A-Za-z]+\d+)\s*\)/g)) {
      const id = m[1].toLowerCase();
      const img = store && store.get(id);
      if (img) found.set(id, img);
      else if (!missing.includes(id)) missing.push(id);
    }
  }
  if (missing.length) {
    const have = store ? store.list().slice(-12).map((i) => `${i.id} (${i.label || "image"})`) : [];
    throw new Error(`There's no image ${missing.join(", ")} in this chat${have.length ? `. Images you can use: ${have.join("; ")}` : ": take a browser_screenshot (keep_only works) or ask the user to attach one"}. Images aren't kept after Zen restarts.`);
  }
  return found;
}

// How big an image goes on a page: its own size, fitted inside maxW × maxH (in px)
export function fitImage(img, maxW, maxH) {
  const w0 = Math.max(1, img.cssWidth || img.width);
  const h0 = Math.max(1, w0 * (img.height / Math.max(1, img.width)));
  const k = Math.min(1, maxW / w0, maxH / h0);
  return { w: Math.round(w0 * k), h: Math.round(h0 * k) };
}

// Simple Markdown → WordprocessingML paragraphs. images: id → image (from
// imagesFor); media collects the pictures used ({ rid, name, img })
export function docxBodyXml(title, content, images = new Map(), media = []) {
  const run = (text, { bold = false, size = 22, italic = false, color = "" } = {}) =>
    `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${bold ? "<w:b/>" : ""}${italic ? "<w:i/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
  const runs = (text, opts = {}) =>
    text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) =>
      /^\*\*[^*]+\*\*$/.test(part) ? run(part.slice(2, -2), { ...opts, bold: true }) : run(part, opts)
    ).join("");
  const para = (inner, { after = 160, before = 0, indent = false } = {}) =>
    `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${indent ? '<w:ind w:left="360" w:hanging="360"/>' : ""}</w:pPr>${inner}</w:p>`;

  // A Markdown table → a bordered Word table (header row shaded and repeated on each page)
  const table = (t) => {
    const cols = t.header.length;
    const width = Math.floor(9360 / cols); // page width minus margins, in twips
    const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
    const cell = (text, i, isHead) => {
      const jc = t.aligns[i] === "center" ? "center" : t.aligns[i] === "right" ? "right" : "left";
      const shade = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : "";
      const body = runs(String(text || "").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"), { bold: isHead, size: 20 });
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/><w:jc w:val="${jc}"/></w:pPr>${body}</w:p></w:tc>`;
    };
    const row = (cells, isHead) =>
      `<w:tr>${isHead ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: cols }, (_, i) => cell(cells[i], i, isHead)).join("")}</w:tr>`;
    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
      `<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
      `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>${row(t.header, true)}${t.rows.map((r) => row(r, false)).join("")}</w:tbl>` +
      para("", { after: 120 });
  };

  // A picture on its own centred line (fitted inside 6.5 × 8.5 in), caption under it
  const EMU = 9525; // per px at 96 dpi
  let pictures = 0;
  const picture = (img, caption) => {
    let item = media.find((x) => x.img === img);
    if (!item) {
      item = { rid: `rIdImg${media.length + 1}`, name: `image${media.length + 1}.${img.mediaType === "image/png" ? "png" : "jpeg"}`, img };
      media.push(item);
    }
    const n = ++pictures; // each drawing's id, unique in the document
    const { w, h } = fitImage(img, 624, 816);
    const cx = w * EMU;
    const cy = h * EMU;
    const drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${xmlEscape(caption)}"/>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="${n}" name="${item.name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${item.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const pic = `<w:p><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="${caption ? 40 : 160}"/><w:jc w:val="center"/></w:pPr>${drawing}</w:p>`;
    return caption ? pic + `<w:p><w:pPr><w:spacing w:after="200"/><w:jc w:val="center"/></w:pPr>${run(caption, { italic: true, size: 19, color: "595959" })}</w:p>` : pic;
  };

  const out = [];
  if (title && title.trim()) out.push(para(run(title.trim(), { bold: true, size: 40 }), { after: 240 }));
  const lines = String(content).replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) continue;
    const t = parseTable(lines, i);
    if (t) {
      out.push(table(t));
      i = t.end - 1;
      continue;
    }
    let m;
    if ((m = line.match(IMAGE_LINE)) && images.has(m[2].toLowerCase())) {
      out.push(picture(images.get(m[2].toLowerCase()), m[1].trim()));
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      const size = { 1: 32, 2: 28, 3: 24 }[m[1].length];
      out.push(para(runs(m[2], { bold: true, size }), { before: 200, after: 100 }));
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      out.push(para(run("•  ") + runs(m[1]), { after: 60, indent: true }));
    } else if ((m = line.match(/^\s*(\d+[.)])\s+(.*)$/))) {
      out.push(para(run(m[1] + "  ") + runs(m[2]), { after: 60, indent: true }));
    } else {
      out.push(para(runs(line)));
    }
  }
  return out.join("");
}

export function buildDocx(title, content, images = new Map()) {
  const enc = new TextEncoder();
  const media = [];
  const body = docxBodyXml(title, content, images, media);
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const files = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
  ];
  if (media.length) {
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join("")}</Relationships>`;
    files.push({ name: "word/_rels/document.xml.rels", data: enc.encode(docRels) });
    for (const m of media) files.push({ name: `word/media/${m.name}`, data: base64Bytes(m.img.base64) });
  }
  return zipStore(files);
}

export function base64Bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Excel (.xlsx): sheets of rows; numbers stay numbers, "=…" is a formula
// (worked out when the file opens), the first row is a bold, frozen header
// ---------------------------------------------------------------------------
export const XLSX_MAX_CELLS = 200000;

export function xlsxColumn(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function buildXlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error("sheets must list at least one sheet.");
  if (sheets.length > 50) throw new Error("That's too many sheets (50 max).");
  const enc = new TextEncoder();
  const used = new Set();
  let cells = 0;
  const parts = sheets.map((sheet, n) => {
    if (!sheet || !Array.isArray(sheet.rows)) throw new Error(`Sheet ${n + 1} needs rows (a list of rows, each a list of cells).`);
    // Excel's rules for sheet names: ≤31 characters, none of []:*?/\, unique
    let name = String(sheet.name || "").replace(/[\[\]:*?/\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || `Sheet${n + 1}`;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${name.slice(0, 31 - String(k).length - 1)} ${k}`;
    used.add(name.toLowerCase());
    const widths = [];
    const rowsXml = sheet.rows.map((row, r) => {
      if (!Array.isArray(row)) throw new Error(`Sheet "${name}", row ${r + 1} must be a list of cells.`);
      cells += row.length;
      if (cells > XLSX_MAX_CELLS) throw new Error(`That's too many cells (${XLSX_MAX_CELLS.toLocaleString("en-US")} max).`);
      const style = r === 0 ? ' s="1"' : "";
      const cellsXml = row.map((v, c) => {
        const ref = xlsxColumn(c) + (r + 1);
        const shown = v == null ? "" : String(v);
        widths[c] = Math.max(widths[c] || 0, Math.min(60, shown.length));
        if (v == null || v === "") return "";
        if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${style}><v>${v}</v></c>` : `<c r="${ref}"${style} t="inlineStr"><is><t>${xmlEscape(shown)}</t></is></c>`;
        if (typeof v === "boolean") return `<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`;
        if (shown.length > 1 && shown.startsWith("=")) return `<c r="${ref}"${style}><f>${xmlEscape(shown.slice(1))}</f></c>`;
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(shown.slice(0, 32767))}</t></is></c>`;
      }).join("");
      return `<row r="${r + 1}">${cellsXml}</row>`;
    }).join("");
    const cols = widths.length ? `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${Math.max(9, Math.min(60, (w || 0) + 2))}" customWidth="1"/>`).join("")}</cols>` : "";
    const freeze = sheet.rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "";
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${rowsXml}</sheetData></worksheet>`;
    return { name, xml };
  });
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const nsR = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${parts.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook ${ns} ${nsR}><sheets>${parts.map((p, i) => `<sheet name="${xmlEscape(p.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${parts.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet ${ns}><fonts count="2"><font><sz val="12"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="12"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
    ...parts.map((p, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(p.xml) })),
  ]);
}

// ---------------------------------------------------------------------------
// Jupyter notebooks (.ipynb, nbformat 4.5): Python 3, opens in Colab too
// ---------------------------------------------------------------------------
export function buildNotebook(cells, images = new Map()) {
  if (!Array.isArray(cells) || !cells.length) throw new Error("cells must list at least one cell.");
  const lines = (text) => {
    const parts = String(text).replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
    return parts.map((l, i) => (i < parts.length - 1 ? l + "\n" : l)).filter((l, i) => !(i === parts.length - 1 && l === ""));
  };
  const nb = {
    cells: cells.map((c, i) => {
      if (!c || typeof c.source !== "string") throw new Error(`Cell ${i + 1} needs source text.`);
      const type = c.type === "markdown" ? "markdown" : c.type === "code" ? "code" : null;
      if (!type) throw new Error(`Cell ${i + 1}: type must be "markdown" or "code".`);
      const id = `cell-${i + 1}`;
      if (type === "code") return { cell_type: "code", execution_count: null, id, metadata: {}, outputs: [], source: lines(c.source) };
      // Pictures in Markdown cells go in as data: URLs (Colab and Jupyter both show them)
      const text = c.source.replace(/!\[([^\]]*)\]\(\s*([A-Za-z]+\d+)\s*\)/g, (all, alt, ref) => {
        const img = images.get(ref.toLowerCase());
        return img ? `![${alt}](data:${img.mediaType};base64,${img.base64})` : all;
      });
      return { cell_type: "markdown", id, metadata: {}, source: lines(text) };
    }),
    metadata: {
      colab: { provenance: [] },
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(nb, null, 1) + "\n";
}

// What a file is, in words, for its card
export const FILE_KINDS = {
  pdf: "PDF", docx: "Word document", xlsx: "Excel spreadsheet", ipynb: "Jupyter notebook",
  csv: "CSV", tsv: "TSV", py: "Python", js: "JavaScript", mjs: "JavaScript", ts: "TypeScript",
  java: "Java", c: "C", cpp: "C++", h: "C header", cs: "C#", go: "Go", rs: "Rust", rb: "Ruby",
  swift: "Swift", kt: "Kotlin", r: "R", sql: "SQL", sh: "Shell script", html: "HTML", css: "CSS",
  json: "JSON", xml: "XML", yaml: "YAML", yml: "YAML", md: "Markdown", txt: "Text", tex: "LaTeX",
  ics: "Calendar event", svg: "SVG image",
};
export function fileKind(name) {
  const ext = ((String(name).match(/\.([^.]+)$/) || [])[1] || "").toLowerCase();
  return FILE_KINDS[ext] || (ext ? `${ext.toUpperCase()} file` : "File");
}

// save_file can't make these right (they aren't text): their own tools can
export const SAVE_FILE_REDIRECTS = { pdf: "create_pdf", docx: "create_docx", doc: "create_docx", xlsx: "create_xlsx", xls: "create_xlsx" };

// A safe file name: no folders, no hidden files, no double-click-to-run types
export function safeFileName(name, forceExtension) {
  let base = String(name || "")
    .split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f:*?"<>|]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  if (forceExtension && !base.toLowerCase().endsWith("." + forceExtension)) base += "." + forceExtension;
  if (!base || base === "." + forceExtension) throw new Error("A file name is required.");
  const ext = (base.match(/\.([^.]+)$/) || [])[1];
  if (ext && BLOCKED_EXTENSIONS.has(ext.toLowerCase())) {
    throw new Error(`.${ext} files can run programs when opened, so they can't be saved. Use a plain text extension like .txt instead.`);
  }
  return base;
}

// ~/Documents/Claude Output, or the hidden zenai.outputFolder pref (an
// absolute path; the real-Zen tests point it at a throwaway folder)
export function outputFolderPath() {
  const custom = prefs.get("outputFolder", "");
  if (custom && custom.startsWith("/") && !custom.split("/").includes("..")) return custom.replace(/\/+$/, "");
  return PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ...OUTPUT_FOLDER);
}

export async function outputDir() {
  const dir = outputFolderPath();
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  return dir;
}

// Writes a NEW file in the output folder ("name (2).ext" if taken)
export async function writeOutputFile(fileName, bytes, max = MAX_FILE_BYTES) {
  if (bytes.length > max) throw new Error(`That file is too big (${Math.round(max / 1048576)} MB max).`);
  const dir = await outputDir();
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? fileName : `${stem} (${n})${ext}`;
    const path = PathUtils.join(dir, candidate);
    if (await IOUtils.exists(path)) continue;
    await IOUtils.write(path, bytes, { mode: "create" });
    return { path, name: candidate, size: bytes.length, bytes };
  }
  throw new Error("Couldn't find a free file name.");
}

// io.images: the chat's image store (screenshots, attached images)
export async function runZenTool(name, args, io = {}) {
  const a = args || {};
  if (name === "save_file") {
    if (typeof a.content !== "string") throw new Error("content must be text.");
    const fileName = safeFileName(a.name);
    const ext = ((fileName.match(/\.([^.]+)$/) || [])[1] || "").toLowerCase();
    if (SAVE_FILE_REDIRECTS[ext]) throw new Error(`A .${ext} file isn't plain text. Use ${SAVE_FILE_REDIRECTS[ext]} instead.`);
    if (ext === "ipynb") {
      let ok = false;
      try { ok = Array.isArray(JSON.parse(a.content).cells); } catch (e) {}
      if (!ok) throw new Error("That isn't a valid notebook. Use create_notebook instead.");
    }
    return writeOutputFile(fileName, new TextEncoder().encode(a.content));
  }
  if (name === "edit_file") {
    const entry = io.files && io.files.get(a.file);
    if (!entry) {
      const have = io.files ? io.files.list().map((f) => `“${f.name}”`) : [];
      throw new Error(`There's no file “${String(a.file || "").slice(0, 120)}” to edit in this chat. ${have.length ? `Files you can edit: ${have.join(", ")}.` : "Only files the user attached or you made in this chat can be edited."}`);
    }
    const { bytes, report } = await editFileBytes(entry.name, entry.bytes, { edits: a.edits, cells: a.cells });
    const ext = extensionOf(entry.name);
    const stem = entry.name.replace(/\.[^.]+$/, "");
    const file = await writeOutputFile(safeFileName(typeof a.file_name === "string" && a.file_name.trim() ? a.file_name : `${stem} (edited)`, ext || undefined), bytes, DOC_MAX_BYTES);
    file.report = report;
    return file;
  }
  if (name === "create_md") {
    if (typeof a.content !== "string") throw new Error("content must be text.");
    const fileName = safeFileName(a.file_name, "md");
    const title = typeof a.title === "string" && a.title.trim() ? `# ${a.title.trim().replace(/\s+/g, " ")}\n\n` : "";
    return writeOutputFile(fileName, new TextEncoder().encode(title + a.content.replace(/\r\n?/g, "\n").replace(/\s*$/, "\n")));
  }
  if (name === "create_pdf") {
    if (typeof a.content !== "string") throw new Error("content must be text.");
    const fileName = safeFileName(a.file_name, "pdf");
    const title = typeof a.title === "string" ? a.title : "";
    const images = imagesFor([a.content], io.images);
    return writeOutputFile(fileName, await makePdf({ title, content: a.content, landscape: a.landscape === true, images, fallbackTitle: fileName.replace(/\.pdf$/i, "") }), DOC_MAX_BYTES);
  }
  if (name === "create_xlsx") {
    const fileName = safeFileName(a.file_name, "xlsx");
    return writeOutputFile(fileName, buildXlsx(a.sheets));
  }
  if (name === "create_notebook") {
    const fileName = safeFileName(a.file_name, "ipynb");
    const images = imagesFor((Array.isArray(a.cells) ? a.cells : []).filter((c) => c && c.type === "markdown").map((c) => c.source), io.images);
    return writeOutputFile(fileName, new TextEncoder().encode(buildNotebook(a.cells, images)), DOC_MAX_BYTES);
  }
  if (name === "create_docx") {
    if (typeof a.content !== "string") throw new Error("content must be text.");
    const fileName = safeFileName(a.file_name, "docx");
    const images = imagesFor([a.content], io.images);
    return writeOutputFile(fileName, buildDocx(typeof a.title === "string" ? a.title : "", a.content, images), DOC_MAX_BYTES);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// JSON-RPC handler for our in-process MCP server.
// hooks: { onFile(file), browserTool(name, args) → content blocks,
//   readSkill(name) → text, agents(name, args) → content blocks (agent_* calls),
//   agentTools: list the agent tools, exclude: Set of tool names this session
//   never gets (not listed, refused if called anyway) }
export async function handleZenMcp(message, hooks) {
  const { onFile = () => {}, browserTool = null, readSkill = null, agents = null, agentTools = false, exclude = null, images = null, files = null, createSkill = null, watchPage = null } = typeof hooks === "function" ? { onFile: hooks } : hooks || {};
  const id = message.id;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (message.method) {
    case "initialize":
      return ok({
        protocolVersion: (message.params && message.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: ZEN_SERVER, version: "1.0.0" },
      });
    case "tools/list": {
      let tools = browserTool ? [...ZEN_TOOLS, ...BROWSER_TOOLS] : ZEN_TOOLS;
      if (agentTools && agents) tools = [...tools, ...AGENT_TOOLS];
      if (exclude) tools = tools.filter((t) => !exclude.has(t.name));
      return ok({ tools });
    }
    case "tools/call": {
      const params = message.params || {};
      // Hidden tools stay off even when called by name
      if (exclude && exclude.has(params.name)) {
        return ok({ content: [{ type: "text", text: `${String(params.name).slice(0, 60)} isn't available here.` }], isError: true });
      }
      if (AGENT_TOOL_NAMES.has(params.name)) {
        try {
          if (!agents) throw new Error("Agents aren't available here.");
          return ok({ content: await agents(params.name, params.arguments || {}) });
        } catch (e) {
          return ok({ content: [{ type: "text", text: (e && e.message) || String(e) }], isError: true });
        }
      }
      if (BROWSER_TOOL_NAMES.has(params.name)) {
        try {
          if (!browserTool) throw new Error("Browser tools aren't available here.");
          return ok({ content: await browserTool(params.name, params.arguments || {}) });
        } catch (e) {
          return ok({ content: [{ type: "text", text: `That didn't work: ${(e && e.message) || e}` }], isError: true });
        }
      }
      if (params.name === "watch_page") {
        try {
          if (!watchPage) throw new Error("Watches aren't available here.");
          return ok({ content: [{ type: "text", text: await watchPage(params.arguments || {}) }] });
        } catch (e) {
          return ok({ content: [{ type: "text", text: (e && e.message) || String(e) }], isError: true });
        }
      }
      if (params.name === "create_skill") {
        try {
          if (!createSkill) throw new Error("Skills can't be made here.");
          return ok({ content: [{ type: "text", text: await createSkill(params.arguments || {}) }] });
        } catch (e) {
          return ok({ content: [{ type: "text", text: (e && e.message) || String(e) }], isError: true });
        }
      }
      if (params.name === "read_skill") {
        try {
          if (!readSkill) throw new Error("Skills can't be read here.");
          return ok({ content: [{ type: "text", text: await readSkill(String((params.arguments || {}).name || "")) }] });
        } catch (e) {
          return ok({ content: [{ type: "text", text: (e && e.message) || String(e) }], isError: true });
        }
      }
      try {
        const file = await runZenTool(params.name, params.arguments, { images, files });
        if (files && file.bytes) files.add(file.name, file.bytes, "made"); // edit_file can change it later
        onFile(file);
        const shown = prefs.get("outputFolder", "") ? file.path : `~/${OUTPUT_FOLDER.join("/")}/${file.name}`;
        const changes = file.report ? ` A copy with ${file.report.length} change${file.report.length === 1 ? "" : "s"} (the original is unchanged): ${file.report.join("; ")}.` : "";
        return ok({ content: [{ type: "text", text: `Saved to ${shown} (${file.size} bytes).${changes}` }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Couldn't save: ${(e && e.message) || e}` }], isError: true });
      }
    }
    case "ping":
      return ok({});
    default:
      if (id === undefined || id === null) return { jsonrpc: "2.0", result: {}, id: 0 }; // notification
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}
