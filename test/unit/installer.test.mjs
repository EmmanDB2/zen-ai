// The friend kit's installer (kit/Install Zen AI.command), run against a fake
// Zen.app, profile folder and Claude Code in a temp folder. Never touches the
// real Zen, profile or System Settings.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, checker, crash } from "../helpers/common.mjs";

const { check, done } = checker();
const FX = process.env.FX_AUTOCONFIG || join(homedir(), "fx-autoconfig");
if (!existsSync(join(FX, "profile/chrome/utils/boot.sys.mjs")) || !existsSync(join(FX, "program/config.js"))) {
  console.log(`SKIP fx-autoconfig isn't at ${FX}`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "zenai-kit-"));
const read = (p) => readFileSync(p, "utf8");

// The kit, laid out as scripts/kit.mjs makes it
const KIT = join(tmp, "Zen AI");
const files = join(KIT, "files");
mkdirSync(join(files, "fx-autoconfig/program/defaults/pref"), { recursive: true });
mkdirSync(join(files, "fx-autoconfig/profile/chrome"), { recursive: true });
cpSync(join(ROOT, "dist/zen-ai-chat.uc.js"), join(files, "zen-ai-chat.uc.js"));
cpSync(join(FX, "program/config.js"), join(files, "fx-autoconfig/program/config.js"));
cpSync(join(FX, "program/defaults/pref/config-prefs.js"), join(files, "fx-autoconfig/program/defaults/pref/config-prefs.js"));
cpSync(join(FX, "profile/chrome/utils"), join(files, "fx-autoconfig/profile/chrome/utils"), { recursive: true });
const INSTALLER = join(KIT, "Install Zen AI.command");
cpSync(join(ROOT, "kit/Install Zen AI.command"), INSTALLER);

// A fake Claude Code: `--version`, and `auth status` saying signed in or not
function fakeClaude(name, signedIn) {
  const p = join(tmp, name);
  writeFileSync(p, `#!/bin/sh
case "$1" in
  --version) echo "2.1.296 (Claude Code)" ;;
  auth) echo '{ "loggedIn": ${signedIn}, "authMethod": "claude.ai" }' ;;
esac
`);
  chmodSync(p, 0o755);
  return p;
}
const signedIn = fakeClaude("claude-in", true);
const signedOut = fakeClaude("claude-out", false);

// A fresh fake Mac: Zen.app without the loader, a profile named like Zen's
function mac({ ini = "install", oldUtils = false } = {}) {
  const base = mkdtempSync(join(tmp, "mac-"));
  const app = join(base, "Zen.app");
  mkdirSync(join(app, "Contents/Resources/defaults/pref"), { recursive: true });
  const support = join(base, "support");
  const name = "a1b2c3d4.Default (release)";
  const profile = join(support, "Profiles", name);
  mkdirSync(join(profile, "chrome"), { recursive: true });
  mkdirSync(join(support, "Profiles", "ij5m1zz9.Default Profile"), { recursive: true });
  if (ini === "install") {
    writeFileSync(join(support, "profiles.ini"), `[General]\nStartWithLastProfile=1\n\n[Profile1]\nName=Default Profile\nIsRelative=1\nPath=Profiles/ij5m1zz9.Default Profile\nDefault=1\n\n[Profile0]\nName=Default (release)\nIsRelative=1\nPath=Profiles/${name}\n\n[Install6ED35B3CA1B5D3AF]\nDefault=Profiles/${name}\nLocked=1\n`);
  } else if (ini === "default") {
    writeFileSync(join(support, "profiles.ini"), `[Profile0]\nName=Other\nIsRelative=1\nPath=Profiles/ij5m1zz9.Default Profile\n\n[Profile1]\nName=Default (release)\nIsRelative=1\nPath=Profiles/${name}\nDefault=1\n`);
  }
  const cache = join(base, "cache");
  mkdirSync(join(cache, "Profiles", name, "startupCache"), { recursive: true });
  writeFileSync(join(cache, "Profiles", name, "startupCache/scriptCache.bin"), "old");
  if (oldUtils) {
    mkdirSync(join(profile, "chrome/utils"), { recursive: true });
    writeFileSync(join(profile, "chrome/utils/boot.sys.mjs"), "// an older fx-autoconfig");
  }
  return { base, app, support, profile, cache: join(cache, "Profiles", name, "startupCache"), res: join(app, "Contents/Resources") };
}

