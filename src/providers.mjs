import { prefs } from "./config.mjs";
import { ClaudeSession, checkClaude, claudeCommand, findClaude } from "./session.mjs";
import { AcpSession } from "./acp.mjs";
import { AGY_DEFAULT_PATH, agyCommand, checkAgy, findAgy } from "./antigravity.mjs";

// CLI adapters share the panel's session contract. Antigravity verifies its
// version and isolated tool gate before starting any conversation.
export const PROVIDERS = Object.freeze([
  Object.freeze({ id: "claude", label: "Claude Code", ai: "Claude", Session: ClaudeSession,
    command: claudeCommand, check: checkClaude, find: findClaude, pathPref: "claudePath" }),
  Object.freeze({ id: "antigravity", label: "Antigravity", ai: "Antigravity", Session: AcpSession,
    command: agyCommand, check: checkAgy, find: findAgy, pathPref: "agyPath" }),
]);

export function providerModelPref(id) { return id === "claude" ? "model" : "model." + id; }
export function providerModelsPref(id) { return id === "claude" ? "models" : "models." + id; }

export async function installedProviders() {
  // Discovery is read-only and doesn't boot either agent. Starting/checking a
  // provider separately verifies the executable and supported protocol version.
  const found = [];
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  for (const provider of PROVIDERS) {
    let candidates = [prefs.get(provider.pathPref, "")];
    if (provider.id === "antigravity") {
      candidates.push(AGY_DEFAULT_PATH, "/usr/local/bin/agy", home + "/.local/bin/agy", home + "/.gemini/antigravity-cli/bin/agy");
    } else candidates.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude", home + "/.local/bin/claude", home + "/.claude/local/claude");
    for (const path of candidates.filter(Boolean)) {
      try { if ((await IOUtils.stat(path)).type === "regular") { found.push(provider.id); break; } } catch (e) {}
    }
  }
  return found;
}

// Missing means a legacy Claude chat. Preserve other provider IDs so reopening
// or deleting a chat never accidentally uses Claude's session/transcript.
export function chatProvider(value) {
  if (value == null || value === "") return "claude";
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : "unavailable";
}

export function providerInfo(id) {
  return PROVIDERS.find((provider) => provider.id === chatProvider(id)) || null;
}

export function defaultProvider() {
  return (providerInfo(prefs.get("provider", "claude")) || PROVIDERS[0]).id;
}

export function aiName(chat) {
  const id = chatProvider(chat && chat.provider);
  if (id === "antigravity") {
    const model = String((chat.session && (chat.session.resolvedModel || chat.session.model)) || chat.model || "");
    if (/^gemini(?:-|$)/i.test(model)) return "Gemini";
    if (/^claude(?:-|$)/i.test(model)) return "Claude";
    if (/^gpt(?:-|$)/i.test(model)) return "GPT";
    return "Antigravity";
  }
  return (providerInfo(id) || {}).ai || "AI";
}

// History from a newer build remains readable. Sending reports an error through
// the panel's normal send failure path; it must never fall back to another CLI.
class UnavailableProviderSession {
  constructor(id, handlers) {
    this.provider = id;
    this.handlers = handlers;
    this.proc = this.starting = this.sessionId = null;
    this.model = "default";
    this.effort = "medium";
    this.tainted = this.busy = this.needsRestart = false;
  }
  async ensureStarted() { throw new Error(`The ${this.provider} provider isn't available in this version of Zen AI.`); }
  async send() { await this.ensureStarted(); }
  stop() {}
  async kill() {}
  async reset() { this.sessionId = null; this.tainted = false; }
  setModel(model) { this.model = model || "default"; }
  setEffort(effort) { this.effort = effort; }
  setTainted(tainted) { this.tainted = tainted; }
  setChild() { this.child = true; }
  setAgentTools() {}
}

// options.child: a helper agent's session (see agent-runs.mjs)
export function createProviderSession(id, handlers, options = {}) {
  const provider = providerInfo(id);
  const session = provider ? new provider.Session(handlers) : new UnavailableProviderSession(chatProvider(id), handlers);
  if (options.child) session.setChild();
  return session;
}
