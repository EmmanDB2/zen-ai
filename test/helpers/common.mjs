// Shared bits for the test scripts. Each test is a plain Node script that
// prints PASS/FAIL lines and exits non-zero on failure (see test/run.mjs).
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const src = (name) => join(ROOT, "src", name);
export const dist = () => join(ROOT, "dist", "zen-ai-chat.uc.js");
export const fixture = (name) => join(ROOT, "test", "fixtures", "files", name);
export const pageUrl = (name) => pathToFileURL(join(ROOT, "test", "fixtures", "pages", name)).href;

// PASS/FAIL bookkeeping
export function checker() {
  let fails = 0;
  const check = (name, cond, extra) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  → " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : ""}`);
    if (!cond) fails++;
  };
  const done = () => {
    console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
    process.exit(fails ? 1 : 0);
  };
  return { check, done, get fails() { return fails; } };
}

export function crash(e) {
  console.log("CRASH", e);
  process.exit(1);
}

// The Claude Code binary for live tests
export function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try { return execSync("command -v claude", { encoding: "utf8" }).trim(); } catch (e) {}
  return "/opt/homebrew/bin/claude";
}

// HOME for live tests: your real one (your Claude login), unless ZENAI_TEST_HOME is set
export const testHome = () => process.env.ZENAI_TEST_HOME || homedir();

// Playwright's Chromium (run `npx playwright install chromium` once)
export async function launchChromium() {
  const { chromium } = await import("playwright");
  return chromium.launch();
}

// Runs the real page agent inside a Playwright page, the way the mod injects it
export async function pageAgentRunner(page) {
  const { pageAgent } = await import(pathToFileURL(src("page-agent.mjs")).href);
  const AGENT = pageAgent.toString();
  return (args) => page.evaluate(([s, a]) => (0, eval)("(" + s + ")")(window, a, null), [AGENT, args]);
}

// The fixture pages over http, under two sites: 127.0.0.1 (originA) and
// localhost (originB), so a frame can really be from another site. In .html
// files __OTHER__ becomes the other site's origin. Also serves node_modules/
// (fixtures load libraries from ../../../node_modules/). extra(req, res, url)
// can answer a request first (return true).
export async function servePages(extra = null) {
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
  const pages = join(ROOT, "test", "fixtures", "pages");
  const site = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (extra && extra(req, res, url)) return;
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = name.startsWith("node_modules/") ? join(ROOT, name) : join(pages, name);
    if (!name || name.includes("..") || !existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    let body = readFileSync(file);
    const other = (req.headers.host || "").startsWith("localhost") ? site.originA : site.originB;
    if (extname(file) === ".html") body = body.toString("utf8").replace(/__OTHER__/g, other);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  site.originA = `http://127.0.0.1:${port}`;
  site.originB = `http://localhost:${port}`;
  return { port, originA: site.originA, originB: site.originB, close: () => server.close() };
}
