// ---------------------------------------------------------------------------
// What one reply cost (no DOM): model requests, how big the history each one
// re-read was, screenshots, compactions, and its helper agents. Claude Code
// reports usage per response (several records can share one id: the last
// counts). Antigravity only reports the history's size. Shown under a reply
// and saved with it (numbers only); warns once the history gets big while
// the reply is still running. Never records prompts, pages or images.
// ---------------------------------------------------------------------------

// Warn while a reply runs once its history passes these sizes
export const STATS_WARN_TOKENS = [200000, 400000];
// ...or once it has taken this many steps
export const STATS_WARN_STEPS = 300;
// Below this many steps a reply gets no usage line (an ordinary answer)
export const STATS_MIN_STEPS = 4;

export function newTurnStats(now = Date.now()) {
  return {
    started: now,
    byId: new Map(),     // response id → usage (Claude Code)
    agentById: new Map(), // "<run>:<id>" → usage, for its helper agents
    context: 0,          // the history's size as last reported (tokens)
    peak: 0,
    tools: 0,
    images: 0,
    compacts: 0,
    warnedTokens: 0,
    warnedSteps: false,
  };
}

const contextOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

// A request's usage ({ id, usage }), or just the history's size ({ context })
export function noteRequest(stats, u) {
  if (!stats || !u) return;
  if (u.usage) {
    stats.byId.set(u.id || `r${stats.byId.size}`, u.usage);
    stats.context = contextOf(u.usage);
  } else if (Number.isFinite(u.context)) {
    stats.context = u.context;
  }
  stats.peak = Math.max(stats.peak, stats.context);
}

export function noteAgentRequest(stats, runId, u) {
  if (!stats || !u || !u.usage) return;
  stats.agentById.set(`${runId}:${u.id || stats.agentById.size}`, u.usage);
}

// A tool call answered (images: how many pictures went back with it)
export function noteTool(stats, images = 0) {
  if (!stats) return;
  stats.tools++;
  stats.images += images;
}

export function noteCompact(stats) {
  if (!stats) return;
  stats.compacts++;
  stats.context = 0;
}

function sums(map) {
  const out = { requests: map.size, reread: 0, written: 0, fresh: 0, output: 0 };
  for (const u of map.values()) {
    out.reread += u.cache_read_input_tokens || 0;
    out.written += u.cache_creation_input_tokens || 0;
    out.fresh += u.input_tokens || 0;
    out.output += u.output_tokens || 0;
  }
  return out;
}

// The numbers kept with the reply (chats.mjs saves exactly these)
export function statsSummary(stats, now = Date.now()) {
  const own = sums(stats.byId);
  const agents = sums(stats.agentById);
  return {
    type: "stats",
    requests: own.requests, peak: stats.peak, reread: own.reread, written: own.written, fresh: own.fresh, output: own.output,
    tools: stats.tools, images: stats.images, compacts: stats.compacts,
    agentRequests: agents.requests, agentReread: agents.reread + agents.written + agents.fresh,
    seconds: Math.max(0, Math.round((now - stats.started) / 1000)),
  };
}

// Worth showing: a reply that took several steps, or used agents
export function statsWorthShowing(sum) {
  return sum.requests >= STATS_MIN_STEPS || sum.agentRequests > 0 || sum.compacts > 0;
}

export function tokensText(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// "42 steps · history up to 180k · 3.1M re-read · 12 screenshots · 1 summary · agents: 6 steps"
export function statsLine(sum) {
  const parts = [`${sum.requests} step${sum.requests === 1 ? "" : "s"}`];
  if (sum.peak) parts.push(`history up to ${tokensText(sum.peak)} tokens`);
  if (sum.reread) parts.push(`${tokensText(sum.reread)} re-read`);
  if (sum.images) parts.push(`${sum.images} screenshot${sum.images === 1 ? "" : "s"}`);
  if (sum.compacts) parts.push(`${sum.compacts} summar${sum.compacts === 1 ? "y" : "ies"}`);
  if (sum.agentRequests) parts.push(`agents: ${sum.agentRequests} step${sum.agentRequests === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// The tooltip: what the numbers mean
export function statsDetail(sum) {
  return [
    `${sum.requests} requests to the model in ${sum.seconds} s; ${sum.tools} tool calls.`,
    `Every request re-reads the chat's history (mostly from cache): ${tokensText(sum.reread)} tokens in all, the history peaking at ${tokensText(sum.peak)}.`,
    `New tokens: ${tokensText(sum.fresh + sum.written)} in, ${tokensText(sum.output)} out (thinking included).`,
    sum.agentRequests ? `Helper agents: ${sum.agentRequests} requests, ${tokensText(sum.agentReread)} tokens read.` : "",
    sum.compacts ? `The history was summarized ${sum.compacts} time${sum.compacts === 1 ? "" : "s"} to keep it small.` : "",
  ].filter(Boolean).join(" ");
}

// A warning to show now (once per threshold), or ""
export function statsWarning(stats) {
  if (!stats) return "";
  const steps = stats.byId.size;
  for (const limit of STATS_WARN_TOKENS) {
    if (stats.context >= limit && stats.warnedTokens < limit) {
      stats.warnedTokens = limit;
      return `This reply's history is now about ${tokensText(stats.context)} tokens, and every step re-reads all of it. If it isn't nearly done, Stop and continue in a new chat (one task per chat keeps it light).`;
    }
  }
  if (steps >= STATS_WARN_STEPS && !stats.warnedSteps) {
    stats.warnedSteps = true;
    return `This reply has taken ${steps} steps. That's normal for a long run; if it keeps redoing the same step, Stop and continue in a new chat.`;
  }
  return "";
}
