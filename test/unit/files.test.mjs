// Reading attachments (Word, PowerPoint, Excel, PDF, text sniffing) and
// writing Word documents, with the real modules in Node.
import fs from "node:fs";
import { checker, crash, fixture } from "../helpers/common.mjs";
import { readDocument, isImageFile, readZip, docxToText } from "../../src/attachments.mjs";
import { JSDOM } from "jsdom";
import { buildDocx, buildNotebook, buildXlsx, fileKind, fitImage, imagesFor, newImageStore, runZenTool, xlsxColumn } from "../../src/files.mjs";
import { fillPdfDocument, pdfBlocks } from "../../src/pdf.mjs";

const { check, done } = checker();
const read = (f) => new Uint8Array(fs.readFileSync(fixture(f)));
const doc = (name, bytes, type = "") => readDocument({ name, type, bytes }).catch((e) => ({ error: e.message }));

(async () => {
  const docx = await doc("lab3.docx", read("lab3.docx"));
  check("Word: text, entities and tabs", docx.kind === "text" && docx.label === "Word document" && /merge sort in O\(n log n\) time\. Compare <quick sort> & café ☕/.test(docx.text) && docx.text.includes("Step\ttwo with a tab"), docx.text?.slice(0, 80));
  const doc2 = await doc("test.docx", read("test.docx"));
  check("Word: bullets and numbered lists", /•\s+7-inch inner display/.test(doc2.text) && /2\.\s+Second <point> & "quotes"/.test(doc2.text));

  const pptx = await doc("lecture.pptx", read("lecture.pptx"));
  check("PowerPoint: slides in order", pptx.label === "PowerPoint" && /--- Slide 1 ---\nWeek 1: Intro[\s\S]*--- Slide 2 ---\nWeek 2: Trees/.test(pptx.text) && pptx.text.includes("AVL rotations <balance>"));

  const xlsx = await doc("grades.xlsx", read("grades.xlsx"));
  check("Excel: sheets as tab-separated rows", xlsx.label === "Spreadsheet" && /--- Sheet: Grades ---\nName\tQ1\tQ2\tNotes\nAna\t95\t88\tlate & ok/.test(xlsx.text) && /--- Sheet: Summary ---\nAverage\t83.75/.test(xlsx.text));
  const budget = await doc("budget.xlsx", read("budget.xlsx"));
  check("Excel: numbers and booleans", /Rent \(monthly\)\t1200.5/.test(budget.text) && /Total\t1200.5\tTRUE/.test(budget.text));

  const pdf = await doc("secret.pdf", read("secret.pdf"), "application/pdf");
  check("PDF is sent whole", pdf.kind === "pdf" && Buffer.from(pdf.base64, "base64").equals(fs.readFileSync(fixture("secret.pdf"))));

  const enc = new TextEncoder();
  const cases = [
    ["notes.md", enc.encode("# Hi\nünïcode ✓"), (r) => r.text === "# Hi\nünïcode ✓"],
    ["Makefile", enc.encode("all:\n\techo hi\n"), (r) => r.kind === "text"],
    ["weird.bin", new Uint8Array([1, 2, 0, 4, 5]), (r) => /Can't read \.bin files/.test(r.error)],
    ["latin1.dat", new Uint8Array([0x63, 0x61, 0x66, 0xe9]), (r) => r.text === "café"],
    ["utf16.txt", new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), (r) => r.text === "hi"],
    ["old.doc", enc.encode("x"), (r) => /Save it as \.docx or PDF/.test(r.error)],
    ["photo.HEIC", enc.encode("x"), (r) => /Export it as JPEG or PNG/.test(r.error)],
    ["broken.docx", enc.encode("not a zip at all"), (r) => /looks damaged/.test(r.error)],
  ];
  for (const [name, bytes, ok] of cases) {
    const r = await doc(name, bytes);
    check(`sniffing: ${name}`, ok(r), r.error || r.text);
  }
  check("image detection", isImageFile("a.PNG", "") && isImageFile("x", "image/webp") && !isImageFile("a.pdf", "application/pdf") && !isImageFile("a.svg", ""));

  // A Word file with a table, read back with our own reader
  const md = "# Sorting algorithms\nHere's how they compare:\n\n| Algorithm | Best | Worst |\n|:---|:---:|---:|\n| **Merge sort** | O(n log n) | O(n log n) |\n| Quick sort | O(n log n) | O(n²) |\n\n- Merge sort needs extra memory.";
  const bytes = buildDocx("Study guide", md);
  const entries = readZip(bytes);
  const xml = new TextDecoder().decode(await entries.get("word/document.xml")());
  check("create_docx: a real Word table", (xml.match(/<w:tbl>/g) || []).length === 1 && (xml.match(/<w:tr>/g) || []).length === 3 && xml.includes("w:tblHeader"));
  const back = await docxToText(entries);
  check("create_docx: readable text", back.includes("Study guide") && back.includes("Quick sort") && back.includes("Merge sort needs extra memory."), back.slice(0, 120));

  // create_xlsx: read back with our own reader (numbers, booleans, names)
  const x = buildXlsx([
    { name: "Grades: Fall/2026", rows: [["Name", "Score", "Pass"], ["Ana", 95, true], ["Bo <&>", 71.5, false], ["Average", "=AVERAGE(B2:B3)", null]] },
    { name: "grades fall/2026", rows: [] },
    { rows: [["only"]] },
  ]);
  const xr = await doc("t.xlsx", x);
  check("create_xlsx: sheets, numbers, booleans, escaped text", /--- Sheet: Grades Fall 2026 ---\nName\tScore\tPass\nAna\t95\tTRUE\nBo <&>\t71.5\tFALSE/.test(xr.text), xr.text || xr.error);
  check("create_xlsx: a repeated sheet name gets a number; a missing one a default", /--- Sheet: grades fall 2026 2 ---/.test(xr.text) && /--- Sheet: Sheet3 ---\nonly/.test(xr.text), xr.text);
  const xe = readZip(x);
  const sheet1 = new TextDecoder().decode(await xe.get("xl/worksheets/sheet1.xml")());
  check("create_xlsx: = is a formula, the header is bold and frozen", sheet1.includes("<f>AVERAGE(B2:B3)</f>") && /<c r="A1" s="1"/.test(sheet1) && sheet1.includes('state="frozen"'), sheet1.slice(0, 300));
  check("create_xlsx: column letters", xlsxColumn(0) === "A" && xlsxColumn(25) === "Z" && xlsxColumn(26) === "AA" && xlsxColumn(701) === "ZZ" && xlsxColumn(702) === "AAA");
  const bad = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  check("create_xlsx: refuses rows that aren't lists", /row 1 must be a list/.test(bad(() => buildXlsx([{ name: "A", rows: ["a,b"] }]))) && /at least one sheet/.test(bad(() => buildXlsx([]))));

  // create_notebook: nbformat 4.5 that Colab and Jupyter open
  const nb = JSON.parse(buildNotebook([{ type: "markdown", source: "# Lab 3\nSorting" }, { type: "code", source: "%pip install numpy\nimport numpy as np\n\n" }]));
  check("create_notebook: cells, ids, sources as lines", nb.nbformat === 4 && nb.nbformat_minor === 5 && nb.cells.length === 2 && nb.cells[0].id && nb.cells[1].cell_type === "code" && nb.cells[1].outputs.length === 0 && nb.cells[1].execution_count === null && JSON.stringify(nb.cells[1].source) === JSON.stringify(["%pip install numpy\n", "import numpy as np"]), nb.cells);
  check("create_notebook: a Python 3 kernel, Colab metadata", nb.metadata.kernelspec.name === "python3" && !!nb.metadata.colab);
  check("create_notebook: refuses an unknown cell type", /type must be/.test(bad(() => buildNotebook([{ type: "raw", source: "x" }]))));

  // save_file sends binary types to their own tools (before writing anything)
  const refused = async (args) => runZenTool("save_file", args).then(() => "", (e) => e.message);
  check("save_file: .pdf goes to create_pdf", /Use create_pdf/.test(await refused({ name: "report.pdf", content: "x" })));
  check("save_file: .xlsx goes to create_xlsx", /Use create_xlsx/.test(await refused({ name: "a.XLSX", content: "x" })));
  check("save_file: a broken .ipynb goes to create_notebook", /create_notebook/.test(await refused({ name: "lab.ipynb", content: "{not json" })));
  check("file kinds", fileKind("a.ipynb") === "Jupyter notebook" && fileKind("b.PDF") === "PDF" && fileKind("c.xyz") === "XYZ file" && fileKind("Makefile") === "File");

  // create_pdf's document: Markdown → blocks → DOM (the printing is in test/zen/files.test.mjs)
  const blocks = pdfBlocks("# Title\nOne line\nnext line\n\n- a\n  - b\n    more of b\n- c\n1. one\n\n```\ncode <x>\n```\n> quote\n> more\n\\newpage\n---\n| A | B |\n|---|--:|\n| 1 | 2 |");
  check("pdf blocks", JSON.stringify(blocks.map((b) => b.type)) === JSON.stringify(["h", "p", "list", "code", "quote", "break", "hr", "table"]), blocks.map((b) => b.type));
  check("pdf: lines of a paragraph stay lines; nested items keep depth", blocks[1].lines.length === 2 && JSON.stringify(blocks[2].items.map((i) => [i.depth, i.ordered, i.text])) === JSON.stringify([[0, false, "a"], [1, false, "b more of b"], [0, false, "c"], [0, true, "one"]]), blocks[2].items);
  const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  const d = window.document;
  fillPdfDocument(d, "Lab <4>", "Some **bold *and italic*** text, `x<y`, [a link](https://example.com) and [not](javascript:alert(1)).\n\n<script>alert(1)</script>\n\n- a\n  - b\n\n| A | B |\n|---|--:|\n| 1 | **2** |");
  check("pdf: title, inline marks, safe links", d.title === "Lab <4>" && d.querySelector(".doc-title").textContent === "Lab <4>" && d.querySelector("strong em").textContent === "and italic" && d.querySelector("code").textContent === "x<y" && d.querySelectorAll("a").length === 1 && d.querySelector("a").getAttribute("href") === "https://example.com");
  check("pdf: HTML in the Markdown stays text", !d.querySelector("script") && d.body.textContent.includes("<script>alert(1)</script>"));
  check("pdf: nested list and table", !!d.querySelector("ul > li > ul > li") && d.querySelectorAll("thead th").length === 2 && d.querySelector("td.al-right strong").textContent === "2");

  // Images for documents: ids, eviction, lookups, sizes
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const store = newImageStore();
  const s1 = store.add("shot", { base64: png1x1, mediaType: "image/png", width: 1600, height: 900 }, "Order page", 800);
  const i1 = store.add("image", { base64: png1x1, mediaType: "image/png", width: 300, height: 300 }, "graph.png");
  check("image ids by kind", s1 === "shot1" && i1 === "image1" && store.get("SHOT1").cssWidth === 800);
  check("only PNG and JPEG are kept", store.add("image", { base64: "x", mediaType: "image/webp", width: 1, height: 1 }) === null);
  for (let k = 0; k < 45; k++) store.add("shot", { base64: png1x1, mediaType: "image/png", width: 10, height: 10 });
  check("the oldest images go first", !store.get("shot1") && !!store.get("shot46") && store.list().length === 40);
  const missing = (() => { try { imagesFor(["![x](shot1)"], store); return ""; } catch (e) { return e.message; } })();
  check("an unknown id says which ones there are", /There's no image shot1/.test(missing) && /shot46/.test(missing), missing);
  check("fitting: its own size, inside the page", JSON.stringify(fitImage({ width: 1600, height: 900, cssWidth: 800 }, 660, 860)) === JSON.stringify({ w: 660, h: 371 }) && JSON.stringify(fitImage({ width: 300, height: 300, cssWidth: 300 }, 660, 860)) === JSON.stringify({ w: 300, h: 300 }) && fitImage({ width: 400, height: 4000, cssWidth: 400 }, 660, 860).h === 860);

  const pics = new Map([["shot3", { id: "shot3", base64: png1x1, mediaType: "image/png", width: 1200, height: 600, cssWidth: 1200 }]]);
  const withPic = buildDocx("Report", "Before\n\n![The order *page*](shot3)\n\nAfter", pics);
  const pe = readZip(withPic);
  const pxml = new TextDecoder().decode(await pe.get("word/document.xml")());
  const prels = pe.get("word/_rels/document.xml.rels") ? new TextDecoder().decode(await pe.get("word/_rels/document.xml.rels")()) : "";
  check("create_docx: the picture, its relationship and media", pxml.includes("<w:drawing>") && pxml.includes('r:embed="rIdImg1"') && /Target="media\/image1\.png"/.test(prels) && !!pe.get("word/media/image1.png"));
  check("create_docx: fitted to 6.5 in, caption under it", pxml.includes(`cx="${624 * 9525}" cy="${312 * 9525}"`) && /<w:i\/>.*The order \*page\*/.test(pxml));
  check("create_docx: still readable", /Before[\s\S]*After/.test(await docxToText(pe)));
  const nbPic = JSON.parse(buildNotebook([{ type: "markdown", source: "Look:\n![graph](shot3)" }, { type: "code", source: "# ![x](shot3) stays" }], pics));
  check("create_notebook: a picture in a Markdown cell, code untouched", nbPic.cells[0].source.join("").includes(`![graph](data:image/png;base64,${png1x1})`) && nbPic.cells[1].source[0] === "# ![x](shot3) stays");
  const toolErr = await runZenTool("create_docx", { file_name: "x", content: "![a](shot9)" }, { images: newImageStore() }).then(() => "", (e) => e.message);
  check("create_docx with an id nobody has: refused before writing", /no image shot9/.test(toolErr) && /take a browser_screenshot/.test(toolErr), toolErr);

  const { window: w2 } = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  fillPdfDocument(w2.document, "", "![Step 2 of the order](shot3)\n\n![gone](shot8)", pics);
  const fig = w2.document.querySelector("figure img");
  check("pdf: a figure at its fitted size, with a caption", fig && fig.getAttribute("src").startsWith("data:image/png;base64,") && fig.getAttribute("style") === "width: 660px; height: 330px;" && w2.document.querySelector("figcaption").textContent === "Step 2 of the order");
  check("pdf blocks: an image line", JSON.stringify(pdfBlocks("![cap](Shot3)")) === JSON.stringify([{ type: "img", id: "shot3", caption: "cap" }]));
  done();
})().catch(crash);
