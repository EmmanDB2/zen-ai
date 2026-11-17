import { h } from "./dom.mjs";

// ---------------------------------------------------------------------------
// The glowing border + Stop pill over the tab an actor (the chat's AI, or one
// of its agents) is working in, and the outline of the element it's about to
// use. One overlay per window; it follows whichever actor works in the tab
// that's showing. Its Stop stops that actor only.
// liveActors(): every actor that may be acting; actor: see chat-controller.mjs
// ---------------------------------------------------------------------------
export function createTabOverlay({ liveActors }) {
  const agentHl = h("div", { class: "zai-agent-hl", hidden: true });

  const agentPillText = h("span", { text: "Claude is using this tab" });

  const agentStop = h("button", { class: "zai-agent-stop", onclick: () => { const a = actingActor(); if (a) a.stop(); } }, "Stop");

  const agentPill = h("div", { class: "zai-agent-pill" },
    h("span", { class: "zai-agent-dot" }),
    agentPillText,
    agentStop
  );

  const agentOverlay = h("div", { id: "zai-agent", hidden: true, "aria-live": "polite" }, agentHl, agentPill);

  document.documentElement.appendChild(agentOverlay);

  // One overlay for the window; each chat keeps its own agent state (chat.agent)
  const agentUi = { timer: null, hlTimer: null };

  // The actor (a chat, or an agent) acting in the tab that's showing, if any
  function actingActor() {
    let selected = null;
    try { selected = gBrowser.selectedTab; } catch (e) {}
    for (const actor of liveActors()) {
      if (actor.browser.active && actor.tab() === selected) return actor;
    }
    return null;
  }

  // The glowing border + Stop pill, over the tab Claude is working in
  function showAgent(actor, on) {
    actor.browser.active = on;
    if (!on) actor.browser.allowed.clear();
    const anyActive = liveActors().some((a) => a.browser.active);
    if (!anyActive) {
      clearInterval(agentUi.timer);
      agentUi.timer = null;
      agentOverlay.hidden = true;
      agentHl.hidden = true;
      return;
    }
    placeAgent();
    if (!agentUi.timer) agentUi.timer = setInterval(placeAgent, 400);
  }

  function placeAgent() {
    const actor = actingActor();
    let r = null;
    try {
      if (actor) r = actor.tab().linkedBrowser.getBoundingClientRect();
    } catch (e) {}
    if (!r || !r.width || !r.height) {
      agentOverlay.hidden = true;
      return;
    }
    Object.assign(agentOverlay.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    const name = actor.overlayName();
    agentPillText.textContent = actor.browser.waiting ? `${name} is waiting` : actor.allowAll ? `${name} is acting without asking` : `${name} is using this tab`;
    agentOverlay.hidden = false;
  }

  // Outline the element Claude is about to use (sticky while its card waits)
  function agentHighlight(actor, rect, sticky) {
    clearTimeout(agentUi.hlTimer);
    // Only over the tab that's showing (an agent may work in a background tab)
    let showing = false;
    try { showing = actor.tab() === gBrowser.selectedTab; } catch (e) {}
    if (!rect || !rect.w || !rect.h || !showing) {
      agentHl.hidden = true;
      return;
    }
    let zoom = 1;
    try { zoom = actor.tab().linkedBrowser.fullZoom || 1; } catch (e) {}
    Object.assign(agentHl.style, {
      left: rect.x * zoom - 4 + "px",
      top: rect.y * zoom - 4 + "px",
      width: rect.w * zoom + 8 + "px",
      height: rect.h * zoom + 8 + "px",
    });
    agentHl.hidden = false;
    // restart the pop animation
    agentHl.classList.remove("zai-hl-pop");
    void agentHl.offsetWidth;
    agentHl.classList.add("zai-hl-pop");
    if (!sticky) agentUi.hlTimer = setTimeout(() => (agentHl.hidden = true), 1100);
  }

  return {
    show: showAgent,
    place: placeAgent,
    highlight: agentHighlight,
    dispose() {
      clearInterval(agentUi.timer);
      clearTimeout(agentUi.hlTimer);
      agentUi.timer = null;
      agentOverlay.remove();
    },
  };
}
