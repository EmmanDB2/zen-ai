import { ALWAYS_ASK, AUTOCOMPACT_MIN_VERSION, CLAUDE_DEFAULT_PATH, CLAUDE_ENV, CLAUDE_ENV_PATH, CLEAN_CHAT_TOOLS, ZEN_SERVER, autocompactSetting, prefs, systemPrompt } from "./config.mjs";
import { outputDir } from "./files.mjs";

export const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

// What Claude Code says when --resume names a chat it has deleted
export const SESSION_GONE = /No conversation found with session ID/i;

// Where Claude Code's installers put it (~ is the home folder)
const CLAUDE_PLACES = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", "~/.claude/local/claude", "~/.local/bin/claude", "~/.npm-global/bin/claude", "~/.bun/bin/claude", "~/.volta/bin/claude"];

// Runs `<path> --version`: { ok, version } or { ok: false, why }
export async function checkClaude(path) {
  if (!path) return { ok: false, why: "No path given." };
  if (!(await IOUtils.exists(path).catch(() => false))) return { ok: false, why: "There's nothing at that path." };
  let proc;
  try {
    proc = await Subprocess.call({ command: path, arguments: ["--version"], environment: { PATH: CLAUDE_ENV_PATH, ...CLAUDE_ENV }, environmentAppend: true, stderr: "stdout" });
  } catch (e) {
    return { ok: false, why: "That file can't be run." };
  }
  let out = "";
  const reading = (async () => { for (;;) { const s = await proc.stdout.readString(); if (!s) break; out += s; } })().catch(() => {});
  const timeout = new Promise((r) => setTimeout(() => r(null), 10000));
  const done = await Promise.race([proc.wait(), timeout]);
  if (!done) {
    proc.kill().catch(() => {});
    return { ok: false, why: "It didn't answer within 10 seconds." };
  }
  await reading;
  const version = (out.match(/\d+\.\d+\.\d+/) || [])[0];
  if (done.exitCode === 0 && /claude/i.test(out) && version) return { ok: true, version };
  return { ok: false, why: `It isn't Claude Code${out.trim() ? ` (it said “${out.trim().split("\n")[0].slice(0, 80)}”)` : ""}.` };
}

// The first place Claude Code is installed, or ""
export async function findClaude() {
  let home = "";
  try { home = Services.dirsvc.get("Home", Ci.nsIFile).path; } catch (e) {}
  const places = CLAUDE_PLACES.map((p) => p.replace(/^~/, home));
  try {
    const found = await Subprocess.pathSearch("claude", { PATH: CLAUDE_ENV_PATH });
    if (found && !places.includes(found)) places.unshift(found);
  } catch (e) {}
  for (const p of places) {
    if ((await checkClaude(p)).ok) return p;
  }
  return "";
}

