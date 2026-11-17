// edit_file: a copy of a file with only the asked-for text changed. Word (a
// paper with a header, double spacing and runs split mid-phrase), real Word,
// PowerPoint and Excel files, a notebook and plain text; what's refused.
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { checker, crash, fixture } from "../helpers/common.mjs";

const { window } = new JSDOM("");
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;

const { editFileBytes, editText, newFileStore } = await import("../../src/file-edit.mjs");
const { zipStore, buildXlsx, buildNotebook } = await import("../../src/files.mjs");
const { readZip, readDocument } = await import("../../src/attachments.mjs");

const { check, done } = checker();
const enc = new TextEncoder();
const dec = new TextDecoder();
const read = (f) => new Uint8Array(fs.readFileSync(fixture(f)));
const text = async (name, bytes) => (await readDocument({ name, type: "", bytes })).text;
const part = async (bytes, name) => dec.decode(await readZip(bytes).get(name)());
const fails = (p) => p.then(() => "", (e) => e.message);

// An MLA-style paper: header, centred title, double spacing, a phrase split
// over three runs, an outline item, and the section's settings in the last paragraph
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const dbl = '<w:spacing w:line="480" w:lineRule="auto"/>';
const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>` +
  `<w:p><w:pPr>${dbl}<w:jc w:val="center"/></w:pPr><w:r><w:t>Planning Page</w:t></w:r></w:p>` +
  `<w:p><w:pPr>${dbl}<w:ind w:left="720"/></w:pPr><w:r><w:t xml:space="preserve">I.A </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Nick's distance</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> from his Midwest home</w:t></w:r><w:r><w:t xml:space="preserve"> and family</w:t></w:r></w:p>` +
  `<w:p><w:pPr>${dbl}<w:ind w:left="720"/></w:pPr><w:r><w:t>I.B Gatsby's parties</w:t></w:r></w:p>` +
  `<w:p><w:pPr>${dbl}</w:pPr><w:r><w:t>Note: the Note: phrase</w:t></w:r></w:p>` +
  `<w:p><w:pPr>${dbl}<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>Last line</w:t></w:r></w:p>` +
  `</w:body></w:document>`;
