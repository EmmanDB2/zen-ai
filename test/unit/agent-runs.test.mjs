// Delegated agents without DOM: validation, process slots (per turn and across
// windows), ownership, waiting for results, cancelling, timeouts, what a
// child may call, and that the public run record stays plain data.
import { checker, crash } from "../helpers/common.mjs";
import { AGENT_LIMITS, AGENT_ACTIVE_STATES, AGENT_END_STATES, createAgentScheduler, createAgentRuns } from "../../src/agent-runs.mjs";

const { check, done } = checker();
const tick = () => new Promise((r) => setImmediate(r));

// A clock with timers the test moves forward by hand
function fakeClock() {
  let t = 1000, n = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++n, { at: t + ms, fn }); return n; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    get pending() { return timers.size; },
  };
}

// Sessions that record what they were told; the test plays their events
function fakeSessions() {
  const made = [];
  const factory = (provider, handlers, opts) => {
    if (factory.throwNext) { factory.throwNext = false; throw new Error("no binary"); }
    const s = {
      provider, handlers, opts, calls: [],
      setModel(m) { s.calls.push("model:" + m); },
      setEffort(e) { s.calls.push("effort:" + e); },
      setTainted(v) { s.calls.push("tainted:" + v); },
      send(c) {
        s.calls.push("send");
        s.sent = c;
        if (factory.rejectNext) { factory.rejectNext = false; return Promise.reject(new Error("pipe closed")); }
        return Promise.resolve();
      },
      stop() { s.calls.push("stop"); },
      kill() { s.calls.push("kill"); return Promise.resolve(); },
    };
    made.push(s);
    return s;
  };
  factory.made = made;
  return factory;
}

function fakeRouter() {
  const r = {
    ends: new Map(), perms: [], mcp: [],
    onPermission(run, req, tainted, { setWaiting }) {
      return new Promise((resolve) => r.perms.push({ run, req, tainted, setWaiting, resolve }));
    },
    async onMcpMessage(run, serverName, message) { r.mcp.push({ run, serverName, message }); return { jsonrpc: "2.0", id: message.id, result: { content: [] } }; },
    onEnd(run) { r.ends.set(run.id, (r.ends.get(run.id) || 0) + 1); },
  };
  return r;
}

let idN = 0;
function setup({ scheduler, limits = AGENT_LIMITS } = {}) {
  const clock = fakeClock();
  const sessions = fakeSessions();
  const router = fakeRouter();
  const changes = [];
  scheduler = scheduler || createAgentScheduler({ limit: limits.appProcesses });
  const runs = createAgentRuns({
    scheduler, createSession: sessions, router, limits,
    childPrompt: (run, context) => `Task: ${run.instruction}` + (context || []).map((c) => `\n${c.text}`).join(""),
    onChange: (run) => changes.push(run.state),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    newId: () => "a" + (++idN).toString(16).padStart(8, "0"),
  });
  return { clock, sessions, router, runs, scheduler, changes };
}

const spec = (extra = {}) => ({ title: "Source review", instruction: "Summarize the two articles.", provider: "claude", model: "sonnet", effort: "medium", ...extra });
const A = { chatId: "c1", turnId: "t1" };

