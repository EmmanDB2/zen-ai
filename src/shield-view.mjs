import { h, icon } from "./dom.mjs";
import { aiName } from "./providers.mjs";

// ---------------------------------------------------------------------------
// Shield: web content or files are in this chat, so the built-in tools are
// off. Click it to turn them back on for this chat (or off again). It also
// shows "Allow all actions" while that's on, with a way back to asking.
// The chat controller and browser controller change the state; this shows it.
// ---------------------------------------------------------------------------
export function createShieldView({ placePopover, popovers, hideTip, getActive, toolsLocked, onToolsUnlocked, onAskAgain }) {
  const shield = h("button", { class: "zai-icon-btn zai-shield", hidden: true, "aria-haspopup": "dialog", "aria-expanded": "false", "data-tip-pos": "below" });

  const shieldPop = h("div", { class: "zai-popover", role: "dialog", "aria-label": "Tools in this chat", hidden: true });

  function updateShield() {
    const active = getActive();
    shield.hidden = !active.tainted && !active.allowAll;
    const locked = toolsLocked(active);
    shield.classList.toggle("zai-unlocked", !locked || active.allowAll);
    shield.replaceChildren(icon(locked ? "shield" : "shieldOff", 16, 2));
    const label = (locked ? "Tools are off: this chat has web content" : "Tools are on, even with web content") +
      (active.allowAll ? " · browser actions don't ask" : "");
    shield.setAttribute("aria-label", label);
    if (shieldPop.hidden) shield.setAttribute("data-tip", label);
  }

  function renderShieldPop() {
    const active = getActive();
    const locked = toolsLocked(active);
    const tools = active.tainted ? h("div", { class: "zai-pop-section" },
      h("div", { class: "zai-pop-head" },
        h("span", { class: "zai-pop-icon" + (locked ? "" : " zai-unlocked") }, icon(locked ? "shield" : "shieldOff", 15, 2)),
        h("span", { text: locked ? "Tools are off in this chat" : "Tools are on in this chat" })
      ),
      h("p", {
        class: "zai-pop-body",
        text: active.provider === "antigravity"
          ? `Commands and file access ${locked ? "are off because this chat contains web content or attachments" : "are on and still require your approval"}. Built-in web search, browser, scheduling and subagents remain disabled. Use Zen AI browser tools for web access.`
          : locked
          ? "This chat has web pages, screenshots or files in it, and text hidden in those could try to steer Claude. So running commands, reading your files and web tools are off (saving to Claude Output still works). If you trust what you shared, turn them back on. You'll still approve every use."
          : "Commands, file access and web tools are on even though this chat has web content. Each use still asks you first, so read every card before you allow it.",
      }),
      h("button", {
        class: "zai-pop-btn" + (locked ? " zai-primary" : ""),
        text: locked ? "Turn tools back on for this chat" : "Turn tools off",
        onclick: () => onToolsUnlocked(locked),
      })
    ) : null;
    // "Allow all actions in this chat" is on: say what that means, and undo it
    const actions = active.allowAll ? h("div", { class: "zai-pop-section" },
      h("div", { class: "zai-pop-head" },
        h("span", { class: "zai-pop-icon zai-unlocked" }, icon("pointer", 15, 2)),
        h("span", { text: "Browser actions don't ask" })
      ),
      h("p", {
        class: "zai-pop-body",
        text: `You allowed all actions in this chat, so ${aiName(active)} clicks, types, submits, pays, sends and opens other sites without asking. Passwords, card numbers and codes are still never filled, and Stop still stops it.`,
      }),
      h("button", {
        class: "zai-pop-btn zai-primary",
        text: "Ask before each action again",
        onclick: () => {
          closeShieldPop();
          onAskAgain(active);
        },
      })
    ) : null;
    shieldPop.replaceChildren(...[actions, tools].filter(Boolean));
  }

  function openShieldPop() {
    hideTip();
    popovers.closeOthers(entry);
    renderShieldPop();
    shieldPop.hidden = false;
    placePopover(shieldPop, shield);
    shield.setAttribute("aria-expanded", "true");
    shield.removeAttribute("data-tip");
  }

  function closeShieldPop() {
    if (shieldPop.hidden) return;
    shieldPop.hidden = true;
    shield.setAttribute("aria-expanded", "false");
    updateShield();
  }

  shield.addEventListener("click", () => (shieldPop.hidden ? openShieldPop() : closeShieldPop()));
  const entry = popovers.register({
    isOpen: () => !shieldPop.hidden,
    close: closeShieldPop,
    contains: (path) => path.includes(shieldPop) || path.includes(shield),
  });

  return {
    button: shield, pop: shieldPop,
    update: updateShield,
    refresh() { updateShield(); if (!shieldPop.hidden) renderShieldPop(); },
    close: closeShieldPop,
  };
}
