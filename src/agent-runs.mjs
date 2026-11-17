// Delegated agents ("child agents"): separate, ordinary provider sessions that
// a parent chat's AI starts through Zen's agent_start / agent_status /
// agent_wait / agent_cancel tools. This module owns their run state, the
// process slots they wait for, budgets, timeouts, results and cancellation.
// No DOM and no provider wire formats: the panel injects a session factory
// and the router that decides each child's tool calls and approvals.
//
// Two parts:
// - createAgentScheduler: one per window; the windows' schedulers see each
//   other (peers), so the cap on live child processes is application-wide.
// - createAgentRuns: one per window; the runs of each parent turn.

export const AGENT_LIMITS = Object.freeze({
  perTurnActive: 2,     // at most 2 children of one parent turn hold a slot / run at once (others wait queued)
  perTurnTotal: 6,      // at most 6 child runs created per parent turn (including failed/stopped)
  appProcesses: 4,      // application-wide ceiling of live child processes (all windows)
  activeMs: 5 * 60000,  // active work per run; paused while waiting for an approval
  elapsedMs: 10 * 60000,// wall clock from the moment the run got a slot (starting), including approval waits
  waitMaxMs: 20000,     // one agent_wait call waits at most this long
  titleChars: 80, instructionChars: 8000, contextItems: 8, contextChars: 60000,
  resultChars: 12000,   // a result/text kept and returned is cut to this (with a note that it was cut)
  activityItems: 40,    // activity entries kept per run (oldest dropped)
});
export const AGENT_ACTIVE_STATES = new Set(["queued", "starting", "working", "waiting"]);
export const AGENT_END_STATES = new Set(["done", "failed", "stopped", "interrupted"]);

const AGENT_NO_NESTING = "Agents can't start or manage other agents.";
const AGENT_STOPPED_NOTE = "Stopped. Actions it already finished stay done.";
const AGENT_ACTIVITY_CHARS = 300;
// A tool name that manages agents, as Claude Code (mcp__zenai__agent_start),
// Antigravity (mcp_zenai_agent_start) or a bare MCP tools/call names it
const AGENT_TOOL_RE = /^(mcp__?zenai__?)?agent_/;

// Enqueue order (fairness ties go to the older job). Each window runs its own
// copy of this file, so the order across windows comes from the clock.
let agentJobSeq = 0;
const agentNextSeq = () => Date.now() * 1000 + (++agentJobSeq % 1000);

