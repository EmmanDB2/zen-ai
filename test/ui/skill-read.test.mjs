// A big skill using smaller ones: access: can name other skills. Claude gets
// their names and descriptions (not their text) and reads one with read_skill
// when it needs it. Only skills the skill that ran lists; the smaller skill's
// own access: files don't come along; a data file with the same name wins
// unless it's written /name; a name that's nothing gets a line in the chat.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const DIR = "/profile/chrome/zenai-skills";
const sk = (name, desc, extra = "") => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\nBODY-OF-${name}`;
const FILES = {
  "big.md": sk("big", "The big runner", "lessons: true\naccess:\n  - solve\n  - /notes\n  - about-me\n  - /ghost\n  - big\n"),
  "School/solve.md": sk("solve", "Solve a math problem", "access:\n  - about-me\n"),
  "notes.md": sk("notes", "Take notes"),
  "other.md": sk("other", "Not listed"),
  "mixed.md": sk("mixed", "Plain name, with a data file too", "access:\n  - notes\n"),
  "_about-me.md": "# About me\nName: ABOUT-ME-TEXT\n",
  "_notes.md": "NOTES-DATA-TEXT\n",
};

(async () => {
  const zen = await fakeZen({ holdReplies: true });
  const { w, $, $$ } = zen;
  const paths = new Map(Object.entries(FILES).map(([k, v]) => [`${DIR}/${k}`, v]));
  const io = w.IOUtils;
  const { getChildren, readUTF8, exists } = io;
  const kids = (d) => [...new Set([...paths.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))];
  io.getChildren = async (d) => (d.startsWith(DIR) ? kids(d) : getChildren(d));
  io.readUTF8 = async (p) => { if (paths.has(p)) return paths.get(p); if (p.startsWith(DIR)) throw new Error("not found"); return readUTF8(p); };
  io.exists = async (p) => (p.startsWith(DIR) ? p === DIR || paths.has(p) || kids(p).length > 0 : exists(p));
  io.stat = async (p) => ({ type: kids(p).length ? "directory" : "regular" });
  w.Services.prefs.setStringPref("zenai.skillsVersion", "3");

  await zen.open();
  const input = $(".zai-input");
  const run = async (name) => {
    input.value = "/" + name;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(80);
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(30);
    await zen.send("", { wait: false });
    await sleep(120);
    return zen.sent[zen.sent.length - 1].text;
  };
  const read = async (name) => {
    const perm = await zen.askPermission("mcp__zenai__read_skill", { name });
    const res = await zen.callTool("read_skill", perm.updatedInput);
    return { perm, error: !!res.isError, text: (res.content || []).map((c) => c.text || "").join("") };
  };
  const lines = () => $$(".zai-thread .zai-toolline").map((l) => l.textContent).join(" | ");

  const sent = await run("big");
  check("Claude gets the listed skills' names and descriptions", /<available_skills [^>]*>\n/.test(sent) && sent.includes("- /solve: Solve a math problem") && sent.includes("- /notes: Take notes") && !sent.includes("- /other"), sent.slice(0, 500));
  check("...not their text", !/BODY-OF-(solve|notes)/.test(sent) && sent.includes("BODY-OF-big"));
  check("data files still go as before", sent.includes('<data_file name="_about-me.md"') && sent.includes("ABOUT-ME-TEXT"));
  check("a skill gets no New info note (only data files do)", !/new_info_instructions file="_(solve|notes)\.md"/.test(sent) && sent.includes('new_info_instructions file="_about-me.md"'));
  check("a /name that's no skill gets a line in the chat", /\/big lists \/ghost under access:, but there's no skill by that name/.test(lines()), lines());
  check("a skill listing itself is ignored", !/- \/big/.test(sent));

  let r = await read("solve");
  check("read_skill: no card, the listed skill's text", r.perm.behavior === "allow" && !$(".zai-approval") && !r.error && r.text.includes("BODY-OF-solve"), r);
  check("...with a line in the chat saying so", /Read the \/solve skill/.test(lines()), lines());
  check("...its own access: file doesn't come along", !r.text.includes("ABOUT-ME-TEXT"));
  r = await read("/notes");
  check("“/notes” works too", !r.error && r.text.includes("BODY-OF-notes"), r);
  r = await read("other");
  check("a skill that isn't listed is refused", r.error && /\/other isn't available here/.test(r.text) && !r.text.includes("BODY-OF-other"), r);
  r = await read("big");
  check("so is the skill itself (it already has it)", r.error, r);
  r = await read("../_about-me");
  check("names can't reach anything else", r.error && !r.text.includes("ABOUT-ME-TEXT"), r);

  // A plain name that's both: the data file wins
  await zen.finishReplies();
  zen.newChat();
  await sleep(40);
  const mixed = await run("mixed");
  check("a plain name that's a skill and a data file: the data file", mixed.includes('<data_file name="_notes.md"') && !mixed.includes("available_skills"), mixed.slice(0, 300));
  r = await read("solve");
  check("a new chat with another skill can't read the first one's list", r.error, r);

  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  done();
})().catch(crash);
