#!/usr/bin/env node
// Stitches src/*.mjs into the single file Zen loads: dist/zen-ai-chat.uc.js.
//
// The modules share one scope once stitched (exactly like the original single
// file), so the build only has to drop the import lines and the "export "
// keywords, in a fixed order. No dependencies, no transpiling: what you read
// in src/ is what runs in Zen.
//
//   node scripts/build.mjs           build
//   node scripts/build.mjs --check   fail if dist/ is out of date

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "zen-ai-chat.uc.js");

// Load order matters: a constant must be defined before code that runs at load
// time uses it (functions are fine in any order). Add new modules here.
export const MODULES = [
  "config",        // settings, prompts, tool definitions, default skills
  "styles",        // the panel's CSS
  "dom",           // h(), icons, small UI helpers
  "markdown",      // Markdown → DOM for replies
  "pdf",           // create_pdf: Markdown → PDF with Gecko's printer
  "files",         // zip/docx writer, output folder, the in-mod MCP tools
  "pages",         // reading tabs: text, selection, screenshots, sanitizing
  "page-agent",    // runs INSIDE web pages (must stay self-contained)
  "browser-agent", // runs the page agent, page diffs, navigation
  "frames",        // the page agent in frames from other sites (their own processes)
  "zen-tabs",      // Zen's folders, pinned tabs and Essentials (tab list, organizing)
  "attachments",   // reading files the user attaches
  "file-edit",     // edit_file: a copy of an attached or made file, its formatting kept
  "skills",        // the skills folder
  "lessons",       // skill updates: finding lessons, checking and diffing drafts (no DOM)
  "session",       // the Claude Code process and its protocol
  "mcp-bridge",    // private Unix socket for stdio MCP clients
  "antigravity",   // CLI discovery and isolated pre-execution tool restrictions
  "acp",           // Antigravity's Agent Client Protocol adapter
  "providers",     // available session adapters and provider identity
  "usage",         // the plan's 5-hour and weekly limits (the ring on Send)
  "chats",         // chat history: saved chats per Space, search, resume
  "skill-updates", // the card that merges a run's Lessons into the skill (review, save, undo)
  "settings",      // the Zen AI pane in Zen's settings (about:preferences)
  "panel-layout",  // the window's frame: tooltips, docking, position, resizing, blur
  "panel-parts",   // small UI pieces the views share (chips, lines, menus, popovers)
  "skill-form",    // a new skill's settings: /create-skill's panel and the "New skill" card
  "turn-stats",    // what a reply cost: requests, history size, screenshots (no DOM)
  "chat-view",     // the thread: messages, streaming replies, cards, saved chats
  "approval-view", // approval cards (the choice only; controllers decide)
  "history-view",  // the history popover and unread dots
  "shield-view",   // the shield button and its popover
  "capture",       // screenshot an area of the page
  "composer",      // message box, chips, attachments, pickers, model menu, usage ring
  "message-builder", // the message the AI receives (context, untrusted wrapping)
  "tab-overlay",   // the glow + Stop pill over the tab an actor works in
  "browser-controller", // browser actions: permission, grants, secrets, running them (per actor)
  "agent-runs",    // delegated agents: run state, scheduling, budgets, cancellation (no DOM)
  "agent-view",    // agent boxes in a reply (and restored from history)
  "agent-host",    // the chat side of agents: tools, child routing, context, combining results
  "watches",       // watch_page without DOM: conditions, timing, the saved list
  "watch-view",    // the "Watch this page?" card and the eye button's list
  "watch-host",    // one window checks every watch; firing: notify or wake the chat
  "chat-controller", // chats and turns: sessions, send/stop, history, Spaces
  "panel",         // builds the window: creates and wires the parts
  "main",          // starts it once per window
];

const HEADER = `// ==UserScript==
// @name           Zen AI — floating chat
// @description    Floating/docked AI chat for Zen, powered by Claude Code or Antigravity.
// ==/UserScript==
//
// Built from src/ by scripts/build.mjs. Edit the modules there, not this file.
`;

