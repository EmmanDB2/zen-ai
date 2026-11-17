// The skills folder: defaults written once, new defaults added once to old
// folders, user deletions respected, _about-me.md detection. Plus small helpers.
import "../helpers/firefox.mjs";
import { checker, crash } from "../helpers/common.mjs";
import { prefs as prefStore } from "../helpers/firefox.mjs";
import { loadSkills, readAboutMe, parseSkill, findSensitiveNumbers, parseSecrets, secretSiteOk, skillSlug, folderParts, skillFileText, cleanSkillBody } from "../../src/skills.mjs";
import { DEFAULT_SKILLS } from "../../src/config.mjs";
import { modelInfo } from "../../src/dom.mjs";
import { refRanges } from "../../src/browser-agent.mjs";

const { check, done } = checker();

// An in-memory skills folder
async function run(files, version) {
  const store = new Map(Object.entries(files).map(([k, v]) => ["/p/chrome/zenai-skills/" + k, v]));
  if (version) prefStore.set("zenai.skillsVersion", version); else prefStore.delete("zenai.skillsVersion");
  const existed = Object.keys(files).length > 0 || version;
  globalThis.PathUtils = { join: (...a) => a.join("/"), filename: (p) => p.split("/").pop(), profileDir: "/p" };
  globalThis.IOUtils = {
    exists: async (p) => (p === "/p/chrome/zenai-skills" ? !!existed : store.has(p)),
    makeDirectory: async () => {},
    writeUTF8: async (p, t) => store.set(p, t),
    readUTF8: async (p) => { if (!store.has(p)) throw new Error("not found"); return store.get(p); },
    // Direct children only (files, and folders implied by deeper files)
    getChildren: async (d) => [...new Set([...store.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))],
    stat: async (p) => ({ type: [...store.keys()].some((k) => k.startsWith(p + "/")) ? "directory" : "regular" }),
  };
  const skills = await loadSkills();
  return {
    files: [...store.keys()].map((k) => k.split("/").pop()).sort().join(","),
    skills: skills.map((s) => s.name).join(","),
    list: skills,
    version: prefStore.get("zenai.skillsVersion"),
    aboutMe: await readAboutMe(),
  };
}

