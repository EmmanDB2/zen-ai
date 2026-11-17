// The "/" menu with skills in folders: the built mod (dist/) in a jsdom Zen
// window, with a skills folder holding loose skills and folders (and one
// folder inside another). Grouped under folder names with nothing typed;
// typing searches across folders and names each row's folder; arrow keys
// skip the headings; two files with one name are flagged.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const DIR = "/profile/chrome/zenai-skills";
const sk = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\nDo ${name}.`;
const FILES = {
  "summarize.md": sk("summarize", "Summarize this page"),
  "tldr.md": sk("tldr", "One-line summary"),
  "School/solve.md": sk("solve", "Solve the math problem"),
  "School/flashcards.md": sk("flashcards", "Make flashcards"),
  "School/Chem/balance.md": sk("balance", "Balance an equation"),
  "Work/reply.md": sk("reply", "Draft a reply"),
  "Work/summarize.md": sk("summarize", "Summarize for my team"),
  "_drafts/wip.md": sk("wip", "Not ready"),
};

(async () => {
  const zen = await fakeZen();
  const { w, $, $$ } = zen;
  // The skills folder on "disk"
  const paths = new Map(Object.entries(FILES).map(([k, v]) => [`${DIR}/${k}`, v]));
  const io = w.IOUtils;
  const { getChildren, readUTF8 } = io;
  io.getChildren = async (d) => (d.startsWith(DIR) ? [...new Set([...paths.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))] : getChildren(d));
  io.readUTF8 = async (p) => (paths.has(p) ? paths.get(p) : readUTF8(p));
  io.stat = async (p) => ({ type: [...paths.keys()].some((k) => k.startsWith(p + "/")) ? "directory" : "regular" });
  w.Services.prefs.setStringPref("zenai.skillsVersion", "3"); // no defaults written

  await zen.open();
  const input = $(".zai-input");
  const type = async (text) => {
    input.value = text;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(80);
  };
  const key = async (k) => {
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    await sleep(30);
  };
  // The skill rows (the "Open skills folder" footer looks like one, but isn't)
  const rows = () => $$(".zai-picker > .zai-pick .zai-pick-title").map((t) => t.textContent);
  const descs = () => $$(".zai-picker > .zai-pick .zai-pick-desc").map((d) => d.textContent);
  const groups = () => $$(".zai-picker .zai-pick-group").map((g) => g.textContent);
  // The menu top to bottom: "# heading" or "/skill"
  const menu = () => $$(".zai-picker > .zai-pick-group, .zai-picker > .zai-pick").map((el) => (el.classList.contains("zai-pick-group") ? "# " + el.textContent : el.querySelector(".zai-pick-title").textContent));

  await type("/");
  check("“/”: the built-in /create-skill, loose skills, then each folder under its name", menu().join(" | ") === "/create-skill | /summarize | /tldr | # School | /flashcards | /solve | # School / Chem | /balance | # Work | /reply", menu());
  check("headings aren't choices (no option role)", $$(".zai-picker .zai-pick-group").every((g) => g.getAttribute("role") === "presentation") && $$(".zai-picker [role=option]").length === 7);
  check("_folders are skipped", !rows().includes("/wip"));
  const sum = $$(".zai-picker > .zai-pick").find((b) => b.querySelector(".zai-pick-title").textContent === "/summarize");
  check("two files named /summarize: flagged on the one that's used", /Same name as Work\/summarize\.md, which isn't used\. Rename one\./.test(sum.querySelector(".zai-pick-note").textContent) && /Summarize this page/.test(sum.textContent), sum.textContent);
  check("with nothing typed, rows don't repeat the folder", descs().length === 7 && !descs().some((d) => /^School ·/.test(d)), descs());
  check("the footer says folders group skills", /folders group them/.test($(".zai-pick-footer").textContent), $(".zai-pick-footer").textContent);

  // Arrow keys move between skills, skipping the headings
  await key("ArrowDown");
  await key("ArrowDown");
  await key("ArrowDown");
  check("arrow keys skip headings (tldr → flashcards)", $(".zai-picker .zai-pick.zai-active .zai-pick-title").textContent === "/flashcards");

  // Typing: a flat list across folders, each row naming its folder
  await type("/sch");
  check("typing a folder's name finds its skills, folders in folders too", rows().join(",") === "/flashcards,/solve,/balance" && !groups().length, rows());
  check("...and each row says which folder", descs().join(" | ") === "School · Make flashcards | School · Solve the math problem | School / Chem · Balance an equation", descs());
  await type("/bal");
  check("typing a name finds it inside a folder", rows().join(",") === "/balance");
  await key("Enter");
  check("choosing it gives the usual pill, named just “balance”", $(".zai-pill") && $(".zai-pill").textContent === "balance" && $(".zai-picker").hidden, $(".zai-pill") && $(".zai-pill").textContent);
  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  done();
})().catch(crash);
