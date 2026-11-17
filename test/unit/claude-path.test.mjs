// Where chats run Claude Code from: the path set in settings, else the usual
// Homebrew place, else the first real install found (and remembered).
import "../helpers/firefox.mjs";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checker, crash } from "../helpers/common.mjs";
import { prefs as prefStore, FAKE_HOME } from "../helpers/firefox.mjs";
import { claudeCommand } from "../../src/session.mjs";
import { CLAUDE_DEFAULT_PATH } from "../../src/config.mjs";

const { check, done } = checker();

const program = (rel, says) => {
  const p = join(FAKE_HOME, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `#!/bin/sh\necho "${says}"\n`);
  chmodSync(p, 0o755);
  return p;
};
const realExists = IOUtils.exists;

(async () => {
  const dirs = [".claude", ".local"].map((d) => join(FAKE_HOME, d));
  try {
    prefStore.set("zenai.claudePath", "/somewhere/claude");
    check("a path set in settings wins", (await claudeCommand()) === "/somewhere/claude");

    prefStore.delete("zenai.claudePath");
    check("no setting: the Homebrew place, if it's there", (await claudeCommand()) === CLAUDE_DEFAULT_PATH || !(await realExists(CLAUDE_DEFAULT_PATH)));

    // A Mac without Homebrew's Claude Code: the native installer's ~/.local/bin
    IOUtils.exists = async (p) => (p === CLAUDE_DEFAULT_PATH || p === "/usr/local/bin/claude" ? false : realExists(p));
    program(".claude/local/claude", "hello"); // something else called claude: skipped
    const native = program(".local/bin/claude", "2.1.296 (Claude Code)");
    const got = await claudeCommand();
    check("finds Claude Code in ~/.local/bin", got === native, got);
    check("remembers it in settings", prefStore.get("zenai.claudePath") === native);

    prefStore.delete("zenai.claudePath");
    rmSync(native);
    const none = await claudeCommand();
    check("nothing installed: falls back to the usual place (start then says how to fix it)", none === CLAUDE_DEFAULT_PATH, none);
    check("…and saves nothing", !prefStore.has("zenai.claudePath"));
  } finally {
    IOUtils.exists = realExists;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
  done();
})().catch(crash);