(async () => {
  check("limits and state sets", AGENT_LIMITS.perTurnActive === 2 && AGENT_LIMITS.appProcesses === 4 && AGENT_ACTIVE_STATES.has("waiting") && AGENT_END_STATES.has("interrupted") && Object.isFrozen(AGENT_LIMITS));

  // --- Validation ---------------------------------------------------------
  {
    const env = setup();
    const bad = [
      ["empty title", spec({ title: "   " })],
      ["two-line title", spec({ title: "One\nTwo" })],
      ["long title", spec({ title: "x".repeat(81) })],
      ["no instruction", spec({ instruction: "" })],
      ["huge instruction", spec({ instruction: "x".repeat(8001) })],
      ["9 context items", spec({ context: Array.from({ length: 9 }, (_, i) => ({ id: "x" + i, label: "L", text: "t" })) })],
      ["context too large", spec({ context: [{ id: "p", label: "Page", text: "x".repeat(60001) }] })],
      ["no provider", spec({ provider: "" })],
      ["no model", spec({ model: undefined })],
    ];
    for (const [name, s] of bad) {
      const r = env.runs.start(A, s);
      check(`invalid (${name}) → error, no run`, typeof r.error === "string" && r.error.length > 10 && !r.run, r);
    }
    check("invalid owner → error", !!env.runs.start({ chatId: "c1" }, spec()).error);
    check("invalid spec never spawns or queues", env.sessions.made.length === 0 && env.scheduler.inUse() === 0 && env.scheduler.queuedJobs().length === 0 && env.runs.list(A).length === 0);
    check("start never throws on garbage", !!env.runs.start(A, null).error && !!env.runs.start(null, spec()).error);

    // Six per turn, then a clear refusal
    for (let i = 0; i < 6; i++) env.runs.cancel(A, env.runs.start(A, spec({ title: "Run " + i })).run.id);
    const seventh = env.runs.start(A, spec());
    check("7th run in a turn refused", /already started 6 agents/.test(seventh.error || ""), seventh);
    check("7th run made no job", env.scheduler.queuedJobs().length === 0 && env.runs.list(A).length === 6);
    check("another turn may still start", !!env.runs.start({ chatId: "c1", turnId: "t2" }, spec()).run);
  }

  // --- Starting, per-turn limit, record --------------------------------------
  {
    const env = setup();
    const r1 = env.runs.start(A, spec({ context: [{ id: "p1", label: "The article", kind: "page", text: "Body", untrusted: true }] })).run;
    const r2 = env.runs.start(A, spec({ title: "Counterexamples" })).run;
    const r3 = env.runs.start(A, spec({ title: "Third" })).run;
    check("two start at once", r1.state === "starting" && r2.state === "starting" && env.sessions.made.length === 2);
    check("third waits queued", r3.state === "queued" && env.scheduler.inUse() === 2 && env.scheduler.queuedJobs().length === 1);
    const s1 = env.sessions.made[0];
    check("child session: provider, child flag, model/effort/tainted, prompt with context", s1.provider === "claude" && s1.opts.child === true &&
      s1.calls.slice(0, 4).join() === "model:sonnet,effort:medium,tainted:true,send" && s1.sent === "Task: Summarize the two articles.\nBody", s1.calls);
    check("untrusted context marks the run", r1.untrusted === true && r2.untrusted === false && r1.contextLabels[0] === "The article");

    s1.handlers.onText("Reading the first article.\n");
    check("text → working with an update entry", r1.state === "working" && r1.activity.at(-1).kind === "update" && r1.activity.at(-1).text === "Reading the first article.");
    s1.handlers.onText("Comparing claims");
    check("update entry replaced, not piled up", r1.activity.filter((a) => a.kind === "update").length === 1 && r1.activity.at(-1).text === "Comparing claims");
    s1.handlers.onStatus("Using a tool");
    check("status activity", r1.activity.at(-1).kind === "status");
    s1.handlers.onDone({ subtype: "success", result: "ignored" });
    check("done keeps streamed text as result", r1.state === "done" && r1.result === "Reading the first article.\nComparing claims" && r1.endedAt === env.clock.now());
    check("done kills the session (no stop)", s1.calls.includes("kill") && !s1.calls.includes("stop"));
    check("queued third got the freed slot", r3.state === "starting" && env.sessions.made.length === 3 && env.scheduler.inUse() === 2);
    check("onEnd once for the done run", env.router.ends.get(r1.id) === 1);

    // Late events after done are ignored
    s1.handlers.onText("late");
    s1.handlers.onDone({ subtype: "success" });
    check("late text after done ignored", r1.result.endsWith("Comparing claims") && !r1.text.includes("late") && env.router.ends.get(r1.id) === 1);

    // The record is plain data
    const values = Object.values(r1).concat(r1.activity.flatMap(Object.values));
    check("record has no functions/objects with methods", values.every((v) => typeof v !== "function") && !("session" in r1) && !("ticket" in r1));
    check("record survives a JSON round trip", JSON.stringify(JSON.parse(JSON.stringify(r1))) === JSON.stringify(r1) && Object.keys(JSON.parse(JSON.stringify(r1))).length === Object.keys(r1).length);
    check("record fields", ["id", "chatId", "turnId", "title", "instruction", "provider", "model", "effort", "browser", "contextLabels", "state", "created", "startedAt", "endedAt", "activity", "text", "result", "error", "files", "untrusted", "delivered", "gen"].every((k) => k in r1));
    check("onChange heard the states", env.changes.includes("queued") && env.changes.includes("working") && env.changes.includes("done"));

    // Assistant-message fallback (no deltas) and the error result
    const s2 = env.sessions.made[1];
    s2.handlers.onAssistantMessage({ message: { content: [{ type: "text", text: "Found three cases." }, { type: "tool_use" }] } });
    s2.handlers.onDone({ subtype: "success" });
    check("assistant message fallback gives the result", r2.state === "done" && r2.result === "Found three cases.");
    const s3 = env.sessions.made[2];
    s3.handlers.onDone({ subtype: "error_max_turns", is_error: true, result: "Ran out of turns" });
    check("error result → failed with its reason", r3.state === "failed" && r3.error === "Ran out of turns");
    check("all slots freed", env.scheduler.inUse() === 0);

    // Empty result fails
    const r4 = env.runs.start(A, spec()).run;
    env.sessions.made[3].handlers.onDone({ subtype: "success", result: "" });
    check("empty result → failed", r4.state === "failed" && r4.error === "The agent finished without a result.");
  }

  // --- Bounded text ----------------------------------------------------------
  {
    const env = setup();
    const r = env.runs.start(A, spec()).run;
    const s = env.sessions.made[0];
    for (let i = 0; i < 30; i++) s.handlers.onText("y".repeat(1000));
    check("text bounded to resultChars with a note", r.text.length <= AGENT_LIMITS.resultChars && /cut/.test(r.text.slice(-60)), r.text.length);
    s.handlers.onDone({ subtype: "success" });
    check("result bounded", r.result.length <= AGENT_LIMITS.resultChars && r.state === "done");
    check("activity text short", r.activity.every((a) => a.text.length <= 300));
    for (let i = 0; i < 60; i++) env.runs.note(r, "tool", "Clicked " + i);
    check("activity bounded, oldest dropped", r.activity.length === AGENT_LIMITS.activityItems && r.activity.at(-1).text === "Clicked 59" && r.activity.at(-1).kind === "tool");
    env.runs.addFile(r, { name: "out.md", path: "/x/out.md", size: 12, secret: "no", fn() {} });
    env.runs.taint(r);
    check("addFile keeps name/path/size only; taint", JSON.stringify(r.files) === '[{"name":"out.md","path":"/x/out.md","size":12}]' && r.untrusted === true);
  }

  // --- Start failures release their slot ---------------------------------------
  {
    const env = setup();
    env.sessions.throwNext = true;
    const r = env.runs.start(A, spec()).run;
    check("createSession throws → failed, slot released", r.state === "failed" && /Couldn't start/.test(r.error) && env.scheduler.inUse() === 0 && env.router.ends.get(r.id) === 1);
    env.sessions.rejectNext = true;
    const r2 = env.runs.start(A, spec()).run;
    check("send pending: still starting", r2.state === "starting" && env.scheduler.inUse() === 1);
    await tick();
    check("send rejects → failed, slot released, killed", r2.state === "failed" && /Couldn't send/.test(r2.error) && env.scheduler.inUse() === 0 && env.sessions.made[0].calls.includes("kill"));
    check("no timers left behind", env.clock.pending === 0);
  }

  // --- Scheduler: across windows -----------------------------------------------
  {
    const winA = [], winB = [];
    const all = [];
    const peers = () => all;
    const sa = createAgentScheduler({ limit: 4, peers });
    const sb = createAgentScheduler({ limit: 4, peers });
    all.push(sa, sb);
    const grants = [];
    const job = (s, owner, list) => { const t = s.request({ owner, perOwnerActive: 2, grant: (tk) => grants.push(owner + "#" + tk.id) }); list.push(t); return t; };
    job(sa, "x", winA); job(sa, "x", winA); job(sa, "y", winA); job(sb, "z", winB);
    check("4 slots used across two windows", sa.inUse() === 3 && sb.inUse() === 1);
    const queued = job(sb, "w", winB);
    check("5th waits; queued doesn't count as live", sb.inUse() === 1 && sb.queuedJobs().length === 1 && sa.inUse() + sb.inUse() === 4);
    sa.release(winA[0]);
    check("release in A grants B's queued job", sb.inUse() === 2 && sb.queuedJobs().length === 0 && sa.inUse() === 2 && grants.at(-1).startsWith("w#"));
    sa.release(winA[0]);
    check("release twice frees one slot", sa.inUse() === 2 && sa.inUse() + sb.inUse() === 4);

    // Fairness: y holds 1, x holds 1 (one released), new owner v holds 0 → v first
    const later = job(sa, "x", winA);
    const fresh = job(sb, "v", winB);
    sb.release(winB[0]); // z frees a slot
    check("owner with fewer slots goes first", grants.at(-1).startsWith("v#") && sa.queuedJobs().length === 1);
    queued.cancel(); // already granted: no-op
    later.cancel();
    check("cancel removes a queued job", sa.queuedJobs().length === 0);
    check("heldBy per window", sa.heldBy("x") === 1 && sb.heldBy("v") === 1);

    // A throwing grant leaves accounting right
    const sc = createAgentScheduler({ limit: 1 });
    sc.request({ owner: "q", grant: () => { throw new Error("bad"); } });
    check("throwing grant releases its slot", sc.inUse() === 0);
    // perOwnerActive blocks the owner even with free slots
    const t1 = sc.request({ owner: "o", perOwnerActive: 1, grant: () => {} });
    const sd = createAgentScheduler({ limit: 3 });
    sd.request({ owner: "o", perOwnerActive: 1, grant: () => {} });
    sd.request({ owner: "o", perOwnerActive: 1, grant: () => {} });
    check("per-owner limit keeps a job queued with free slots", sd.inUse() === 1 && sd.queuedJobs().length === 1 && sc.inUse() === 1 && !!t1);

    // Re-entrant: a grant that releases itself immediately lets the next in
    const se = createAgentScheduler({ limit: 1 });
    let order = [];
    const ta = se.request({ owner: "a", grant: (tk) => { order.push("a"); se.release(tk); } });
    se.request({ owner: "b", grant: () => order.push("b") });
    check("grant may release re-entrantly", order.join() === "a,b" && se.inUse() === 1 && !!ta);

    // Dispose frees a window's slots for the others
    sa.dispose();
    const tq = sb.request({ owner: "n", grant: () => {} });
    check("dispose frees slots for peers", sa.inUse() === 0 && sb.inUse() === 3 && !!tq);
  }

  // --- Two windows of runs share the cap ------------------------------------------
  {
    const all = [];
    const sa = createAgentScheduler({ peers: () => all });
    const sb = createAgentScheduler({ peers: () => all });
    all.push(sa, sb);
    const ea = setup({ scheduler: sa }), eb = setup({ scheduler: sb });
    const ra = [ea.runs.start({ chatId: "c1", turnId: "t1" }, spec()).run, ea.runs.start({ chatId: "c1", turnId: "t1" }, spec()).run, ea.runs.start({ chatId: "c2", turnId: "t1" }, spec()).run];
    const rb = [eb.runs.start({ chatId: "c3", turnId: "t1" }, spec()).run, eb.runs.start({ chatId: "c4", turnId: "t1" }, spec()).run];
    check("app-wide cap of 4 across windows", ra.every((r) => r.state === "starting") && rb[0].state === "starting" && rb[1].state === "queued");
    ea.sessions.made[0].handlers.onError("crashed");
    check("child error in A starts B's queued run", ra[0].state === "failed" && rb[1].state === "starting" && sa.inUse() + sb.inUse() === 4);
  }

  // --- Ownership --------------------------------------------------------------------
  {
    const env = setup();
    const r = env.runs.start(A, spec()).run;
    const otherChat = { chatId: "c2", turnId: "t1" }, otherTurn = { chatId: "c1", turnId: "t2" };
    check("get: other chat/turn → null", env.runs.get(otherChat, r.id) === null && env.runs.get(otherTurn, r.id) === null && env.runs.get(A, r.id) === r);
    const st = env.runs.status(otherChat, [r.id]);
    check("status: other chat → unknown", st.runs.length === 0 && st.unknown[0] === r.id);
    const w = await env.runs.wait(otherTurn, [r.id], 5000);
    check("wait: other turn → unknown, resolves at once", w.unknown[0] === r.id && w.pending.length === 0 && w.results.length === 0);
    const c = env.runs.cancel(otherChat, r.id);
    check("cancel: other chat → no effect", c.ok === false && r.state === "starting");
    check("forged id → unknown", env.runs.status(A, ["a00000000", r.id]).unknown.join() === "a00000000");
    check("list/listChat", env.runs.list(A).length === 1 && env.runs.list(otherTurn).length === 0 && env.runs.listChat("c1").length === 1);
  }

  // --- Waiting --------------------------------------------------------------------
  {
    const env = setup();
    const r1 = env.runs.start(A, spec({ title: "One" })).run;
    const r2 = env.runs.start(A, spec({ title: "Two" })).run;
    const [s1, s2] = env.sessions.made;
    let got = null;
    env.runs.wait(A, [r1.id, r2.id], 15000).then((x) => { got = x; });
    s1.handlers.onText("Result one");
    s1.handlers.onDone({ subtype: "success" });
    await tick();
    check("wait still pending with one running", got === null);
    s2.handlers.onError("It broke");
    await tick();
    check("wait resolves early when all settle", got && got.pending.length === 0 && got.results.length === 2);
    check("partial success kept (done + failed)", got.results[0].state === "done" && got.results[0].result === "Result one" && got.results[1].state === "failed" && got.results[1].error === "It broke");
    check("results carry files and untrusted", Array.isArray(got.results[0].files) && got.results[0].untrusted === false);
    check("delivered marked", r1.delivered && r2.delivered && env.runs.undelivered(A).length === 0);
    const again = await env.runs.wait(A, [r1.id], 1000);
    check("second delivery: delivered flag only", again.results[0].delivered === true && !("result" in again.results[0]) && again.results[0].state === "done");

    // Timeout is pending, not failure; clamped to waitMaxMs
    const r3 = env.runs.start(A, spec({ title: "Slow" })).run;
    let t = null;
    env.runs.wait(A, [r3.id], 999999).then((x) => { t = x; });
    env.clock.advance(AGENT_LIMITS.waitMaxMs - 1);
    await tick();
    check("not resolved before waitMaxMs", t === null);
    env.clock.advance(1);
    await tick();
    check("timeout clamped to waitMaxMs → pending", t && t.pending[0] === r3.id && t.results.length === 0 && r3.state === "starting");
    check("undelivered empty while running; active counts", env.runs.active(A) === 1);

    // Several waits at once; cancelTurn resolves all promptly
    let w1 = null, w2 = null;
    env.runs.wait(A, [r3.id], 20000).then((x) => { w1 = x; });
    env.runs.wait(A, [], 20000).then((x) => { w2 = x; });
    env.runs.cancelTurn(A);
    await tick();
    check("cancelTurn resolves outstanding waits", w1 && w2 && w1.results[0].state === "stopped" && w2.pending.length === 0);
    check("stopped run delivered to one wait only", "result" in w1.results[0] && w2.results.find((x) => x.id === r3.id).delivered === true);
  }

  // --- Cancelling ----------------------------------------------------------------------
  {
    const env = setup();
    const r1 = env.runs.start(A, spec()).run;
    const r2 = env.runs.start(A, spec()).run;
    const r3 = env.runs.start(A, spec()).run;
    check("third queued", r3.state === "queued");
    const c3 = env.runs.cancel(A, r3.id);
    check("cancel queued → stopped, never spawns", c3.ok && r3.state === "stopped" && env.sessions.made.length === 2 && env.scheduler.queuedJobs().length === 0);
    check("queued cancel: onEnd once, no 'actions stay done' note", env.router.ends.get(r3.id) === 1 && !r3.activity.some((a) => /stay done/.test(a.text)));
    const s1 = env.sessions.made[0];
    s1.handlers.onText("Working on it");
    const c1 = env.runs.cancel(A, r1.id);
    check("cancel running → stop + kill, stopped", c1.ok && c1.state === "stopped" && s1.calls.includes("stop") && s1.calls.includes("kill") && r1.state === "stopped");
    check("stopped run says finished actions stay done", r1.activity.some((a) => a.text === "Stopped. Actions it already finished stay done."));
    const c1b = env.runs.cancel(A, r1.id);
    check("cancel is idempotent", c1b.ok && c1b.state === "stopped" && env.router.ends.get(r1.id) === 1 && s1.calls.filter((c) => c === "kill").length === 1);
    const gen = r1.gen;
    s1.handlers.onText("late text");
    s1.handlers.onDone({ subtype: "success", result: "late" });
    check("late text/done after cancel ignored", r1.state === "stopped" && !r1.text.includes("late") && r1.result === "" && r1.gen === gen);
    const perm = await s1.handlers.onPermission({ tool_name: "mcp__zenai__browser_click", input: {} }, true);
    check("late approval after cancel → deny, router not asked", perm.behavior === "deny" && env.router.perms.length === 0);
    check("one slot left in use", env.scheduler.inUse() === 1);
    env.runs.cancelChat("c1");
    check("cancelChat stops the rest", r2.state === "stopped" && env.scheduler.inUse() === 0);

    // dispose → interrupted
    const env2 = setup();
    const r = env2.runs.start(A, spec()).run;
    const q = [env2.runs.start(A, spec()).run, env2.runs.start(A, spec()).run][1];
    env2.runs.dispose();
    check("dispose interrupts running and queued", r.state === "interrupted" && q.state === "interrupted" && env2.scheduler.inUse() === 0 && env2.sessions.made.length === 2);
    check("no start after dispose", !!env2.runs.start(A, spec()).error);
  }

  // --- Timers ----------------------------------------------------------------------------
  {
    const env = setup();
    const r = env.runs.start(A, spec()).run;
    const s = env.sessions.made[0];
    s.handlers.onText("Started");
    env.clock.advance(60000);
    const pending = s.handlers.onPermission({ tool_name: "mcp__zenai__browser_click", input: { ref: "e1" } }, true);
    await tick();
    const p = env.router.perms[0];
    check("router gets run, request, taint", p.run === r && p.req.input.ref === "e1" && p.tainted === true);
    p.setWaiting(true);
    check("setWaiting(true) → waiting", r.state === "waiting");
    env.clock.advance(4.5 * 60000); // 5.5 minutes in all: past the active limit if it weren't paused
    check("active timer paused while waiting", r.state === "waiting");
    p.setWaiting(false);
    check("setWaiting(false) → working", r.state === "working");
    p.resolve({ behavior: "allow", updatedInput: { ref: "e1" } });
    const ans = await pending;
    check("router's allow passes through", ans.behavior === "allow" && ans.updatedInput.ref === "e1");
    env.clock.advance(4 * 60000 - 1);
    check("not yet at 5 minutes of work", r.state === "working");
    env.clock.advance(1);
    check("active timeout → failed with message", r.state === "failed" && r.error === "Stopped after 5 minutes of work." && env.scheduler.inUse() === 0, [r.state, r.error, env.scheduler.inUse()]);
    check("timeout stops and kills", s.calls.includes("stop") && s.calls.includes("kill") && env.router.ends.get(r.id) === 1 && env.clock.pending === 0);

    // The elapsed timer still runs during a long approval
    const r2 = env.runs.start(A, spec()).run;
    const s2 = env.sessions.made[1];
    const pend2 = s2.handlers.onPermission({ tool_name: "mcp__zenai__browser_type", input: {} }, true);
    await tick();
    env.router.perms[1].setWaiting(true);
    env.clock.advance(10 * 60000);
    check("elapsed timeout fires while waiting", r2.state === "failed" && r2.error === "Stopped after 10 minutes.");
    env.router.perms[1].resolve({ behavior: "allow", updatedInput: {} });
    const late = await pend2;
    check("approval that comes after the timeout → deny", late.behavior === "deny");
    check("slot released once after timeout", env.scheduler.inUse() === 0 && env.router.ends.get(r2.id) === 1);

    // Router throws → deny
    const r3 = env.runs.start(A, spec()).run;
    const s3 = env.sessions.made[2];
    const bad = env.router.onPermission;
    env.router.onPermission = () => Promise.reject(new Error("oops"));
    const ans3 = await s3.handlers.onPermission({ tool_name: "mcp__zenai__browser_click", input: {} }, false);
    env.router.onPermission = bad;
    check("router error → deny, run carries on", ans3.behavior === "deny" && r3.state === "starting");
  }

  // --- What a child may call -------------------------------------------------------------
  {
    const env = setup();
    const r = env.runs.start(A, spec()).run;
    const s = env.sessions.made[0];
    const a1 = await s.handlers.onPermission({ tool_name: "mcp__zenai__agent_start", input: {} }, false);
    const a2 = await s.handlers.onPermission({ tool_name: "mcp_zenai_agent_wait", input: {} }, false);
    check("child can't approve agent_* tools (both name styles)", a1.behavior === "deny" && a2.behavior === "deny" && /other agents/.test(a1.message) && env.router.perms.length === 0);
    const m1 = await s.handlers.onMcpMessage("zenai", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "agent_start", arguments: {} } });
    check("tools/call agent_* refused with isError", m1.id === 7 && m1.result.isError === true && /other agents/.test(m1.result.content[0].text) && env.router.mcp.length === 0);
    const m2 = await s.handlers.onMcpMessage("zenai", { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "save_file", arguments: {} } });
    check("other tools go to the router", m2.id === 8 && env.router.mcp.length === 1 && env.router.mcp[0].run === r && env.router.mcp[0].serverName === "zenai");
    s.handlers.onInit({}); s.handlers.onRateLimit({}); s.handlers.onCompact({});
    check("onInit/onRateLimit/onCompact are no-ops", r.state === "starting");
    env.runs.cancel(A, r.id);
    const m3 = await s.handlers.onMcpMessage("zenai", { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "save_file" } });
    check("after stop: MCP calls refused", m3.result.isError === true && /stopped/.test(m3.result.content[0].text) && env.router.mcp.length === 1);
    s.handlers.onSessionGone();
    check("onEnd exactly once per run", env.router.ends.get(r.id) === 1 && r.state === "stopped");
  }

  // --- A gone process ----------------------------------------------------------------------
  {
    const env = setup();
    const r = env.runs.start(A, spec()).run;
    env.sessions.made[0].handlers.onSessionGone();
    check("session gone → failed, slot freed", r.state === "failed" && /ended unexpectedly/.test(r.error) && env.scheduler.inUse() === 0);
    check("failed run is undelivered until waited", env.runs.undelivered(A).length === 1);
    env.runs.markDelivered(r);
    check("markDelivered", r.delivered === true && env.runs.undelivered(A).length === 0);
  }

  done();
})().catch(crash);
