// Files a reply makes: their cards sit together at the end of the reply
// (live and in a reopened chat), say what kind of file they are, and the new
// file tools reach the folder; create_pdf's printing needs real Zen (test/zen/files.test.mjs).
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep, HOME } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const OUT = `${HOME}/Documents/Claude Output`;
const textOf = (r) => ((r && r.content) || []).map((c) => c.text || "").join("");

(async () => {
  const disk = new Map();
  let zen = await fakeZen({ disk, transcripts: new Set(), holdReplies: true });
  await zen.open();
  const n = zen.sent.length;
  await zen.send("Make me the lab files", { wait: false });
  for (let i = 0; i < 300 && zen.sent.length === n; i++) await sleep(10);

  // Some words first, then three files, then the rest of the reply
  zen.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Making them now." } } });
  await sleep(50);
  const tools = (await zen.listTools()).tools.map((t) => t.name);
  check("the new file tools are listed", ["create_pdf", "create_xlsx", "create_notebook", "save_file", "create_docx", "create_md", "create_skill"].every((t) => tools.includes(t)), tools);
  const py = await zen.callTool("save_file", { name: "sort.py", content: "print(sorted([3, 1, 2]))\n" });
  const xl = await zen.callTool("create_xlsx", { file_name: "Grades", sheets: [{ name: "Grades", rows: [["Name", "Score"], ["Ana", 95]] }] });
  const nb = await zen.callTool("create_notebook", { file_name: "Lab 3", cells: [{ type: "code", source: "print(1)" }] });
  check("files are written to Claude Output", /Saved to ~\/Documents\/Claude Output\/sort\.py/.test(textOf(py)) && disk.has(`${OUT}/Grades.xlsx`) && disk.has(`${OUT}/Lab 3.ipynb`), [textOf(py), textOf(xl), textOf(nb)]);
  const md = await zen.callTool("create_md", { file_name: "Notes", title: "Chapter 5", content: "- one\n- two" });
  check("create_md writes a Markdown file with its title", !md.isError && new TextDecoder().decode(disk.get(`${OUT}/Notes.md`)) === "# Chapter 5\n\n- one\n- two\n", textOf(md));
  const pdf = await zen.callTool("create_pdf", { file_name: "Report", content: "# Hi" });
  check("create_pdf without Gecko's printer fails cleanly (no card, no file)", pdf.isError && /^Couldn't save: (PDFs can only be made in Zen|Couldn't set up the page to print)/.test(textOf(pdf)) && !disk.has(`${OUT}/Report.pdf`), textOf(pdf));
  const wrong = await zen.callTool("save_file", { name: "Report.pdf", content: "%PDF fake" });
  check("save_file points a .pdf at create_pdf", wrong.isError && /Use create_pdf/.test(textOf(wrong)) && !disk.has(`${OUT}/Report.pdf`));
  await zen.finishReplies();
  await sleep(200);

  const reply = zen.$$(".zai-assistant").at(-1);
  const kids = [...reply.children];
  const tray = reply.querySelector(".zai-files");
  const lastSeg = kids.filter((k) => k.classList.contains("zai-seg")).at(-1);
  check("one tray holds all the cards", !!tray && tray.querySelectorAll(".zai-filecard").length === 4 && reply.querySelectorAll(".zai-filecard").length === 4);
  check("...after all the reply's text, even text that came later", tray && lastSeg && kids.indexOf(tray) > kids.indexOf(lastSeg) && /Reply to/.test(lastSeg.textContent), kids.map((k) => k.className));
  const metas = [...tray.querySelectorAll(".zai-file-meta")].map((m) => m.textContent);
  check("cards say what kind of file", /^Python · /.test(metas[0]) && /^Excel spreadsheet · /.test(metas[1]) && /^Jupyter notebook · /.test(metas[2]), metas);
  const tile = tray.querySelector(".zai-filecard:nth-child(2) .zai-file-tile");
  check("the tile knows the type and asks for the system's icon", tile.dataset.ext === "xlsx" && tile.querySelector("img.zai-file-icon").getAttribute("src") === "moz-icon://.xlsx?size=64");
  const main = tray.querySelector(".zai-file-main");
  check("the card itself opens the file and can be dragged", main.getAttribute("role") === "button" && main.getAttribute("draggable") === "true");
  await zen.close();

  // Reopened: the same tray after the text
  zen = await fakeZen({ disk, transcripts: new Set(), holdReplies: false });
  await zen.open();
  const saved = zen.$$(".zai-assistant").at(-1);
  const savedKids = saved ? [...saved.children] : [];
  const savedTray = saved && saved.querySelector(".zai-files");
  check("a reopened chat keeps the tray at the end", !!savedTray && savedTray.querySelectorAll(".zai-filecard").length === 4 && savedKids.indexOf(savedTray) > savedKids.indexOf(savedKids.filter((k) => k.classList.contains("zai-seg")).at(-1)), savedKids.map((k) => k.className));
  await zen.close();
  done();
})().catch(crash);
