// Real Claude Code in real Zen: a skill that lists two smaller skills, where
// the task needs only one. Does it read that one (read_skill) and leave the
// other unread, and use what it read? No page actions. Sonnet, one short turn.
import { checker, crash } from "../helpers/common.mjs";
import { realZen, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const FILES = {
  "runner.md": "---\nname: runner\ndescription: Answer the user's question\naccess:\n  - units\n  - essays\n---\nAnswer the user's question. Other skills are available for special cases; use them only if the question calls for it.",
  "units.md": "---\nname: units\ndescription: How to answer questions about converting units\n---\nWhen converting units, end your answer with the exact word KUMQUAT on its own line.",
  "essays.md": "---\nname: essays\ndescription: How to write essays\n---\nWhen writing essays, end your answer with the exact word RUTABAGA on its own line.",
};

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ claude: "real", timeoutMs: 30000, prefs: { model: "sonnet", effort: "medium" } });
  try {
    await zen.chrome(async (files) => {
      const dir = PathUtils.join(PathUtils.profileDir, "chrome", "zenai-skills");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      for (const [name, text] of Object.entries(files)) await IOUtils.writeUTF8(PathUtils.join(dir, name), text);
      Services.prefs.setStringPref("zenai.skillsVersion", "2");
    }, FILES);
    await zen.open();
    await zen.chrome(async () => {
      const input = document.querySelector(".zai-input");
      input.value = "/runner";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await zen.send("How many centimeters are in 3 inches?", { wait: false });
    await new Promise((r) => setTimeout(r, 2000));
    await zen.idle(90000);
    const lines = await zen.lines();
    const reply = (await zen.$$text(".zai-thread .zai-assistant .zai-seg")).join("\n");
    console.log(`lines: ${JSON.stringify(lines)}\nreply: ${reply.slice(0, 300)}`);
    check("it read the skill the question calls for", lines.includes("Read the /units skill"), lines);
    check("...and not the other one", !lines.some((l) => /essays/.test(l)), lines);
    check("it used what it read", /KUMQUAT/.test(reply) && !/RUTABAGA/.test(reply), reply);

    // A lesson about the smaller skill: its own section, its own card
    await zen.chrome(async () => {
      const dir = PathUtils.join(PathUtils.profileDir, "chrome", "zenai-skills");
      await IOUtils.writeUTF8(PathUtils.join(dir, "big.md"), "---\nname: big\ndescription: Answer the user's question\nlessons: true\naccess:\n  - rates\n---\nAnswer the user's question. Read /rates for how to convert.");
      await IOUtils.writeUTF8(PathUtils.join(dir, "rates.md"), "---\nname: rates\ndescription: How to convert inches to centimeters\n---\nTo convert inches to centimeters, multiply by 2.");
      document.querySelector('.zai-header [aria-label="New chat"]').click();
      await new Promise((r) => setTimeout(r, 200));
      const input = document.querySelector(".zai-input");
      input.value = "/big";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await zen.send("How many centimeters are in 3 inches? I know the real answer is 7.62, so check whether your instructions got it right.", { wait: false });
    await new Promise((r) => setTimeout(r, 2000));
    await zen.idle(90000);
    const titles = await zen.$$text(".zai-update .zai-approval-title");
    const second = (await zen.$$text(".zai-thread .zai-assistant .zai-seg")).join("\n");
    console.log(`cards: ${JSON.stringify(titles)}\nreply: ${second.slice(0, 600)}`);
    check("the wrong instruction in the smaller skill got a card for that skill", titles.includes("/rates: lessons from this /big run"), titles);
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
