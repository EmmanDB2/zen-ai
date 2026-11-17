// Runs the test scripts and summarizes. Each test is a standalone Node script
// that prints PASS/FAIL lines and exits non-zero on failure.
//
//   node test/run.mjs          offline tests: unit, ui (jsdom), browser (Playwright)
//   node test/run.mjs live     real Claude Code (uses your Claude usage!)
//   node test/run.mjs zen      in real Zen, headless, with a throwaway profile (free)
//   node test/run.mjs <file>   one test, full output
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers/common.mjs";

const arg = process.argv[2];
const dirFiles = (dir, suffix) => readdirSync(join(ROOT, "test", dir)).filter((f) => f.endsWith(suffix)).sort().map((f) => join(ROOT, "test", dir, f));
let files;
if (arg === "live") files = dirFiles("live", ".live.mjs");
else if (arg === "zen") files = dirFiles("zen", ".test.mjs");
else if (arg) files = [join(process.cwd(), arg)];
else files = [...dirFiles("unit", ".test.mjs"), ...dirFiles("ui", ".test.mjs"), ...dirFiles("browser", ".test.mjs")];

let failed = 0;
for (const file of files) {
  const name = relative(ROOT, file);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { encoding: "utf8", stdio: arg && arg !== "live" && arg !== "zen" ? "inherit" : "pipe", timeout: 10 * 60 * 1000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const passes = (out.match(/^PASS/gm) || []).length;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) {
    const skip = out.match(/^SKIP .*$/m);
    console.log(skip ? `- ${name}  (${skip[0].replace(/^SKIP\s+/, "skipped: ")})` : `✓ ${name}  (${passes} checks, ${secs}s)`);
    const bench = out.match(/^BENCH .*$/m);
    if (bench) console.log("  " + bench[0]);
  } else {
    failed++;
    console.log(`✗ ${name}  (exit ${r.status}, ${secs}s)`);
    const interesting = out.split("\n").filter((l) => /^(FAIL|CRASH|ERROR|PAGE ERROR|Error|timeout)/.test(l) || /Error:/.test(l));
    console.log((interesting.length ? interesting : out.trim().split("\n").slice(-15)).map((l) => "    " + l).join("\n"));
  }
}
console.log(failed ? `\n${failed} of ${files.length} test files failed` : `\nAll ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
