// Keeping long runs light: Claude Code starts with --autocompact (150k by
// default, a setting), a long reply gets a usage line (steps, history size,
// re-read, screenshots, summaries), a warning while it runs once its history
// gets big, and a line when the history was summarized. Saved: numbers only.
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const usage = (read) => ({ input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: 400, output_tokens: 60 });

(async () => {
  const zen = await fakeZen({ holdReplies: true });
  const { $, $$ } = zen;
  await zen.open();
  const arg = (proc, name) => (proc.args.includes(name) ? proc.args[proc.args.indexOf(name) + 1] : null);
  // Sends, and waits until Claude Code has the message
  const say = async (text) => {
    const n = zen.sent.length;
    await zen.send(text, { wait: false });
    for (let i = 0; i < 300 && zen.sent.length === n; i++) await sleep(10);
    return zen.sent.at(-1);
  };

  // A short answer: no usage line
  let parent = (await say("hi")).proc;
  check("Claude Code starts with --autocompact 150k by default", arg(parent, "--autocompact") === "150k", parent.args);
  await zen.finishReplies();
  check("a short reply gets no usage line", !$(".zai-turn-stats"));

  // A long one: four requests (one reported twice), a big history, a summary
  parent = (await say("do the long thing")).proc;
  const emit = (o) => zen.emit(o, { proc: parent });
  emit({ type: "assistant", message: { id: "r1", content: [], usage: usage(30000) } });
  emit({ type: "assistant", message: { id: "r1", content: [], usage: usage(30000) } });
  emit({ type: "assistant", message: { id: "r2", content: [], usage: usage(90000) } });
  emit({ type: "assistant", message: { id: "r3", content: [], usage: usage(205000) } });
  await sleep(60);
  const warn = $$(".zai-thread .zai-toolline.zai-warned").map((l) => l.textContent).join(" | ");
  check("a warning while it runs once the history passes 200k", /about 205k tokens.*new chat/.test(warn), warn);
  emit({ type: "system", subtype: "compact_boundary", session_id: "x" });
  emit({ type: "assistant", message: { id: "r4", content: [], usage: usage(40000) } });
  await sleep(60);
  const lines = $$(".zai-thread .zai-toolline").map((l) => l.textContent).join(" | ");
  check("a line when the history is summarized", /Summarized the earlier steps/.test(lines), lines);
  await zen.finishReplies();
  const stats = $$(".zai-turn-stats").pop();
  check("the reply gets a usage line", !!stats && /^4 steps · history up to 205k tokens · 365k re-read · 1 summary$/.test(stats.textContent), stats && stats.textContent);
  check("...with the details on hover", /4 requests to the model/.test(stats.getAttribute("data-tip")) && /summarized 1 time/.test(stats.getAttribute("data-tip")), stats.getAttribute("data-tip"));

  // Saved: the numbers, nothing else
  await sleep(400);
  const saved = [...zen.disk.entries()].map(([, v]) => String(v)).find((v) => v.includes('"type":"stats"')) || "";
  const block = saved ? JSON.parse(saved).messages.flatMap((m) => m.blocks || []).find((b) => b.type === "stats") : null;
  check("the saved chat keeps the usage numbers", block && block.requests === 4 && block.peak === 205403 && block.compacts === 1, block);
  check("...and only numbers", block && Object.entries(block).every(([k, v]) => k === "type" || typeof v === "number"), block);

  // The setting: Claude Code's own default, or another window
  zen.prefStore.set("zenai.autocompact", "auto");
  zen.newChat();
  await sleep(40);
  await say("again");
  check("“Claude Code's default” passes no --autocompact", arg(zen.sent.at(-1).proc, "--autocompact") === null, zen.sent.at(-1).proc.args);
  await zen.finishReplies();
  zen.prefStore.set("zenai.autocompact", "300k");
  zen.newChat();
  await sleep(40);
  await say("and again");
  check("another size is passed as chosen", arg(zen.sent.at(-1).proc, "--autocompact") === "300k");
  await zen.finishReplies();
  zen.prefStore.set("zenai.autocompact", "12k");
  zen.newChat();
  await sleep(40);
  await say("odd value");
  check("a value Claude Code wouldn't take falls back to 150k", arg(zen.sent.at(-1).proc, "--autocompact") === "150k");
  await zen.finishReplies();
  check("the version check isn't a chat process", zen.spawns.every((p) => !(p.args.length === 1 && p.args[0] === "--version")));

  check("no errors in the window", zen.errors.length === 0, zen.errors);
  await zen.close();
  done();
})().catch(crash);
