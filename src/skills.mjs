import { AGENT_MAX_PER_SKILL, DEFAULT_SKILLS, MAX_DATA_FILE_CHARS, prefs } from "./config.mjs";

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export const SKILL_CONTEXTS = new Set(["page", "selection", "screenshot", "me"]);
export const ABOUT_ME_FILE = "_about-me.md";
// Data files a skill may use, listed under access: in its header. "about-me"
// is _about-me.md in the skills folder (files starting with _ aren't skills).
const DATA_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const dataFile = (name) => `_${name}.md`;
// _secrets.md: never sent as text (saved secrets are filled in by name)
export const SECRETS_NAME = "secrets";
// Bumped when new default skills ship, so existing folders get them once
export const SKILLS_VERSION = 3;
export const SKILLS_ADDED = { 2: ["fill.md", ABOUT_ME_FILE], 3: ["compare-sources.md"] };

export function skillsDir() {
  return PathUtils.join(PathUtils.profileDir, "chrome", "zenai-skills");
}

// Writes the default skills into a new folder, and any newly added defaults
// into an existing one, once. Never overwrites a file that's there.
export async function ensureDefaultSkills() {
  const dir = skillsDir();
  const existed = await IOUtils.exists(dir);
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const version = parseInt(prefs.get("skillsVersion", existed ? "1" : "0"), 10) || 0;
  if (version >= SKILLS_VERSION) return;
  let files = Object.keys(DEFAULT_SKILLS);
  if (version > 0) {
    files = [];
    for (let v = version + 1; v <= SKILLS_VERSION; v++) files.push(...(SKILLS_ADDED[v] || []));
  }
  for (const file of files) {
    const path = PathUtils.join(dir, file);
    if (!(await IOUtils.exists(path))) await IOUtils.writeUTF8(path, DEFAULT_SKILLS[file]).catch(() => {});
  }
  prefs.set("skillsVersion", SKILLS_VERSION);
}

// The user's own details for /fill (null if the file is missing or still blank)
export async function readAboutMe() {
  try {
    const text = await IOUtils.readUTF8(PathUtils.join(skillsDir(), ABOUT_ME_FILE));
    // Counts as filled in once any "Field: value" line has a value
    return /^[A-Za-z][^#\n:.]{0,40}:[ \t]*\S/m.test(text) ? text.trim().slice(0, 8000) : null;
  } catch (e) {
    return null;
  }
}

// The header between --- lines: "key: value", and lists either as "key:"
// followed by "- item" lines or inline ("key: [a, b]" or "key: a, b")
function parseFrontMatter(lines) {
  const meta = {};
  let listKey = null;
  for (const line of lines) {
    const item = line.match(/^\s*-\s*(.*?)\s*$/);
    if (item && listKey) {
      if (item[1]) meta[listKey].push(item[1]);
      continue;
    }
    listKey = null;
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (m[2] === "") {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = m[2];
    }
  }
  return meta;
}

const listOf = (v) => (Array.isArray(v) ? v : String(v || "").replace(/^\[|\]$/g, "").split(",")).map((s) => s.trim()).filter(Boolean);

// A skill's own lesson notes ("## Lessons (notes for this skill)"): taken out
// of the body and sent after the standard lessons text instead
const LESSON_NOTES = /^##[ \t]+Lessons\b[^\n]*\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m;

export function parseSkill(source, fileName) {
  const text = source.replace(/\r\n/g, "\n");
  let meta = {};
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    meta = parseFrontMatter(fm[1].split("\n"));
    body = fm[2];
  }
  const one = (key) => (Array.isArray(meta[key]) ? meta[key].join(", ") : meta[key] || "");
  const name = (one("name") || fileName.replace(/\.md$/i, "")).toLowerCase().replace(/[^\w-]/g, "");
  if (!name || !body.trim()) return null;
  const context = listOf(meta.context).map((s) => s.toLowerCase()).filter((s) => SKILL_CONTEXTS.has(s));
  // access: data files by name ("about-me", or "_about-me.md" written out);
  // the old "context: me" means about-me
  // "/solve" is always another skill; a plain name that turns out to be one
  // moves to accessSkills in loadSkills, which knows all the skills
  const access = [];
  const accessSkills = [];
  for (const raw of [...listOf(meta.access), ...(context.includes("me") ? ["about-me"] : [])]) {
    if (raw.startsWith("/")) {
      const n = raw.slice(1).toLowerCase().replace(/[^\w-]/g, "");
      if (n && n !== name && !accessSkills.includes(n)) accessSkills.push(n);
      continue;
    }
    const n = raw.toLowerCase().replace(/^_/, "").replace(/\.md$/, "");
    if (DATA_NAME.test(n) && !access.includes(n)) access.push(n);
  }
  const lessons = /^(true|yes|on)$/i.test(one("lessons"));
  // agents: N lets this skill delegate to helper agents, N at a time (Zen runs
  // them; see agent-runs.mjs). Missing or 0: never. Anything else is refused
  // (no agents) and the reason shows when the skill runs.
  const agentsRaw = one("agents").trim();
  let agents = 0;
  let agentsError = "";
  if (agentsRaw) {
    if (/^\d+$/.test(agentsRaw) && Number(agentsRaw) <= AGENT_MAX_PER_SKILL) agents = Number(agentsRaw);
    else agentsError = `agents: “${agentsRaw.slice(0, 40)}” isn't a whole number from 0 to ${AGENT_MAX_PER_SKILL}, so /${name} runs without agents.`;
  }
  let lessonNotes = "";
  if (lessons) {
    const m = body.match(LESSON_NOTES);
    if (m) {
      lessonNotes = m[1].trim();
      body = body.replace(m[0], "");
    }
  }
  return {
    name,
    description: one("description"),
    context: context.filter((c) => c !== "me"),
    access,
    accessSkills,
    lessons,
    lessonNotes,
    agents,
    agentsError,
    body: body.trim(),
  };
}