// a.b.c ≥ x.y.z
export function versionAtLeast(version, min) {
  const a = String(version || "").split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

// Does this Claude Code know --autocompact? Asked once per path and window
// (an older one would refuse to start with it)
const autocompactKnown = new Map();
function autocompactSupported(command) {
  if (!autocompactKnown.has(command)) {
    autocompactKnown.set(command, checkClaude(command).then((r) => !!r.ok && versionAtLeast(r.version, AUTOCOMPACT_MIN_VERSION)).catch(() => false));
  }
  return autocompactKnown.get(command);
}

// Where to run Claude Code: the path chosen in settings, else the usual
// place, else the first install found (saved, so the settings pane shows it)
export async function claudeCommand() {
  const chosen = prefs.get("claudePath", "");
  if (chosen) return chosen;
  if (await IOUtils.exists(CLAUDE_DEFAULT_PATH).catch(() => false)) return CLAUDE_DEFAULT_PATH;
  const found = await findClaude();
  if (found) prefs.set("claudePath", found);
  return found || CLAUDE_DEFAULT_PATH;
}

// ---------------------------------------------------------------------------
// One long-running Claude Code process per conversation
// ---------------------------------------------------------------------------
export class ClaudeSession {
  constructor(handlers) {
    this.handlers = handlers;
    this.proc = null;
    this.sessionId = null;
    this.effort = "medium";
    this.model = "default"; // Claude Code's own default unless the user picks one
    this.needsRestart = false;
    this.busy = false;
    this.starting = null;
    this.stopping = null;   // a Stop in progress (see stop)
    this.stopTimer = null;
    this.sendTicket = 0;
    this.stderrTail = "";
    this.generation = 0;
    this.tainted = false; // web content in the chat → built-in tools removed
    this.child = false;   // a helper agent's session (setChild): nothing saved, never resumed
    this.agentTools = false; // the agent_* tools are listed (a skill that allows agents ran)
  }

  async ensureStarted() {
    if (this.proc && !this.needsRestart) return;
    if (this.proc && this.needsRestart) await this.kill();
    if (!this.starting) this.starting = this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  async start() {
    // Claude Code works inside the output folder, so files it makes land there
    const workdir = await outputDir();
    const command = await claudeCommand();

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--effort", this.effort,
      // Clean chat: the built-in tools, each one needing approval.
      // Web content in the chat: none of them, only our two file tools.
      "--tools", this.tainted ? "" : CLEAN_CHAT_TOOLS.join(","),
      "--permission-mode", "default",
      "--settings", JSON.stringify({ permissions: { ask: ALWAYS_ASK } }),
      // Every permission question comes to this window
      "--permission-prompt-tool=stdio",
      // Our file tools run inside the mod; no other MCP servers load
      "--mcp-config", JSON.stringify({ mcpServers: { [ZEN_SERVER]: { type: "sdk", name: ZEN_SERVER } } }),
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--system-prompt", systemPrompt("claude"),
    ];
    if (this.model && this.model !== "default") args.push("--model", this.model);
    // Compact earlier than Claude Code would: every request re-reads the history
    const compact = autocompactSetting();
    if (compact !== "auto" && (await autocompactSupported(command))) args.push("--autocompact", compact);
    // A helper agent: one task, no transcript kept, never resumed
    if (this.child) args.push("--no-session-persistence");
    else if (this.sessionId) args.push("--resume", this.sessionId);

    const generation = ++this.generation;
    this.stderrTail = "";
    this.needsRestart = false;

    let proc;
    try {
      proc = await Subprocess.call({
        command,
        arguments: args,
        workdir,
        environment: { PATH: CLAUDE_ENV_PATH, ...CLAUDE_ENV },
        environmentAppend: true,
        stderr: "pipe",
      });
    } catch (e) {
      throw new Error(`Couldn't start Claude Code at ${command}. Install it from claude.com/claude-code, or set where it is in Zen's settings → Zen AI.`);
    }
    this.proc = proc;
    this.readStdout(proc, generation);
    this.readStderr(proc, generation);
    // Tell Claude Code which in-process tool servers we host
    this.writeLine({ type: "control_request", request_id: `init-${generation}`, request: { subtype: "initialize", sdkMcpServers: [ZEN_SERVER] } });
    proc.wait().then(async ({ exitCode }) => {
      if (generation !== this.generation) return; // we replaced it on purpose
      await new Promise((resolve) => setTimeout(resolve, 60)); // let the last of stderr arrive
      if (generation !== this.generation) return;
      this.proc = null;
      this.finishStop();
      // The chat's transcript is gone: say so even if nothing was being sent
      if (this.sessionId && SESSION_GONE.test(this.stderrTail) && this.handlers.onSessionGone) {
        this.busy = false;
        this.handlers.onSessionGone();
        return;
      }
      if (this.busy) {
        this.busy = false;
        this.handlers.onError(this.describeExit(exitCode));
      }
    });
  }

  describeExit(exitCode) {
    const detail = this.stderrTail.trim().split("\n").slice(-3).join("\n");
    return `Claude Code stopped unexpectedly (exit code ${exitCode}).` + (detail ? `\n${detail}` : "");
  }

  async readStdout(proc, generation) {
    let buffer = "";
    try {
      while (true) {
        const chunk = await proc.stdout.readString();
        if (!chunk) break;
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line && generation === this.generation) this.handleLine(line);
        }
      }
    } catch (e) {}
  }

  async readStderr(proc, generation) {
    try {
      while (true) {
        const chunk = await proc.stderr.readString();
        if (!chunk) break;
        if (generation === this.generation) this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      }
    } catch (e) {}
  }

  writeLine(obj, proc = this.proc) {
    if (!proc) return Promise.resolve();
    return proc.stdin.write(JSON.stringify(obj) + "\n").catch(() => {});
  }

  // Claude Code asking us something: run one of our tools, or approve a tool use
  async handleControlRequest(msg) {
    const proc = this.proc;
    const req = msg.request || {};
    const reply = (body) => this.writeLine({ type: "control_response", response: { request_id: msg.request_id, ...body } }, proc);
    // Left over from a reply the user stopped: never act on it
    if (this.stopping) {
      if (req.subtype === "can_use_tool") {
        reply({ subtype: "success", response: { behavior: "deny", message: "The user stopped this reply." } });
        return;
      }
      if (req.subtype === "mcp_message" && req.message && req.message.method === "tools/call") {
        reply({ subtype: "error", error: "The user stopped this reply." });
        return;
      }
    }
    try {
      let response;
      if (req.subtype === "mcp_message") {
        response = { mcp_response: await this.handlers.onMcpMessage(req.server_name, req.message || {}) };
      } else if (req.subtype === "can_use_tool") {
        response = await this.handlers.onPermission(req, this.tainted);
      } else {
        reply({ subtype: "error", error: `Unsupported request: ${req.subtype}` });
        return;
      }
      if (this.proc === proc) reply({ subtype: "success", response });
    } catch (e) {
      if (this.proc === proc) reply({ subtype: "error", error: String((e && e.message) || e) });
    }
  }

  handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    if (msg.session_id) this.sessionId = msg.session_id;
    if (msg.type === "control_request") {
      this.handleControlRequest(msg);
      return;
    }
    if (msg.type === "control_response") {
      // Claude Code's answer to initialize: its models (and which one is the default)
      const r = msg.response || {};
      if (String(r.request_id || "").startsWith("init-") && r.subtype === "success" && this.handlers.onInit) {
        this.handlers.onInit(r.response || {});
      }
      return;
    }
    // The plan's limits: kept even while a stopped reply winds down
    if (msg.type === "rate_limit_event") {
      if (this.handlers.onRateLimit) this.handlers.onRateLimit(msg.rate_limit_info);
      return;
    }
    if (msg.parent_tool_use_id) return;
    // What each request cost (several records can share one response id)
    if (msg.type === "assistant" && msg.message && msg.message.usage && this.handlers.onUsage) {
      this.handlers.onUsage({ id: msg.message.id || "", usage: msg.message.usage });
    }
    // The rest of a reply the user stopped: drop it, up to its result
    if (this.stopping) {
      if (msg.type === "result") this.finishStop();
      return;
    }

    switch (msg.type) {
      case "stream_event": {
        const ev = msg.event || {};
        if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta") this.handlers.onText(ev.delta.text || "");
        }
        break;
      }
      case "assistant":
        this.handlers.onAssistantMessage(msg);
        break;
      case "system":
        if (msg.subtype === "api_retry") {
          this.handlers.onStatus(`Retrying… (${msg.attempt}/${msg.max_retries})`);
        } else if (msg.subtype === "compact_boundary" && this.handlers.onCompact) {
          this.handlers.onCompact();
        }
        break;
      case "result":
        this.busy = false;
        this.handlers.onDone(msg);
        break;
    }
  }

  // content: a string, or an array of content blocks (text / image)
  async send(content) {
    if (this.stopping) await this.stopping; // let a stopped reply wind down first
    const ticket = ++this.sendTicket;
    await this.ensureStarted();
    if (ticket !== this.sendTicket) return; // stopped while Claude Code was starting
    if (!this.proc) throw new Error("Claude Code isn't running.");
    this.busy = true;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const payload = {
      type: "user",
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    };
    await this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  async kill() {
    const proc = this.proc;
    this.generation++;
    this.proc = null;
    this.busy = false;
    this.finishStop();
    if (proc) {
      try { await proc.kill(500); } catch (e) {}
    }
  }

  // Stop the current reply. Claude Code stays running (no restart, and its
  // cache stays warm), so the next message starts right away. If it doesn't
  // stop within a few seconds, end the process; the chat resumes next time.
  stop() {
    this.sendTicket++; // a message still waiting for Claude Code to start isn't sent
    if (!this.proc || !this.busy || this.stopping) return;
    this.busy = false;
    const proc = this.proc;
    this.stopping = new Promise((resolve) => (this.stopDone = resolve));
    this.writeLine({ type: "control_request", request_id: `stop-${Date.now()}`, request: { subtype: "interrupt" } });
    this.stopTimer = setTimeout(() => {
      if (this.stopping && this.proc === proc) this.kill();
    }, 4000);
  }

  finishStop() {
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    if (!this.stopping) return;
    this.stopping = null;
    if (this.stopDone) this.stopDone();
    this.stopDone = null;
  }

  // Switch models without restarting (the chat carries on with the new one)
  setModel(model) {
    model = model || "default";
    if (model === this.model) return;
    this.model = model;
    if (this.proc && !this.needsRestart) {
      this.writeLine({ type: "control_request", request_id: `model-${Date.now()}`, request: { subtype: "set_model", model } });
    }
  }

  // Forget the conversation entirely.
  async reset() {
    await this.kill();
    this.sessionId = null;
    this.tainted = false;
  }

  // Once web content enters the chat, restart without the built-in tools
  // (the conversation continues via --resume)
  setTainted(tainted) {
    if (tainted === this.tainted) return;
    this.tainted = tainted;
    if (this.proc) this.needsRestart = true;
  }

  setEffort(level) {
    if (level === this.effort) return;
    this.effort = level;
    if (this.proc) this.needsRestart = true; // picks it up on the next message
  }

  // A helper agent's session (agent-runs.mjs): no built-in tools (it starts
  // tainted), no saved transcript
  setChild() {
    this.child = true;
    this.tainted = true;
  }

  // The tool list Claude Code reads at start changes: restart with --resume
  setAgentTools(on) {
    if (!!on === this.agentTools) return;
    this.agentTools = !!on;
    if (this.proc) this.needsRestart = true;
  }
}

