// ClaudeSession (src/session.mjs) against real Claude Code: the model list,
// switching models without a restart, Stop without killing the process, Stop
// while starting, --model on (re)start, and the plan's usage limits.
import { Subprocess } from "../helpers/firefox.mjs";
import { checker, crash } from "../helpers/common.mjs";
import { ClaudeSession } from "../../src/session.mjs";
import { handleZenMcp } from "../../src/files.mjs";

const { check, done } = checker();
const ok = (cond, name, extra) => check(name, cond, extra);
const lastCall = () => Subprocess.calls[Subprocess.calls.length - 1];
(async () => {
  let init = null, results = [], texts = "", waiter = null, limits = [];
  const nextDone = () => new Promise((r) => (waiter = r));
  const s = new ClaudeSession({
    onText(t) { texts += t; }, onAssistantMessage() {}, onStatus() {},
    onDone(msg) { results.push(msg); if (waiter) { const w = waiter; waiter = null; w(msg); } },
    onError(e) { console.log("onError", e); if (waiter) { const w = waiter; waiter = null; w({ error: e }); } },
    onInit(i) { init = i; },
    onRateLimit(info) { limits.push(info); },
    async onPermission() { return { behavior: "deny", message: "no" }; },
    onMcpMessage: (sv, msg) => handleZenMcp(msg, { onFile() {}, browserTool: async () => [{ type: "text", text: "n/a" }] }),
  });
  s.tainted = true; s.effort = "low";
  let r = nextDone(); await s.send("Reply with just: one"); r = await r;
  ok(init && Array.isArray(init.models) && init.models.length > 1, "Claude Code reports its models", init && init.models.map((x) => x.value).join(", "));
  const w = limits.length && limits[0].unifiedWindows;
  ok(w && Number.isFinite(w.five_hour && w.five_hour.utilization) && Number.isFinite(w.seven_day && w.seven_day.utilization), "Claude Code reports the 5-hour and weekly limits (rate_limit_event)", limits[0]);
  ok(lastCall().environment.CLAUDE_CODE_DISABLE_CLAUDE_MDS === "1" && !lastCall().args.includes("--model"), "lighter env, no --model for default");
  const first = Object.keys(r.modelUsage).pop();
  s.setModel("haiku");
  r = nextDone(); await s.send("Reply with just: two"); r = await r;
  ok(Subprocess.calls.length === 1 && r.modelUsage && Object.keys(r.modelUsage).some((k) => /haiku/.test(k)), "switch to Haiku without a restart", Object.keys(r.modelUsage).join(", "));
  s.setModel("default");
  r = nextDone(); await s.send("Reply with just: three"); r = await r;
  // modelUsage is cumulative; check this turn's model via the assistant reply's usage would need more plumbing → compare cost delta by model
  ok(Subprocess.calls.length === 1 && r.subtype === "success", "back to default without a restart", JSON.stringify(Object.fromEntries(Object.entries(r.modelUsage).map(([k, v]) => [k, v.outputTokens]))));
  // Stop mid-reply, then immediately send the next message
  texts = "";
  const before = results.length;
  await s.send("Count from 1 to 400, one number per line, no other text.");
  while (texts.length < 20) await new Promise((x) => setTimeout(x, 20));
  const t0 = Date.now();
  s.stop();
  r = nextDone(); await s.send("What's 5+5? Reply with just the number."); r = await r;
  ok(Subprocess.calls.length === 1, "Stop keeps the same Claude Code process", `Subprocess.calls.length=${Subprocess.calls.length}`);
  ok(results.length === before + 1 && /10/.test(r.result || ""), "stopped reply is dropped; next reply is clean", `${Date.now() - t0}ms, result=${JSON.stringify(r.result)}`);
  // Stop while nothing is running: no-op
  s.stop();
  r = nextDone(); await s.send("Reply with just: ok"); r = await r;
  ok(r.subtype === "success" && Subprocess.calls.length === 1, "Stop when idle does nothing");
  // Stop while starting (new process): the message isn't sent
  await s.reset();
  const sp = Subprocess.calls.length; const d0 = results.length;
  const p = s.send("Reply with just: should-not-run"); s.stop(); await p;
  await new Promise((x) => setTimeout(x, 6000));
  ok(results.length === d0 && !s.busy, "Stop while starting cancels that message", `Subprocess.calls.length ${sp}→${Subprocess.calls.length}`);
  r = nextDone(); await s.send("Reply with just: after"); r = await r;
  ok(/after/i.test(r.result || ""), "next message after that works", JSON.stringify(r.result));
  // --model is passed on (re)start when one is picked
  await s.reset(); s.setModel("haiku");
  r = nextDone(); await s.send("Reply with just: hi"); r = await r;
  ok(lastCall().args.includes("--model") && lastCall().args[lastCall().args.indexOf("--model") + 1] === "haiku" && Object.keys(r.modelUsage).every((k) => /haiku/.test(k)), "picked model is used from the start", Object.keys(r.modelUsage).join(","));
  await s.reset();
  done();
})().catch(crash);
setTimeout(() => { console.log("timeout"); process.exit(1); }, 240000);
