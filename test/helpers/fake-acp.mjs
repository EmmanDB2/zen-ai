// An ACP peer for adapter and built-panel tests. Transport is injected; the
// actual Unix socket is covered separately in real Zen.
//
// Several sessions at once (a chat and its agents): each bridge gets its own
// mcpServer (args ["-U", "/fake/sock-N"]), and a process that starts or
// resumes a session with it gets proc.bridge, so callTool / listTools can
// take a proc. replyFor(text, proc) → the reply (or a Promise of it).
let acpSessionCount = 0;
let acpBridgeCount = 0;
export function fakeAcp({ transcripts = new Set(), replyMs = 40, holdReplies = false, replyFor = null } = {}) {
  const procs = [], bridges = [], sent = [], calls = [], answers = new Map();
  let permissionId = 0, toolId = 0;
  const promptText = (prompt) => (prompt.params.prompt || []).map((b) => b.text || "").join("");
  // A bridge, or a proc (its own bridge)
  const bridgeOf = (target) => (target && target.onMessage ? target : target && target.bridge);
  const options = () => [
    { id: "model", currentValue: "gemini-test", options: [{ value: "gemini-test", name: "Gemini Test" }, { value: "claude-test", name: "Claude Test" }] },
    { id: "thought_level", currentValue: "medium", options: ["low", "medium", "high"].map((value) => ({ value, name: value })) },
  ];
  const fixture = {
    procs, bridges, sent, calls,
    prepare: async () => ({ command: "/fake/agy", arguments: ["acp"] }),
    async bridge(onMessage, options) {
      const bridge = { closed: false, onMessage, onClosed: options.onClosed, mcpServer: { name: "zenai", command: "/fake/nc", args: ["-U", `/fake/sock-${++acpBridgeCount}`], env: [] }, async close() { this.closed = true; } };
      bridges.push(bridge); return bridge;
    },
    subprocess: { async call(opts) {
      const out = [];
      let waiter, exitResolve;
      const exited = new Promise((r) => { exitResolve = r; });
      const proc = { killed: false, opts, config: options(), timers: [], prompt: null, sessionId: null };
      const push = (m) => { if (!proc.killed) { out.push(JSON.stringify(m) + "\n"); if (waiter) { waiter(); waiter = null; } } };
      proc.push = push;
      proc.update = (update) => push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: proc.sessionId, update } });
      const result = (id, value) => push({ jsonrpc: "2.0", id, result: value });
      const end = (prompt, stopReason, text) => {
        if (stopReason === "end_turn") {
          proc.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
          proc.update({ sessionUpdate: "usage_update", used: 12345, size: 1000000 });
        }
        result(prompt.id, { stopReason, usage: { inputTokens: 100, outputTokens: 20 } }); proc.prompt = null;
      };
      proc.finish = (stopReason = "end_turn") => {
        proc.timers.forEach(clearTimeout); proc.timers = [];
        const prompt = proc.prompt;
        if (!prompt) return;
        if (stopReason !== "end_turn") { end(prompt, stopReason); return; }
        if (prompt.replying) return; // replyFor's Promise is still pending
        const reply = replyFor ? replyFor(promptText(prompt), proc) : null;
        if (!reply || typeof reply.then !== "function") { end(prompt, stopReason, reply || "Reply from Antigravity"); return; }
        // A Promise: the turn ends when it settles, unless cancelled first
        prompt.replying = true;
        reply.then((text) => { if (proc.prompt === prompt) end(prompt, stopReason, text || "Reply from Antigravity"); });
      };
      proc.stdin = { async write(line) {
        const message = JSON.parse(line); calls.push(message);
        if (!message.method && answers.has(message.id)) { answers.get(message.id)(message.result); answers.delete(message.id); return; }
        const p = message.params || {};
        if (message.method === "initialize") result(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, promptCapabilities: { image: true, embeddedContext: true } } });
        else if (["session/new", "session/resume", "session/load"].includes(message.method)) {
          const server = (p.mcpServers || [])[0];
          const bridge = server && bridges.find((b) => JSON.stringify(b.mcpServer.args) === JSON.stringify(server.args));
          if (bridge) proc.bridge = bridge;
          if (p.sessionId && !transcripts.has(p.sessionId)) { push({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Session not found" } }); return; }
          proc.sessionId = p.sessionId || `ac000000-0000-4000-8000-${String(++acpSessionCount).padStart(12, "0")}`;
          transcripts.add(proc.sessionId);
          if (message.method === "session/load") proc.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Replayed history must not appear" } });
          result(message.id, { sessionId: proc.sessionId, configOptions: proc.config });
        } else if (message.method === "session/set_config_option") {
          proc.config.find((o) => o.id === p.configId).currentValue = p.value;
          result(message.id, { configOptions: proc.config });
        } else if (message.method === "session/prompt") {
          proc.prompt = message; sent.push({ ...p, proc });
          proc.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private reasoning" } });
          if (!holdReplies) proc.timers.push(setTimeout(() => proc.finish(), replyMs));
        } else if (message.method === "session/cancel") proc.finish("cancelled");
      } };
      proc.stdout = { async readString() { while (!out.length && !proc.killed) await new Promise((r) => { waiter = r; }); return out.shift() || ""; } };
      proc.stderr = { readString: async () => { await exited; return ""; } };
      proc.wait = () => exited;
      proc.kill = async () => { proc.killed = true; proc.timers.forEach(clearTimeout); if (waiter) waiter(); exitResolve({ exitCode: 0 }); };
      procs.push(proc); return proc;
    } },
    permission(name, input, { proc = procs.at(-1), options = [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } = {}) {
      const id = "permission-" + (++permissionId);
      const promise = new Promise((resolve) => answers.set(id, resolve));
      proc.push({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: proc.sessionId, toolCall: { name, rawInput: input, title: name }, options } });
      return promise;
    },
    // target: a bridge or a proc (default: the newest bridge)
    callTool(name, args, target = bridges.at(-1)) { return bridgeOf(target).onMessage({ jsonrpc: "2.0", id: "tool-1", method: "tools/call", params: { name, arguments: args } }); },
    // tools/list over that bridge/proc → the JSON-RPC response
    listTools(target = bridges.at(-1)) { return bridgeOf(target).onMessage({ jsonrpc: "2.0", id: "list-" + (++toolId), method: "tools/list", params: {} }); },
    // All held replies, or only that process's
    finishReplies({ proc } = {}) { for (const p of proc ? [proc] : procs) p.finish(); },
  };
  return fixture;
}
