import { Subprocess, prefs } from "../helpers/firefox.mjs";
import { checker, crash } from "../helpers/common.mjs";
import { SYSTEM_PROMPT, systemPrompt } from "../../src/config.mjs";
import { ClaudeSession } from "../../src/session.mjs";
import { PROVIDERS, aiName, chatProvider, createProviderSession, defaultProvider, providerInfo } from "../../src/providers.mjs";

const { check, done } = checker();

(async () => {
  check("only implemented providers are selectable", PROVIDERS.map((p) => p.id).join() === "claude,antigravity" && providerInfo("antigravity") !== null);
  check("legacy provider identity is Claude", chatProvider() === "claude" && chatProvider(null) === "claude" && chatProvider("") === "claude");
  check("unknown and malformed IDs cannot resolve to Claude", providerInfo("future-ai") === null && providerInfo("__proto__") === null && providerInfo({}) === null);
  prefs.set("zenai.provider", "future-ai");
  check("new chats use an available default", defaultProvider() === "claude");
  const handlers = {};
  const session = createProviderSession("claude", handlers);
  check("Claude uses the existing adapter and handlers", session instanceof ClaudeSession && session.handlers === handlers);
  check("Claude's system prompt is unchanged", systemPrompt("claude") === SYSTEM_PROMPT && systemPrompt() === SYSTEM_PROMPT);
  const prompt = systemPrompt("antigravity");
  const shared = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("Keep answers concise"));
  check("Antigravity keeps all shared instructions without Claude's identity", prompt.includes(shared) && !prompt.includes("made by Anthropic") && prompt.includes("mcp_zenai_*") && prompt.includes("Your own web search, fetch, browser"));
  check("model families determine Antigravity's name", ["gemini-test", "claude-test", "gpt-oss-test", "default"].map((model) => aiName({ provider: "antigravity", model })).join() === "Gemini,Claude,GPT,Antigravity");
  check("live session model wins over the saved model", aiName({ provider: "antigravity", model: "gemini-test", session: { model: "claude-test" } }) === "Claude" && aiName({}) === "Claude" && aiName({ provider: "future-ai" }) === "AI");

  const unavailable = createProviderSession("future-ai", handlers);
  unavailable.sessionId = "saved-session";
  unavailable.setModel("gemini-test");
  unavailable.setEffort("high");
  unavailable.setTainted(true);
  let error = "";
  try { await unavailable.send("private chat text"); } catch (e) { error = e.message; }
  check("unavailable adapters refuse to send without spawning any process", /future-ai.*isn't available/.test(error) && Subprocess.calls.length === 0 && !unavailable.proc && !unavailable.busy);
  check("unavailable chats retain model and safety state", unavailable.model === "gemini-test" && unavailable.effort === "high" && unavailable.tainted && unavailable.sessionId === "saved-session");
  unavailable.stop();
  await unavailable.kill();
  await unavailable.reset();
  check("unavailable adapters support panel cleanup", unavailable.sessionId === null && !unavailable.tainted);
  done();
})().catch(crash);
