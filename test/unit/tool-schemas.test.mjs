// Every tool's input schema in a form both Claude and Gemini (Antigravity)
// take: Gemini refuses non-text enum values ("enum[0]: cannot be empty" for
// enum: [0, 1, 2], which broke every message in Antigravity chats) and type
// lists (type: ["string", "number"]); anyOf works for both.
import { checker, crash } from "../helpers/common.mjs";
import { AGENT_TOOLS, BROWSER_TOOLS, ZEN_TOOLS } from "../../src/config.mjs";

const { check, done } = checker();

(async () => {
  const problems = [];
  const walk = (s, path) => {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.enum) && s.enum.some((v) => typeof v !== "string")) problems.push(`${path}: enum must be text (${JSON.stringify(s.enum)})`);
    if (Array.isArray(s.type)) problems.push(`${path}: type must be one type; use anyOf (${JSON.stringify(s.type)})`);
    if (!s.type && !s.anyOf && path.includes(".")) problems.push(`${path}: needs a type or anyOf`);
    for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${path}.${k}`);
    if (s.items) walk(s.items, `${path}[]`);
    for (const [i, v] of (s.anyOf || []).entries()) walk(v, `${path}|${i}`);
  };
  const all = [...ZEN_TOOLS, ...BROWSER_TOOLS, ...AGENT_TOOLS];
  for (const t of all) walk(t.inputSchema, t.name);
  check(`all ${all.length} tool schemas suit Claude and Gemini`, problems.length === 0, problems);
  check("names are unique", new Set(all.map((t) => t.name)).size === all.length);
  done();
})().catch(crash);
