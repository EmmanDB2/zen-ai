// Helper agents (agents: N in a skill): Zen runs separate Claude Code
// sessions for the chat's AI. Only a skill that allows them; agents see only
// their task and the context items named; they can't manage agents, read
// skills, use built-in tools or the user's tabs; the reply waits for them and
// combines their results; Stop stops them all; approvals are per agent; the
// saved chat keeps their boxes (not their instructions or context).
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const DIR = "/profile/chrome/zenai-skills";
const sk = (name, extra = "") => `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\nBODY-OF-${name}`;
const FILES = {
  "team.md": sk("team", "agents: 2\naccess:\n  - about-me\n"),
  "plain.md": sk("plain"),
  "wrong.md": sk("wrong", "agents: 5\n"),
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
  // Children answer with their task's title; the parent with a draft
  const zen = await fakeZen({
    holdReplies: true,
    replyFor: (text) => {
      const m = text.match(/<agent_task title="([^"]*)"/);
      if (m) return `RESULT-OF-${m[1]}`;
      if (text.includes("your agents have finished")) return "COMBINED ANSWER";
      return null;
    },
  });
  const { w, $, $$ } = zen;
  const paths = new Map(Object.entries(FILES).map(([k, v]) => [`${DIR}/${k}`, v]));
  const io = w.IOUtils;
  const { getChildren, readUTF8, exists } = io;
  const kids = (d) => [...new Set([...paths.keys()].filter((k) => k.startsWith(d + "/")).map((k) => d + "/" + k.slice(d.length + 1).split("/")[0]))];
  io.getChildren = async (d) => (d.startsWith(DIR) ? kids(d) : getChildren(d));
  io.readUTF8 = async (p) => { if (paths.has(p)) return paths.get(p); if (p.startsWith(DIR)) throw new Error("not found"); return readUTF8(p); };
  io.exists = async (p) => (p.startsWith(DIR) ? p === DIR || paths.has(p) || kids(p).length > 0 : exists(p));
  io.stat = async (p) => ({ type: kids(p).length ? "directory" : "regular" });
  w.Services.prefs.setStringPref("zenai.skillsVersion", "3");

  await zen.open();
  const input = $(".zai-input");
  const run = async (name) => {
    input.value = "/" + name;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(80);
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(30);
    const before = zen.sent.length;
    await zen.send("", { wait: false });
    // (the session may restart first, to list the agent tools)
    const ok = await until(() => zen.sent.length > before && zen.sent.at(-1).text.includes(`BODY-OF-${name}`) && !zen.sent.at(-1).proc.killed, 10000);
    if (!ok) throw new Error(`/${name}: the message never reached Claude Code`);
    return zen.sent.at(-1);
  };
  const textOf = (res) => (res.content || []).map((c) => c.text || "").join("");
  const start = async (parent, args) => {
    const perm = await zen.askPermission("mcp__zenai__agent_start", args, { proc: parent });
    const res = await zen.callTool("agent_start", perm.updatedInput || args, { proc: parent });
    const id = (textOf(res).match(/Started agent (a[0-9a-f]+)/) || [])[1];
    return { perm, res, id, text: textOf(res) };
  };
  const children = () => zen.spawns.filter((p) => zen.isChildSpawn(p));
  const box = (title) => $$(".zai-task").find((b) => b.querySelector(".zai-task-title").textContent === title);
  const state = (title) => (box(title) || {}).dataset?.state;
  const lines = () => $$(".zai-thread .zai-toolline").map((l) => l.textContent).join(" | ");

  // --- 1. No delegation without the skill's opt-in -------------------------------
  let msg = await run("plain");
  let parent = msg.proc;
  let listed = await zen.listTools({ proc: parent });
  check("a chat that never ran an agents skill isn't offered agent tools", !listed.tools.some((t) => t.name.startsWith("agent_")), listed.tools.map((t) => t.name));
  check("no <agent_context> without opt-in", !msg.text.includes("<agent_context"));
  let r = await start(parent, { title: "Sneaky", instruction: "x" });
  check("agent_start is denied without opt-in, and no process starts", r.perm.behavior === "deny" && r.res.isError && /only a skill with agents:/.test(r.text) && !children().length && !$(".zai-task"), [r.perm, r.text]);
  await zen.finishReplies();

  zen.newChat();
  await sleep(40);
  msg = await run("wrong");
  check("a bad agents: value says why, and the skill runs without agents", /agents: “5” isn't a whole number from 0 to 2/.test(lines()) && !msg.text.includes("<agent_context"), lines());
  await zen.finishReplies();

  // --- 2. A skill that allows two agents --------------------------------------------
  zen.newChat();
  await sleep(40);
  msg = await run("team");
  parent = msg.proc;
  check("the parent is told what it may hand to agents (by id)", msg.text.includes("<agent_context") && msg.text.includes("- data:_about-me.md:"), msg.text.slice(0, 600));
  check("the parent is a normal chat session, not an agent's", !zen.isChildSpawn(parent) && !parent.args.includes("--no-session-persistence"));
  listed = await zen.listTools({ proc: parent });
  check("the parent now lists agent_start/status/wait/cancel", ["agent_start", "agent_status", "agent_wait", "agent_cancel"].every((n) => listed.tools.some((t) => t.name === n)));

  r = await start(parent, { title: "Source A", instruction: "Read the user's file. TASK-A", context: ["data:_about-me.md"] });
  const idA = r.id;
  check("agent_start: no card, returns an id right away", r.perm.behavior === "allow" && !$(".zai-approval") && !!idA, r.text);
  const b = await start(parent, { title: "Source B", instruction: "TASK-B" });
  const idB = b.id;
  await until(() => children().length === 2);
  const [childA, childB] = children();
  check("two separate child processes", children().length === 2 && childA !== childB && childA !== parent);
  check("children keep no transcript and never resume the parent's", childA.args.includes("--no-session-persistence") && !childA.resume && !childA.args.includes("--resume"));
  check("children start without built-in tools", childA.args[childA.args.indexOf("--tools") + 1] === "");
  await until(() => zen.sent.filter((s) => s.proc === childA || s.proc === childB).length === 2);
  const toA = zen.sent.find((s) => s.proc === childA).text;
  const toB = zen.sent.find((s) => s.proc === childB).text;
  check("agent A gets its task and the item it was given", toA.includes("TASK-A") && toA.includes("ABOUT-ME-TEXT") && toA.includes("<agent_task"), toA.slice(0, 400));
  check("agent B gets only its own task (no chat, no other context)", toB.includes("TASK-B") && !toB.includes("ABOUT-ME-TEXT") && !toB.includes("BODY-OF-team") && !toB.includes("TASK-A"));
  check("two boxes in the reply, working, with Stop", !!box("Source A") && !!box("Source B") && $$(".zai-task .zai-task-stop").filter((x) => !x.hidden).length === 2, $$(".zai-task").map((x) => x.dataset.state));
  check("a box names the provider", /Claude Code/.test(box("Source A").querySelector(".zai-task-who").textContent));

  // A third waits for a slot (two at a time); an unknown context id starts nothing
  r = await start(parent, { title: "Bad context", instruction: "x", context: ["../../etc/passwd"] });
  check("a context id that wasn't offered fails without a process", r.res.isError && /no context item/.test(r.text) && children().length === 2 && !box("Bad context"), r.text);
  const c = await start(parent, { title: "Source C", instruction: "TASK-C" });
  await sleep(50);
  check("a third agent is queued, without a process", state("Source C") === "queued" && children().length === 2, state("Source C"));

  // What an agent may and may not do
  const childTools = await zen.listTools({ proc: childA });
  const names = childTools.tools.map((t) => t.name);
  check("an agent isn't offered agent tools, read_skill or the browser", !names.some((n) => n.startsWith("agent_") || n.startsWith("browser_")) && !names.includes("read_skill") && names.includes("save_file"), names);
  let p = await zen.askPermission("mcp__zenai__agent_start", { title: "Nested", instruction: "x" }, { proc: childA });
  let call = await zen.callTool("agent_start", { title: "Nested", instruction: "x" }, { proc: childA });
  check("an agent can't start agents (permission and direct call)", p.behavior === "deny" && call.isError && /can't start or manage other agents/.test(textOf(call)) && children().length === 2);
  p = await zen.askPermission("Bash", { command: "ls" }, { proc: childA });
  check("an agent's built-in tool is refused without a card", p.behavior === "deny" && !$(".zai-approval"), p);
  call = await zen.callTool("read_skill", { name: "plain" }, { proc: childA });
  check("read_skill is refused for an agent even when called by name", call.isError && !textOf(call).includes("BODY-OF-plain"));
  call = await zen.callTool("browser_read", {}, { proc: childA });
  check("an agent without the browser can't call browser tools", call.isError);

  // Ownership: ids of another turn/chat are unknown
  call = await zen.callTool("agent_status", { ids: ["a00000000"] }, { proc: parent });
  check("a forged id is unknown", /Not agents of this message: a00000000/.test(textOf(call)), textOf(call));

  // A finishes → C gets its slot; results come back once, as data
  await zen.finishReplies({ proc: childA });
  await until(() => state("Source A") === "done");
  await until(() => children().length === 3);
  check("A is done and its box collapsed", state("Source A") === "done" && box("Source A").querySelector(".zai-task-details").hidden);
  check("C starts once A's slot is free", children().length === 3 && ["starting", "working"].includes(state("Source C")), state("Source C"));
  call = await zen.callTool("agent_wait", { ids: [idA], seconds: 1 }, { proc: parent });
  const waited = textOf(call);
  check("agent_wait returns A's result, wrapped as untrusted data", waited.includes("RESULT-OF-Source A") && /<agent_result[^>]*state="done"/.test(waited) && waited.includes("<untrusted_content>"), waited);
  call = await zen.callTool("agent_wait", { ids: [idA], seconds: 1 }, { proc: parent });
  check("...and only once", /already have this result/.test(textOf(call)) && !textOf(call).includes("RESULT-OF-Source A"));
  const t0 = Date.now();
  call = await zen.callTool("agent_wait", { ids: [idB], seconds: 1 }, { proc: parent });
  check("waiting on a running agent times out as pending, not failure", /Still working: a[0-9a-f]+/.test(textOf(call)) && !call.isError && Date.now() - t0 < 3000, textOf(call));
  call = await zen.callTool("agent_cancel", { id: c.id }, { proc: parent });
  await until(() => state("Source C") === "stopped");
  check("agent_cancel stops one agent", /is stopped/.test(textOf(call)) && state("Source C") === "stopped" && children()[2].killed, textOf(call));
  call = await zen.callTool("agent_cancel", { id: c.id }, { proc: parent });
  check("...and is idempotent", !call.isError && /is stopped/.test(textOf(call)));

  // The parent ends its reply while B still works: the reply waits, then continues once
  await zen.finishReplies({ proc: parent });
  await sleep(60);
  check("the reply stays open while an agent works", !!$(".zai-send.zai-stop") && /Waiting for the agents/.test(($(".zai-status.zai-live") || {}).textContent || ""), ($(".zai-status.zai-live") || {}).textContent);
  const before = zen.sent.length;
  await zen.finishReplies({ proc: childB });
  await until(() => zen.sent.length > before);
  const cont = zen.sent.at(-1);
  check("once B is done the parent gets one more message with B's result (not A's again)", cont.proc === parent && cont.text.includes("your agents have finished") && cont.text.includes("RESULT-OF-Source B") && !cont.text.includes("RESULT-OF-Source A"), cont.text.slice(0, 300));
  await zen.finishReplies({ proc: parent });
  await until(() => !$(".zai-send.zai-stop"));
  check("the combined answer finishes the reply", !$(".zai-send.zai-stop") && zen.replies().some((t) => t.includes("COMBINED ANSWER")), zen.replies());
  check("every agent process is gone", children().every((x) => x.killed));

  // Saved: the boxes' labels, states and results; never instructions or context
  await sleep(400);
  const files = [...zen.disk.entries()].filter(([k]) => /chats\/[^/]+\.json$/.test(k) && !k.endsWith("index.json"));
  const saved = files.map(([, v]) => String(v)).find((v) => v.includes('"agents"')) || "";
  check("history keeps an agents block", /"type":"agents"/.test(saved) && saved.includes("Source A") && saved.includes('"state":"stopped"'), saved.slice(0, 300));
  check("...without the agents' instructions or the context they got", !saved.includes("TASK-A") && !saved.includes("TASK-B") && !saved.includes("<agent_task"));

  // --- 3. Approvals belong to one agent; Stop stops everything ------------------------
  zen.newChat();
  await sleep(40);
  msg = await run("team");
  parent = msg.proc;
  const nBefore = children().length;
  const x = await start(parent, { title: "Browser X", instruction: "open a page", browser: true });
  const y = await start(parent, { title: "Browser Y", instruction: "open a page", browser: true });
  await until(() => children().length === nBefore + 2);
  const [cx, cy] = children().slice(-2);
  const tools = (await zen.listTools({ proc: cx })).tools.map((t) => t.name);
  check("an agent with the browser gets page tools, not tab switching or organizing", tools.includes("browser_navigate") && !tools.includes("browser_switch_tab") && !tools.includes("browser_organize_tabs"), tools);
  let read = await zen.askPermission("mcp__zenai__browser_read", {}, { proc: cx });
  check("an agent must open its own tab first", read.behavior === "deny" && /Open your own tab first/.test(read.message), read);
  const px = zen.askPermission("mcp__zenai__browser_navigate", { url: "https://example.com/x" }, { proc: cx });
  const py = zen.askPermission("mcp__zenai__browser_navigate", { url: "https://example.org/y" }, { proc: cy });
  await until(() => $$(".zai-task .zai-approval").length === 2);
  const cardX = box("Browser X").querySelector(".zai-approval");
  check("each agent's card is in its own box, visible with Details closed", !!cardX && !!box("Browser Y").querySelector(".zai-approval") && box("Browser X").querySelector(".zai-task-details").hidden);
  check("the card names the agent asking", /Agent “Browser X”/.test(cardX.textContent) && /background tab/.test(cardX.textContent), cardX.textContent.slice(0, 200));
  check("a box waiting for an approval says so", state("Browser X") === "waiting" && state("Browser Y") === "waiting");
  check("an agent's card has no inherited site grant or Allow-all for the chat", !/in this chat/.test(cardX.querySelector(".zai-allow-all").textContent), cardX.querySelector(".zai-allow-all").textContent);
  cardX.querySelector(".zai-allow").click();
  const ax = await px;
  check("allowing X's card allows only X", ax.behavior === "allow" && ax.updatedInput.tab === "new" && !!box("Browser Y").querySelector(".zai-approval"), ax);
  call = await zen.callTool("browser_navigate", { url: "https://example.org/y", tab: "new" }, { proc: cy });
  check("Y can't run an action on X's approval", call.isError && /wasn't approved/.test(textOf(call)), textOf(call));

  // Stop during an approval: every agent stops, the card says no, late output is ignored
  $(".zai-send").click();
  // (its process is killed, so the answer is never written back to it)
  const ay = await Promise.race([py, sleep(300).then(() => null)]);
  await until(() => state("Browser X") === "stopped" && state("Browser Y") === "stopped");
  check("Stop stops the reply and all its agents", state("Browser X") === "stopped" && state("Browser Y") === "stopped" && !$(".zai-send.zai-stop"));
  check("a card waiting at Stop is denied", (!ay || ay.behavior === "deny") && !$(".zai-task .zai-approval") && /Denied · Open example\.org/.test(box("Browser Y").textContent), [ay, box("Browser Y").textContent]);
  check("Stop kills the agents' processes", cx.killed && cy.killed);
  await zen.finishReplies({ proc: cy });
  await sleep(60);
  check("late output after Stop changes nothing", state("Browser Y") === "stopped");

  // --- 4. Turned off in the settings -----------------------------------------------------
  w.Services.prefs.setStringPref("zenai.agents.enabled", "false");
  zen.newChat();
  await sleep(40);
  msg = await run("team");
  r = await start(msg.proc, { title: "Off", instruction: "x" });
  check("agents off in the settings: the skill runs without them", !msg.text.includes("<agent_context") && r.res.isError && /turned off/.test(r.text), r.text);
  await zen.finishReplies();
  w.Services.prefs.setStringPref("zenai.agents.enabled", "true");

  // --- 5. Closing the window stops its agents --------------------------------------------
  zen.newChat();
  await sleep(40);
  msg = await run("team");
  const lateCount = children().length;
  await start(msg.proc, { title: "Late", instruction: "x" });
  await until(() => children().length === lateCount + 1);
  const late = children().at(-1);
  check("no errors in the window", zen.errors.length === 0, zen.errors);
  await zen.close();
  await sleep(50);
  check("closing the window stops its agents' processes", late.killed);
  done();
})().catch(crash);