const IMPORT_START = /^import\s/;
const IMPORT_FROM = /from\s+"\.\/([\w-]+)\.mjs";\s*$/;
const EXPORT_DECL = /^export (?=(?:async\s+)?function\s|const\s|let\s|class\s)/;
const TOP_DECL = /^(?:async\s+)?function\s+(\w+)|^(?:const|let|class)\s+(\w+)|^const\s+\{([^}]+)\}/;

function readModule(name) {
  const file = join(ROOT, "src", name + ".mjs");
  const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
  const imports = []; // { from, names }
  const body = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (IMPORT_START.test(line)) {
      let stmt = line;
      while (!IMPORT_FROM.test(stmt) && i + 1 < lines.length) stmt += " " + lines[++i].trim();
      const m = stmt.match(IMPORT_FROM);
      if (!m) throw new Error(`${name}.mjs: only imports from sibling modules ("./x.mjs") are supported:\n  ${stmt}`);
      const names = (stmt.match(/\{([^}]*)\}/) || [, ""])[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (names.some((n) => / as /.test(n))) throw new Error(`${name}.mjs: "import { a as b }" isn't supported (the bundle shares one scope)`);
      imports.push({ from: m[1], names });
      continue;
    }
    if (/^export\s/.test(line) && !EXPORT_DECL.test(line)) {
      throw new Error(`${name}.mjs: only "export function/const/let/class" is supported:\n  ${line}`);
    }
    body.push(line.replace(EXPORT_DECL, ""));
  }
  const exported = new Set();
  for (const line of lines) {
    if (!EXPORT_DECL.test(line)) continue;
    const m = line.replace(EXPORT_DECL, "").match(TOP_DECL);
    if (m && m[3]) m[3].split(",").forEach((n) => exported.add(n.split(":").pop().trim()));
    else if (m) exported.add(m[1] || m[2]);
  }
  return { name, imports, body, exported };
}

export function build() {
  const mods = MODULES.map(readModule);
  const byName = new Map(mods.map((m) => [m.name, m]));
  const problems = [];
  // Imports must point at real modules and exported names
  for (const m of mods) {
    for (const { from, names } of m.imports) {
      const target = byName.get(from);
      if (!target) { problems.push(`${m.name}.mjs imports from unknown module ./${from}.mjs (add it to MODULES)`); continue; }
      for (const n of names) if (!target.exported.has(n)) problems.push(`${m.name}.mjs imports ${n}, which ${from}.mjs doesn't export`);
    }
  }
  // Once stitched everything shares one scope: top-level names must be unique
  const seen = new Map();
  for (const m of mods) {
    for (const line of m.body) {
      const d = line.match(TOP_DECL);
      if (!d) continue;
      const names = d[3] ? d[3].split(",").map((n) => n.split(":").pop().trim()) : [d[1] || d[2]];
      for (const n of names) {
        if (seen.has(n)) problems.push(`"${n}" is declared at the top level of both ${seen.get(n)}.mjs and ${m.name}.mjs`);
        else seen.set(n, m.name);
      }
    }
  }
  // The version the settings pane shows
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const shown = (readFileSync(join(ROOT, "src", "config.mjs"), "utf8").match(/MOD_VERSION = "([^"]+)"/) || [])[1];
  if (shown !== pkg) problems.push(`config.mjs MOD_VERSION is ${shown}, package.json says ${pkg}`);
  if (problems.length) throw new Error("Build failed:\n  " + problems.join("\n  "));

  const parts = mods.map((m) => `// ===== src/${m.name}.mjs =====\n${m.body.join("\n").replace(/^\n+/, "")}`);
  return `${HEADER}\n(function () {\n"use strict";\n\n${parts.join("\n\n")}\n})();\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = build();
  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== out) {
      console.error("dist/zen-ai-chat.uc.js is out of date. Run: npm run build");
      process.exit(1);
    }
    console.log("dist is up to date");
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, out);
    console.log(`Built dist/zen-ai-chat.uc.js (${out.split("\n").length} lines from ${MODULES.length} modules)`);
  }
}