// A data file's text: { file, text } (text null if it's missing or empty)
export async function readDataFile(name) {
  const file = dataFile(name);
  try {
    const text = (await IOUtils.readUTF8(PathUtils.join(skillsDir(), file))).replace(/\r\n/g, "\n").trim();
    return { file, text: text || null };
  } catch (e) {
    return { file, text: null };
  }
}

// Numbers that belong in _secrets.md, never in a file sent as text: card
// numbers (Luhn checksum), SSNs, bank account/routing numbers and IBANs.
// [{ kind, line }]
export function findSensitiveNumbers(text) {
  const found = [];
  const luhn = (digits) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = +digits[digits.length - 1 - i];
      if (i % 2) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  };
  String(text).split("\n").forEach((line, i) => {
    const at = i + 1;
    for (const m of line.matchAll(/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 13 && luhn(digits) && !/^(\d)\1+$/.test(digits)) found.push({ kind: "card number", line: at });
    }
    if (/(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/.test(line) || /\b(ssn|social security)\b\D{0,20}\d{9}\b/i.test(line)) found.push({ kind: "Social Security number", line: at });
    if (/\b(routing|account|acct)\b[^\n\d]{0,25}\d{6,17}\b/i.test(line) || /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/.test(line)) found.push({ kind: "bank number", line: at });
  });
  return found;
}

// Skills can sit in folders inside the skills folder (folders in folders
// too, up to this deep), which group them in the "/" menu. A skill's command
// doesn't depend on its folder, so moving files around never renames one.
export const MAX_SKILL_DEPTH = 3;
const byName = (a, b) => PathUtils.filename(a).localeCompare(PathUtils.filename(b), undefined, { sensitivity: "base", numeric: true });

// Every skill file: loose ones first, then each folder's (A–Z, depth first).
// Names starting with _ or . are skipped, files and folders alike.
async function skillFiles(dir, folders = [], out = []) {
  let children = [];
  try { children = await IOUtils.getChildren(dir); } catch (e) { return out; }
  const files = [];
  const dirs = [];
  for (const path of children) {
    const base = PathUtils.filename(path);
    if (/^[_.]/.test(base)) continue;
    if (/\.md$/i.test(base)) files.push(path);
    else if (folders.length < MAX_SKILL_DEPTH) {
      try { if ((await IOUtils.stat(path)).type === "directory") dirs.push(path); } catch (e) {}
    }
  }
  for (const path of files.sort(byName)) out.push({ path, folders });
  for (const path of dirs.sort(byName)) await skillFiles(path, [...folders, PathUtils.filename(path)], out);
  return out;
}

