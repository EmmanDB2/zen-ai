import { CLAUDE_ENV_PATH, ZEN_SERVER, systemPrompt } from "./config.mjs";
import { outputDir } from "./files.mjs";
import { Subprocess } from "./session.mjs";
import { AGY_APPROVABLE_TOOLS, prepareAgy } from "./antigravity.mjs";
import { MCP_LINE_LIMIT, createMcpBridge } from "./mcp-bridge.mjs";

export function toAcpBlocks(content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks) || !blocks.length) throw new Error("The message is empty.");
  const result = blocks.map((block, index) => {
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    const source = block.source || {};
    if (source.type !== "base64" || typeof source.data !== "string") throw new Error("Antigravity can't read this attachment format.");
    if (block.type === "image") return { type: "image", mimeType: source.media_type, data: source.data };
    if (block.type === "document" && source.media_type === "application/pdf") return {
      type: "resource", resource: { uri: "file:///zenai-attachment-" + index + ".pdf", mimeType: source.media_type, blob: source.data },
    };
    throw new Error("Antigravity can't read this attachment format.");
  });
  // ACP's slash expansion trims whitespace. Use a literal non-slash prefix,
  // not a leading space, for a prompt that would otherwise execute a command.
  const first = result.find((b) => b.type === "text");
  if (first && /^\s*\//.test(first.text)) first.text = "User message (literal text):\n" + first.text;
  return result;
}