function run(m, { args = [], input = "", claude = signedIn, yes = true } = {}) {
  const r = spawnSync("bash", [INSTALLER, ...args], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      ZEN_APP: m.app, ZEN_SUPPORT: m.support, ZEN_CACHE: join(m.base, "cache"),
      ZEN_PROCESS: "no-such-process-zenai", ZENAI_CLAUDE_PLACES: claude, ZENAI_NO_OPEN: "1",
      ...(yes ? { ZENAI_YES: "1" } : {}),
    },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}
const mod = (m) => join(m.profile, "chrome/JS/zen-ai-chat.uc.js");
const backups = (m) => readdirSync(join(m.profile, "chrome")).filter((f) => f.startsWith("utils.before-zen-ai-"));

try {
  // A first install
  let m = mac();
  let r = run(m);
  check("installs (exit 0)", r.code === 0, r.out);
  check("picks the profile Zen opens ([Install…] Default=, with spaces in its name)", r.out.includes(`Profile: ${m.profile}`), r.out);
  check("puts the loader into Zen.app", read(join(m.res, "config.js")) === read(join(FX, "program/config.js")) && existsSync(join(m.res, "defaults/pref/config-prefs.js")));
  check("copies the loader's profile part", read(join(m.profile, "chrome/utils/boot.sys.mjs")) === read(join(FX, "profile/chrome/utils/boot.sys.mjs")));
  check("installs the mod (same as dist)", existsSync(mod(m)) && read(mod(m)) === read(join(ROOT, "dist/zen-ai-chat.uc.js")));
  check("clears Zen's startup cache", !existsSync(m.cache));
  check("finds Claude Code and sees it's signed in", r.out.includes("Found 2.1.296 (Claude Code)") && r.out.includes("Signed in."), r.out);

  // Again (after an update of the kit, or by accident): nothing breaks
  r = run(m);
  check("running it again is fine", r.code === 0 && r.out.includes("Already in Zen.app.") && backups(m).length === 0, r.out);

  // Another fx-autoconfig version was there: kept aside, replaced
  m = mac({ oldUtils: true });
  r = run(m);
  check("an older loader in the profile is kept aside and replaced", r.code === 0 && backups(m).length === 1 && read(join(m.profile, "chrome/utils/boot.sys.mjs")) !== "// an older fx-autoconfig", r.out);

  // No [Install…] section: the Default=1 profile
  m = mac({ ini: "default" });
  r = run(m);
  check("falls back to the Default=1 profile", r.code === 0 && existsSync(mod(m)), r.out);

  // Zen never opened: no profile yet
  m = mac({ ini: "none" });
  r = run(m);
  check("no profile yet: says to open Zen once", r.code === 1 && r.out.includes("Open Zen once"), r.out);

  // macOS refuses to let Terminal change Zen.app (no App Management yet)
  m = mac();
  execFileSync("chmod", ["-R", "a-w", m.res]);
  r = run(m);
  execFileSync("chmod", ["-R", "u+w", m.res]);
  check("Zen.app not writable: points at App Management, installs nothing", r.code === 1 && r.out.includes("App Management") && !existsSync(mod(m)), r.out);

  // No Claude Code, and the user says no to installing it
  m = mac();
  r = run(m, { claude: join(tmp, "nowhere/claude"), input: "n\n", yes: false });
  check("no Claude Code: offers to install it", r.out.includes("Install it now"), r.out);
  check("…says no: installs Zen AI anyway and says what's missing", r.code === 0 && existsSync(mod(m)) && r.out.includes("won't start until Claude Code is"), r.out);

  // Claude Code signed out, and the user says not now
  m = mac();
  r = run(m, { claude: signedOut, input: "n\n", yes: false });
  check("signed out: offers to sign in, says how to later", r.code === 0 && r.out.includes("isn't signed in") && r.out.includes("claude auth login"), r.out);

  // Downloaded kits are quarantined: the installer clears that
  execFileSync("xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", join(files, "zen-ai-chat.uc.js")]);
  m = mac();
  r = run(m);
  const xattrs = spawnSync("xattr", [join(files, "zen-ai-chat.uc.js")], { encoding: "utf8" }).stdout;
  check("clears the download quarantine", r.code === 0 && !xattrs.includes("quarantine"), xattrs);

  // Taking it out again
  r = run(m, { args: ["--remove"] });
  check("--remove takes the mod out", r.code === 0 && !existsSync(mod(m)) && existsSync(join(m.profile, "chrome/utils")), r.out);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
done();