// Skills in menu order. Each: { name, description, context, body, folder
// ("School / Chem", "" when loose), file ("School/Chem/x.md"), clashes
// (other files with the same name, which aren't used: the first one wins) }
export async function loadSkills() {
  try {
    await ensureDefaultSkills();
    const skills = [];
    for (const { path, folders } of await skillFiles(skillsDir())) {
      try {
        const skill = parseSkill(await IOUtils.readUTF8(path), PathUtils.filename(path));
        if (!skill) continue;
        const file = [...folders, PathUtils.filename(path)].join("/");
        const first = skills.find((s) => s.name === skill.name);
        if (first) first.clashes.push(file);
        else skills.push({ ...skill, folder: folders.join(" / "), file, clashes: [] });
      } catch (e) {}
    }
    // access: a plain name is another skill if one has that name, unless a
    // data file does too (the file wins; "/name" always means the skill)
    for (const skill of skills) {
      for (const name of [...skill.access]) {
        if (name === SECRETS_NAME || name === skill.name || !skills.some((s) => s.name === name)) continue;
        if (await IOUtils.exists(PathUtils.join(skillsDir(), dataFile(name))).catch(() => false)) continue;
        skill.access = skill.access.filter((n) => n !== name);
        if (!skill.accessSkills.includes(name)) skill.accessSkills.push(name);
      }
      // Where each listed skill lives (lessons can update them too)
      skill.skillFiles = {};
      for (const name of skill.accessSkills) {
        const other = skills.find((s) => s.name === name);
        if (other) skill.skillFiles[name] = other.file;
      }
    }
    return skills;
  } catch (e) {
    console.error("[Zen AI] Couldn't load skills:", e);
    return [];
  }
}

export function revealSkillsFolder() {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(skillsDir());
    file.reveal();
  } catch (e) {
    console.error("[Zen AI] Couldn't open the skills folder:", e);
  }
}

// ---------------------------------------------------------------------------
// Writing skill and data files (the skill updater), always with a backup in
// _backups/ (starts with _, so never a skill). Only .md files inside the
// skills folder, never _secrets.md, never in _backups/ itself.
// ---------------------------------------------------------------------------
export const BACKUPS_DIR = "_backups";

// "Home/Recipes/weeknight.md" or "_about-me.md" → its full path, or null
export function skillFilePath(rel) {
  const parts = String(rel || "").split("/");
  if (!parts.length || parts.length > MAX_SKILL_DEPTH + 1) return null;
  if (parts.some((p) => !p || p === ".." || p.startsWith("."))) return null;
  if (!/\.md$/i.test(parts[parts.length - 1]) || parts[0] === BACKUPS_DIR || rel === dataFile(SECRETS_NAME)) return null;
  // Data files (_x.md) only at the top
  if (parts.slice(0, -1).some((p) => p.startsWith("_"))) return null;
  return PathUtils.join(skillsDir(), ...parts);
}

export async function readSkillFile(rel) {
  const path = skillFilePath(rel);
  if (!path) throw new Error(`Not a file Zen AI may change: ${rel}`);
  try {
    return (await IOUtils.readUTF8(path)).replace(/\r\n/g, "\n");
  } catch (e) {
    return "";
  }
}

