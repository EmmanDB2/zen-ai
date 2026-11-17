import { h, icon } from "./dom.mjs";
import { SKILL_SEES, folderParts, skillSlug } from "./skills.mjs";

// ---------------------------------------------------------------------------
// The "New skill" card (create_skill, or /create-skill sent empty): name,
// description, folder (a menu, with "New folder…"), what it sees, what it
// uses (checkboxes), other skills it may read (+ Add skill), lessons,
// helper agents, and the instructions (editable). What the user confirms
// here is what gets saved.
// ---------------------------------------------------------------------------
export const SKILL_SEE_LABELS = { page: "Page text", selection: "Selection", screenshot: "Screenshot" };

// opts: { values: { name, description, folder ("" = top, "Home / Recipes"),
//   sees, uses, lessons, agents, instructions }, folders, skills (names),
//   dataFiles (names), agentsOn, check(values) → "" or why Create is off,
//   onCheck(why), openInstructions }
export function createSkillForm(opts) {
  const v = { name: "", description: "", folder: "", sees: [], uses: [], lessons: false, agents: 0, instructions: "", ...(opts.values || {}) };
  v.sees = [...(v.sees || [])];
  v.uses = [...(v.uses || [])];
  let disabled = false;
  let openMenu = null; // { el, close }
  const changed = () => { render(); updateCheck(); };

  const input = (cls, value, attrs, onInput) => {
    const el = h("input", { class: "zai-sf-input " + cls, type: "text", spellcheck: "false", ...attrs });
    el.value = value || "";
    el.addEventListener("input", () => onInput(el));
    return el;
  };
  const nameInput = input("", v.name, { maxlength: "40", placeholder: "skill-name", "aria-label": "Skill name" }, (el) => { v.name = skillSlug(el.value); updateCheck(); });
  nameInput.addEventListener("blur", () => { nameInput.value = v.name; });
  const descInput = input("zai-sf-desc", v.description, { maxlength: "300", placeholder: "What it does, in one line", "aria-label": "Description", spellcheck: "true" }, (el) => { v.description = el.value; updateCheck(); });
  const instructions = h("textarea", { class: "zai-sf-instructions", rows: "8", spellcheck: "true", placeholder: "The skill's instructions, in Markdown: what to use, what to do, what to give back.", "aria-label": "Instructions" });
  instructions.value = v.instructions || "";
  const linesLabel = () => { const n = v.instructions.trim() ? v.instructions.trim().split("\n").length : 0; return n ? `Instructions (${n} line${n === 1 ? "" : "s"})` : "Instructions"; };
  const summary = h("summary", { text: linesLabel() });
  instructions.addEventListener("input", () => { v.instructions = instructions.value; updateCheck(); summary.textContent = linesLabel(); });
  const preview = h("details", { class: "zai-sf-preview" }, summary, instructions);
  if (opts.openInstructions) preview.open = true;

  const row = (label, ...controls) => h("div", { class: "zai-sf-row" }, h("span", { class: "zai-sf-label", text: label }), h("div", { class: "zai-sf-opts" }, ...controls));
  const toggle = (label, on, onClick, tip) => h("button", {
    class: "zai-sf-opt" + (on ? " zai-on" : ""), "aria-pressed": String(!!on), "data-tip": tip || null,
    onclick: (e) => { e.preventDefault(); if (!disabled) onClick(); },
  }, on ? icon("check", 12, 2.4) : null, h("span", { text: label }));
  const checkbox = (label, on, onChange, tip) => {
    const box = h("input", { type: "checkbox", class: "zai-sf-checkbox" });
    box.checked = !!on;
    box.addEventListener("change", () => { if (!disabled) onChange(box.checked); });
    return h("label", { class: "zai-sf-checklabel", "data-tip": tip || null }, box, h("span", { text: label }));
  };

  // A small menu under a button (folder, + Add skill); one open at a time
  function popMenu(anchor, build) {
    closeMenu();
    const el = h("div", { class: "zai-sf-menu", role: "menu" });
    const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
    const close = () => {
      el.remove();
      el.ownerDocument.removeEventListener("mousedown", outside, true);
      openMenu = null;
    };
    el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); anchor.focus(); } });
    build(el, close);
    anchor.parentNode.append(el);
    // No room below (the thread's bottom edge): open upward
    const box = el.closest(".zai-thread");
    if (box && el.getBoundingClientRect().bottom > box.getBoundingClientRect().bottom - 4) el.classList.add("zai-sf-up");
    el.ownerDocument.addEventListener("mousedown", outside, true);
    openMenu = { el, close };
    const first = el.querySelector("input, button");
    if (first) first.focus();
  }
  function closeMenu() { if (openMenu) openMenu.close(); }
  const menuItem = (label, onClick, o = {}) => h("button", {
    class: "zai-sf-item" + (o.on ? " zai-on" : ""), role: "menuitem",
    onclick: (e) => { e.preventDefault(); onClick(); },
  }, h("span", { class: "zai-sf-item-check" }, o.on ? icon("check", 13, 2.4) : null), h("span", { text: label }));

  // Folder: the user's folders, the top, or a new one ("Work/Reports")
  const folderMenu = (anchor) => popMenu(anchor, (el, close) => {
    const folders = [...(opts.folders || [])];
    if (v.folder && !folders.includes(v.folder)) folders.push(v.folder);
    const pick = (f) => { v.folder = f; close(); changed(); };
    el.append(menuItem("Top of the skills folder", () => pick(""), { on: v.folder === "" }));
    for (const f of folders) el.append(menuItem(f, () => pick(f), { on: v.folder === f }));
    const field = h("input", { class: "zai-sf-input", type: "text", placeholder: "New folder, e.g. Work/Reports", spellcheck: "false", "aria-label": "New folder" });
    const add = () => {
      const parts = folderParts(field.value);
      if (!parts || !parts.length) { field.classList.add("zai-sf-bad"); return; }
      pick(parts.join(" / "));
    };
    field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    el.append(h("div", { class: "zai-sf-menu-sep" }), h("div", { class: "zai-sf-newfolder" }, field, h("button", { class: "zai-sf-opt", text: "Add", onclick: (e) => { e.preventDefault(); add(); } })));
  });

  // + Add skill: search the user's skills
  const skillMenu = (anchor) => popMenu(anchor, (el, close) => {
    const field = h("input", { class: "zai-sf-input", type: "text", placeholder: "Search skills", spellcheck: "false", "aria-label": "Search skills" });
    const list = h("div", { class: "zai-sf-menu-list" });
    const fill = () => {
      const q = field.value.trim().toLowerCase().replace(/^\//, "");
      const names = (opts.skills || []).filter((n) => n !== v.name && !v.uses.includes("/" + n) && (!q || n.includes(q)));
      list.replaceChildren(...(names.length ? names.map((n) => menuItem("/" + n, () => { v.uses = [...v.uses, "/" + n]; close(); changed(); })) : [h("div", { class: "zai-sf-empty", text: "No matching skills" })]));
    };
    field.addEventListener("input", fill);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const first = list.querySelector(".zai-sf-item"); if (first) first.click(); }
    });
    fill();
    el.append(field, list);
  });

  const checkEl = h("div", { class: "zai-sf-check", role: "status", hidden: true });
  const body = h("div", { class: "zai-sf-body" });
  const el = h("div", { class: "zai-sf" },
    h("div", { class: "zai-sf-row" }, h("span", { class: "zai-sf-label", text: "Name" }), h("div", { class: "zai-sf-opts" }, h("span", { class: "zai-sf-slash", text: "/" }), nameInput)),
    row("About", descInput),
    body,
    preview,
    checkEl
  );

  function render() {
    closeMenu();
    const dataFiles = opts.dataFiles || [];
    const skillUses = v.uses.filter((u) => u.startsWith("/"));
    const folderBtn = h("button", { class: "zai-sf-select", "aria-haspopup": "menu", onclick: (e) => { e.preventDefault(); if (!disabled) folderMenu(folderBtn); } },
      h("span", { text: v.folder || "Top of the skills folder" }), icon("chevronDown", 13, 2));
    const addBtn = h("button", { class: "zai-sf-opt zai-sf-add", onclick: (e) => { e.preventDefault(); if (!disabled) skillMenu(addBtn); } }, icon("plus", 12, 2.2), h("span", { text: "Add skill" }));
    body.replaceChildren(
      row("Folder", h("div", { class: "zai-sf-anchor" }, folderBtn)),
      row("Sees", ...SKILL_SEES.map((c) => toggle(SKILL_SEE_LABELS[c], v.sees.includes(c), () => {
        v.sees = v.sees.includes(c) ? v.sees.filter((x) => x !== c) : [...v.sees, c];
        changed();
      }, c === "selection" ? "Needs a selection to run" : c === "page" ? "The page's text is sent with it" : "A screenshot of the page is sent with it"))),
      row("Uses",
        ...["about-me", ...dataFiles.filter((d) => d !== "about-me"), "secrets"].map((d) => checkbox(
          d === "about-me" ? "About me" : d === "secrets" ? "Saved logins" : `_${d}.md`,
          v.uses.includes(d),
          (on) => { v.uses = on ? [...v.uses, d] : v.uses.filter((x) => x !== d); changed(); },
          d === "about-me" ? "_about-me.md: your details" : d === "secrets" ? "_secrets.md: the AI gets the labels, never the values" : "A data file from your skills folder"
        ))
      ),
      row("Skills",
        ...skillUses.map((u) => h("span", { class: "zai-sf-opt zai-on zai-sf-chip" }, h("span", { text: u }),
          h("button", { class: "zai-sf-x", "aria-label": `Remove ${u}`, onclick: (e) => { e.preventDefault(); if (!disabled) { v.uses = v.uses.filter((x) => x !== u); changed(); } } }, icon("close", 11, 2.4)))),
        h("div", { class: "zai-sf-anchor" }, addBtn)
      ),
      row("Learns", checkbox("Learn from each run (lessons)", v.lessons, (on) => { v.lessons = on; changed(); }, "Offers to update the skill with what a run learned")),
      row("Agents",
        ...[0, 1, 2].map((n) => toggle(n ? String(n) : "None", v.agents === n, () => { v.agents = n; changed(); }, n ? `Up to ${n} helper agent${n > 1 ? "s" : ""} may draft at the same time` : "No helper agents")),
        opts.agentsOn === false && v.agents > 0 ? h("span", { class: "zai-sf-note", text: "Agents are off in Zen AI's settings" }) : null
      )
    );
  }

  function updateCheck() {
    const why = opts.check ? opts.check(values()) : "";
    checkEl.textContent = why || "";
    checkEl.hidden = !why;
    // Something still to fill in is a hint; a clash or a refusal is an error
    checkEl.classList.toggle("zai-sf-hint", /^(Give it|Write its)/.test(why || ""));
    if (opts.onCheck) opts.onCheck(why);
  }

  function values() {
    return { name: v.name, description: v.description, folder: v.folder, sees: [...v.sees], uses: [...v.uses], lessons: v.lessons, agents: v.agents, instructions: v.instructions };
  }

  render();
  updateCheck();
  return {
    el, values,
    setDisabled(on) {
      disabled = !!on;
      closeMenu();
      el.classList.toggle("zai-sf-off", disabled);
      for (const x of el.querySelectorAll("input, textarea")) x.disabled = disabled;
    },
    focusName: () => nameInput.focus(),
  };
}

