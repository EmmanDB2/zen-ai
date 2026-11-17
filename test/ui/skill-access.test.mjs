// What a skill run sends Claude Code: its access: data files under their own
// names, the standard Lessons text (with the skill's own notes after it) and a
// New info note per file; a missing file, a blank About me, a file holding a
// card number (not sent, a line in the chat) and secrets (never sent as text).
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const DIR = "/profile/chrome/zenai-skills";
const FILES = {
  "job-apps.md": "---\nname: job-apps\ndescription: Apply for jobs\nlessons: true\naccess:\n  - about-me\n  - projects\n  - secrets\n---\n# Job applications runner\nUse `_about-me.md` for every field.\n\n## Lessons (notes for this skill)\nUse the run's date as the run name.\n",
  "plain.md": "---\nname: plain\ndescription: No extras\n---\nJust do it.",
  "cards.md": "---\nname: cards\ndescription: Reads a bad file\naccess:\n  - wallet\n---\nUse it.",
  "_about-me.md": "# About me\nName: Alex Kim\nCity: Springfield\n",
  "_wallet.md": "Card: 4111 1111 1111 1111\n",
  "_secrets.md": "- Main password (shop.example.com): hunter2\n",
};

(async () => {
  const zen = await fakeZen();
  const { w, $, $$ } = zen;
  const paths = new Map(Object.entries(FILES).map(([k, v]) => [`${DIR}/${k}`, v]));
  const io = w.IOUtils;
  const { getChildren, readUTF8 } = io;
  io.getChildren = async (d) => (d.startsWith(DIR) ? [...new Set([...paths.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))] : getChildren(d));
  io.readUTF8 = async (p) => { if (paths.has(p)) return paths.get(p); if (p.startsWith(DIR)) throw new Error("not found"); return readUTF8(p); };
  io.stat = async (p) => ({ type: [...paths.keys()].some((k) => k.startsWith(p + "/")) ? "directory" : "regular" });
  w.Services.prefs.setStringPref("zenai.skillsVersion", "3");

  await zen.open();
  const input = $(".zai-input");
  const run = async (name) => {
    input.value = "/" + name;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(80);
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(40);
    await zen.send("");
    return zen.sent[zen.sent.length - 1].text;
  };

  let sent = await run("job-apps");
  check("the data file goes under its own name", sent.includes('<data_file name="_about-me.md"') && sent.includes("Name: Alex Kim\nCity: Springfield"), sent.slice(0, 400));
  check("a listed file that doesn't exist yet is named as missing", sent.includes("(_projects.md doesn't exist yet or is empty.)"));
  check("_secrets.md is never sent as text", !sent.includes("hunter2") && !sent.includes('name="_secrets.md"') && !sent.includes("new_info_instructions file=\"_secrets.md\""));
  check("a New info note for each data file", sent.includes('<new_info_instructions file="_about-me.md">') && sent.includes('<new_info_instructions file="_projects.md">') && sent.includes("## New info for _about-me.md"));
  check("the standard Lessons text, with the skill's name", sent.includes("<lessons_instructions>") && sent.includes("`## Lessons for /job-apps (<run name>)`"));
  check("...followed by the skill's own notes", /Notes for this skill:\nUse the run's date as the run name\.\n<\/lessons_instructions>/.test(sent));
  check("the notes aren't also left in the skill text", (sent.match(/Use the run's date/g) || []).length === 1);
  check("order: data file, skill, New info notes, Lessons, then the run line", (() => {
    const at = (s) => sent.indexOf(s);
    return at("<data_file") < at("<skill ") && at("</skill>") < at("<new_info_instructions") && at("<new_info_instructions") < at("<lessons_instructions>") && at("</lessons_instructions>") < at('Run the "job-apps" skill.');
  })());
  check("no warning lines for clean files", !$$(".zai-toolline.zai-warned").length);

  zen.newChat();
  await sleep(30);
  sent = await run("plain");
  check("a skill without access: or lessons gets none of it", !/data_file|lessons_instructions|new_info_instructions/.test(sent));

  zen.newChat();
  await sleep(30);
  sent = await run("cards");
  check("a file with a card number isn't sent", !sent.includes("4111") && sent.includes("(_wallet.md wasn't shared with you because it seems to hold a card number."), sent.slice(0, 300));
  const warn = $$(".zai-toolline.zai-warned").map((l) => l.textContent).join(" | ");
  check("...and the chat says which file and line", /Didn't share _wallet\.md: line 1 looks like a card number/.test(warn), warn);

  // A blank About me (still the template): asked for, not sent
  paths.set(`${DIR}/_about-me.md`, "# About me (for /fill)\nName:\nEmail:\n");
  zen.newChat();
  await sleep(30);
  sent = await run("job-apps");
  check("a blank About me isn't sent; Claude is told to ask", !sent.includes('<data_file name="_about-me.md"') && sent.includes("(The user hasn't filled in _about-me.md yet."));

  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  done();
})().catch(crash);
