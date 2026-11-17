// edit_file in real Zen (Gecko's own XML parser and serializer): files the
// user drops on the panel and files Claude made in the chat can be edited;
// the copy reads back right, the original is untouched, unknown names list
// the files there are. Everything goes to a throwaway folder.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker, crash, fixture } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";
import { readDocument, readZip } from "../../src/attachments.mjs";

const { check, done } = checker();
const docText = async (path) => (await readDocument({ name: path, type: "", bytes: new Uint8Array(readFileSync(path)) })).text;

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const out = mkdtempSync(join(tmpdir(), "zenai-edit-"));
  const zen = await realZen({ holdReplies: true, prefs: { "zenai.outputFolder": out } });
  try {
    await zen.open();
    // Drop two files on the panel, as from Finder
    const files = ["lab3.docx", "grades.xlsx"].map((n) => ({ name: n, b64: readFileSync(fixture(n)).toString("base64") }));
    await zen.chrome(async (files) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const bin = atob(f.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name));
      }
      document.getElementById("zai-panel").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      for (let i = 0; i < 50 && document.querySelectorAll(".zai-composer .zai-chip.zai-loading").length; i++) await new Promise((r) => setTimeout(r, 100));
    }, files);
    await zen.send("Fix my lab and the grades", { wait: false });
    const msg = zen.sent.at(-1).text;
    check("the dropped files reach Claude", msg.includes("lab3.docx") && msg.includes("grades.xlsx"), msg.slice(0, 300));

    let res = await zen.callTool("edit_file", { file: "lab3.docx", edits: [{ find: "merge sort", replace: "heap sort" }], file_name: "Lab 3 (revised)" });
    const docx = join(out, "Lab 3 (revised).docx");
    check("Word: the copy is saved with the change listed", !res.isError && existsSync(docx) && /1 change \(the original is unchanged\): “merge sort” → “heap sort”/.test(textOf(res)), textOf(res));
    check("...and reads back right (Gecko's XML out)", existsSync(docx) && (await docText(docx)).includes("heap sort in O(n log n) time. Compare <quick sort> & café ☕"));
    const xml = existsSync(docx) ? new TextDecoder().decode(await readZip(new Uint8Array(readFileSync(docx))).get("word/document.xml")()) : "";
    check("...with its declaration and namespaces", xml.startsWith("<?xml") && xml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'), xml.slice(0, 200));

    res = await zen.callTool("edit_file", { file: "grades.xlsx", edits: [{ find: "late & ok", replace: "on time" }], cells: [{ cell: "B2", value: 100 }] });
    const xlsx = join(out, "grades (edited).xlsx");
    check("Excel: text and a cell, saved as “(edited)”", !res.isError && existsSync(xlsx) && /Ana\t100\t88\ton time/.test(await docText(xlsx)), textOf(res));

    // A file Claude made in this chat, edited by its name
    await zen.callTool("create_md", { file_name: "Notes", content: "Merge sort is O(n log n).\n" });
    res = await zen.callTool("edit_file", { file: "Notes.md", edits: [{ find: "O(n log n)", replace: "Θ(n log n)" }] });
    check("a file made in the chat can be edited too", !res.isError && readFileSync(join(out, "Notes (edited).md"), "utf8") === "Merge sort is Θ(n log n).\n", textOf(res));
    check("...and the one it was made from is unchanged", readFileSync(join(out, "Notes.md"), "utf8") === "Merge sort is O(n log n).\n");

    res = await zen.callTool("edit_file", { file: "essay.docx", edits: [{ find: "a", replace: "b" }] });
    check("an unknown file: refused, listing the ones there are", res.isError && /no file “essay\.docx”.*lab3\.docx.*grades\.xlsx/.test(textOf(res)), textOf(res));
    res = await zen.callTool("edit_file", { file: "lab3.docx", edits: [{ find: "not in it", replace: "x" }] });
    check("an edit that doesn't match: nothing saved, told why", res.isError && /isn't in the file/.test(textOf(res)) && !existsSync(join(out, "lab3 (edited).docx")), textOf(res));
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
    if (!process.env.KEEP_OUT) rmSync(out, { recursive: true, force: true });
    else console.log("Kept", out);
  }
  done();
})().catch(crash);
