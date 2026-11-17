import { CLAUDE_ENV_PATH, prefs } from "./config.mjs";
import { Subprocess } from "./session.mjs";

export const AGY_DEFAULT_PATH = "/opt/homebrew/bin/agy";
export const AGY_VERIFIED_VERSION = "1.5.9";
// Search bypasses ACP approvals in 1.5.9 even with force_ask. Fail closed for
// it and every tool outside this small set; our browser tools provide web access.
export const AGY_APPROVABLE_TOOLS = ["read_file", "view_file", "write_file", "write_to_file", "edit_file", "replace_file_content", "multi_replace_file_content", "list_dir", "find_by_name", "grep_search", "run_command"];
export const AGY_GATE_SCRIPT = `#!/bin/sh
name=$(/usr/bin/plutil -extract toolCall.name raw -o - - 2>/dev/null) || name=''
case "$name" in
  mcp_zenai_*|${AGY_APPROVABLE_TOOLS.join("|")})
    /bin/echo '{"decision":"force_ask","reason":"Zen AI requires permission for this tool."}' ;;
  *)
    /bin/echo '{"decision":"deny","reason":"This built-in tool is disabled in Zen AI. Use Zen AI browser tools, or answer without it."}' ;;
esac
`;

async function agyInspect(path, args) {
  let proc, timer;
  try {
    proc = await Subprocess.call({ command: path, arguments: args, environment: { PATH: CLAUDE_ENV_PATH, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, environmentAppend: true, stderr: "stdout" });
    let text = "";
    const reading = (async () => { for (;;) { const s = await proc.stdout.readString(); if (!s) break; if (text.length < 40000) text += s; } })();
    const result = await Promise.race([proc.wait(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("It didn't answer within 10 seconds.")), 10000); })]);
    await reading;
    return { text, exitCode: result.exitCode };
  } finally { clearTimeout(timer); if (proc) await proc.kill().catch(() => {}); }
}

export async function checkAgy(path) {
  if (!path || !(await IOUtils.exists(path).catch(() => false))) return { ok: false, why: "There's nothing at that path." };
  try {
    const version = await agyInspect(path, ["--version"]);
    const help = await agyInspect(path, ["acp", "--help"]);
    const number = (version.text.match(/\b\d+\.\d+\.\d+\b/) || [])[0];
    if (version.exitCode || help.exitCode || !number || !/antigravity acp/i.test(help.text)) return { ok: false, why: "It isn't Antigravity CLI with ACP support." };
    if (number !== AGY_VERIFIED_VERSION) return { ok: false, version: number, why: `Antigravity ${number} hasn't been verified with Zen AI's permission controls. This build supports ${AGY_VERIFIED_VERSION}.` };
    return { ok: true, version: number };
  } catch (e) { return { ok: false, why: e.message || "That file can't be run." }; }
}

export async function findAgy() {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const places = [AGY_DEFAULT_PATH, "/usr/local/bin/agy", home + "/.local/bin/agy", home + "/.gemini/antigravity-cli/bin/agy"];
  try { const p = await Subprocess.pathSearch("agy", { PATH: CLAUDE_ENV_PATH }); if (p && !places.includes(p)) places.unshift(p); } catch (e) {}
  for (const p of places) if ((await checkAgy(p)).ok) return p;
  return "";
}

export async function agyCommand() {
  const chosen = prefs.get("agyPath", "");
  if (chosen) return chosen;
  const found = await findAgy();
  if (!found) throw new Error("Antigravity CLI wasn't found. Install it and choose its location in Zen's settings → Zen AI.");
  prefs.set("agyPath", found);
  return found;
}

// Zen owns these files. Never edit the user's global settings/customizations.
export async function prepareAgy() {
  const command = await agyCommand();
  const checked = await checkAgy(command);
  if (!checked.ok) throw new Error(checked.why);
  let namespace = prefs.get("antigravity.configId", "");
  if (!/^zenai-[a-f0-9]{32}$/.test(namespace)) {
    namespace = "zenai-" + crypto.randomUUID().replace(/-/g, "");
    prefs.set("antigravity.configId", namespace);
  }
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const dir = PathUtils.join(home, ".gemini", "antigravity-cli", namespace);
  await IOUtils.makeDirectory(dir, { permissions: 0o700 });
  await IOUtils.setPermissions(dir, 0o700);
  const gate = PathUtils.join(dir, "tool-gate.sh");
  const hooks = PathUtils.join(dir, "hooks.json");
  const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  const files = [
    [gate, AGY_GATE_SCRIPT],
    [hooks, JSON.stringify({ "zenai-permissions": { PreToolUse: [{ matcher: "*", hooks: [{ command: "/bin/sh " + quote(gate), timeout: 5 }] }] } })],
    [PathUtils.join(dir, "settings.json"), JSON.stringify({ toolPermission: "strict", defaultHooksPath: hooks, disableSlashCommands: true })],
  ];
  for (const [path, text] of files) {
    if (await IOUtils.readUTF8(path).catch(() => "") !== text) await IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp-" + crypto.randomUUID() });
    await IOUtils.setPermissions(path, 0o600);
  }
  return { command, arguments: ["acp", "--cli_dir_name", namespace, "--include-default-customizations=false", "--disable-telemetry"], configDir: dir };
}
