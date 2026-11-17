import { SVG_NS } from "./config.mjs";
import { h, icon } from "./dom.mjs";
import { cropAround } from "./pages.mjs";
import { toolLine } from "./panel-parts.mjs";

// ---------------------------------------------------------------------------
// Approval cards: what an action will do, and the user's answer. The card
// only reports the choice; the browser controller and the chat controller
// decide what it permits. Cards appear where the asking actor works (see
// "actor" in chat-controller.mjs): the main reply, or an agent's box.
//
// actor: { pending: Set, name(), from, scope, place(el, block), answered(block, allowed),
//          highlight(rect|null, sticky), unread() }
// ---------------------------------------------------------------------------
export function createApprovalView() {
  // What the approval card shows for Claude Code's own tools: the exact command / path / URL
  function describeTool(name, input, ai) {
    const i = input || {};
    const clip = (value, n = 600) => {
      const text = String(value == null ? "" : value);
      return text.length > n ? text.slice(0, n) + "…" : text;
    };
    switch (name) {
      case "Bash":
        return { icon: "terminal", title: "Run a command", sub: i.description || "Exactly what will run on your Mac", detail: clip(i.command, 4000), short: i.command };
      case "Read":
        return { icon: "doc", title: "Read a file", sub: `${ai} will see this file's contents`, detail: i.file_path, short: i.file_path };
      case "Write":
        return { icon: "edit", title: "Write a file", sub: "Creates or replaces this file", detail: `${i.file_path}\n\n${clip(i.content)}`, short: i.file_path };
      case "Edit":
        return { icon: "edit", title: "Edit a file", sub: "Changes part of this file", detail: `${i.file_path}\n\n− ${clip(i.old_string, 300)}\n+ ${clip(i.new_string, 300)}`, short: i.file_path };
      case "WebFetch":
        return { icon: "globe", title: "Open a web page", sub: `${ai} will read this page`, detail: `${i.url}${i.prompt ? "\n\n" + clip(i.prompt, 300) : ""}`, short: i.url };
      case "WebSearch":
        return { icon: "search", title: "Search the web", sub: `Results come back to ${ai}`, detail: i.query, short: i.query };
      case "Glob":
      case "Grep":
        return { icon: "search", title: "Search your files", sub: i.path ? `In ${i.path}` : "In the Claude Output folder", detail: `${i.pattern}${i.path ? "\nin " + i.path : ""}`, short: i.pattern };
      default:
        return { icon: "terminal", title: `Use ${name}`, sub: "", detail: clip(JSON.stringify(i, null, 2), 4000), short: name };
    }
  }

  // An approval card where the actor works (the chat's reply, or an agent's
  // box). Resolves "deny", "once", "site" or "all".
  // d: { icon, title, sub, detail, fields, warn, site, browser, short, rect, preview, line, noAllowAll }
  function card(actor, d) {
    return new Promise((resolve) => {
      const el = h("div", { class: "zai-approval", role: "group", "aria-label": `Approval needed: ${actor.from ? actor.from + ": " : ""}${d.title}` });
      const entry = {};
      const block = { type: "line", kind: "ok", text: "", pending: true }; // saved once answered
      const finish = (choice) => {
        if (!actor.pending.has(entry)) return;
        actor.pending.delete(entry);
        if (d.rect) actor.highlight(null);
        const allowed = choice !== "deny";
        const kind = allowed ? "ok" : "denied";
        const text = d.browser
          ? allowed ? (d.line || d.title) + (choice === "site" ? ` · allowed on ${d.site} for ${actor.scope}` : choice === "all" ? ` · all actions allowed ${actor.scope === "this chat" ? "in this chat" : "for " + actor.scope} from now on` : "") : `Denied · ${d.title}`
          : `${allowed ? "Allowed" : "Denied"} · ${d.title.toLowerCase()} ·`;
        // (a denied browser action keeps its title: "Denied · …")
        const code = d.browser ? undefined : d.short;
        Object.assign(block, { kind, text, code, pending: false });
        el.replaceWith(toolLine(kind, text, code));
        actor.answered(block, allowed);
        resolve(choice);
      };
      entry.deny = () => finish("deny");
      entry.allowBrowser = d.browser ? () => finish("once") : null;
      actor.pending.add(entry);
      const buttons = [h("button", { class: "zai-deny", onclick: () => finish("deny") }, "Deny")];
      if (d.site) buttons.push(h("button", { class: "zai-allow-site", "data-tip": `Don't ask again on ${d.site} for ${actor.scope} (submitting still asks)`, onclick: () => finish("site") }, "Allow on this site"));
      buttons.push(h("button", { class: "zai-allow" + (d.warn ? " zai-risky" : ""), onclick: () => finish("once") }, d.warn ? "Allow" : "Allow once"));
      el.append(...[
        // Which agent is asking (never only inside its collapsed details)
        actor.from ? h("div", { class: "zai-approval-from", text: actor.from }) : null,
        h("div", { class: "zai-approval-head" },
          h("span", { class: "zai-approval-icon" }, icon(d.icon, 15, 2)),
          h("span", { class: "zai-approval-text" },
            h("span", { class: "zai-approval-title", text: d.title }),
            d.sub ? h("span", { class: "zai-approval-sub", text: d.sub, title: d.sub }) : null
          )
        ),
        d.warn ? h("div", { class: "zai-approval-warn" }, icon("shield", 14, 2), h("span", { text: d.warn })) : null,
        d.preview ? shotPreview(d.preview, actor.name()) : null,
        d.fields ? h("div", { class: "zai-fields" }, d.fields.flatMap((f) => [
          h("span", { class: "zai-f-label", text: f.label, title: f.label }),
          h("span", { class: "zai-f-value" + (f.skipped || f.skipNote ? " zai-f-skip" : ""), text: f.skipNote || (f.skipped ? `Skipped: ${f.skipped}, fill it yourself` : f.value) }),
        ])) : null,
        d.detail ? h("pre", { text: d.detail }) : null,
        h("div", { class: "zai-approval-actions" }, buttons),
        // Browser actions only: stop asking for the rest of this chat
        d.browser && !d.noAllowAll ? h("div", { class: "zai-approval-more" },
          h("button", {
            class: "zai-allow-all",
            "data-tip": `${actor.name()} won't ask again ${actor.scope === "this chat" ? "in this chat" : "for " + actor.scope}, even to submit, pay, send, delete or open other sites. Saved card, bank and ID numbers still ask each time.`,
            onclick: () => finish("all"),
          }, actor.scope === "this chat" ? "Allow all actions in this chat" : `Allow all actions for ${actor.scope}`)
        ) : null,
      ].filter(Boolean));
      actor.place(el, block);
      if (d.rect) actor.highlight(d.rect, true);
      actor.unread(); // waiting on the user in a chat they may not be looking at
    });
  }

  // A close-up of Claude's screenshot, marking where it will press (and let
  // go): what a point means is only clear on the picture.
  // marks: [{ kind: "click" | "from" | "to", x, y }] in the screenshot's pixels
  function shotPreview({ shot, marks }, ai) {
    const box = cropAround(marks, shot.w, shot.h);
    const svg = (tag, attrs) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      return el;
    };
    const pic = svg("svg", { viewBox: `${box.x} ${box.y} ${box.w} ${box.h}`, class: "zai-shot-pic", role: "img", "aria-label": marks.length > 1 ? `Where ${ai} will press and let go, on its screenshot` : `Where ${ai} will click, on its screenshot` });
    pic.append(svg("image", { href: shot.dataUrl, x: 0, y: 0, width: shot.w, height: shot.h }));
    const [a, b] = marks;
    if (b) {
      pic.append(svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "zai-shot-halo" }));
      pic.append(svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "zai-shot-path" }));
    }
    const r = box.w / 40; // the same size on the card, however big the crop
    for (const m of marks) pic.append(svg("circle", { cx: m.x, cy: m.y, r, class: `zai-shot-mark zai-shot-${m.kind}` }));
    return h("div", { class: "zai-shot", style: `aspect-ratio: ${box.w} / ${box.h}` }, pic);
  }

  // One of the AI's own tools (commands, files, web): allowed or not
  async function ask(actor, toolName, input) {
    return (await card(actor, describeTool(toolName, input, actor.name()))) !== "deny";
  }

  // Stop / Stop waiting: every card still waiting for this actor says no
  function denyAll(actor) {
    for (const entry of [...actor.pending]) entry.deny();
  }

  // "Allow all": cards already waiting for this actor are covered too
  function allowWaitingBrowser(actor) {
    for (const entry of [...actor.pending]) if (entry.allowBrowser) entry.allowBrowser();
  }

  return { card, ask, denyAll, allowWaitingBrowser, describeTool };
}