function agentHexId() {
  let s = "a";
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// Cuts text to max characters, saying so at the end
function agentCut(text, max) {
  text = String(text ?? "");
  if (text.length <= max) return text;
  const note = `\n[… cut: longer than ${max} characters]`;
  return text.slice(0, Math.max(0, max - note.length)) + note;
}

function agentShort(text, max = AGENT_ACTIVITY_CHARS) {
  text = String(text ?? "").trim();
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function agentDuration(ms) {
  if (ms >= 60000) { const m = Math.round(ms / 60000); return `${m} minute${m === 1 ? "" : "s"}`; }
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? "" : "s"}`;
}

const agentOwnerKey = (chatId, turnId) => `${chatId}/${turnId}`;
const agentIsText = (v) => typeof v === "string" && v.trim() !== "";

// --- Process slots ----------------------------------------------------------

export function createAgentScheduler({ limit = AGENT_LIMITS.appProcesses, peers = null } = {}) {
  const inner = { queue: [], held: new Map(), pumping: false, again: false, disposed: false, grantJob };
  const self = { request, release, inUse, queuedJobs, heldBy, pump, dispose };
  // The private side, readable by peers in other windows (a module-level
  // WeakMap wouldn't be: every window has its own copy of this code)
  Object.defineProperty(self, "inner", { value: inner });

  const group = () => {
    const list = (peers ? peers() : null) || [self];
    return list.includes(self) ? list : [...list, self];
  };
  const innerOf = (s) => (s && s.inner) || null;

  function request({ owner, perOwnerActive = Infinity, grant }) {
    const ticket = { id: agentNextSeq(), cancel: () => { inner.queue = inner.queue.filter((j) => j.ticket !== ticket); } };
    if (inner.disposed) return ticket;
    inner.queue.push({ ticket, owner: String(owner), perOwnerActive, grant, seq: ticket.id });
    pump();
    return ticket;
  }

  // Frees the ticket's slot once, however often it's called
  function release(ticket) {
    if (!ticket) return;
    ticket.cancel?.();
    if (!inner.held.delete(ticket.id)) return;
    pump();
  }

  function inUse() { return inner.held.size; }
  function queuedJobs() { return inner.queue.slice(); }
  function heldBy(owner) {
    let n = 0;
    for (const o of inner.held.values()) if (o === owner) n++;
    return n;
  }

  // Called by whichever scheduler picked this job (maybe another window's)
  function grantJob(job) {
    inner.queue = inner.queue.filter((j) => j !== job);
    inner.held.set(job.ticket.id, job.owner);
    try { job.grant?.(job.ticket); } catch (e) { release(job.ticket); }
  }

  // Gives one free slot to the fairest eligible job in any window
  function grantNext() {
    const all = group().map(innerOf).filter((i) => i && !i.disposed);
    let used = 0;
    const heldByOwner = new Map();
    for (const i of all) {
      used += i.held.size;
      for (const o of i.held.values()) heldByOwner.set(o, (heldByOwner.get(o) || 0) + 1);
    }
    if (used >= limit) return false;
    let best = null, bestHeld = 0;
    for (const i of all) for (const job of i.queue) {
      const n = heldByOwner.get(job.owner) || 0;
      if (n >= job.perOwnerActive) continue;
      if (!best || n < bestHeld || (n === bestHeld && job.seq < best.job.seq)) { best = { i, job }; bestHeld = n; }
    }
    if (!best) return false;
    best.i.grantJob(best.job);
    return true;
  }

  function pump() {
    if (inner.disposed) return;
    // A grant callback may request or release: the pump already running
    // anywhere in the group picks that up instead of nesting
    const running = group().map(innerOf).filter((i) => i?.pumping);
    if (running.length) { for (const i of running) i.again = true; return; }
    inner.pumping = true;
    try {
      do {
        inner.again = false;
        while (grantNext()) {}
      } while (inner.again);
    } finally {
      inner.pumping = false;
    }
  }

  function dispose() {
    inner.queue = [];
    inner.held.clear();
    inner.disposed = true;
    const other = group().find((s) => s !== self && !innerOf(s)?.disposed);
    other?.pump();
  }

  return self;
}

// --- Runs ---------------------------------------------------------------------

export function createAgentRuns({
  scheduler, createSession, childPrompt, router, onChange = () => {},
  limits = AGENT_LIMITS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  newId = agentHexId,
} = {}) {
  const runs = new Map();     // id → private side { run, key, owner, context, ticket, session, … }
  const byRun = new WeakMap(); // public record → private side
  const waiters = new Set();
  let disposed = false;

  const changed = (run) => { try { onChange(run); } catch (e) {} };
  const live = (p) => AGENT_ACTIVE_STATES.has(p.run.state);

  function addActivity(run, kind, text) {
    const list = run.activity;
    list.push({ kind, text: agentShort(text), ts: now() });
    if (list.length > limits.activityItems) list.splice(0, list.length - limits.activityItems);
  }

  function validate(owner, spec) {
    if (!owner || !agentIsText(owner.chatId) || !agentIsText(owner.turnId)) return "This chat can't start agents right now.";
    if (!spec || typeof spec !== "object") return "Give the agent a title and an instruction.";
    const title = typeof spec.title === "string" ? spec.title.trim() : "";
    if (!title) return "Give the agent a short title.";
    if (/[\r\n]/.test(title)) return "The agent's title must be one line.";
    if (title.length > limits.titleChars) return `The agent's title is too long: keep it to ${limits.titleChars} characters.`;
    const instruction = typeof spec.instruction === "string" ? spec.instruction.trim() : "";
    if (!instruction) return "Give the agent an instruction: what it should do and return.";
    if (instruction.length > limits.instructionChars) return `The instruction is too long (${instruction.length} characters): keep it under ${limits.instructionChars} and pass material as context instead.`;
    const context = spec.context ?? [];
    if (!Array.isArray(context)) return "The agent's context must be a list.";
    if (context.length > limits.contextItems) return `Too much context: an agent gets at most ${limits.contextItems} items.`;
    let chars = 0;
    for (const c of context) {
      if (!c || typeof c !== "object") return "One of the context items isn't valid.";
      chars += String(c.text ?? "").length;
    }
    if (chars > limits.contextChars) return `The context is too large (${chars} characters, at most ${limits.contextChars}): pass fewer or shorter items.`;
    if (!agentIsText(spec.provider)) return "The agent needs a provider.";
    if (!agentIsText(spec.model)) return "The agent needs a model.";
    const key = agentOwnerKey(owner.chatId, owner.turnId);
    let total = 0;
    for (const p of runs.values()) if (p.key === key) total++;
    if (total >= limits.perTurnTotal) return `This turn already started ${limits.perTurnTotal} agents, the most one turn can. Do the rest of the work yourself or finish with what you have.`;
    return null;
  }

  function start(owner, spec) {
    if (disposed) return { error: "This window is closing: agents can't start." };
    let error;
    try { error = validate(owner, spec); } catch (e) { error = "The agent's task isn't valid."; }
    if (error) return { error };

    let id = String(newId());
    while (runs.has(id)) id = agentHexId();
    const context = (spec.context || []).map((c) => ({ ...c }));
    const run = {
      id, chatId: owner.chatId, turnId: owner.turnId,
      title: spec.title.trim(), instruction: spec.instruction.trim(),
      provider: spec.provider, model: spec.model, effort: typeof spec.effort === "string" ? spec.effort : "",
      browser: !!spec.browser,
      contextLabels: context.map((c) => agentShort(c.label ?? c.id ?? "", 120)),
      state: "queued", created: now(), startedAt: null, endedAt: null,
      activity: [], text: "", result: "", error: "", files: [],
      untrusted: context.some((c) => !!c.untrusted), delivered: false, gen: 0,
    };
    const p = {
      run, key: agentOwnerKey(owner.chatId, owner.turnId), owner: { ...owner }, context,
      ticket: null, session: null, timers: { elapsed: null, active: null },
      activeLeft: limits.activeMs, activeSince: 0, waiting: 0, streamed: false, textFull: false,
    };
    runs.set(id, p);
    byRun.set(run, p);
    addActivity(run, "status", "Waiting for a free agent slot");
    // spec.maxActive: the skill's own agents: N, never above the per-turn limit
    const perOwnerActive = Math.max(1, Math.min(limits.perTurnActive, Number(spec.maxActive) || limits.perTurnActive));
    p.ticket = scheduler.request({ owner: p.key, perOwnerActive, grant: (ticket) => granted(p, ticket) });
    changed(run);
    return { run };
  }

  // --- Running ----------------------------------------------------------------

  function granted(p, ticket) {
    p.ticket = ticket;
    const { run } = p;
    if (!live(p)) { scheduler.release(ticket); return; }
    run.state = "starting";
    run.startedAt = now();
    addActivity(run, "status", "Starting");
    const gen = run.gen;
    p.timers.elapsed = setTimer(() => {
      if (run.gen === gen) finish(p, "failed", `Stopped after ${agentDuration(limits.elapsedMs)}.`);
    }, limits.elapsedMs);
    resumeActive(p);
    try {
      p.session = createSession(run.provider, handlersFor(p, gen), { child: true });
      if (!p.session) throw new Error("no session");
      p.session.setModel?.(run.model);
      if (run.effort) p.session.setEffort?.(run.effort);
      p.session.setTainted?.(true);
      const content = childPrompt(run, p.context);
      Promise.resolve(p.session.send(content)).catch((e) => {
        if (run.gen === gen) finish(p, "failed", `Couldn't send the task to the agent: ${e?.message || e}`);
      });
    } catch (e) {
      finish(p, "failed", `Couldn't start the agent: ${e?.message || e}`);
      return;
    }
    changed(run);
  }

  // The active-work clock stops while an approval is pending
  function resumeActive(p) {
    if (p.timers.active) return;
    const gen = p.run.gen;
    p.activeSince = now();
    p.timers.active = setTimer(() => {
      if (p.run.gen === gen) finish(p, "failed", `Stopped after ${agentDuration(limits.activeMs)} of work.`);
    }, Math.max(0, p.activeLeft));
  }
  function pauseActive(p) {
    if (!p.timers.active) return;
    clearTimer(p.timers.active);
    p.timers.active = null;
    p.activeLeft -= now() - p.activeSince;
  }

  function appendText(p, text) {
    const { run } = p;
    if (p.textFull || !text) return;
    const all = run.text + text;
    if (all.length > limits.resultChars) { run.text = agentCut(all, limits.resultChars); p.textFull = true; }
    else run.text = all;
    if (run.state === "starting") run.state = "working";
    // Model-written progress: one trailing "update" entry, replaced as it grows
    const line = run.text.replace(/\n\[… cut:[^\]]*\]$/, "").trim().split("\n").filter((l) => l.trim()).pop() || "";
    const last = run.activity[run.activity.length - 1];
    if (last && last.kind === "update") { last.text = agentShort(line); last.ts = now(); }
    else addActivity(run, "update", line);
    changed(run);
  }

  function handlersFor(p, gen) {
    const { run } = p;
    const ok = () => run.gen === gen && live(p);
    const deny = (message) => ({ behavior: "deny", message });
    const mcpError = (message, text) => ({ jsonrpc: "2.0", id: message?.id ?? null, result: { isError: true, content: [{ type: "text", text }] } });
    return {
      onText(text) { if (ok()) { p.streamed = true; appendText(p, String(text ?? "")); } },
      onAssistantMessage(msg) {
        if (!ok() || p.streamed) return;
        const blocks = msg?.message?.content;
        const text = Array.isArray(blocks) ? blocks.filter((b) => b?.type === "text").map((b) => b.text || "").join("") : "";
        if (text) appendText(p, (run.text ? "\n\n" : "") + text);
      },
      onStatus(text) {
        if (!ok() || !text) return;
        addActivity(run, "status", text);
        changed(run);
      },
      onDone(msg) {
        if (!ok()) return;
        if (msg?.is_error || (msg?.subtype && msg.subtype !== "success")) {
          const why = msg.result || (Array.isArray(msg.errors) ? msg.errors.join("; ") : "") || "The agent ended with an error.";
          finish(p, "failed", agentShort(why, 1000));
          return;
        }
        const result = String(run.text || msg?.result || "").trim();
        if (!result) { finish(p, "failed", "The agent finished without a result."); return; }
        run.result = agentCut(result, limits.resultChars);
        finish(p, "done");
      },
      onError(text) { if (ok()) finish(p, "failed", agentShort(text || "The agent stopped with an error.", 1000)); },
      onSessionGone() { if (ok()) finish(p, "failed", "The agent's process ended unexpectedly."); },
      async onPermission(req, tainted) {
        if (AGENT_TOOL_RE.test(String(req?.tool_name || ""))) return deny(AGENT_NO_NESTING);
        if (!ok()) return deny("This agent was stopped.");
        let mine = false;
        const setWaiting = (on) => {
          if (!ok() || !!on === mine) return;
          mine = !!on;
          p.waiting += on ? 1 : -1;
          if (on && p.waiting === 1) { pauseActive(p); run.state = "waiting"; changed(run); }
          if (!on && p.waiting === 0) { run.state = "working"; resumeActive(p); changed(run); }
        };
        let answer;
        try { answer = await router.onPermission(run, req, tainted, { setWaiting }); }
        catch (e) { answer = null; }
        finally { setWaiting(false); }
        if (!ok()) return deny("This agent was stopped.");
        if (answer?.behavior === "allow") return answer;
        return deny(answer?.message || "Not allowed.");
      },
      async onMcpMessage(serverName, message) {
        if (message?.method === "tools/call" && AGENT_TOOL_RE.test(String(message.params?.name || ""))) return mcpError(message, AGENT_NO_NESTING);
        if (!ok()) return mcpError(message, "This agent was stopped.");
        try { return await router.onMcpMessage(run, serverName, message); }
        catch (e) { return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: String(e?.message || e) } }; }
      },
      // What it costs: passed to the host (the chat's usage line counts agents too)
      onUsage(u) { if (ok() && router && router.onUsage) { try { router.onUsage(run, u); } catch (e) {} } },
      onInit() {}, onRateLimit() {}, onCompact() {},
    };
  }

  // --- Ending -----------------------------------------------------------------

  // Every run ends here, exactly once
  function finish(p, state, error = "") {
    const { run } = p;
    if (!live(p)) return false;
    const wasRunning = run.state !== "queued";
    run.state = state;
    run.endedAt = now();
    run.error = state === "done" ? "" : error;
    run.gen++;
    for (const k of ["elapsed", "active"]) if (p.timers[k]) { clearTimer(p.timers[k]); p.timers[k] = null; }
    p.waiting = 0;
    if (state === "failed") addActivity(run, "error", error);
    else if (state === "done") addActivity(run, "status", "Done");
    else if (wasRunning) addActivity(run, "status", AGENT_STOPPED_NOTE);
    else addActivity(run, "status", state === "interrupted" ? "Interrupted before it started" : "Stopped before it started");

    const session = p.session;
    p.session = null;
    if (session) {
      if (state !== "done") { try { session.stop?.(); } catch (e) {} }
      try { Promise.resolve(session.kill?.()).catch(() => {}); } catch (e) {}
    }
    try { router?.onEnd?.(run); } catch (e) {}
    changed(run);
    settleWaiters();
    // Last, so a queued run that gets this slot starts after this one ended
    const ticket = p.ticket;
    p.ticket = null;
    if (ticket) { ticket.cancel?.(); scheduler.release(ticket); }
    return true;
  }

  function stopState(why) {
    if (AGENT_END_STATES.has(why) && why !== "done" && why !== "failed") return { state: why, error: why === "interrupted" ? "The window closed before the agent finished." : "Stopped before it finished." };
    return { state: "stopped", error: agentShort(why || "Stopped before it finished.", 300) };
  }

  // --- Owned lookups ------------------------------------------------------------

  function owned(owner, id) {
    if (!owner || typeof id !== "string") return null;
    const p = runs.get(id);
    if (!p || p.run.chatId !== owner.chatId || p.run.turnId !== owner.turnId) return null;
    return p;
  }
  const turnRuns = (owner) => owner ? [...runs.values()].filter((p) => p.run.chatId === owner.chatId && p.run.turnId === owner.turnId) : [];

  // No ids (or an empty list) means every run of the turn
  function pick(owner, ids) {
    if (ids == null || (Array.isArray(ids) && !ids.length)) return { known: turnRuns(owner), unknown: [] };
    const known = [], unknown = [], seen = new Set();
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const p = owned(owner, id);
      if (p) known.push(p); else unknown.push(String(id));
    }
    return { known, unknown };
  }

  const get = (owner, id) => owned(owner, id)?.run || null;
  const list = (owner) => turnRuns(owner).map((p) => p.run);
  const listChat = (chatId) => [...runs.values()].filter((p) => p.run.chatId === chatId).map((p) => p.run);

  function status(owner, ids) {
    const { known, unknown } = pick(owner, ids);
    const out = known.map(({ run }) => ({
      id: run.id, title: run.title, state: run.state,
      activity: run.activity.length ? run.activity[run.activity.length - 1].text : "", error: run.error,
    }));
    return { runs: out, unknown };
  }

  // --- Waiting for results --------------------------------------------------------

  function collect(w) {
    const results = [], pending = [];
    for (const p of w.known) {
      const { run } = p;
      if (live(p)) { pending.push(run.id); continue; }
      if (run.delivered) { results.push({ id: run.id, title: run.title, state: run.state, delivered: true }); continue; }
      results.push({ id: run.id, title: run.title, state: run.state, result: run.result, error: run.error, files: run.files.map((f) => ({ ...f })), untrusted: run.untrusted });
      run.delivered = true;
      changed(run);
    }
    return { results, pending, unknown: w.unknown };
  }

  function resolveWaiter(w) {
    if (!waiters.delete(w)) return;
    if (w.timer) clearTimer(w.timer);
    w.resolve(collect(w));
  }

  function settleWaiters() {
    for (const w of [...waiters]) if (w.known.every((p) => !live(p))) resolveWaiter(w);
  }

  function wait(owner, ids, timeoutMs) {
    const ms = Math.min(Math.max(Number(timeoutMs) || 0, 0), limits.waitMaxMs);
    const { known, unknown } = pick(owner, ids);
    const w = { key: owner ? agentOwnerKey(owner.chatId, owner.turnId) : "", chatId: owner?.chatId, known, unknown, resolve: null, timer: null };
    return new Promise((resolve) => {
      w.resolve = resolve;
      if (disposed || known.every((p) => !live(p))) { resolve(collect(w)); return; }
      waiters.add(w);
      w.timer = setTimer(() => { w.timer = null; resolveWaiter(w); }, ms);
    });
  }

  // --- Cancelling -------------------------------------------------------------------

  function cancel(owner, id, why = "stopped") {
    const p = owned(owner, id);
    if (!p) return { ok: false, state: null, error: "No agent with that id in this turn." };
    if (live(p)) { const s = stopState(why); finish(p, s.state, s.error); }
    return { ok: true, state: p.run.state };
  }

  // Queued runs first, so a slot freed by a running one never starts them
  function cancelWhere(match, why) {
    const s = stopState(why);
    const doomed = [...runs.values()].filter((p) => match(p) && live(p));
    doomed.sort((a, b) => (b.run.state === "queued") - (a.run.state === "queued"));
    for (const p of doomed) finish(p, s.state, s.error);
  }

  function cancelTurn(owner, why = "stopped") {
    if (!owner) return;
    const key = agentOwnerKey(owner.chatId, owner.turnId);
    cancelWhere((p) => p.key === key, why);
    for (const w of [...waiters]) if (w.key === key) resolveWaiter(w);
  }

  function cancelChat(chatId, why = "stopped") {
    cancelWhere((p) => p.run.chatId === chatId, why);
    for (const w of [...waiters]) if (w.chatId === chatId) resolveWaiter(w);
  }

  function dispose() {
    disposed = true;
    cancelWhere(() => true, "interrupted");
    for (const w of [...waiters]) resolveWaiter(w);
  }

  // --- Counting and host notes ----------------------------------------------------------

  const active = (owner) => turnRuns(owner).filter(live).length;
  const undelivered = (owner) => turnRuns(owner).filter((p) => !live(p) && !p.run.delivered).map((p) => p.run);

  function markDelivered(run) {
    if (!byRun.has(run) || run.delivered) return;
    run.delivered = true;
    changed(run);
  }

  function taint(run) {
    if (!byRun.has(run) || run.untrusted) return;
    run.untrusted = true;
    changed(run);
  }

  function addFile(run, file) {
    if (!byRun.has(run) || !file) return;
    run.files.push({ name: String(file.name ?? ""), path: String(file.path ?? ""), size: Number(file.size) || 0 });
    changed(run);
  }

  function note(run, kind, text) {
    if (!byRun.has(run) || !text) return;
    addActivity(run, ["status", "update", "tool", "error"].includes(kind) ? kind : "status", text);
    changed(run);
  }

  return {
    start, get, list, listChat, status, wait, cancel, cancelTurn, cancelChat, dispose,
    active, undelivered, markDelivered, taint, addFile, note,
  };
}
