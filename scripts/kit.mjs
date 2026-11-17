// Builds "Zen AI <version>.zip" for giving to a friend: the built mod,
// fx-autoconfig's two parts, the double-click installer and a read-me.
//
//   npm run kit                       → out/Zen AI <version>.zip
//   FX_AUTOCONFIG=~/somewhere npm run kit
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FX = process.env.FX_AUTOCONFIG || join(homedir(), "fx-autoconfig");
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// dist/ must match src/ (build.mjs --check exits non-zero otherwise)
execFileSync(process.execPath, [join(ROOT, "scripts/build.mjs"), "--check"], { stdio: "inherit" });

const need = ["program/config.js", "program/defaults/pref/config-prefs.js", "profile/chrome/utils/boot.sys.mjs", "LICENSE"];
const missing = need.filter((f) => !existsSync(join(FX, f)));
if (missing.length) {
  console.error(`fx-autoconfig isn't complete at ${FX} (missing ${missing.join(", ")}). Clone github.com/MrOtherGuy/fx-autoconfig or set FX_AUTOCONFIG.`);
  process.exit(1);
}

const OUT = join(ROOT, "out");
const folder = join(OUT, "Zen AI");
const zip = join(OUT, `Zen AI ${version}.zip`);
rmSync(folder, { recursive: true, force: true });
rmSync(zip, { force: true });

const files = join(folder, "files");
const fx = join(files, "fx-autoconfig");
mkdirSync(join(fx, "program/defaults/pref"), { recursive: true });
mkdirSync(join(fx, "profile/chrome"), { recursive: true });
cpSync(join(ROOT, "dist/zen-ai-chat.uc.js"), join(files, "zen-ai-chat.uc.js"));
// Only the loader's own files (program/ may hold other things)
cpSync(join(FX, "program/config.js"), join(fx, "program/config.js"));
cpSync(join(FX, "program/defaults/pref/config-prefs.js"), join(fx, "program/defaults/pref/config-prefs.js"));
cpSync(join(FX, "profile/chrome/utils"), join(fx, "profile/chrome/utils"), { recursive: true });
cpSync(join(FX, "LICENSE"), join(fx, "LICENSE"));
cpSync(join(ROOT, "kit/Install Zen AI.command"), join(folder, "Install Zen AI.command"));
chmodSync(join(folder, "Install Zen AI.command"), 0o755);
cpSync(join(ROOT, "kit/Read me first.txt"), join(folder, "Read me first.txt"));

// ditto keeps the installer's "can run" bit, which Finder's unzip honours
execFileSync("ditto", ["-c", "-k", "--keepParent", "--norsrc", "--noextattr", folder, zip]);
console.log(`Built ${zip.slice(ROOT.length + 1)}`);