(async () => {
  let r = await run({});
  check("new install gets every default", r.files === "_about-me.md,compare-sources.md,explain.md,fill.md,reply.md,solve.md,summarize.md,tldr.md" && r.skills === "compare-sources,explain,fill,reply,solve,summarize,tldr" && r.version === "3", r);
  check("blank about-me doesn't count as filled", r.aboutMe === null);
  r = await run({ "solve.md": "custom solve", "mine.md": "---\nname: mine\n---\nhi" });
  check("old folder: only the newly added defaults, nothing overwritten", r.files === "_about-me.md,compare-sources.md,fill.md,mine.md,solve.md" && r.skills === "compare-sources,fill,mine,solve", r);
  r = await run({ "solve.md": "x" }, "3");
  check("up-to-date folder: a deleted default stays deleted", r.files === "solve.md", r);
  r = await run({ "solve.md": "x" }, "2");
  check("a version-2 folder gets only the agents example", r.files === "compare-sources.md,solve.md" && r.version === "3", r);
  r = await run({ "_about-me.md": "# About me\nName: Alex Kim\nEmail:\n" }, "3");
  check("filled about-me is read, and isn't a skill", r.aboutMe === "# About me\nName: Alex Kim\nEmail:" && r.skills === "", r);

  // Folders: grouped, in order, commands unchanged, clashes noted
  const sk = (name, desc = "") => `---\nname: ${name}\ndescription: ${desc}\n---\nDo ${name}.`;
  r = await run({
    "summarize.md": sk("summarize", "Summarize this page"),
    "Work/reply.md": sk("reply"),
    "Work/summarize.md": sk("summarize", "Work version"),
    "school/solve.md": sk("solve"),
    "school/Chem/balance.md": sk("balance"),
    "school/Chem/Labs/Week 2/deep.md": sk("deep"),
    "school/10 drill.md": sk("drill"),
    "school/2 flash.md": sk("flash"),
    "_drafts/wip.md": sk("wip"),
    ".git/hooks.md": sk("hooks"),
    "school/_old.md": sk("old"),
  }, "3");
  check("folders: loose skills first, then each folder A–Z (any case, numbers in order), folders in folders after", r.skills === "summarize,flash,drill,solve,balance,reply", r.skills);
  const by = Object.fromEntries(r.list.map((x) => [x.name, x]));
  check("folders: each skill knows its folder and file", by.summarize.folder === "" && by.solve.folder === "school" && by.balance.folder === "school / Chem" && by.balance.file === "school/Chem/balance.md", r.list.map((x) => [x.name, x.folder, x.file]));
  check("folders: a command is the skill's name, wherever it lives", by.balance.body === "Do balance." && !r.list.some((x) => /\//.test(x.name)));
  check("folders: same name twice → the loose one wins, the other is noted", by.summarize.description === "Summarize this page" && by.summarize.clashes.join() === "Work/summarize.md", by.summarize);
  check("folders: _ and . folders and files are skipped", !/wip|hooks|old/.test(r.skills));
  check("folders: only 3 levels deep", !by.deep, r.skills);

  // agents: N (helper agents), checked strictly; anything odd means none
  const ag = (v) => parseSkill(`---\nname: big\n${v === undefined ? "" : `agents: ${v}\n`}---\nDo it.`, "big.md");
  check("agents: missing means none", ag().agents === 0 && ag().agentsError === "");
  check("agents: 1 and 2 are allowed", ag("1").agents === 1 && ag("2").agents === 2 && !ag("2").agentsError);
  check("agents: 0 means none, without a complaint", ag("0").agents === 0 && !ag("0").agentsError);
  for (const bad of ["3", "-1", "two", "1.5", "[2]", "yes"]) check(`agents: “${bad}” is refused with a reason`, ag(bad).agents === 0 && /isn't a whole number from 0 to 2/.test(ag(bad).agentsError), ag(bad));
  check("the example skill allows two agents", parseSkill(DEFAULT_SKILLS["compare-sources.md"], "compare-sources.md").agents === 2);
  check("no other default skill uses agents", Object.entries(DEFAULT_SKILLS).filter(([f]) => f !== "compare-sources.md" && !f.startsWith("_")).every(([f, t]) => parseSkill(t, f).agents === 0));

  const s = parseSkill("---\nname: Drill me\ndescription: Make flashcards\ncontext: page, selection\n---\nAsk me questions.", "drill.md");
  check("skill front matter", s && s.description === "Make flashcards" && s.context.join() === "page,selection" && s.body === "Ask me questions.", s);

  // access: data files, as a list under the key (the format the skills use)
  const sch = parseSkill("---\nname: job-apps\ndescription: Apply\nlessons: true\naccess:\n  - about-me\n  - projects\n---\n# Runner\nDo it.\n\n## Final report\nList them.\n\n## Lessons (notes for this skill)\nUse the run's date as the run name.\n", "job-apps.md");
  check("access: a list under the key", sch.access.join() === "about-me,projects", sch.access);
  check("lessons: true", sch.lessons === true);
  check("the skill's own lesson notes come out of the body, kept for after the standard text", sch.lessonNotes === "Use the run's date as the run name." && sch.body === "# Runner\nDo it.\n\n## Final report\nList them.", sch);
  const mid = parseSkill("---\nname: x\nlessons: true\n---\nA\n## Lessons (notes for this skill)\nNote.\n## Reporting\nR", "x.md");
  check("lesson notes in the middle: only that section moves", mid.lessonNotes === "Note." && mid.body === "A\n## Reporting\nR", mid);
  const off = parseSkill("---\nname: y\n---\nA\n## Lessons (notes for this skill)\nNote.", "y.md");
  check("without lessons: true, the body is left alone", off.lessons === false && off.lessonNotes === "" && /## Lessons/.test(off.body), off);
  const inline = parseSkill("---\nname: z\nAccess: [about-me, _projects.md]\ncontext: page, me\n---\nZ", "z.md");
  check("inline access, any case, written-out file names; context: me means about-me", inline.access.join() === "about-me,projects" && inline.context.join() === "page", inline);
  const bad = parseSkill("---\nname: q\naccess:\n  - ../../etc/passwd\n  - Project Notes\n  - ok-file\n---\nQ", "q.md");
  check("only plain names are accepted (no paths)", bad.access.join() === "ok-file", bad.access);
  check("a list doesn't swallow the next key", parseSkill("---\nname: r\naccess:\n  - about-me\ndescription: After\n---\nR", "r.md").description === "After");
  const withSkills = parseSkill("---\nname: big\naccess:\n  - /Solve\n  - notes\n  - /big\n  - /../x\n---\nB", "big.md");
  check("access: /name is another skill (never itself); plain names wait for loadSkills", withSkills.accessSkills.join() === "solve,x" && withSkills.access.join() === "notes", withSkills);
  const fill = parseSkill(DEFAULT_SKILLS["fill.md"], "fill.md");
  check("the built-in /fill uses access: and names the file", fill.access.join() === "about-me" && fill.context.length === 0 && /`_about-me\.md`/.test(fill.body) && !/<about_me>/.test(fill.body), fill);

  // Numbers that never go to Claude as text
  const kinds = (t) => findSensitiveNumbers(t).map((f) => `${f.kind}@${f.line}`).join(",");
  check("a real card number (Luhn) is caught, with or without spaces", kinds("Card: 4111 1111 1111 1111\nOther: 4242424242424242") === "card number@1,card number@2");
  check("long numbers that fail the checksum aren't", kinds("Order 4111111111111112\nTracking 1Z999AA10123456784") === "");
  check("SSNs", kinds("SSN: 123-45-6789\nsocial security 123456789") === "Social Security number@1,Social Security number@2");
  check("bank numbers and IBANs", kinds("Routing number: 021000021\nIBAN GB82 WEST 1234 5698 7654 32") === "bank number@1,bank number@2");
  check("ordinary details aren't flagged", kinds("Phone: 555-123-4567\nZIP: 21801-1234\nGraduation: 2027-05-20\nStudent ID: 1234567\nGPA: 3.8\nAccounts created: 3\nApplied 2026-10-28") === "", kinds("Phone: 555-123-4567\nZIP: 21801-1234\nGraduation: 2027-05-20\nStudent ID: 1234567"));
  check("the About me template is clean", kinds(DEFAULT_SKILLS["_about-me.md"]) === "");

  // _secrets.md
  const sec = parseSecrets("# My secrets\n- Main password (shopmart.com, https://www.mailhub.org/login): hunter2:with:colons\n* SSN: 123-45-6789\n- Visa card: 4111 1111 1111 1111\n- Chase routing number (chase.com): 021000021\n- Empty one:\nnot a list line: x\n- main PASSWORD: duplicate\n");
  check("secrets: label, sites, value (colons in it kept)", sec[0].label === "Main password" && sec[0].sites.join() === "shopmart.com,mailhub.org" && sec[0].value === "hunter2:with:colons", sec[0]);
  check("secrets: kinds from the label", sec.map((x) => x.kind).join() === "password,ID number,payment card,bank account", sec.map((x) => [x.label, x.kind]));
  check("secrets: empty values, other lines and repeated labels are skipped", sec.length === 4);
  check("secrets: sites match with subdomains, nothing else", secretSiteOk(sec[0], "login.shopmart.com") && secretSiteOk(sec[0], "mailhub.org") && !secretSiteOk(sec[0], "shopmart.com.evil.net") && !secretSiteOk(sec[0], "notshopmart.com") && !secretSiteOk(sec[1], "anything.com"));

  const def = modelInfo({ value: "default", description: "Sonnet 5.5 · Efficient for routine tasks" });
  const fable = modelInfo({ value: "fable", displayName: "Fable", description: "Fable 5.1 · Most capable for hard tasks · Requires usage credits" });
  const bare = modelInfo({ value: "haiku", displayName: "Haiku", description: "" });
  check("model names from Claude Code's list", def.name === "Sonnet 5.5" && bare.name === "Haiku", [def, bare]);
  check("a model's catch is never cut off", fable.blurb.startsWith("Requires usage credits"), fable.blurb);
  check("ref ranges", refRanges(["e3", "e4", "e5", "e9", "e11", "e12"]) === "e3–e5, e9, e11–e12");

  // Making a skill (create_skill): names, folders, the header from the card's settings
  check("skill names", skillSlug("Lab Report!") === "lab-report" && skillSlug("  my_cool  skill ") === "my-cool-skill" && skillSlug("---") === "");
  check("folders", JSON.stringify(folderParts("Home / Recipes")) === '["Home","Recipes"]' && JSON.stringify(folderParts("")) === "[]" && folderParts("../x") === null && folderParts("_backups") === null && folderParts("a/b/c/d") === null);
  const made = skillFileText({ name: "lab-report", description: "Write a lab report\n---\nagents: 2", sees: ["page", "screenshot", "bogus"], uses: ["about-me", "secrets", "/in-my-voice"], lessons: true, agents: 2 }, "# Lab report\n\nDo it.\n\n## Lessons (notes for this skill)\nKeep it short.");
  const back = parseSkill(made, "lab-report.md");
  check("a made skill reads back with exactly its settings", back.name === "lab-report" && back.description === "Write a lab report --- agents: 2" && JSON.stringify(back.context) === '["page","screenshot"]' && JSON.stringify(back.access) === '["about-me","secrets"]' && JSON.stringify(back.accessSkills) === '["in-my-voice"]' && back.lessons && back.agents === 2 && back.lessonNotes === "Keep it short.", back);
  const plain = parseSkill(skillFileText({ name: "tiny", description: "Tiny", sees: [], uses: [], lessons: false, agents: 0 }, "Just do it."), "tiny.md");
  check("...and a plain one has no extras", plain.context.length === 0 && plain.access.length === 0 && !plain.lessons && plain.agents === 0 && plain.body === "Just do it.");
  check("Claude's own header is dropped from the instructions", cleanSkillBody("---\nname: x\nagents: 2\n---\n# Body") === "# Body");
  const refuse = (t) => { try { cleanSkillBody(t); return ""; } catch (e) { return e.message; } };
  check("empty, huge, or with a card number: refused", /empty/.test(refuse("  ")) && /too long/.test(refuse("x".repeat(40001))) && /card, bank or ID number/.test(refuse("Pay with 4111 1111 1111 1111")));
  done();
})().catch(crash);