// 2026-11-16-113239 (backups sort by name)
function backupStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const backupPrefix = (rel) => rel.replace(/\.md$/i, "").replace(/\//g, "__") + ".";

// Saves the old text to _backups/, keeps the newest `keep` per file, writes
// the new text. Resolves with the backup's file name ("" if there was no old file).
export async function writeSkillFile(rel, text, keep = 3) {
  const path = skillFilePath(rel);
  if (!path) throw new Error(`Not a file Zen AI may change: ${rel}`);
  const dir = PathUtils.join(skillsDir(), BACKUPS_DIR);
  let backup = "";
  const old = await IOUtils.exists(path) ? await IOUtils.readUTF8(path) : null;
  if (old !== null) {
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    backup = `${backupPrefix(rel)}${backupStamp()}.md`;
    await IOUtils.writeUTF8(PathUtils.join(dir, backup), old);
  }
  await IOUtils.makeDirectory(PathUtils.parent ? PathUtils.parent(path) : path.replace(/\/[^/]*$/, ""), { ignoreExisting: true });
  await IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp" });
  // Only the newest few backups of each file
  try {
    const mine = (await IOUtils.getChildren(dir)).filter((p) => PathUtils.filename(p).startsWith(backupPrefix(rel))).sort();
    for (const p of mine.slice(0, Math.max(0, mine.length - Math.max(1, keep)))) await IOUtils.remove(p);
  } catch (e) {}
  return backup;
}

// Puts a backup back (Undo). The backup name must be one of this file's.
export async function restoreBackup(rel, backup) {
  const path = skillFilePath(rel);
  if (!path || !backup.startsWith(backupPrefix(rel)) || backup.includes("/")) throw new Error("That backup doesn't belong to this file.");
  const text = await IOUtils.readUTF8(PathUtils.join(skillsDir(), BACKUPS_DIR, backup));
  await IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp" });
}

export function revealBackups() {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(PathUtils.join(skillsDir(), BACKUPS_DIR));
    if (file.exists()) file.reveal();
    else revealSkillsFolder();
  } catch (e) {
    console.error("[Zen AI] Couldn't open the backups folder:", e);
  }
}

// ---------------------------------------------------------------------------
// _secrets.md: what the user saved for Zen AI to fill in by name. One per line:
//   - Main password (shop.example.com, mail.example.com): hunter2
//   - SSN: 123-45-6789
// Claude only ever gets the labels (and sites); the value goes straight from
// here into the page's matching protected field (panel.mjs → page agent).
// Read fresh each time, never kept. Zen AI never writes this file.
// ---------------------------------------------------------------------------
// The kind of field a secret may go into (the page agent's protectedKind)
export function secretKind(label) {
  const l = String(label).toLowerCase();
  if (/\bssn\b|social security|tax id|\bitin\b|\bid number\b/.test(l)) return "ID number";
  if (/card|visa|mastercard|amex|discover|\bcvv\b|\bcvc\b|expir/.test(l)) return "payment card";
  if (/bank|routing|account number|\bacct\b|\biban\b|swift/.test(l)) return "bank account";
  return "password";
}

const siteOf = (s) => String(s).trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "").replace(/:\d+$/, "");

// [{ label, sites, kind, value }]; the first of two with one label wins
export function parseSecrets(text) {
  const out = [];
  for (const line of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const m = line.match(/^\s*[-*]\s*(.+?)\s*(?:\(([^)]*)\))?\s*:\s*(.*?)\s*$/);
    if (!m || !m[3]) continue;
    const label = m[1].trim();
    if (!label || out.some((x) => x.label.toLowerCase() === label.toLowerCase())) continue;
    const sites = (m[2] || "").split(",").map(siteOf).filter(Boolean);
    out.push({ label, sites, kind: secretKind(label), value: m[3] });
  }
  return out;
}

export async function readSecrets() {
  try {
    return parseSecrets(await IOUtils.readUTF8(PathUtils.join(skillsDir(), dataFile(SECRETS_NAME))));
  } catch (e) {
    return null; // no file
  }
}

// Is a page on `host` one this secret may be filled on? (subdomains count)
export function secretSiteOk(secret, host) {
  const h = siteOf(host);
  return !!h && secret.sites.some((s) => h === s || h.endsWith("." + s));
}

// The values, only to make sure an update never writes one into another file
export async function secretValues() {
  return ((await readSecrets()) || []).map((s) => s.value);
}

// ---------------------------------------------------------------------------
// Making a skill (create_skill → the "New skill" card): the header comes only
// from the settings the user confirmed on the card; Claude writes the
// description and instructions. New files only, inside the skills folder,
// except a skill this chat created (Replace, with a backup).
// ---------------------------------------------------------------------------
export const SKILL_SEES = ["page", "selection", "screenshot"];
export const MAX_SKILL_CHARS = 40000;

