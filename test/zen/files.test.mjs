// Making files in real Zen: create_pdf prints with Gecko's own PDF printer
// (pages, landscape, Unicode), create_xlsx / create_notebook write real
// files, and the cards sit at the end of the reply with macOS's icon for the
// type. Everything goes to a throwaway folder (zenai.outputFolder), never
// ~/Documents/Claude Output.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const out = mkdtempSync(join(tmpdir(), "zenai-files-"));
  const zen = await realZen({ holdReplies: true, prefs: { "zenai.outputFolder": out } });
  try {
    await zen.open();
    await zen.send("Make the lab files", { wait: false });

    const md = [
      "## Results",
      "Merge sort is O(n log n); x² + √x ≤ π, θ ∈ [0, 2π), café ✓.",
      "",
      "- first",
      "  - nested",
      "- second",
      "",
      "| Algorithm | Best | Worst |",
      "|---|:---:|---:|",
      "| **Merge** | O(n log n) | O(n log n) |",
      "| Quick | O(n log n) | O(n²) |",
      "",
      "```python",
      "def f(x):\n    return x * 2",
      "```",
      "\\newpage",
      "# Page two",
      "> A quote.",
    ].join("\n");
    const res = await zen.callTool("create_pdf", { file_name: "Lab 4 report", title: "Lab 4: Sorting", content: md });
    const pdfPath = join(out, "Lab 4 report.pdf");
    check("create_pdf saves a PDF", !res.isError && existsSync(pdfPath), textOf(res));
    const pdf = existsSync(pdfPath) ? readFileSync(pdfPath) : Buffer.alloc(0);
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    check("...a real PDF with the page break (2 pages)", pdf.subarray(0, 5).toString() === "%PDF-" && pages === 2, { size: pdf.length, pages });
    check("...portrait Letter", /\/MediaBox\s*\[\s*0 0 612 792\s*\]/.test(pdf.toString("latin1")));

    const wide = await zen.callTool("create_pdf", { file_name: "Wide", content: "| a | b |\n|---|---|\n| 1 | 2 |", landscape: true });
    const widePdf = existsSync(join(out, "Wide.pdf")) ? readFileSync(join(out, "Wide.pdf")).toString("latin1") : "";
    check("landscape pages", !wide.isError && /\/MediaBox\s*\[\s*0 0 792 612\s*\]/.test(widePdf), textOf(wide));
    const again = await zen.callTool("create_pdf", { file_name: "Wide", content: "again" });
    check("a second file with the same name doesn't overwrite", !again.isError && existsSync(join(out, "Wide (2).pdf")), textOf(again));

    const xl = await zen.callTool("create_xlsx", { file_name: "Grades", sheets: [{ name: "Grades", rows: [["Name", "Score"], ["Ana", 95], ["Avg", "=AVERAGE(B2:B2)"]] }] });
    const nb = await zen.callTool("create_notebook", { file_name: "Lab 3", cells: [{ type: "markdown", source: "# Lab 3" }, { type: "code", source: "print(1)" }] });
    check("create_xlsx and create_notebook write files", !xl.isError && existsSync(join(out, "Grades.xlsx")) && !nb.isError && JSON.parse(readFileSync(join(out, "Lab 3.ipynb"), "utf8")).cells.length === 2, [textOf(xl), textOf(nb)]);
    check("no hidden print browser is left behind", await zen.chrome(() => ![...document.querySelectorAll("browser")].some((b) => (b.getAttribute("style") || "").includes("-30000px"))));

    // Screenshots in documents: every screenshot gets an id; keep_only doesn't show it to Claude
    await zen.openTab(zen.page("frames.html"));
    const seen = await zen.tool("browser_screenshot", {});
    const shotId = (textOf(seen).match(/Image id (shot\d+)/) || [])[1];
    check("a screenshot gets an image id", !!shotId && (seen.content || []).some((c) => c.type === "image"), textOf(seen).slice(-200));
    const kept = await zen.tool("browser_screenshot", { keep_only: true });
    const keptId = (textOf(kept).match(/saved for documents as (shot\d+)/) || [])[1];
    check("keep_only: an id and no picture for Claude", !!keptId && keptId !== shotId && !(kept.content || []).some((c) => c.type === "image"), textOf(kept));
    const withShots = await zen.callTool("create_pdf", { file_name: "With shots", content: `Before\n\n![The page](${shotId})\n\n![Kept only](${keptId})\n\nAfter` });
    const shotPdf = existsSync(join(out, "With shots.pdf")) ? readFileSync(join(out, "With shots.pdf")).toString("latin1") : "";
    check("create_pdf puts the screenshots in", !withShots.isError && (shotPdf.match(/\/Subtype\s*\/Image/g) || []).length >= 2, textOf(withShots));
    const docShots = await zen.callTool("create_docx", { file_name: "With shots", content: `![The page](${shotId})` });
    const docx = existsSync(join(out, "With shots.docx")) ? readFileSync(join(out, "With shots.docx")).toString("latin1") : "";
    check("create_docx puts a screenshot in", !docShots.isError && docx.includes("word/media/image1.jpeg"), textOf(docShots));
    const bad = await zen.callTool("create_pdf", { file_name: "Bad", content: "![x](shot99)" });
    check("an unknown image id is refused with the ones there are", bad.isError && new RegExp(`no image shot99.*${shotId}`).test(textOf(bad)) && !existsSync(join(out, "Bad.pdf")), textOf(bad));

    await zen.finishReplies();
    const tray = await zen.chrome(async () => {
      await new Promise((r) => setTimeout(r, 600)); // the icons load
      const reply = [...document.querySelectorAll(".zai-assistant")].pop();
      const kids = [...reply.children];
      const t = reply.querySelector(".zai-files");
      return {
        cards: t ? t.querySelectorAll(".zai-filecard").length : 0,
        last: t ? kids.indexOf(t) > kids.indexOf(kids.filter((k) => k.classList.contains("zai-seg")).pop()) : false,
        metas: t ? [...t.querySelectorAll(".zai-file-meta")].map((m) => m.textContent) : [],
        icons: t ? t.querySelectorAll(".zai-file-tile.zai-has-icon").length : 0,
      };
    });
    check("the cards are together at the end of the reply", tray.cards === 7 && tray.last, tray);
    check("...named by kind", /^PDF · /.test(tray.metas[0]) && tray.metas.some((m) => /^Excel spreadsheet · /.test(m)) && tray.metas.some((m) => /^Jupyter notebook · /.test(m)), tray.metas);
    check("...with macOS's icons for their types", tray.icons === 7, tray);
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
    rmSync(out, { recursive: true, force: true });
  }
  done();
})().catch(crash);
