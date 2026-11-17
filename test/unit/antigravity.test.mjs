import { prefs, FAKE_HOME } from "../helpers/firefox.mjs";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AGY_GATE_SCRIPT, AGY_APPROVABLE_TOOLS, checkAgy, prepareAgy } from "../../src/antigravity.mjs";
import { checker, crash } from "../helpers/common.mjs";
const { check, done } = checker();

(async () => {
  const temp = mkdtempSync(join(tmpdir(), "zenai-agy-test-"));
  let configDir;
  const cli = join(temp, "agy");
  const makeCli = (version, help = "Usage: antigravity acp") => {
    writeFileSync(cli, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; else echo '${help}'; fi\n`);
    chmodSync(cli, 0o755);
  };
  try {
    check("missing executable reports a useful error", !(await checkAgy(join(temp, "missing"))).ok);
    makeCli("1.5.9", "unrelated executable");
    check("a matching version alone is not an Antigravity CLI", !(await checkAgy(cli)).ok);
    makeCli("1.6.0");
    const newer = await checkAgy(cli);
    check("unverified versions fail closed", !newer.ok && /permission controls/.test(newer.why));
    makeCli("1.5.9");
    check("the verified CLI is accepted", (await checkAgy(cli)).ok);
    prefs.set("zenai.agyPath", cli);
    prefs.set("zenai.antigravity.configId", "../global");
    IOUtils.setPermissions = async (path, mode) => chmodSync(path, mode);
    const prepared = await prepareAgy();
    configDir = prepared.configDir;
    const namespace = prefs.get("zenai.antigravity.configId");
    check("unsafe namespace is replaced with a profile-owned one", /^zenai-[a-f0-9]{32}$/.test(namespace) && configDir === join(FAKE_HOME, ".gemini/antigravity-cli", namespace));
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    const hooks = JSON.parse(readFileSync(settings.defaultHooksPath, "utf8"));
    check("strict settings load only the explicit gate while default customizations are off", settings.toolPermission === "strict" && settings.disableSlashCommands && prepared.arguments.includes("--include-default-customizations=false") && hooks["zenai-permissions"].PreToolUse[0].matcher === "*");
    check("config folder and files are private", (statSync(configDir).mode & 0o777) === 0o700 && ["settings.json", "hooks.json", "tool-gate.sh"].every((name) => (statSync(join(configDir, name)).mode & 0o777) === 0o600));
    check("repeated startup retains its own namespace", (await prepareAgy()).configDir === configDir);
    if (process.platform === "darwin" && existsSync("/usr/bin/plutil")) {
      const gate = (input) => JSON.parse(spawnSync("/bin/sh", ["-c", AGY_GATE_SCRIPT], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" }).stdout).decision;
      check("the executable gate asks for every supported native tool and Zen MCP", [...AGY_APPROVABLE_TOOLS, "mcp_zenai_browser_click"].every((name) => gate({ toolCall: { name } }) === "force_ask"));
      check("search, fetch, browser, scheduling, subagents and unknown tools are denied before execution", ["search_web", "read_url_content", "browser_subagent", "schedule_task", "task", "new_tool", "mcp_other_browser_click"].every((name) => gate({ toolCall: { name } }) === "deny"));
      check("malformed hook input fails closed", gate("bad json") === "deny" && gate({}) === "deny");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  }
  done();
})().catch(crash);
