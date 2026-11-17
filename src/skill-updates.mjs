import { DEFAULT_UPDATER_RULES, UPDATER_RULES_FILE, UPDATER_SYSTEM_PROMPT, UPDATER_TIMEOUT_MS, UPDATE_DEFAULTS, prefs } from "./config.mjs";
import { h, icon, modelInfo } from "./dom.mjs";
import { acceptBlocks, applyEdits, changesLabel, checkUpdate, diffHunks, findUpdateBlocks, lineDiff, parseUpdaterReply, updaterPrompt } from "./lessons.mjs";
import { loadSkills, readSkillFile, restoreBackup, secretValues, skillsDir, writeSkillFile } from "./skills.mjs";
import { claudeCommand, runClaudeOnce } from "./session.mjs";

// ---------------------------------------------------------------------------
// The skill-update card under a reply: a run's Lessons (or New info) →
// Merge → the updater drafts edits → checks → review with a diff → Save
// (with a backup) → Undo. Nothing is written without the user's click.
// One card per file. The card's state lives in a saved "update" block.
// ---------------------------------------------------------------------------

export const updatesOn = () => prefs.get("updates.offer", "true") !== "false";
export const updaterModel = () => prefs.get("updates.model", UPDATE_DEFAULTS.model);
export const updaterEffort = () => prefs.get("updates.effort", UPDATE_DEFAULTS.effort);
export const backupsToKeep = () => Math.max(1, Math.min(50, parseInt(prefs.get("updates.backups", String(UPDATE_DEFAULTS.backups)), 10) || UPDATE_DEFAULTS.backups));

// A short fingerprint of a file's text (to tell if it changed since)
export function textHash(s) {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h1.toString(16) + ":" + s.length;
}

// _updater.md: the user's rules (written with the defaults the first time)
export async function updaterRules() {
  const path = PathUtils.join(skillsDir(), UPDATER_RULES_FILE);
  try {
    if (await IOUtils.exists(path)) return (await IOUtils.readUTF8(path)).trim();
    await IOUtils.makeDirectory(skillsDir(), { ignoreExisting: true });
    await IOUtils.writeUTF8(path, DEFAULT_UPDATER_RULES);
  } catch (e) {}
  return DEFAULT_UPDATER_RULES.trim();
}

// The reply's update sections for the skill that ran: blocks to save and
// show, plus lines about sections that were ignored
export function updateBlocksFor(replyText, skill) {
  const { accepted, refused } = acceptBlocks(findUpdateBlocks(replyText), skill);
  return {
    blocks: accepted.map((a) => ({ type: "update", kind: a.kind, skill: a.skill, from: a.from || "", file: a.file, run: a.run || "", text: a.text, state: "offered" })),
    ignored: refused.map((r) => `Ignored “${r.heading}”: ${r.why}.`),
  };
}

