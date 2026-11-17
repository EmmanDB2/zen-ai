// Helper agents in an Antigravity chat: the same delegation as
// agents.test.mjs (Claude Code), through ACP. The parent gets agent_* only
// once a skill with agents: runs; each agent is its own ACP process with its
// own MCP bridge; native tools are refused for agents without a card; agent
// tools are refused for agents (permission and direct call); the parent's
// exact-argument grants still hold; Stop stops the parent and every agent.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const DIR = "/profile/chrome/zenai-skills";
const sk = (name, extra = "") => `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\nBODY-OF-${name}`;
const FILES = {
  "team.md": sk("team", "agents: 2\naccess:\n  - about-me\n"),
  "plain.md": sk("plain"),
  "_about-me.md": "# About me\nName: ABOUT-ME-TEXT\n",
};

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
};

(async () => {
  const zen = await fakeZen({ antigravity: true, holdReplies: true, prefs: { provider: "antigravity" } });
  const { w, $, $$, acp } = zen;
  const paths = new Map(Object.entries(FILES).map(([k, v]) => [`${DIR}/${k}`, v]));
  const io = w.IOUtils;
  const { getChildren, readUTF8, exists, stat } = io;
  const kids = (d) => [...new Set([...paths.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))];
  io.getChildren = async (d) => (d.startsWith(DIR) ? kids(d) : getChildren(d));
  io.readUTF8 = async (p) => { if (paths.has(p)) return paths.get(p); if (p.startsWith(DIR)) throw new Error("not found"); return readUTF8(p); };
  io.exists = async (p) => (p.startsWith(DIR) ? p === DIR || paths.has(p) || kids(p).length > 0 : exists(p));
  io.stat = async (p) => (p.startsWith(DIR) ? { type: kids(p).length ? "directory" : "regular" } : stat(p));
  w.Services.prefs.setStringPref("zenai.skillsVersion", "3");

  await zen.open();
  const input = $(".zai-input");
  const promptText = (s) => (s.prompt || []).map((b) => b.text || "").join("");
  // holdSpawn: the prewarm that typing triggers can't start the ACP process
  // until the message is sent (works around the restart bug below)
  let spawnGate = null;
  const spawnCall = acp.subprocess.call.bind(acp.subprocess);
  acp.subprocess.call = async (opts) => { while (spawnGate) await spawnGate; return spawnCall(opts); };
  const run = async (name, { holdSpawn = false } = {}) => {
    let open = null;
    if (holdSpawn) spawnGate = new Promise((r) => (open = r));
    input.value = "/" + name;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(80);
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(30);
    await zen.send("", { wait: false });
    if (open) { await sleep(30); spawnGate = null; open(); }
    await until(() => acp.sent.length && promptText(acp.sent.at(-1)).includes(`BODY-OF-${name}`));
    const s = acp.sent.at(-1);
    return { proc: s.proc, text: promptText(s) };
  };
  // ACP permission → "allow"/"deny"
  const perm = async (name, args, proc) => ((await acp.permission(name, args, { proc })).outcome || {}).optionId;
  const call = async (name, args, proc) => (await acp.callTool(name, args, proc)).result || {};
  const textOf = (res) => (res.content || []).map((c) => c.text || "").join("");
  const toolNames = async (proc) => ((await acp.listTools(proc)).result || {}).tools.map((t) => t.name);
  // fakeZen doesn't hand replyFor to the fake ACP peer: end a held prompt
  // with our own text, the way fakeAcp's finish() does
  const finishWith = (proc, text) => {
    const prompt = proc.prompt;
    if (!prompt) return false;
    proc.timers.forEach(clearTimeout);
    proc.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    proc.push({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
    proc.prompt = null;
    return true;
  };
  const box = (title) => $$(".zai-task").find((b) => b.querySelector(".zai-task-title").textContent === title);
  const state = (title) => (box(title) || {}).dataset?.state;

  // --- A plain message first: no agent tools --------------------------------------
  let msg = await run("plain");
  const parents = new Set([msg.proc]);
  let names = await toolNames(msg.proc);
  check("before an agents skill, the parent's bridge lists no agent_* tools", names.length > 0 && !names.some((n) => n.startsWith("agent_")), names);
  check("...and agent_start is refused at permission time", (await perm("mcp_zenai_agent_start", { title: "Sneaky", instruction: "x" }, msg.proc)) === "deny");
  acp.finishReplies({ proc: msg.proc });
  await zen.idle();

  // --- The skill that allows two agents ---------------------------------------------
  // In the same chat: listing agent tools restarts the ACP process (resume).
  // (Once a bug: the restart's kill() cancelled the waiting message.)
  const sentBefore = acp.sent.length;
  msg = await run("team");
  const sameChat = acp.sent.length > sentBefore && msg.text.includes("BODY-OF-team");
  check("an agents skill run later in the same Antigravity chat restarts it and the message still goes out", sameChat,
    acp.calls.slice(-3).map((m) => m.method || m.id));
  if (!sameChat) {
    // Work around it for the rest of the test: a fresh chat
    if ($(".zai-send.zai-stop")) zen.click($(".zai-send.zai-stop"));
    await zen.idle();
    zen.newChat();
    await sleep(60);
    msg = await run("team", { holdSpawn: true });
  }
  const parent = msg.proc;
  for (const p of acp.procs) parents.add(p);
  check("the parent is told what it may hand to agents", msg.text.includes("<agent_context") && msg.text.includes("data:_about-me.md"), msg.text.slice(0, 400));
  names = await toolNames(parent);
  check("after the skill runs, the parent's bridge lists agent_start/status/wait/cancel", ["agent_start", "agent_status", "agent_wait", "agent_cancel"].every((n) => names.includes(n)), names);

  const argsA = { title: "Source A", instruction: "TASK-A read the file", context: ["data:_about-me.md"] };
  check("parent: mcp_zenai_agent_start is allowed (no card)", (await perm("mcp_zenai_agent_start", argsA, parent)) === "allow" && !$(".zai-approval"));
  let res = await call("agent_start", argsA, parent);
  const idA = (textOf(res).match(/Started agent (a[0-9a-f]+)/) || [])[1];
  check("agent_start with the approved arguments starts agent A", !res.isError && !!idA, textOf(res));
  const children = () => acp.procs.filter((p) => !parents.has(p));
  await until(() => children().length === 1 && !!children()[0].bridge);
  const childA = children()[0];
  check("agent A is a separate ACP process with its own bridge", !!childA && childA !== parent && !!childA.bridge && childA.bridge !== parent.bridge, [!!childA, !!(childA && childA.bridge)]);
  check("no Claude Code process for an Antigravity chat's agent", zen.spawns.length === 0);

  // Exact-argument grants still hold for the parent
  const argsB = { title: "Source B", instruction: "TASK-B" };
  check("parent: permission for agent B", (await perm("mcp_zenai_agent_start", argsB, parent)) === "allow");
  res = await call("agent_start", { ...argsB, instruction: "TASK-B plus something never approved", context: ["data:_about-me.md"] }, parent);
  check("calling agent_start with other arguments than approved fails, starting nothing", res.isError && /not been approved/.test(textOf(res)) && children().length === 1, textOf(res));
  res = await call("agent_start", argsB, parent);
  const idB = (textOf(res).match(/Started agent (a[0-9a-f]+)/) || [])[1];
  check("...the approved arguments still work once", !res.isError && !!idB, textOf(res));
  res = await call("agent_start", argsB, parent);
  check("...and only once (a grant is one call)", res.isError && /not been approved/.test(textOf(res)), textOf(res));
  await until(() => children().length === 2 && children().every((p) => p.bridge));
  const childB = children()[1];

  await until(() => acp.sent.filter((s) => s.proc === childA || s.proc === childB).length === 2);
  const toA = promptText(acp.sent.find((s) => s.proc === childA) || {});
  const toB = promptText(acp.sent.find((s) => s.proc === childB) || {});
  check("agent A's task has its instruction and the context item it was given", toA.includes("<agent_task") && toA.includes("TASK-A") && toA.includes("ABOUT-ME-TEXT"), toA.slice(0, 300));
  check("agent B's task has only its own instruction (no chat, skill or other context)", toB.includes("TASK-B") && !toB.includes("ABOUT-ME-TEXT") && !toB.includes("BODY-OF-team") && !toB.includes("TASK-A") && !toB.includes("never approved"));
  check("both boxes show, working, naming Antigravity (same provider)", ["Source A", "Source B"].every((t) => box(t) && /Antigravity/.test(box(t).querySelector(".zai-task-who").textContent)) && ["starting", "working"].includes(state("Source A")), $$(".zai-task").map((b) => b.dataset.state + " " + b.querySelector(".zai-task-who").textContent));
  check("agent processes run the same Antigravity CLI as the chat", children().every((p) => p.opts.command === "/fake/agy"));

  // What an agent may not do
  check("agent: native run_command is rejected without an approval card", (await perm("run_command", { CommandLine: "echo hi" }, childA)) === "deny" && !$(".zai-approval"));
  check("agent: mcp_zenai_agent_start is rejected", (await perm("mcp_zenai_agent_start", { title: "Nested", instruction: "x" }, childA)) === "deny");
  res = await call("agent_start", { title: "Nested", instruction: "x" }, childA);
  check("agent: a direct agent_start over its bridge is refused and starts nothing", res.isError && children().length === 2, textOf(res));
  check("agent: mcp_zenai_read_skill is rejected", (await perm("mcp_zenai_read_skill", { name: "plain" }, childA)) === "deny");
  const childNames = await toolNames(childA);
  check("agent's tools/list has no agent_*, read_skill or browser_* tools", childNames.length > 0 && !childNames.some((n) => n.startsWith("agent_") || n.startsWith("browser_") || n === "read_skill"), childNames);
  check("agent: its own Zen file tool is allowed", (await perm("mcp_zenai_save_file", { name: "notes.txt", content: "x" }, childA)) === "allow");

  // A finishes → the parent's agent_wait returns its result
  finishWith(childA, "RESULT-OF-Source-A");
  await until(() => state("Source A") === "done");
  check("A is done", state("Source A") === "done", state("Source A"));
  const waitArgs = { ids: [idA], seconds: 1 };
  check("parent: agent_wait is allowed", (await perm("mcp_zenai_agent_wait", waitArgs, parent)) === "allow");
  res = await call("agent_wait", waitArgs, parent);
  check("agent_wait returns A's result as untrusted data", textOf(res).includes("RESULT-OF-Source-A") && /<agent_result[^>]*state="done"/.test(textOf(res)) && textOf(res).includes("<untrusted_content>"), textOf(res));
  check("A's process is closed once it's done", childA.killed && childA.bridge.closed);

  // Stop: the parent and B stop; B's process is cancelled/killed
  const callsBefore = acp.calls.length;
  zen.click($(".zai-send.zai-stop"));
  await until(() => state("Source B") === "stopped" && childB.killed);
  const later = acp.calls.slice(callsBefore);
  check("Stop cancels the parent's ACP prompt", later.some((m) => m.method === "session/cancel" && m.params.sessionId === parent.sessionId));
  check("Stop stops agent B and kills its process", state("Source B") === "stopped" && childB.killed && state("Source A") === "done", [state("Source B"), childB.killed]);
  await until(() => !$(".zai-send.zai-stop"));
  check("the reply ends", !$(".zai-send.zai-stop"));

  // Late output from B is ignored
  const sentNow = acp.sent.length;
  finishWith(childB, "LATE-RESULT");
  res = await call("save_file", { name: "late.txt", content: "x" }, childB);
  await sleep(80);
  check("late output after Stop changes nothing", state("Source B") === "stopped" && !box("Source B").textContent.includes("LATE-RESULT") && res.isError && acp.sent.length === sentNow, textOf(res));

  check("no window errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  done();
})().catch(crash);