// "Lab Report!" → "lab-report"
export function skillSlug(text) {
  return String(text || "").toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

// "Home / Recipes" or "Home/Recipes" → ["Home", "Recipes"] (null if not allowed)
export function folderParts(folder) {
  const parts = String(folder || "").split("/").map((p) => p.trim().replace(/[\u0000-\u001f:*?"<>|\\]/g, "").slice(0, 40)).filter(Boolean);
  if (parts.length > MAX_SKILL_DEPTH || parts.some((p) => p === ".." || p.startsWith(".") || p.startsWith("_"))) return null;
  return parts;
}

// The data files the user has (_x.md → "x"), not _secrets.md or Zen's own
export async function listDataFiles() {
  try {
    const kids = await IOUtils.getChildren(skillsDir());
    return kids.map((p) => PathUtils.filename(p)).filter((n) => /^_[a-z0-9][a-z0-9-]{0,40}\.md$/i.test(n))
      .map((n) => n.slice(1, -3).toLowerCase())
      .filter((n) => n !== SECRETS_NAME && n !== "updater" && n !== "skills-updater-brief").sort();
  } catch (e) {
    return [];
  }
}

// Settings → the file's text. s: { name, description, sees, uses (data files,
// "secrets", "/skill"), lessons, agents }
export function skillFileText(s, body) {
  const one = (t) => String(t || "").replace(/\s+/g, " ").replace(/^-+\s*/, "").trim().slice(0, 300);
  const lines = ["---", `name: ${s.name}`, `description: ${one(s.description)}`];
  const sees = (s.sees || []).filter((c) => SKILL_SEES.includes(c));
  if (sees.length) lines.push(`context: ${sees.join(", ")}`);
  if (s.lessons) lines.push("lessons: true");
  if (s.agents > 0) lines.push(`agents: ${Math.min(AGENT_MAX_PER_SKILL, s.agents)}`);
  if ((s.uses || []).length) lines.push("access:", ...s.uses.map((u) => `  - ${u}`));
  lines.push("---", "");
  return lines.join("\n") + "\n" + String(body || "").trim() + "\n";
}

// The instructions as written by Claude, made safe to save (or an error)
export function cleanSkillBody(text) {
  let body = String(text || "").replace(/\r\n?/g, "\n");
  // A header Claude wrote itself is dropped: the card's settings are the header
  const fm = body.match(/^\s*---\n[\s\S]*?\n---\n?/);
  if (fm) body = body.slice(fm[0].length);
  body = body.trim();
  if (!body) throw new Error("instructions are empty.");
  if (body.length > MAX_SKILL_CHARS) throw new Error(`instructions are too long (${MAX_SKILL_CHARS.toLocaleString("en-US")} characters max).`);
  const numbers = findSensitiveNumbers(body);
  if (numbers.length) throw new Error("The instructions contain what looks like a card, bank or ID number. Leave it out: saved logins go in _secrets.md, written by the user.");
  return body;
}

// Writes the skill. replace: the path this chat created before (may be overwritten)
export async function saveNewSkill(folder, name, text, { replace = "" } = {}) {
  const parts = folderParts(folder);
  if (!parts) throw new Error("That folder isn't allowed.");
  const rel = [...parts, `${name}.md`].join("/");
  const path = skillFilePath(rel);
  if (!path) throw new Error("That isn't a place for a skill.");
  const taken = (await loadSkills()).find((s) => s.name === name);
  if (taken && taken.file !== replace) throw new Error(`There's already a /${name} skill (${taken.file}). Pick another name.`);
  if (rel !== replace && await IOUtils.exists(path).catch(() => false)) throw new Error(`${rel} already exists.`);
  const backup = await writeSkillFile(rel, text);
  // Updated into another folder: the old file moves to _backups/ (no two skills with one name)
  const oldPath = replace && replace !== rel ? skillFilePath(replace) : null;
  if (oldPath && await IOUtils.exists(oldPath).catch(() => false)) {
    const dir = PathUtils.join(skillsDir(), BACKUPS_DIR);
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    await IOUtils.writeUTF8(PathUtils.join(dir, `${backupPrefix(replace)}${backupStamp()}.md`), await IOUtils.readUTF8(oldPath));
    await IOUtils.remove(oldPath);
  }
  return { rel, path, backup };
}
