// Real Claude Code in real Zen: a skill with agents: 2 hands two independent
// questions to two helper agents, waits for both and combines their answers.
// Checks the boxes end done, the answer uses both results, and nothing in the
// window broke. Haiku, low effort, short turns (a few small requests).
import { checker, crash } from "../helpers/common.mjs";
import { realZen, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const SKILL = `---
name: duo
description: Two helper agents answer two small questions
agents: 2
---
Use exactly two helper agents, started one right after the other with agent_start (no context items):
- title "Multiply", instruction: "What is 17 times 3? Reply with only the number."
- title "Capital", instruction: "What is the capital city of Australia? Reply with only the city name."
Do not answer the questions yourself. Then call agent_wait (no ids) until both are done, and reply with one line: the number, then the city.`;

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ claude: "real", timeoutMs: 30000, prefs: { model: "haiku", effort: "low" } });
  try {
    await zen.chrome(async (text) => {
      const dir = PathUtils.join(PathUtils.profileDir, "chrome", "zenai-skills");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      await IOUtils.writeUTF8(PathUtils.join(dir, "duo.md"), text);
      Services.prefs.setStringPref("zenai.skillsVersion", "3");
    }, SKILL);
    await zen.open();
    await zen.chrome(async () => {
      const input = document.querySelector(".zai-input");
      input.value = "/duo";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    const t0 = Date.now();
    await zen.send("", { wait: false });
    await new Promise((r) => setTimeout(r, 3000));
    await zen.idle(240000);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const boxes = await zen.chrome(() => [...document.querySelectorAll(".zai-task")].map((b) => ({
      title: b.querySelector(".zai-task-title").textContent, state: b.dataset.state, who: b.querySelector(".zai-task-who").textContent,
    })));
    const reply = (await zen.$$text(".zai-thread .zai-assistant .zai-seg")).join("\n");
    const errorText = (await zen.$$text(".zai-thread .zai-error")).join(" ");
    console.log(`seconds: ${secs}\nboxes: ${JSON.stringify(boxes)}\nreply: ${reply.slice(-400)}\nerrors: ${errorText}`);
    console.log(`BENCH agents: ${secs} s for two agents and a combined answer`);
    check("two agent boxes, both done", boxes.length === 2 && boxes.every((b) => b.state === "done"), boxes);
    check("the boxes name Claude Code", boxes.every((b) => /Claude Code/.test(b.who)), boxes);
    check("the combined answer uses both agents' results", /\b51\b/.test(reply) && /Canberra/i.test(reply), reply.slice(-400));
    check("no error in the reply", !errorText, errorText);
    check("the reply finished", !(await zen.chrome(() => !!document.querySelector(".zai-send.zai-stop"))));
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
