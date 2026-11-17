// /create-skill in real Zen: the built-in in the "/" menu; with a
// description, Claude's create_skill shows a "New skill" card filled in with
// its suggestions; the user changes the folder (a new one), adds a skill,
// ticks lessons, picks agents and edits the instructions; the file's header
// comes from the card only. Updating (and moving) the skill this chat made,
// a taken name, Cancel, Stop, and /create-skill sent empty (a blank card,
// no request to Claude).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ holdReplies: true });
  const skillsDir = join(zen.profile, "chrome", "zenai-skills");
  // Picks /create-skill from the "/" menu; → its note
  const pick = () => zen.chrome(async () => {
    const input = document.querySelector(".zai-input");
    input.value = "/create";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 40 && ![...document.querySelectorAll(".zai-pick-title")].some((e) => e.textContent === "/create-skill"); i++) await new Promise((r) => setTimeout(r, 50));
    const row = [...document.querySelectorAll(".zai-pick")].find((b) => b.querySelector(".zai-pick-title")?.textContent === "/create-skill");
    const note = row.querySelector(".zai-pick-note")?.textContent || "";
    row.click();
    return { note, panel: !!document.querySelector(".zai-skill-panel"), placeholder: input.placeholder, pill: document.querySelector(".zai-pill")?.textContent };
  });
  const waitCard = (what = "the New skill card") => zen.until(() => zen.chrome(() => !!document.querySelector(".zai-skill-card:not(.zai-decided) .zai-allow")), 8000, what);
  // Runs fn(card) in the newest open card (chrome code can't eval, so the
  // command's source is put together here; zen.chrome writes fn's text to a file)
  const inCard = (fn) => zen.chrome({
    toString: () => `async () => (${fn.toString()})([...document.querySelectorAll(".zai-skill-card:not(.zai-decided)")].pop())`,
  });
  try {
    await zen.open();
    const picked = await pick();
    check("/create-skill is in the / menu, built in, with no settings panel", picked.note === "Built in" && !picked.panel && picked.pill === "create-skill" && /What should the skill do/.test(picked.placeholder), picked);

    await zen.send("Summarize a lab handout into a checklist", { wait: false });
    const msg = zen.sent.at(-1).text;
    check("the message: the guide, the skills folder, the request", msg.includes("# Skill creator") && msg.includes("<skills_folder") && msg.includes("What the new skill should do: Summarize a lab handout into a checklist") && !msg.includes("already chose"), msg.slice(-500));

    // Claude's suggestions on the card
    const args = {
      name: "Lab Checklist", description: "Turn a lab handout into a checklist", folder: "",
      sees: ["page", "bogus"], uses: ["about-me", "/no-such-skill", "_nope.md"], lessons: false, agents: 0,
      instructions: "---\nname: evil\nagents: 2\naccess:\n  - secrets\n---\n# Lab checklist\n- Read the handout.",
    };
    let call = zen.callTool("create_skill", args);
    await waitCard();
    const card = await inCard((c) => ({
      sub: c.querySelector(".zai-approval-sub").textContent,
      name: c.querySelector(".zai-sf-input").value,
      desc: c.querySelector(".zai-sf-desc").value,
      folder: c.querySelector(".zai-sf-select").textContent,
      on: [...c.querySelectorAll(".zai-sf-opt.zai-on")].map((b) => b.textContent),
      boxes: [...c.querySelectorAll(".zai-sf-checklabel")].map((l) => `${l.textContent}:${l.querySelector("input").checked}`),
      instructions: c.querySelector(".zai-sf-instructions").value,
      open: c.querySelector(".zai-sf-preview").open,
    }));
    check("the card: filled in by Claude", card.sub === "Claude chose suggested settings" && card.name === "lab-checklist" && card.desc === "Turn a lab handout into a checklist" && card.folder === "Top of the skills folder", card);
    check("...sees and agents as buttons, uses and lessons as checkboxes, unknown ones dropped", JSON.stringify(card.on) === '["Page text","None"]' && JSON.stringify(card.boxes) === '["About me:true","Saved logins:false","Learn from each run (lessons):false"]', card);
    check("...the instructions (closed, editable) without Claude's header", !card.open && card.instructions.startsWith("# Lab checklist") && !card.instructions.includes("evil"), card.instructions);

    // The user: a new folder, + Add skill, lessons, 2 agents, an extra line
    await inCard(async (c) => {
      const wait = () => new Promise((r) => setTimeout(r, 60));
      c.querySelector(".zai-sf-select").click(); await wait();
      const field = c.querySelector(".zai-sf-menu .zai-sf-newfolder input");
      field.value = "School/Labs";
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await wait();
      c.querySelector(".zai-sf-add").click(); await wait();
      const search = c.querySelector(".zai-sf-menu input");
      search.value = "fil";
      search.dispatchEvent(new Event("input", { bubbles: true })); await wait();
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await wait();
      [...c.querySelectorAll(".zai-sf-checklabel")].find((l) => /lessons/.test(l.textContent)).querySelector("input").click(); await wait();
      [...c.querySelectorAll(".zai-sf-opt")].find((b) => b.textContent === "2").click(); await wait();
      const ta = c.querySelector(".zai-sf-instructions");
      ta.value += "\n- List each step.";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const edited = await inCard((c) => ({ folder: c.querySelector(".zai-sf-select").textContent, chips: [...c.querySelectorAll(".zai-sf-chip")].map((e) => e.textContent), menu: !!c.querySelector(".zai-sf-menu") }));
    check("folder menu: a new folder; + Add skill: a searched skill as a chip", edited.folder === "School / Labs" && JSON.stringify(edited.chips) === '["/fill"]' && !edited.menu, edited);
    await inCard((c) => c.querySelector(".zai-allow").click());
    let res = await call;
    const file = join(skillsDir, "School", "Labs", "lab-checklist.md");
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    check("saved in the new folder; Claude hears every change", /Created \/lab-checklist \(School\/Labs\/lab-checklist\.md/.test(textOf(res)) && /The user changed: folder → School \/ Labs; uses → about-me, \/fill; lessons → on; agents → 2; edited the instructions\./.test(textOf(res)), textOf(res));
    check("the file: header from the card, the edited instructions", text === "---\nname: lab-checklist\ndescription: Turn a lab handout into a checklist\ncontext: page\nlessons: true\nagents: 2\naccess:\n  - about-me\n  - /fill\n---\n\n# Lab checklist\n- Read the handout.\n- List each step.\n", text);
    const tray = await zen.chrome(() => [...document.querySelectorAll(".zai-files .zai-file-meta")].map((e) => e.textContent));
    check("a card for the skill at the end of the reply", tray.some((t) => /^Skill · \/lab-checklist · /.test(t)), tray);
    const summary = await zen.chrome(() => [...document.querySelectorAll(".zai-skill-card .zai-sf-summary")].pop()?.textContent);
    check("the decided card shrinks to one line", summary === "/lab-checklist · in School / Labs · sees page text · uses about me, /fill · lessons on · 2 agents", summary);

    // Again: an update keeps its folder; moving it leaves no copy behind
    call = zen.callTool("create_skill", { ...args, name: "lab-checklist", instructions: "# Lab checklist v2" });
    await waitCard("the update card");
    const upd = await inCard(async (c) => {
      const out = { t: c.querySelector(".zai-approval-title").textContent, folder: c.querySelector(".zai-sf-select").textContent };
      c.querySelector(".zai-sf-select").click();
      await new Promise((r) => setTimeout(r, 60));
      [...c.querySelectorAll(".zai-sf-item")].find((b) => b.textContent === "Top of the skills folder").click();
      await new Promise((r) => setTimeout(r, 60));
      c.querySelector(".zai-allow").click();
      return out;
    });
    res = await call;
    const backups = existsSync(join(skillsDir, "_backups")) ? readdirSync(join(skillsDir, "_backups")) : [];
    check("an update starts in the skill's folder", upd.t === "Update /lab-checklist" && upd.folder === "School / Labs", upd);
    check("...moved to the top: one file, the old one in _backups", /^Updated/.test(textOf(res)) && existsSync(join(skillsDir, "lab-checklist.md")) && !existsSync(file) && backups.some((b) => b.startsWith("School__Labs__lab-checklist.")), { res: textOf(res), backups });

    // A taken name: Create is off until it's renamed; Cancel tells Claude
    call = zen.callTool("create_skill", { ...args, name: "fill" });
    await waitCard();
    const taken = await inCard((c) => {
      const out = { disabled: c.querySelector(".zai-allow").disabled, why: c.querySelector(".zai-sf-check").textContent };
      c.querySelector(".zai-deny").click();
      return out;
    });
    res = await call;
    check("a taken name: Create is off, with why", taken.disabled && /There's already a \/fill skill/.test(taken.why), taken);
    check("Cancel: nothing saved, Claude is told", /The user cancelled/.test(textOf(res)));

    // Stop while the card waits: it's cancelled
    call = zen.callTool("create_skill", { ...args, name: "another-one" });
    await waitCard();
    await zen.chrome(() => document.querySelector(".zai-send.zai-stop").click());
    res = await Promise.race([call, sleep(5000).then(() => null)]);
    check("Stop cancels a waiting card", res && /cancelled/.test(textOf(res)) && !existsSync(join(skillsDir, "another-one.md")), res && textOf(res));
    await zen.idle();

    // /create-skill sent empty: a blank card right away, nothing sent to Claude
    const before = zen.sent.length;
    await pick();
    await zen.chrome(() => document.querySelector(".zai-send").click());
    await waitCard("the blank card");
    const blank = await inCard((c) => ({ sub: c.querySelector(".zai-approval-sub").textContent, name: c.querySelector(".zai-sf-input").value, open: c.querySelector(".zai-sf-preview").open, disabled: c.querySelector(".zai-allow").disabled, why: c.querySelector(".zai-sf-check").textContent }));
    check("empty /create-skill: a blank card, instructions open, no request to Claude", zen.sent.length === before && blank.sub === "Write your new skill" && blank.name === "" && blank.open && blank.disabled && blank.why === "Give it a name.", blank);
    await inCard(async (c) => {
      const set = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set(c.querySelector(".zai-sf-input"), "My Quick Note");
      set(c.querySelector(".zai-sf-desc"), "Rewrite the selection as a short note");
      set(c.querySelector(".zai-sf-instructions"), "Rewrite the selected text as a two-line note.");
      [...c.querySelectorAll(".zai-sf-opt")].find((b) => b.textContent === "Selection").click();
      await new Promise((r) => setTimeout(r, 60));
      c.querySelector(".zai-allow").click();
    });
    await zen.until(() => existsSync(join(skillsDir, "my-quick-note.md")), 5000, "the blank card's skill");
    check("...saved from what the user wrote", readFileSync(join(skillsDir, "my-quick-note.md"), "utf8") === "---\nname: my-quick-note\ndescription: Rewrite the selection as a short note\ncontext: selection\n---\n\nRewrite the selected text as a two-line note.\n");
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
