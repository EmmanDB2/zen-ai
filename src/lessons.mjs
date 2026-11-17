import { findSensitiveNumbers, dataFile } from "./skills.mjs";
import { sanitizeUntrusted } from "./pages.mjs";

// ---------------------------------------------------------------------------
// Skill updates (no DOM): finding a run's "## Lessons for /skill (…)" and
// "## New info for _file.md" sections in a reply, what to give the updater,
// applying its edits, the checks a draft must pass, and a line diff for the
// review card. The card and the files are in skill-updates.mjs.
// ---------------------------------------------------------------------------

const LESSONS_HEADING = /^##[ \t]+Lessons for \/([\w-]+)[ \t]*(?:\(([^)\n]*)\))?[ \t]*$/;
const NEW_INFO_HEADING = /^##[ \t]+New info for (_[a-z0-9][a-z0-9-]{0,40}\.md)[ \t]*$/i;
const MAX_BLOCK_CHARS = 20000;

// Sections of a reply: [{ kind: "lessons", skill, run, text } | { kind: "info", file, text }].
// A section runs until the next "## " heading (or the end). Two sections for
// the same file are joined. Headings inside code blocks don't count.
export function findUpdateBlocks(reply) {
  const out = [];
  let cur = null;
  let fenced = false;
  const close = () => {
    if (!cur) return;
    const text = cur.lines.join("\n").trim();
    delete cur.lines;
    if (text) {
      const same = out.find((b) => b.kind === cur.kind && (b.kind === "lessons" ? b.skill === cur.skill : b.file === cur.file));
      if (same) same.text = `${same.text}\n\n${text}`.slice(0, MAX_BLOCK_CHARS);
      else out.push({ ...cur, text: text.slice(0, MAX_BLOCK_CHARS) });
    }
    cur = null;
  };
  for (const line of String(reply || "").replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^##[ \t]/.test(line)) {
      close();
      const l = line.match(LESSONS_HEADING);
      const n = line.match(NEW_INFO_HEADING);
      if (l) cur = { kind: "lessons", skill: l[1].toLowerCase(), run: (l[2] || "").trim(), lines: [] };
      else if (n) cur = { kind: "info", file: n[1].toLowerCase(), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  close();
  return out;
}

// Which sections this run may update: lessons for the skill that ran (if it
// has lessons: true) or a skill it lists under access: (from: the one that
// ran), New info only for its access: files (never secrets).
// { accepted: [{ kind, skill, file, run, text, from }], refused: [{ heading, why }] }
export function acceptBlocks(blocks, skill) {
  const accepted = [];
  const refused = [];
  for (const b of blocks) {
    if (b.kind === "lessons") {
      const listed = skill && skill.skillFiles && skill.skillFiles[b.skill];
      if (!skill || (b.skill !== skill.name && !listed)) refused.push({ heading: `Lessons for /${b.skill}`, why: skill ? `this chat ran /${skill.name}${skill.accessSkills && skill.accessSkills.length ? `, which doesn't list /${b.skill} under access:` : ""}` : "no skill ran in this message" });
      else if (!skill.lessons) refused.push({ heading: `Lessons for /${b.skill}`, why: `/${skill.name} doesn't have lessons: true` });
      else if (b.skill === skill.name) accepted.push({ kind: "lessons", skill: skill.name, file: skill.file, run: b.run, text: b.text });
      else accepted.push({ kind: "lessons", skill: b.skill, file: listed, run: b.run, text: b.text, from: skill.name });
    } else {
      const name = b.file.replace(/^_/, "").replace(/\.md$/, "");
      if (!skill || !skill.access.includes(name) || name === "secrets") refused.push({ heading: `New info for ${b.file}`, why: skill ? `/${skill.name} doesn't list ${name} under access:` : "no skill ran in this message" });
      else accepted.push({ kind: "info", skill: skill.name, file: dataFile(name), text: b.text });
    }
  }
  return { accepted, refused };
}

const fence = (s) => sanitizeUntrusted(String(s)).replace(/<(\/?)(rules|file|lessons|new_info)\b/gi, "‹$1$2");

// The updater's message: the user's rules, the file and the lessons (untrusted)
export function updaterPrompt({ rules, file, kind, text, blockText, skill, run, from }) {
  const what = kind === "lessons" ? `Lessons ${from ? `for /${skill}, from a /${from} run` : `from a /${skill} run`}${run ? ` (${run})` : ""}` : `New info for ${file}, from a /${skill} run`;
  return [
    `<rules file="_updater.md">\n${rules}\n</rules>`,
    `<file name="${file}" kind="${kind === "lessons" ? "skill" : "data file about the user"}">\n${text || "(this file is empty or doesn't exist yet)"}\n</file>`,
    `<${kind === "lessons" ? "lessons" : "new_info"} note="${what}">\n<untrusted_content>\n${fence(blockText)}\n</untrusted_content>\n</${kind === "lessons" ? "lessons" : "new_info"}>`,
    `Merge these into ${file} following the rules, and reply with the JSON.`,
  ].join("\n\n");
}

// The updater's reply → { edits, changed, covered, unclear } (throws if it isn't one)
export function parseUpdaterReply(reply) {
  const s = String(reply || "");
  const fenced = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const raw = fenced ? fenced[1] : s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);
  let o;
  try { o = JSON.parse(raw); } catch (e) { throw new Error("The updater's answer wasn't in the expected format."); }
  if (!o || typeof o !== "object" || !Array.isArray(o.edits)) throw new Error("The updater's answer had no list of edits.");
  const lines = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 400)) : []);
  const edits = o.edits
    .filter((e) => e && typeof e.find === "string" && typeof e.replace === "string")
    .map((e) => ({ find: e.find, replace: e.replace, section: typeof e.section === "string" ? e.section.slice(0, 120) : "", lesson: typeof e.lesson === "string" ? e.lesson.slice(0, 200) : "" }));
  return { edits, changed: lines(o.changed), covered: lines(o.already_covered), unclear: lines(o.unclear) };
}

