// Real Antigravity + real Gecko socket, in a throwaway Zen profile. Uses the
// user's Antigravity login/quota. No edits to the user's global CLI settings.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checker, crash } from "../helpers/common.mjs";
import { realZen, zenMissing, sleep } from "../helpers/real-zen.mjs";
const { check, done } = checker();
const bin = process.env.AGY_BIN || "/opt/homebrew/bin/agy";
if (!existsSync(bin) || zenMissing()) { console.log("SKIP " + (zenMissing() || "Antigravity CLI is not installed")); process.exit(0); }

(async () => {
  const zen = await realZen({ claude: "real", prefs: { "zenai.provider": "antigravity", "zenai.agyPath": bin, "zenai.model.antigravity": "gemini-3.8-flash" }, timeoutMs: 90000 });
  let namespace = "", saved = "";
  const send = async (text) => { await zen.send(text, { wait: false }); await zen.until(async () => !(await zen.chrome(() => !!document.querySelector(".zai-send.zai-stop"))), 90000, "Antigravity to finish"); };
  try {
    await zen.openTab(zen.page("form.html"));
    await zen.open();
    await send("Reply with exactly ZENAI_ACP_OK. Do not call any tools.");
    const errors = await zen.$$text(".zai-error");
    check("live Antigravity streams a reply", (await zen.$$text(".zai-assistant .zai-seg")).join(" ").includes("ZENAI_ACP_OK") && !errors.length, errors);
    if (errors.length) throw new Error(errors.join("\n"));
    const name = "zenai-acp-live-" + Date.now() + ".txt";
    await send(`Use mcp_zenai_save_file to save a text file named ${name} containing exactly ZENAI_MCP_OK. Do not use built-in file or shell tools.`);
    saved = join(homedir(), "Documents", "Claude Output", name);
    check("live MCP save_file writes the expected content", existsSync(saved) && readFileSync(saved, "utf8") === "ZENAI_MCP_OK", await zen.$$text(".zai-error"));
    // Supply a deterministic button on a local fixture page (no external action).
    await zen.inPage((win) => { win.document.body.innerHTML = '<button id="zenai-acp-next" onclick="this.textContent=\'Done\'">ZenAI test next</button>'; return true; });
    await zen.send("Use browser_read, then browser_click to click the button named ZenAI test next. Ask for permission as usual.", { wait: false });
    const card = await zen.approve("once", 60000);
    check("live browser action asks for approval", /ZenAI test next/.test(card.title), card);
    await zen.until(async () => !(await zen.chrome(() => !!document.querySelector(".zai-send.zai-stop"))), 60000, "the click turn to finish");
    check("approved live browser action runs", await zen.inPage((win) => win.document.getElementById("zenai-acp-next").textContent) === "Done");
    await zen.send("Write a very long numbered list from 1 to 1000.", { wait: false });
    await sleep(500);
    await zen.chrome(() => document.querySelector(".zai-send.zai-stop").click());
    await sleep(500);
    check("Stop ends the live reply", !(await zen.chrome(() => !!document.querySelector(".zai-send.zai-stop"))));
    await send("Reply with exactly AFTER_STOP. No tools.");
    check("another live turn works after Stop", (await zen.$$text(".zai-assistant .zai-seg")).join(" ").includes("AFTER_STOP"));
    await sleep(400);
    const sid = await zen.chrome(async () => JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "zen-ai", "chats", "index.json"))).chats[0].sessionId);
    await zen.chrome(() => document.querySelector('.zai-header [aria-label="New chat"]').click());
    await zen.chrome(() => document.querySelector('.zai-header [aria-label="Chat history"]').click());
    await zen.until(() => zen.chrome(() => !!document.querySelector(".zai-hist-row")), 5000, "the saved chat");
    await zen.chrome(() => document.querySelector(".zai-hist-row").click());
    await send("What exact token did you use in your very first reply in this conversation? Reply with only that token, no tools.");
    check("reopened live chat resumes its original memory", (await zen.$$text(".zai-assistant .zai-seg")).at(-1).includes("ZENAI_ACP_OK"));
    await sleep(400);
    check("resume preserves the original session ID", await zen.chrome(async (id) => JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "zen-ai", "chats", "index.json"))).chats[0].sessionId === id, sid));
    check("no errors in Zen's console", zen.errors().length === 0, zen.errors());
  } catch (e) {
    console.log(zen.log().split("\n").filter((line) => /Zen AI|Error:/.test(line)).join("\n"));
    throw e;
  } finally {
    namespace = await zen.chrome(() => Services.prefs.getStringPref("zenai.antigravity.configId", "")).catch(() => "");
    await zen.quit();
    if (saved && existsSync(saved)) rmSync(saved);
    if (/^zenai-[a-f0-9]{32}$/.test(namespace)) rmSync(join(homedir(), ".gemini", "antigravity-cli", namespace), { recursive: true, force: true });
  }
  done();
})().catch(crash);
