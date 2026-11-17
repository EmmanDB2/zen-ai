// What a reply cost (turn-stats.mjs): requests counted once per response id,
// the history's peak, re-read totals, agents apart, warnings once each.
import { checker, crash } from "../helpers/common.mjs";
import { newTurnStats, noteAgentRequest, noteCompact, noteRequest, noteTool, statsLine, statsSummary, statsWarning, statsWorthShowing, tokensText } from "../../src/turn-stats.mjs";

const { check, done } = checker();
const u = (input, read, write, out) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out });

(async () => {
  const s = newTurnStats(0);
  noteRequest(s, { id: "m1", usage: u(5, 20000, 1000, 10) });
  noteRequest(s, { id: "m1", usage: u(5, 20000, 1000, 40) }); // the same response, a later block
  noteRequest(s, { id: "m2", usage: u(3, 21000, 500, 30) });
  noteTool(s, 1);
  noteTool(s, 0);
  let sum = statsSummary(s, 9000);
  check("a response counts once, its last record wins", sum.requests === 2 && sum.output === 70, sum);
  check("re-read and new tokens add up", sum.reread === 41000 && sum.written === 1500 && sum.fresh === 8, sum);
  check("the peak history size", sum.peak === 21503, sum.peak);
  check("tools and screenshots", sum.tools === 2 && sum.images === 1);
  check("seconds", sum.seconds === 9);
  check("two steps isn't worth a line", !statsWorthShowing(sum));
  for (let i = 3; i <= 4; i++) noteRequest(s, { id: "m" + i, usage: u(1, 22000, 10, 5) });
  sum = statsSummary(s);
  check("four steps is", statsWorthShowing(sum));
  check("the line", statsLine(sum) === "4 steps · history up to 22k tokens · 85k re-read · 1 screenshot", statsLine(sum));
  check("token text", tokensText(950) === "950" && tokensText(150000) === "150k" && tokensText(3100000) === "3.1M" && tokensText(72900000) === "73M");

  // Agents count apart, and make a line worth showing on their own
  const a = newTurnStats();
  noteAgentRequest(a, "a1", { id: "x", usage: u(2, 1000, 3000, 50) });
  noteAgentRequest(a, "a2", { id: "x", usage: u(2, 1000, 3000, 50) }); // same id, another agent
  sum = statsSummary(a);
  check("agents: per run and id", sum.agentRequests === 2 && sum.agentReread === 8004 && sum.requests === 0, sum);
  check("agents alone are worth a line", statsWorthShowing(sum) && /agents: 2 steps/.test(statsLine(sum)));

  // Warnings: once per size, then for many steps
  const w = newTurnStats();
  noteRequest(w, { id: "1", usage: u(0, 150000, 0, 1) });
  check("no warning under 200k", statsWarning(w) === "");
  noteRequest(w, { id: "2", usage: u(0, 210000, 0, 1) });
  check("a warning at 200k", /about 210k tokens/.test(statsWarning(w)));
  check("...once", statsWarning(w) === "");
  noteRequest(w, { id: "3", usage: u(0, 450000, 0, 1) });
  check("another at 400k", /about 450k/.test(statsWarning(w)));
  noteCompact(w);
  check("a summary is counted and resets the size", statsSummary(w).compacts === 1 && w.context === 0 && w.peak === 450000);
  const many = newTurnStats();
  for (let i = 0; i < 300; i++) noteRequest(many, { id: String(i), usage: u(0, 1000, 0, 1) });
  check("a warning after 300 steps, once", /300 steps/.test(statsWarning(many)) && statsWarning(many) === "");
  // Antigravity: only the size
  const g = newTurnStats();
  noteRequest(g, { context: 120000 });
  check("a size-only report sets the size", g.peak === 120000 && statsSummary(g).requests === 0);
  done();
})().catch(crash);