const count = (hay, needle) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};

// Applies the edits one after another. Each "find" must be in the text
// exactly once ("" adds to an empty file). { text, problems, spans }
// spans: where each edit landed in the ORIGINAL text, for the safety check.
export function applyEdits(original, edits) {
  let text = original;
  const problems = [];
  const spans = [];
  for (const [i, e] of edits.entries()) {
    const n = `Edit ${i + 1}${e.section ? ` (${e.section})` : ""}`;
    if (e.find === "") {
      if (text.trim()) { problems.push(`${n} has nothing to find, but the file isn't empty.`); continue; }
      text = e.replace;
      continue;
    }
    const hits = count(text, e.find);
    if (hits !== 1) { problems.push(`${n}: ${hits ? `the text to change appears ${hits} times` : "the text to change isn't in the file"}.`); continue; }
    const at = original.indexOf(e.find);
    if (at >= 0) spans.push({ start: at, end: at + e.find.length, edit: e });
    text = text.replace(e.find, () => e.replace);
  }
  return { text, problems, spans };
}

const frontMatter = (t) => (t.match(/^---\n[\s\S]*?\n---\n?/) || [""])[0];
const headings = (t) => t.split("\n").filter((l) => /^#{1,6}[ \t]/.test(l)).map((l) => l.trim());
const brackets = (t) => t.match(/\[[^\]\n]{1,300}\](?!\()/g) || [];

// Sections whose rules keep the user safe: a change in one needs a second click
const SAFETY_HEADING = /safety|account|log ?in|sign.?in|gmail|authori[sz]|password|submit|\bpay|payment|purchase/i;
const SAFETY_PHRASE = /authori[sz]es?|never (click )?submit|submit(ting)? (is|only)|everything you submit|must be true|password|payment|\bpay\b|log ?in|sign.?in|gmail/i;

// The sections of a Markdown text: [{ title, start, end }]
function sections(text) {
  const out = [];
  const re = /^(#{1,6})[ \t]+(.+)$/gm;
  let m;
  const found = [];
  while ((m = re.exec(text))) found.push({ level: m[1].length, title: m[2].trim(), start: m.index });
  for (const [i, s] of found.entries()) {
    const next = found.slice(i + 1).find((x) => x.level <= s.level);
    out.push({ title: s.title, start: s.start, end: next ? next.start : text.length });
  }
  return out;
}

// What a draft must pass before the user sees it, and what to point out.
// { refuse: [why], safety: [section titles], flags: [note] }
export function checkUpdate({ before, after, kind, spans, edits, secrets = [] }) {
  const refuse = [];
  const flags = [];
  const added = addedLines(before, after).join("\n");
  if (kind === "lessons" && frontMatter(before) !== frontMatter(after)) refuse.push("It changes the skill's header (name, description, lessons or access).");
  if (after.length > before.length * 1.3 + 1500) refuse.push(`It grows the file by ${Math.round((after.length / Math.max(before.length, 1) - 1) * 100)}%, more than one update should.`);
  const numbers = findSensitiveNumbers(added);
  if (numbers.length) refuse.push(`It adds what looks like a ${numbers[0].kind}.`);
  if (secrets.some((v) => v.length >= 4 && after.includes(v) && !before.includes(v))) refuse.push("It adds one of your saved secrets.");
  if (kind === "info") {
    const left = [...brackets(after)];
    for (const b of brackets(before)) {
      const i = left.indexOf(b);
      if (i < 0) { refuse.push(`It fills or removes ${b}, which you fill in yourself.`); break; }
      left.splice(i, 1);
    }
    const kept = headings(after);
    const gone = headings(before).filter((h) => !kept.includes(h));
    if (gone.length) refuse.push(`It removes or renames the heading “${gone[0].replace(/^#+\s*/, "")}”.`);
  } else {
    const kept = headings(after);
    const gone = headings(before).filter((h) => !kept.includes(h));
    if (gone.length) flags.push(`Removes or renames ${gone.map((h) => `“${h.replace(/^#+\s*/, "")}”`).join(", ")}.`);
  }
  if (/^##[ \t]+(Lessons for|New info for|Lessons from)\b/m.test(added)) flags.push("Adds a Lessons or New info section (Zen AI adds those instructions itself).");
  if (/—/.test(added)) flags.push("Uses an em dash.");
  if (/^\s*\|.*\|\s*$/m.test(added)) flags.push("Adds a table.");
  // Safety: an edit inside a safety section, or one that touches safety wording
  const safety = [];
  const secs = sections(before);
  for (const sp of spans || []) {
    for (const s of secs) if (SAFETY_HEADING.test(s.title) && sp.start < s.end && sp.end > s.start && !safety.includes(s.title)) safety.push(s.title);
  }
  for (const e of edits || []) {
    if ((SAFETY_PHRASE.test(e.find) || SAFETY_PHRASE.test(e.replace)) && e.find !== e.replace) {
      const title = e.section || "safety wording";
      if (!safety.includes(title)) safety.push(title);
    }
  }
  return { refuse, safety, flags };
}

// Line diff (LCS): [{ type: "same" | "add" | "del", text }]
export function lineDiff(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  // Trim the common start and end so the table stays small
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const xs = x.slice(s, x.length - e);
  const ys = y.slice(s, y.length - e);
  const n = xs.length;
  const m = ys.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = x.slice(0, s).map((text) => ({ type: "same", text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) { out.push({ type: "same", text: xs[i] }); i++; j++; }
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) out.push({ type: "del", text: xs[i++] });
    else out.push({ type: "add", text: ys[j++] });
  }
  for (const text of x.slice(x.length - e)) out.push({ type: "same", text });
  return out;
}

// The diff with only `context` unchanged lines around each change; a gap is { type: "gap", count }
export function diffHunks(diff, context = 2) {
  const keep = diff.map(() => false);
  diff.forEach((d, i) => {
    if (d.type === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  diff.forEach((d, i) => {
    if (keep[i]) {
      if (skipped) out.push({ type: "gap", count: skipped });
      skipped = 0;
      out.push(d);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ type: "gap", count: skipped });
  return out;
}

function addedLines(before, after) {
  return lineDiff(before, after).filter((d) => d.type === "add").map((d) => d.text);
}

// "1 change", "3 changes"
export const changesLabel = (n) => `${n} change${n === 1 ? "" : "s"}`;
