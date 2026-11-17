import { h, icon } from "./dom.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { providerInfo } from "./providers.mjs";
import { toolLine } from "./panel-parts.mjs";

// ---------------------------------------------------------------------------
// Agent boxes: one compact box per helper agent, grouped inline in the reply
// that started them. Collapsed: title, provider/model, state, latest activity
// and Stop. Details: what it did (real actions as lines, its own progress
// labelled as updates), then its result or error. Approval cards for an agent
// go in its box but outside Details, so they're always visible.
// The view only shows runs (agent-runs.mjs records); Stop is a callback.
// Classes are zai-task-*: zai-agent-* is the browser overlay.
// ---------------------------------------------------------------------------
const AGENT_STATE_LABELS = {
  queued: "Waiting for a free slot",
  starting: "Starting…",
  working: "Working…",
  waiting: "Needs your approval",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};
const AGENT_LIVE = new Set(["queued", "starting", "working", "waiting"]);
// Steps every run goes through: not worth a line once it has ended
const AGENT_ROUTINE = new Set(["Waiting for a free agent slot", "Starting", "Done"]);

// "Antigravity · gemini-3.8-flash", "Claude Code" (the provider's own default)
export function agentWho(run) {
  const label = (providerInfo(run.provider) || {}).label || run.provider || "";
  return run.model && run.model !== "default" ? `${label} · ${run.model}` : label;
}

export function createAgentView({ fileCard, savedFileCard }) {
  // One latest-activity line: model-written progress is an update, not proof
  function activityText(run) {
    const last = run.activity && run.activity[run.activity.length - 1];
    if (!last) return "";
    return last.kind === "update" ? `Update: ${last.text}` : last.text;
  }

  // A box for one run. saved: a run from history (no Stop, nothing live)
  function makeBox(run, { onStop = null, saved = false } = {}) {
    const stateEl = h("span", { class: "zai-task-state" });
    const stopBtn = onStop ? h("button", { class: "zai-task-stop", "aria-label": `Stop agent “${run.title}”`, onclick: () => onStop() }, "Stop") : null;
    const activityEl = h("div", { class: "zai-task-activity" });
    const cards = h("div", { class: "zai-task-cards" });
    const details = h("div", { class: "zai-task-details", hidden: true });
    const toggle = h("button", { class: "zai-task-toggle", "aria-expanded": "false" });
    const el = h("div", { class: "zai-task", role: "group", "aria-label": `Agent: ${run.title}` },
      h("div", { class: "zai-task-head" },
        h("span", { class: "zai-task-dot", "aria-hidden": "true" }),
        h("span", { class: "zai-task-title", text: run.title, title: run.title }),
        h("span", { class: "zai-task-who", text: agentWho(run) }),
        stateEl,
        stopBtn
      ),
      activityEl,
      cards,
      toggle,
      details
    );
    const box = { el, cards, expanded: false, ended: false, saved, run };
    toggle.addEventListener("click", () => {
      box.expanded = !box.expanded;
      render(box);
    });
    render(box);
    return box;
  }

  function render(box) {
    const run = box.run;
    const live = AGENT_LIVE.has(run.state);
    const el = box.el;
    // A box collapses when its agent finishes
    if (!live && !box.ended) {
      box.ended = true;
      box.expanded = false;
    }
    el.dataset.state = run.state;
    el.querySelector(".zai-task-state").textContent = AGENT_STATE_LABELS[run.state] || run.state;
    const stop = el.querySelector(".zai-task-stop");
    if (stop) stop.hidden = !live;
    const activity = el.querySelector(".zai-task-activity");
    // (waiting: its card, right below, says what for)
    const latest = run.state === "waiting" ? "" : live ? activityText(run) : run.state === "done" ? firstLine(run.result) : run.error;
    activity.textContent = latest || "";
    activity.hidden = !latest;
    const toggle = el.querySelector(".zai-task-toggle");
    const hasResult = run.state === "done" && !!run.result;
    toggle.replaceChildren(h("span", { text: box.expanded ? "Hide" : hasResult ? "View result" : "Details" }), icon(box.expanded ? "chevronUp" : "chevronDown", 13, 2.2));
    toggle.setAttribute("aria-expanded", String(box.expanded));
    const details = el.querySelector(".zai-task-details");
    details.hidden = !box.expanded;
    if (box.expanded) details.replaceChildren(...detailNodes(run, box.saved));
  }

  function firstLine(text) {
    const line = String(text || "").split("\n").map((l) => l.trim()).find((l) => l && !/^#+\s*$/.test(l)) || "";
    return line.replace(/^#+\s*/, "").slice(0, 200);
  }

  function detailNodes(run, saved) {
    const out = [];
    // What it did (a saved run keeps only its result)
    const ended = !AGENT_LIVE.has(run.state);
    for (const a of saved ? [] : run.activity || []) {
      if (ended && a.kind === "status" && AGENT_ROUTINE.has(a.text)) continue;
      // Its own progress notes add nothing once the result is there
      if (a.kind === "update" && run.state === "done" && run.result) continue;
      if (a.kind === "tool") out.push(toolLine("ok", a.text));
      else if (a.kind === "error") out.push(toolLine("denied", a.text));
      else if (a.kind === "update") out.push(h("div", { class: "zai-task-update" }, h("span", { class: "zai-task-label", text: "Update" }), h("span", { text: a.text })));
      else out.push(h("div", { class: "zai-task-note", text: a.text }));
    }
    if (run.contextLabels && run.contextLabels.length) out.push(h("div", { class: "zai-task-note", text: `Given: ${run.contextLabels.join(", ")}` }));
    if (run.state === "done" && run.result) out.push(h("div", { class: "zai-task-result" }, renderMarkdown(run.result)));
    else if (run.error) out.push(h("div", { class: "zai-task-error", text: run.error }));
    for (const f of run.files || []) out.push(saved ? savedFileCard(f) : fileCard(f));
    if (!out.length) out.push(h("div", { class: "zai-task-note", text: "Nothing yet." }));
    return out;
  }

  // The group of boxes in a reply; place(el) puts it in the reply
  function makeGroup(place) {
    const el = h("div", { class: "zai-tasks", role: "list", "aria-label": "Agents" });
    place(el);
    return {
      el,
      add(box) { box.el.setAttribute("role", "listitem"); el.append(box.el); },
    };
  }

  // A saved "agents" block (chats.mjs): the boxes as they ended
  function saved(block) {
    const group = h("div", { class: "zai-tasks", role: "list", "aria-label": "Agents" });
    for (const r of block.runs || []) {
      const run = { title: r.title, provider: r.provider, model: r.model, state: r.state, result: r.result || "", error: r.error || (r.state === "interrupted" ? "Zen AI closed before this agent finished. Nothing restarts by itself: run the skill again if you still need it." : ""), files: r.files || [], activity: [] };
      const box = makeBox(run, { saved: true });
      box.el.setAttribute("role", "listitem");
      group.append(box.el);
    }
    return group;
  }

  return { makeBox, render, makeGroup, saved };
}
