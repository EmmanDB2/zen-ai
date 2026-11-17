// Skill-file writes in real Zen (real IOUtils/PathUtils in the throwaway
// profile): a backup in _backups/, only the newest few kept, the new text
// written, Undo restoring it, and paths outside the skills folder refused.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, checker, crash } from "../helpers/common.mjs";
import { realZen, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen();
  // The built mod keeps its functions to itself, so load the real modules
  // (src/skills.mjs and what it imports) into Zen and call them
  const src = (name) => readFileSync(join(ROOT, "src", name), "utf8").replace(/from "\.\/(\w[\w-]*)\.mjs"/g, 'from "./$1.sys.mjs"');
  try {
    const r = await zen.chrome(async (config, skills) => {
      const dirOf = PathUtils.join(PathUtils.profileDir, "chrome", "JS", "cmd");
      await IOUtils.writeUTF8(PathUtils.join(dirOf, "config.sys.mjs"), config);
      await IOUtils.writeUTF8(PathUtils.join(dirOf, "skills.sys.mjs"), skills);
      const { writeSkillFile, restoreBackup, skillsDir } = ChromeUtils.importESModule("chrome://userscripts/content/cmd/skills.sys.mjs");
      const out = { here: typeof writeSkillFile === "function" };
      const dir = skillsDir();
      const rel = "Home/Recipes/demo.md";
      const path = PathUtils.join(dir, "Home", "Recipes", "demo.md");
      await IOUtils.makeDirectory(PathUtils.join(dir, "Home", "Recipes"), { createAncestors: true, ignoreExisting: true });
      await IOUtils.writeUTF8(path, "v0");
      const names = [];
      for (let i = 1; i <= 4; i++) {
        names.push(await writeSkillFile(rel, "v" + i, 3));
        await new Promise((res) => setTimeout(res, 1050)); // backup names go by the second
      }
      const backups = (await IOUtils.getChildren(PathUtils.join(dir, "_backups"))).map((p) => PathUtils.filename(p)).sort();
      out.now = await IOUtils.readUTF8(path);
      out.backups = backups;
      out.backupTexts = await Promise.all(backups.map((b) => IOUtils.readUTF8(PathUtils.join(dir, "_backups", b))));
      out.noTmp = !(await IOUtils.exists(path + ".tmp"));
      await restoreBackup(rel, names[names.length - 1]);
      out.afterUndo = await IOUtils.readUTF8(path);
      // A new data file (no old one: no backup)
      out.newFile = await writeSkillFile("_projects.md", "# Projects", 3);
      out.newText = await IOUtils.readUTF8(PathUtils.join(dir, "_projects.md"));
      out.refused = [];
      for (const bad of ["../prefs.md", "_secrets.md", "_backups/x.md", "Home/_x/y.md", ".hidden.md", "x.txt", "/etc/passwd"]) {
        try { await writeSkillFile(bad, "no", 3); out.refused.push(bad + ":written"); } catch (e) { out.refused.push(bad + ":refused"); }
      }
      try { await restoreBackup(rel, "_about-me.2026-01-01-000000.md"); out.foreign = "restored"; } catch (e) { out.foreign = "refused"; }
      return out;
    }, src("config.mjs"), src("skills.mjs"));
    check("the mod's file functions are there", r.here, r);
    check("writes the new text, no temp file left", r.now === "v4" && r.noTmp, r);
    check("keeps only the newest 3 backups, named by file and time", r.backups.length === 3 && r.backups.every((b) => /^Home__Recipes__demo\.\d{4}-\d\d-\d\d-\d{6}\.md$/.test(b)) && r.backupTexts.join() === "v1,v2,v3", r.backups);
    check("Undo puts the last backup back", r.afterUndo === "v3", r.afterUndo);
    check("a new file is written without a backup", r.newFile === "" && r.newText === "# Projects");
    check("never outside the skills folder, never _secrets.md or _backups/", r.refused.every((x) => x.endsWith(":refused")), r.refused);
    check("Undo only takes this file's backups", r.foreign === "refused");
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