// The card. Resolves { create: true, values } or { create: false } (Cancel,
// Stop). by: who filled it in ("Claude"), or "" for a blank one; replacing:
// the name this chat made before, which may be saved over.
export function skillCard({ values, folders, skills, dataFiles, agentsOn, by = "", replacing = "", check }) {
  let resolve;
  const result = new Promise((r) => (resolve = r));
  let done = false;
  const createBtn = h("button", { class: "zai-allow", text: replacing ? "Update skill" : "Create skill" });
  const form = createSkillForm({
    values, folders, skills, dataFiles, agentsOn, check, openInstructions: !by,
    onCheck: (why) => { createBtn.disabled = !!why; },
  });
  const sub = h("span", { class: "zai-approval-sub", text: by ? `${by} chose suggested settings` : "Write your new skill" });
  const actions = h("div", { class: "zai-approval-actions" },
    h("button", { class: "zai-deny", text: "Cancel", onclick: () => finish(false) }),
    createBtn
  );
  const el = h("div", { class: "zai-approval zai-skill-card" },
    h("div", { class: "zai-approval-head" },
      h("span", { class: "zai-approval-icon" }, icon("spark", 16, 2)),
      h("span", { class: "zai-approval-text" },
        h("span", { class: "zai-approval-title", text: replacing ? `Update /${replacing}` : "New skill" }),
        sub
      )
    ),
    form.el,
    actions
  );
  createBtn.addEventListener("click", () => { if (!createBtn.disabled) finish(true); });
  function finish(create, why = "") {
    if (done) return;
    done = true;
    form.setDisabled(true);
    actions.remove();
    el.classList.add("zai-decided");
    const v = form.values();
    sub.textContent = create ? `Saving /${v.name}…` : why || "Cancelled";
    // Decided: one line instead of the whole form
    const bits = [
      v.folder ? `in ${v.folder}` : "top of the skills folder",
      v.sees.length ? `sees ${v.sees.map((c) => SKILL_SEE_LABELS[c].toLowerCase()).join(", ")}` : "",
      v.uses.length ? `uses ${v.uses.map((u) => (u === "about-me" ? "about me" : u === "secrets" ? "saved logins" : u)).join(", ")}` : "",
      v.lessons ? "lessons on" : "",
      v.agents ? `${v.agents} agent${v.agents > 1 ? "s" : ""}` : "",
    ].filter(Boolean);
    form.el.replaceWith(h("div", { class: "zai-sf-summary", text: create ? `/${v.name} · ${bits.join(" · ")}` : v.name ? `/${v.name} wasn't saved` : "Nothing was saved" }));
    resolve(create ? { create: true, values: v } : { create: false });
  }
  return {
    el, result,
    cancel: (why) => finish(false, why || "Stopped"),
    saved(text) { sub.textContent = text; },
    focus: () => form.focusName(),
  };
}