export function acpPermission(toolCall = {}) {
  const name = String(toolCall.name || "");
  const raw = toolCall.rawInput || toolCall.args || {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = { ...raw };
  delete input.toolSummary;
  if (name.startsWith("mcp_zenai_")) return { tool_name: "mcp__zenai__" + name.slice(10), input, mcp: true };
  if (!AGY_APPROVABLE_TOOLS.includes(name)) return null;
  const path = input.Path || input.path || input.AbsolutePath || input.TargetFile || input.file_path;
  if (name === "run_command") return { tool_name: "Bash", input: { ...input, command: input.CommandLine || input.command, description: toolCall.title } };
  if (["read_file", "view_file"].includes(name)) return { tool_name: "Read", input: { ...input, file_path: path } };
  if (["write_file", "write_to_file"].includes(name)) return { tool_name: "Write", input: { ...input, file_path: path, content: input.Content || input.CodeContent || input.content } };
  if (["edit_file", "replace_file_content"].includes(name)) return { tool_name: "Edit", input: { ...input, file_path: path, old_string: input.TargetContent || input.old_string, new_string: input.ReplacementContent || input.new_string } };
  return { tool_name: name, input };
}

// Stable JSON keys bind each approval to exactly one call and its arguments.
export function acpCallKey(name, input) {
  const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  return JSON.stringify([name, stable(input || {})]);
}

export class AcpSession {
  constructor(handlers, { prepare = prepareAgy, bridge = createMcpBridge, subprocess = Subprocess } = {}) {
    this.handlers = handlers;
    this.prepare = prepare;
    this.makeBridge = bridge;
    this.subprocess = subprocess;
    this.proc = this.starting = this.sessionId = this.bridge = null;
    this.model = "default";
    this.effort = "medium";
    this.tainted = this.busy = this.needsRestart = this.loading = false;
    this.generation = this.ticket = this.requestId = 0;
    this.requests = new Map();
    this.permissions = new Map();
    this.grants = new Map();
    this.configQueue = Promise.resolve();
    this.options = [];
    this.stopping = null;
    this.stopTimer = null;
    this.contextTokens = 0;
    this.child = false;      // a helper agent: native tools refused whatever the taint
    this.agentTools = false; // the agent_* tools are listed
  }

  async ensureStarted() {
    if (this.starting) return this.starting;
    if (this.proc && !this.needsRestart) return;
    if (this.proc) {
      // A restart for a changed tool list: the message waiting for it still
      // goes out (kill() would otherwise cancel it like a Stop)
      const ticket = this.ticket;
      await this.kill();
      this.ticket = ticket;
    }
    const generation = ++this.generation;
    const starting = this.start(generation).finally(() => { if (this.starting === starting) this.starting = null; });
    this.starting = starting;
    return starting;
  }

  async start(generation) {
    let bridge, proc;
    const current = () => { if (generation !== this.generation) throw new Error("Antigravity startup was cancelled."); };
    try {
      const prepared = await this.prepare();
      current();
      const cwd = await outputDir();
      current();
      bridge = await this.makeBridge((message) => this.mcpMessage(message, generation), { onClosed: (e) => this.connectionFailed(e, generation) });
      current();
      proc = await this.subprocess.call({ command: prepared.command, arguments: prepared.arguments, workdir: cwd,
        environment: { PATH: CLAUDE_ENV_PATH, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, environmentAppend: true, stderr: "pipe" });
      current();
      this.proc = proc;
      this.bridge = bridge;
      this.loading = true;
      this.needsRestart = false;
      this.stderrTail = "";
      this.readOutput(proc, generation);
      this.readErrors(proc, generation);
      proc.wait().then(({ exitCode }) => this.connectionFailed(new Error(`Antigravity stopped (exit ${exitCode}). ${this.stderrTail || ""}`), generation), (e) => this.connectionFailed(e, generation));
      const init = await this.rpc("initialize", { protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "zenai", version: "1" } });
      current();
      if (init.protocolVersion !== 1) throw new Error("Antigravity's ACP protocol isn't supported by this version of Zen AI.");
      this.capabilities = init.agentCapabilities || {};
      const args = { cwd, mcpServers: [bridge.mcpServer], _meta: { antigravity: { systemPrompt: { append: systemPrompt("antigravity") } } } };
      let info;
      if (this.sessionId) {
        const caps = this.capabilities.sessionCapabilities || {};
        if (caps.resume) info = await this.rpc("session/resume", { ...args, sessionId: this.sessionId });
        else if (this.capabilities.loadSession) info = await this.rpc("session/load", { ...args, sessionId: this.sessionId });
        else throw new Error("This Antigravity version can't resume chats.");
      } else {
        info = await this.rpc("session/new", args);
        if (!info.sessionId || typeof info.sessionId !== "string") throw new Error("Antigravity didn't return a session ID.");
        this.sessionId = info.sessionId;
      }
      current();
      this.defaultModel = (info.models || {}).currentModelId;
      this.updateConfig(info.configOptions || [], false);
      this.defaultModel = this.defaultModel || this.resolvedModel;
      this.loading = false;
      // Let the panel replace a saved model that's no longer in the account's
      // list before set_config_option could reject it and prevent startup.
      this.notifyInit();
      await this.syncOptions();
      current();
      this.notifyInit();
    } catch (e) {
      if (generation === this.generation) {
        const gone = this.sessionId && /(?:session|conversation).*(?:not found|does not exist|unknown)|(?:unknown|missing|not found).*(?:session|conversation)/i.test(e.message);
        await this.kill();
        if (gone && this.handlers.onSessionGone) this.handlers.onSessionGone();
      }
      if (proc && proc !== this.proc) await proc.kill().catch(() => {});
      if (bridge) await bridge.close().catch(() => {});
      throw e;
    }
  }

  write(message) {
    if (!this.proc) return Promise.reject(new Error("Antigravity isn't running."));
    return this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  rpc(method, params, timeout = 60000) {
    const id = "zenai-" + (++this.requestId);
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.requests.delete(id); reject(new Error(`Antigravity timed out during ${method}.`)); }, timeout) : null;
      this.requests.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        clearTimeout(timer); this.requests.delete(id); reject(e);
      });
    });
  }

  async readOutput(proc, generation) {
    let buffer = "";
    try {
      for (;;) {
        const chunk = await proc.stdout.readString();
        if (!chunk || generation !== this.generation) break;
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          if (nl > MCP_LINE_LIMIT) throw new Error("Antigravity sent an oversized message.");
          const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
          if (line.trim()) this.handleMessage(JSON.parse(line), generation);
        }
        if (buffer.length > MCP_LINE_LIMIT) throw new Error("Antigravity sent an oversized message.");
      }
    } catch (e) { this.connectionFailed(e, generation); }
  }

  async readErrors(proc, generation) {
    try { for (;;) { const s = await proc.stderr.readString(); if (!s || generation !== this.generation) break; this.stderrTail = (this.stderrTail + s).slice(-1200); } } catch (e) {}
  }

  handleMessage(message, generation = this.generation) {
    if (generation !== this.generation || !message || message.jsonrpc !== "2.0") return;
    if (message.method && message.id != null) {
      if (message.method === "session/request_permission") this.requestPermission(message, generation);
      else this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Zen AI does not provide this client capability." } }).catch(() => {});
      return;
    }
    if (message.id != null) {
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id); clearTimeout(pending.timer);
      if (message.error) {
        const e = new Error(message.error.code === -32000 || /auth.*required|not authenticated|not signed in/i.test(message.error.message || "")
          ? "Antigravity isn't signed in. Open Terminal, run `agy`, and log in." : message.error.message || "Antigravity request failed.");
        e.code = message.error.code;
        pending.reject(e);
      } else pending.resolve(message.result || {});
      return;
    }
    const params = message.params || {};
    if (message.method !== "session/update" || this.loading || params.sessionId !== this.sessionId) return;
    const update = params.update || {};
    if (update.sessionUpdate === "config_option_update") { this.updateConfig(update.configOptions); return; }
    if (!this.busy || this.stopping) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content && update.content.type === "text") this.handlers.onText(update.content.text || "");
    if (update.sessionUpdate === "agent_thought_chunk" && !this.thinking) { this.thinking = true; if (this.handlers.onStatus) this.handlers.onStatus("Thinking…"); }
    if (update.sessionUpdate === "usage_update" && Number.isFinite(update.used)) {
      this.contextTokens = update.used;
      if (this.handlers.onUsage) this.handlers.onUsage({ context: update.used });
    }
  }

  async requestPermission(message, generation) {
    const params = message.params || {};
    const permission = acpPermission(params.toolCall);
    const originalKey = permission && permission.mcp ? acpCallKey(permission.tool_name.slice(12), permission.input) : null;
    const token = { generation, ticket: this.ticket };
    this.permissions.set(message.id, token);
    let allowed = false, input;
    try {
      if (permission && this.busy && !this.stopping && !this.loading && params.sessionId === this.sessionId &&
          (permission.mcp || (!this.tainted && !this.child))) {
        const result = await this.handlers.onPermission(permission, this.tainted);
        allowed = result && result.behavior === "allow";
        input = result && result.updatedInput || permission.input;
      }
    } catch (e) {}
    if (this.permissions.get(message.id) !== token || generation !== this.generation) return;
    this.permissions.delete(message.id);
    allowed = allowed && this.busy && !this.stopping && token.ticket === this.ticket && (permission.mcp || (!this.tainted && !this.child));
    const option = (params.options || []).find((o) => o.kind === (allowed ? "allow_once" : "reject_once"));
    // Never select allow_always or fall back to the first offered option.
    if (allowed && option && permission.mcp) {
      const key = originalKey;
      const grants = this.grants.get(key) || [];
      grants.push(input); this.grants.set(key, grants);
    }
    this.write({ jsonrpc: "2.0", id: message.id, result: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } }).catch(() => {});
  }

  async mcpMessage(message, generation = this.generation) {
    const fail = (text) => ({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text }] } });
    if (generation !== this.generation) return fail("This session has ended.");
    if (message.method === "tools/call") {
      if (!this.busy || this.stopping) return fail("The user stopped this reply.");
      const params = message.params || {};
      const key = acpCallKey(params.name, params.arguments);
      const grants = this.grants.get(key);
      if (!grants || !grants.length) return fail("This exact tool call has not been approved. Request permission first.");
      const approved = grants.shift();
      if (!grants.length) this.grants.delete(key);
      // ACP cannot return updatedInput. Apply the panel's sanitized arguments
      // here (e.g. dropping then_click when a protected field was left alone).
      message = { ...message, params: { ...params, arguments: approved } };
    }
    return this.handlers.onMcpMessage(ZEN_SERVER, message);
  }

  updateConfig(options, notify = true) {
    if (!Array.isArray(options)) return;
    this.options = options;
    const model = options.find((o) => o.id === "model");
    if (model) this.resolvedModel = model.currentValue;
    if (notify) this.notifyInit();
  }

  notifyInit() {
    if (!this.handlers.onInit) return;
    const model = this.options.find((o) => o.id === "model");
    const flatten = (items) => (items || []).flatMap((o) => Array.isArray(o.options) ? flatten(o.options) : typeof o.value === "string" ? [{ value: o.value, displayName: o.name || o.value, description: "" }] : []);
    const models = flatten(model && model.options);
    this.handlers.onInit({ models: [{ value: "default", displayName: "Default", description: "" }, ...models], currentModel: this.resolvedModel, configOptions: this.options });
  }

  syncOptions() {
    const generation = this.generation;
    this.configQueue = this.configQueue.catch(() => {}).then(async () => {
      if (!this.proc || this.loading || generation !== this.generation) return;
      for (const [configId, value] of [["model", this.model === "default" ? this.defaultModel : this.model], ["thought_level", this.effort]]) {
        const config = this.options.find((o) => o.id === configId);
        if (!config || !value || config.currentValue === value) continue;
        const result = await this.rpc("session/set_config_option", { sessionId: this.sessionId, configId, value });
        if (generation !== this.generation) return;
        this.updateConfig(result.configOptions || this.options);
      }
    });
    return this.configQueue;
  }

  async send(content) {
    const prompt = toAcpBlocks(content);
    const ticket = ++this.ticket;
    if (this.stopping) await this.stopping;
    await this.ensureStarted();
    if (ticket !== this.ticket) return;
    await this.syncOptions();
    if (ticket !== this.ticket || !this.proc) return;
    if (prompt.some((b) => b.type === "image") && !(this.capabilities.promptCapabilities || {}).image) throw new Error("This Antigravity version doesn't accept images.");
    if (prompt.some((b) => b.type === "resource") && !(this.capabilities.promptCapabilities || {}).embeddedContext) throw new Error("This Antigravity version doesn't accept PDFs.");
    const generation = this.generation;
    this.busy = true; this.thinking = false; this.grants.clear();
    try {
      const result = await this.rpc("session/prompt", { sessionId: this.sessionId, prompt }, 0);
      if (generation !== this.generation || ticket !== this.ticket) return;
      this.busy = false;
      if (result.stopReason === "end_turn") this.handlers.onDone({ subtype: "success", result: "", usage: result.usage || {}, contextTokens: this.contextTokens });
      else if (result.stopReason === "cancelled") this.handlers.onError("Antigravity cancelled the reply.");
      else this.handlers.onError(`Antigravity stopped: ${result.stopReason || "unknown reason"}.`);
    } catch (e) {
      if (generation === this.generation && ticket === this.ticket) { this.busy = false; throw e; }
    } finally {
      if (generation === this.generation) { this.grants.clear(); this.cancelPermissions(); this.finishStop(); }
    }
  }

  cancelPermissions() {
    for (const id of this.permissions.keys()) this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } }).catch(() => {});
    this.permissions.clear();
  }

  stop() {
    this.ticket++;
    this.grants.clear(); this.cancelPermissions();
    if (!this.proc || !this.busy || this.stopping) return;
    this.busy = false;
    this.stopping = new Promise((resolve) => { this.stopDone = resolve; });
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } }).catch(() => {});
    this.stopTimer = setTimeout(() => this.kill(), 4000);
  }

  finishStop() {
    clearTimeout(this.stopTimer); this.stopTimer = null;
    if (this.stopDone) this.stopDone();
    this.stopDone = this.stopping = null;
  }

  async kill() {
    this.cancelPermissions();
    this.generation++; this.ticket++;
    const proc = this.proc, bridge = this.bridge;
    this.proc = this.bridge = this.starting = null;
    this.busy = this.loading = false;
    this.grants.clear(); this.finishStop();
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error("Antigravity session ended.")); }
    this.requests.clear();
    if (proc) await proc.kill(500).catch(() => {});
    if (bridge) await bridge.close().catch(() => {});
  }

  connectionFailed(error, generation) {
    if (generation !== this.generation) return;
    const busy = this.busy;
    this.kill();
    if (busy) this.handlers.onError(error.message || String(error));
  }

  async reset() { await this.kill(); this.sessionId = null; this.tainted = false; }
  setModel(model) { this.model = model || "default"; }
  setEffort(effort) { this.effort = effort; }
  setTainted(tainted) { this.tainted = !!tainted; }
  // A helper agent's session: native shell/file requests are always refused
  setChild() { this.child = true; this.tainted = true; }
  // MCP tools are listed at session/new or resume: restart to change them
  setAgentTools(on) {
    if (!!on === this.agentTools) return;
    this.agentTools = !!on;
    if (this.proc) this.needsRestart = true;
  }
}