const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${W}><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">KIM </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:hdr>`;
const paper = zipStore([
  { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
  { name: "word/document.xml", data: enc.encode(doc) },
  { name: "word/header1.xml", data: enc.encode(header) },
]);

(async () => {
  // A phrase across three runs: the first run (bold) takes the new text
  let r = await editFileBytes("Planning Page.docx", paper, { edits: [{ find: "Nick's distance from his Midwest home and family", replace: "Distance from home" }] });
  let xml = await part(r.bytes, "word/document.xml");
  check("Word: a phrase over three runs is replaced", (await text("p.docx", r.bytes)).includes("I.A Distance from home") && r.report.length === 1, r.report);
  check("...in the first run it covered, keeping that run's formatting", /<w:rPr><w:b\/><\/w:rPr><w:t>Distance from home<\/w:t>/.test(xml), xml.slice(0, 900));
  check("...spacing, centring, indents and the header untouched", (xml.match(/w:line="480"/g) || []).length === 5 && xml.includes('<w:jc w:val="center"/>') && (xml.match(/<w:ind w:left="720"\/>/g) || []).length === 2 && (await part(r.bytes, "word/header1.xml")) === header);
  check("...the XML declaration is kept", xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'));

  // A whole paragraph → two (both styled like it); one removed
  r = await editFileBytes("p.docx", paper, { edits: [{ find: "I.B Gatsby's parties", replace: "I.B Hosting lavish parties\nI.C Watching the green light" }, { find: "Note: the Note: phrase", replace: "" }] });
  xml = await part(r.bytes, "word/document.xml");
  const t = await text("p.docx", r.bytes);
  check("Word: a paragraph split into two, each with its indent and spacing", /I\.B Hosting lavish parties\nI\.C Watching the green light/.test(t) && (xml.match(/<w:ind w:left="720"\/>/g) || []).length === 3, t);
  check("...and a paragraph removed", !t.includes("Note:") && (xml.match(/<w:p>/g) || []).length === 5, t);
  r = await editFileBytes("p.docx", paper, { edits: [{ find: "Last line", replace: "" }] });
  xml = await part(r.bytes, "word/document.xml");
  check("...but the one holding the section's settings is only emptied", xml.includes("<w:sectPr>") && !xml.includes("Last line"));
  r = await editFileBytes("p.docx", paper, { edits: [{ find: "Note:", replace: "N.B.", all: true }] });
  check("all: true replaces every match", (await text("p.docx", r.bytes)).includes("N.B. the N.B. phrase"));

  // Refusals: nothing is saved
  check("not found: says so", /isn't in the file.*inside one paragraph/.test(await fails(editFileBytes("p.docx", paper, { edits: [{ find: "Daisy", replace: "x" }] }))));
  check("twice without all: says how many", /is in the file 2 times/.test(await fails(editFileBytes("p.docx", paper, { edits: [{ find: "Note:", replace: "x" }] }))));
  check("across paragraphs: one edit per paragraph", /can't cross paragraphs/.test(await fails(editFileBytes("p.docx", paper, { edits: [{ find: "Planning Page\nI.A", replace: "x" }] }))));
  check("a line break in part of a paragraph: refused", /only works when find is a whole paragraph/.test(await fails(editFileBytes("p.docx", paper, { edits: [{ find: "Gatsby's", replace: "a\nb" }] }))));
  check("PDF: refused with what to do instead", /create_pdf/.test(await fails(editFileBytes("x.pdf", read("secret.pdf"), { edits: [{ find: "a", replace: "b" }] }))));

  // A real Word file: only document.xml changes
  const lab = read("lab3.docx");
  r = await editFileBytes("lab3.docx", lab, { edits: [{ find: "merge sort", replace: "heap sort" }] });
  const before = readZip(lab);
  const after = readZip(r.bytes);
  let same = true;
  for (const [name, get] of before) if (name !== "word/document.xml" && Buffer.compare(Buffer.from(await get()), Buffer.from(await after.get(name)())) !== 0) same = false;
  check("real Word file: the edit, and every other part byte for byte the same", (await text("l.docx", r.bytes)).includes("heap sort in O(n log n) time") && same && [...after.keys()].join() === [...before.keys()].join());

  // PowerPoint
  r = await editFileBytes("lecture.pptx", read("lecture.pptx"), { edits: [{ find: "Week 2: Trees", replace: "Week 2: Graphs" }] });
  check("PowerPoint: text on a slide", /--- Slide 2 ---\nWeek 2: Graphs/.test(await text("l.pptx", r.bytes)));

  // Excel: shared strings (a real file), cells by name, a new row, formulas
  r = await editFileBytes("grades.xlsx", read("grades.xlsx"), {
    edits: [{ find: "late & ok", replace: "on time" }],
    cells: [{ cell: "B2", value: 99 }, { cell: "Summary!B5", value: "=AVERAGE(Grades!B2:B5)" }, { cell: "A9", value: "Added" }, { cell: "D3", value: null }],
  });
  let x = await text("g.xlsx", r.bytes);
  check("Excel: text replaced, a number set, a new row", /Ana\t99\t88\ton time/.test(x) && /\nAdded/.test(x), x);
  check("...the formula is there and the workbook recalculates on open, without a stale chain", (await part(r.bytes, readZip(r.bytes).has("xl/worksheets/sheet2.xml") ? "xl/worksheets/sheet2.xml" : "xl/worksheets/sheet1.xml")).includes("<f>AVERAGE(Grades!B2:B5)</f>") && (await part(r.bytes, "xl/workbook.xml")).includes('fullCalcOnLoad="1"') && !readZip(r.bytes).has("xl/calcChain.xml"));
  const ours = buildXlsx([{ name: "S", rows: [["Name", "Score"], ["Ana", 1]] }]);
  r = await editFileBytes("o.xlsx", ours, { cells: [{ cell: "A1", value: "Student" }] });
  check("...a cell keeps its style (bold header)", /<c r="A1" s="1" t="inlineStr"><is><t>Student<\/t><\/is><\/c>/.test(await part(r.bytes, "xl/worksheets/sheet1.xml")));
  check("...an unknown sheet names the ones there are", /no sheet “Nope”.*Sheets: S/.test(await fails(editFileBytes("o.xlsx", ours, { cells: [{ cell: "Nope!A1", value: 1 }] }))));
  check("cells on a Word file: refused", /only works for Excel/.test(await fails(editFileBytes("p.docx", paper, { cells: [{ cell: "A1", value: 1 }] }))));

  // Notebook (outputs kept) and text
  const nb = JSON.parse(buildNotebook([{ type: "code", source: "x = 1\nprint(x)" }]));
  nb.cells[0].outputs = [{ output_type: "stream", name: "stdout", text: ["1\n"] }];
  r = await editFileBytes("lab.ipynb", enc.encode(JSON.stringify(nb)), { edits: [{ find: "x = 1", replace: "x = 2" }] });
  const nb2 = JSON.parse(dec.decode(r.bytes));
  check("notebook: a cell's code changed, its outputs kept", JSON.stringify(nb2.cells[0].source) === '["x = 2\\n","print(x)"]' && nb2.cells[0].outputs.length === 1);
  r = await editFileBytes("sort.py", enc.encode("def f(a):\n    return sorted(a)\n"), { edits: [{ find: "sorted(a)", replace: "sorted(a, reverse=True)" }] });
  check("text: find and replace", dec.decode(r.bytes) === "def f(a):\n    return sorted(a, reverse=True)\n");
  check("text: twice needs all", /2 times/.test((() => { try { editText("a a", [{ find: "a", replace: "b" }]); return ""; } catch (e) { return e.message; } })()));

  // The chat's files, by name
  const store = newFileStore();
  store.add("Planning Page.docx", paper, "attached");
  store.add("planning page.docx", lab, "made");
  check("the file store: by name, ignoring case, newest wins", store.get("PLANNING PAGE.DOCX").bytes === lab && store.list().length === 1);
  done();
})().catch(crash);
