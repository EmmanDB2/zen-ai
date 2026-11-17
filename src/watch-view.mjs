import { h, icon } from "./dom.mjs";
import { timeAgo } from "./panel-parts.mjs";
import { describeCondition, everyText } from "./watches.mjs";

// ---------------------------------------------------------------------------
// Watches on screen: the "Watch this page?" card (watch_page), and the eye
// button at the top of the panel with the list (state, last check, Stop).
// ---------------------------------------------------------------------------

// The card. w: the watch it would start; who: the AI's name. Resolves
// { start, allowAll } (allowAll: the user ticked "don't ask" for the Then run)
export function watchCard(w, who) {
  let resolve;
  const result = new Promise((r) => (resolve = r));
  let done = false;
  let site = w.url;
  try { site = new URL(w.url).host.replace(/^www\./, ""); } catch (e) {}
  const row = (label, text, cls = "") => h("div", { class: "zai-wc-row" + cls }, h("span", { class: "zai-wc-label", text: label }), h("span", { class: "zai-wc-text", text }));
  const sub = h("span", { class: "zai-approval-sub", text: `${site}${w.title ? ` · ${w.title}` : ""}`, title: w.url });
  // With something to do: the user may let it run without asking (that run only)
  const allowBox = h("input", { type: "checkbox", class: "zai-sf-checkbox" });
  const warn = h("div", { class: "zai-approval-warn zai-wc-warn", hidden: true }, icon("shield", 14, 2),
    h("span", { text: `When it happens, ${who} won't ask before clicking, typing, submitting, paying or opening other sites while it does this. Saved card, bank and ID numbers still ask each time. It ends when that reply is done.` }));
  const note = h("div", { class: "zai-wc-note", text: "" });
  const setNote = () => {
    const days = Math.round((w.ends - w.created) / 86400000);
    note.textContent = `Zen has to be open. It stops on its own after ${days} days.${w.then && !allowBox.checked ? " Actions still ask you, as usual." : ""}`;
    warn.hidden = !allowBox.checked;
  };
  allowBox.addEventListener("change", setNote);
  setNote();
  const actions = h("div", { class: "zai-approval-actions" },
    h("button", { class: "zai-deny", text: "Cancel", onclick: () => finish(false) }),
    h("button", { class: "zai-allow", text: "Start watching", onclick: () => finish(true) })
  );
  const el = h("div", { class: "zai-approval zai-watch-card" },
    h("div", { class: "zai-approval-head" },
      h("span", { class: "zai-approval-icon" }, icon("eye", 16, 2)),
      h("span", { class: "zai-approval-text" }, h("span", { class: "zai-approval-title", text: "Watch this page?" }), sub)
    ),
    h("div", { class: "zai-wc-rows" },
      row("Until", describeCondition(w.until)),
      row("Checks", everyText(w)),
      // Only when there's something to do once it happens
      w.then ? row("Then", `${who} will: ${w.then}`, " zai-wc-then") : null,
      w.then ? h("label", { class: "zai-sf-checklabel zai-wc-allow" }, allowBox, h("span", { text: `Allow all of ${who}'s actions for this, without asking` })) : null,
      note
    ),
    w.then ? warn : null,
    actions
  );
  function finish(ok, why = "") {
    if (done) return;
    done = true;
    actions.remove();
    allowBox.disabled = true;
    el.classList.add("zai-decided");
    sub.textContent = ok ? `Watching ${site}` : why || "Not watching";
    resolve({ start: ok, allowAll: ok && !!w.then && allowBox.checked });
  }
  return { el, result, cancel: (why) => finish(false, why || "Stopped") };
}

// The eye button and its list. host() → the leading window's watch host;
// onShowTab(url): select the page's tab
export function createWatchView({ placePopover, popovers, hideTip, host, flash }) {
  const button = h("button", { class: "zai-icon-btn zai-watch-btn", "aria-label": "Watches", "data-tip": "Watches", "data-tip-pos": "below", "aria-haspopup": "dialog", "aria-expanded": "false", hidden: true },
    icon("eye"), h("span", { class: "zai-watch-count", hidden: true }));
  const list = h("div", { class: "zai-watch-list", role: "list" });
  const pop = h("div", { class: "zai-popover zai-watches", role: "dialog", "aria-label": "Watches", hidden: true },
    h("div", { class: "zai-watch-head", text: "Watches" }), list);

  const entry = popovers.register({
    isOpen: () => !pop.hidden,
    close,
    contains: (path) => path.includes(pop) || path.includes(button),
  });

  button.addEventListener("click", () => (pop.hidden ? open() : close()));

  function open() {
    hideTip();
    popovers.closeOthers(entry);
    pop.hidden = false;
    button.setAttribute("aria-expanded", "true");
    button.removeAttribute("data-tip");
    render();
    placePopover(pop, button);
  }
  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("data-tip", "Watches");
  }

  async function render() {
    const lead = host();
    const all = lead ? await lead.all() : [];
    const live = all.filter((w) => w.state === "watching");
    button.hidden = all.length === 0;
    const count = button.querySelector(".zai-watch-count");
    count.textContent = String(live.length);
    count.hidden = live.length === 0;
    if (pop.hidden) return;
    if (!all.length) {
      list.replaceChildren(h("div", { class: "zai-hist-empty", text: "No watches" }));
      return;
    }
    list.replaceChildren(...all.map((w) => {
      let site = w.url;
      try { site = new URL(w.url).host.replace(/^www\./, ""); } catch (e) {}
      const state = w.state === "watching"
        ? (w.lastCheck ? `${w.lastNote || "Checked"} · ${timeAgo(w.lastCheck)}` : "Starting…")
        : w.state === "fired" ? `Happened ${timeAgo(w.firedAt)}` : w.state === "expired" ? "Ended after 7 days" : "Stopped";
      return h("div", { class: "zai-watch-row" + (w.state === "watching" ? "" : " zai-ended"), role: "listitem" },
        h("span", { class: "zai-watch-icon" }, icon(w.state === "fired" ? "check" : "eye", 15)),
        h("span", { class: "zai-watch-text" },
          h("span", { class: "zai-watch-title", text: w.what || describeCondition(w.until), title: w.url }),
          h("span", { class: "zai-watch-sub", text: `${site} · ${w.state === "watching" ? everyText(w).replace(", reloading the page", "").replace(", without reloading", "") + " · " : ""}${state}` }),
          w.then ? h("span", { class: "zai-watch-sub", text: `Then${w.allowAll ? ", without asking" : ""}: ${w.then}` }) : null
        ),
        w.state === "watching"
          ? h("button", { class: "zai-watch-stop", text: "Stop", onclick: async () => { const l = host(); if (l) await l.stop(w.id); flash("Stopped watching"); } })
          : h("button", { class: "zai-icon-btn zai-watch-x", "aria-label": "Remove", "data-tip": "Remove", onclick: async () => { const l = host(); if (l) await l.remove(w.id); } }, icon("close", 13, 2.2))
      );
    }));
    placePopover(pop, button);
  }

  return { button, popover: pop, render, close };
}