// ---------------------------------------------------------------------------
// One question to Claude Code with no tools, no MCP servers and no saved
// transcript (the skill updater). { done: Promise<reply text>, cancel() }
// ---------------------------------------------------------------------------
export function runClaudeOnce({ system, prompt, model = "default", effort = "high", timeoutMs = 600000, onRateLimit = null }) {
  let proc = null;
  let cancelled = false;
  let timer = null;
  const done = (async () => {
    const command = await claudeCommand();
    const workdir = await outputDir();
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--effort", effort,
      "--tools", "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--system-prompt", system,
    ];
    if (model && model !== "default") args.push("--model", model);
    try {
      proc = await Subprocess.call({ command, arguments: args, workdir, environment: { PATH: CLAUDE_ENV_PATH, ...CLAUDE_ENV }, environmentAppend: true, stderr: "pipe" });
    } catch (e) {
      throw new Error(`Couldn't start Claude Code at ${command}.`);
    }
    if (cancelled) { proc.kill().catch(() => {}); throw new Error("Stopped."); }
    timer = setTimeout(() => { cancelled = true; proc.kill().catch(() => {}); }, timeoutMs);
    let stderr = "";
    (async () => { for (;;) { const s = await proc.stderr.readString(); if (!s) break; stderr = (stderr + s).slice(-2000); } })().catch(() => {});
    await proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null }) + "\n");
    let buf = "";
    let result = null;
    while (!result) {
      const s = await proc.stdout.readString();
      if (!s) break;
      buf += s;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.type === "rate_limit_event" && onRateLimit) onRateLimit(msg.rate_limit_info);
        if (msg.type === "result") result = msg;
      }
    }
    clearTimeout(timer);
    proc.kill().catch(() => {});
    if (cancelled) throw new Error("Stopped.");
    if (!result) throw new Error(stderr.trim().split("\n").pop() || "Claude Code stopped without answering.");
    if (result.is_error || (result.subtype && result.subtype !== "success")) throw new Error(result.result || "Claude Code couldn't answer.");
    return String(result.result || "");
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      clearTimeout(timer);
      if (proc) proc.kill().catch(() => {});
    },
  };
}