// ctx: { save(), models(), noteUsage(info), scroll(), aiName? }
export function updateCard(block, ctx) {
  const card = h("div", { class: "zai-approval zai-update", role: "group" });
  let job = null;
  let draft = null;
  let stopAsked = false;

  const modelName = () => {
    const value = updaterModel();
    const m = (ctx.models() || []).find((x) => x.value === value);
    return m ? modelInfo(m).name : value.charAt(0).toUpperCase() + value.slice(1);
  };
  const title = block.kind === "lessons" ? `/${block.skill}: lessons from this ${block.from ? `/${block.from} ` : ""}run` : `${block.file}: new info from /${block.skill}`;
  const where = block.kind === "lessons" ? `${block.file}${block.run ? ` · ${block.run}` : ""}` : block.file;
  card.setAttribute("aria-label", title);

  const head = () => h("div", { class: "zai-approval-head" },
    h("span", { class: "zai-approval-icon" }, icon(block.kind === "lessons" ? "spark" : "edit", 15, 2)),
    h("span", { class: "zai-approval-text" },
      h("span", { class: "zai-approval-title", text: title }),
      h("span", { class: "zai-approval-sub", text: where, title: where })
    )
  );
  const actions = (...buttons) => h("div", { class: "zai-approval-actions" }, ...buttons);
  const button = (label, cls, onclick, tip) => h("button", { class: cls, onclick, ...(tip ? { "data-tip": tip } : {}) }, label);
  const note = (text, cls = "") => h("div", { class: "zai-update-note" + (cls ? " " + cls : ""), text });
  const list = (label, items, cls) => (items.length ? h("div", { class: "zai-update-list " + cls },
    h("div", { class: "zai-update-list-title", text: label }),
    h("ul", {}, ...items.map((t) => h("li", { text: t })))) : null);
  const show = (...kids) => {
    card.classList.remove("zai-update-safety", "zai-update-compact");
    card.replaceChildren(head(), ...kids.filter(Boolean));
    ctx.scroll();
  };
  const setState = (state, extra = {}) => {
    Object.assign(block, { state }, extra);
    ctx.save();
  };

  function offered() {
    const mergeButton = button("Merge", "zai-allow", merge);
    show(
      note(block.kind === "lessons"
        ? `${ctx.aiName || "Claude"} listed what went wrong in this run. ${modelName()} can merge it into the skill; you see every change before anything is saved.`
        : `${ctx.aiName || "Claude"} found new details for ${block.file}. ${modelName()} can add them; you see every change before anything is saved.`),
      actions(
        button("Skip", "zai-deny", () => { setState("skipped"); skipped(); }),
        mergeButton,
      )
    );
    claudeCommand().then((path) => IOUtils.exists(path)).catch(() => false).then((available) => {
      if (!available) {
        mergeButton.textContent = "Merge requires Claude Code";
        mergeButton.setAttribute("data-tip", "Set Claude Code's location in Zen's settings → Zen AI.");
      }
    });
  }

  function skipped() {
    show(note("Skipped. Nothing was changed."), actions(button("Merge anyway", "zai-deny", merge)));
  }

  function failed(why) {
    show(note(why, "zai-update-bad"), actions(button("Skip", "zai-deny", () => { setState("skipped"); skipped(); }), button("Try again", "zai-allow", merge)));
  }

  async function merge() {
    const status = h("div", { class: "zai-toolline zai-waiting" }, icon("spark", 14, 2.2), h("span", { text: `${modelName()} is merging it into ${block.file}…` }));
    stopAsked = false;
    show(status, actions(button("Stop", "zai-deny", () => { stopAsked = true; if (job) job.cancel(); })));
    const stillOn = () => { if (stopAsked) throw new Error("Stopped."); };
    try {
      if (!(await IOUtils.exists(await claudeCommand()))) throw new Error("Skill merging requires Claude Code. Set its location in Zen's settings → Zen AI.");
      // The skill as it is now (it may have moved or changed since the run)
      let file = block.file;
      if (block.kind === "lessons") {
        const all = await loadSkills();
        const skill = all.find((s) => s.name === block.skill);
        if (!skill) throw new Error(`There's no /${block.skill} skill any more.`);
        if (block.from) {
          const ran = all.find((s) => s.name === block.from);
          if (!ran || !ran.accessSkills.includes(block.skill)) throw new Error(`/${block.from} doesn't list /${block.skill} under access: any more.`);
        } else if (!skill.lessons) throw new Error(`/${block.skill} doesn't have lessons: true any more.`);
        file = skill.file;
      } else {
        const skill = (await loadSkills()).find((s) => s.name === block.skill);
        const name = block.file.replace(/^_/, "").replace(/\.md$/, "");
        if (!skill || !skill.access.includes(name)) throw new Error(`/${block.skill} doesn't list ${name} under access: any more.`);
      }
      const before = await readSkillFile(file);
      const rules = await updaterRules();
      stillOn();
      job = runClaudeOnce({
        system: UPDATER_SYSTEM_PROMPT,
        prompt: updaterPrompt({ rules, file, kind: block.kind, text: before, blockText: block.text, skill: block.skill, run: block.run, from: block.from }),
        model: updaterModel(),
        effort: updaterEffort(),
        timeoutMs: UPDATER_TIMEOUT_MS,
        onRateLimit: ctx.noteUsage,
      });
      const reply = await job.done;
      job = null;
      stillOn();
      const out = parseUpdaterReply(reply);
      const applied = applyEdits(before, out.edits);
      const checks = checkUpdate({ before, after: applied.text, kind: block.kind, spans: applied.spans, edits: out.edits, secrets: await secretValues() });
      draft = { file, before, after: applied.text, out, problems: applied.problems, checks };
      review();
    } catch (e) {
      const stopped = /^Stopped/.test(e && e.message);
      job = null;
      if (stopped) offered();
      else failed(`Couldn't make the update: ${(e && e.message) || e}`);
    }
  }

  function diffView(before, after) {
    const rows = diffHunks(lineDiff(before, after), 2).map((d) => d.type === "gap"
      ? h("div", { class: "zai-diff-gap", text: `⋯ ${d.count} unchanged line${d.count === 1 ? "" : "s"}` })
      : h("div", { class: "zai-diff-" + d.type }, h("span", { class: "zai-diff-sign", text: d.type === "add" ? "+" : d.type === "del" ? "−" : " " }), h("span", { text: d.text || " " })));
    return h("div", { class: "zai-diff", role: "region", "aria-label": "Changes" }, ...rows);
  }

  function review() {
    const { out, problems, checks, before, after } = draft;
    const lists = [
      list("Changed", out.changed, "zai-update-changed"),
      list("Already covered", out.covered, "zai-update-covered"),
      list("Not applied, unclear", out.unclear, "zai-update-unclear"),
    ];
    if (problems.length || checks.refuse.length) {
      show(note("This draft can't be saved:", "zai-update-bad"), list("", [...problems, ...checks.refuse], "zai-update-problems"), ...lists,
        actions(button("Skip", "zai-deny", () => { setState("skipped"); skipped(); }), button("Try again", "zai-allow", merge)));
      return;
    }
    if (after === before) {
      show(note(`Nothing to change in ${draft.file}.`), ...lists, actions(button("OK", "zai-allow", () => { setState("nochange"); done(); })));
      return;
    }
    const diff = diffView(before, after);
    diff.hidden = true;
    const toggle = button("Show changes", "zai-update-toggle", () => {
      diff.hidden = !diff.hidden;
      toggle.textContent = diff.hidden ? "Show changes" : "Hide changes";
      toggle.setAttribute("aria-expanded", String(!diff.hidden));
    });
    toggle.setAttribute("aria-expanded", "false");
    const safety = checks.safety.length ? h("div", { class: "zai-approval-warn" }, icon("shield", 14, 2),
      h("span", { text: `This changes a safety rule: ${checks.safety.map((s) => `“${s}”`).join(", ")}. Read the changes before saving.` })) : null;
    const flags = checks.flags.length ? list("Check", checks.flags, "zai-update-flags") : null;
    const discard = button("Discard", "zai-deny", () => { draft = null; setState("skipped"); skipped(); });
    const saveBtn = button(checks.safety.length ? "Save…" : "Save", "zai-allow" + (checks.safety.length ? " zai-risky" : ""), () => {
      if (!checks.safety.length) return save();
      // A second, explicit click for a safety change
      const confirm = actions(
        button("Cancel", "zai-deny", () => confirm.replaceWith(row)),
        button(`Save, including the change to ${checks.safety.map((s) => `“${s}”`).join(", ")}`, "zai-allow zai-risky", save),
      );
      row.replaceWith(confirm);
    });
    const row = actions(discard, saveBtn);
    show(safety, ...lists, flags, h("div", { class: "zai-update-diffbar" }, toggle), diff, row);
    if (checks.safety.length) card.classList.add("zai-update-safety");
  }

  async function save() {
    const { file, before, after, out } = draft;
    try {
      if ((await readSkillFile(file)) !== before) {
        show(note(`${file} changed since this draft was made, so it wasn't saved.`, "zai-update-bad"), actions(button("Skip", "zai-deny", () => { setState("skipped"); skipped(); }), button("Redo", "zai-allow", merge)));
        return;
      }
      const backup = await writeSkillFile(file, after, backupsToKeep());
      const count = Math.max(out.changed.length, out.edits.length);
      setState("saved", { savedFile: file, backup, hash: textHash(after), summary: out.changed.slice(0, 20), count });
      draft = null;
      done();
    } catch (e) {
      failed(`Couldn't save ${file}: ${(e && e.message) || e}`);
    }
  }

  async function undo() {
    try {
      const now = await readSkillFile(block.savedFile);
      if (textHash(now) !== block.hash) {
        show(note(`${block.savedFile} changed after this update, so Undo would lose those changes. Its backup is in _backups/.`, "zai-update-bad"));
        return;
      }
      if (block.backup) await restoreBackup(block.savedFile, block.backup);
      setState("undone");
      done();
    } catch (e) {
      show(note(`Couldn't undo: ${(e && e.message) || e}`, "zai-update-bad"));
    }
  }

  // Finished: one compact line (saved, undone, skipped or nothing to change)
  function done() {
    card.classList.remove("zai-update-safety");
    if (block.state === "saved") {
      card.replaceChildren(
        h("div", { class: "zai-update-done" }, icon("check", 14, 2.2),
          h("span", { text: `Updated ${block.savedFile} · ${changesLabel(block.count || 1)}` }),
          block.backup ? h("button", { class: "zai-update-undo", onclick: undo, "data-tip": "Put the file back the way it was" }, "Undo") : null),
        block.summary && block.summary.length ? h("ul", { class: "zai-update-summary" }, ...block.summary.map((t) => h("li", { text: t }))) : null,
      );
    } else if (block.state === "undone") {
      card.replaceChildren(h("div", { class: "zai-update-done" }, icon("check", 14, 2.2), h("span", { text: `Undone: ${block.savedFile} is back to how it was` })));
    } else if (block.state === "nochange") {
      card.replaceChildren(h("div", { class: "zai-update-done" }, icon("check", 14, 2.2), h("span", { text: `Nothing to change in ${block.file}` })));
    }
    card.classList.add("zai-update-compact");
    ctx.scroll();
  }

  if (block.state === "skipped") skipped();
  else if (["saved", "undone", "nochange"].includes(block.state)) done();
  else offered();
  return card;
}
