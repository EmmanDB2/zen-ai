import { WAIT_MAX_SECONDS, WAIT_POLL_MS } from "./config.mjs";
import { newImageStore } from "./files.mjs";
import { newFileStore } from "./file-edit.mjs";
import { clamp, h, icon } from "./dom.mjs";
import { browserInfo, captureVisible, getPageText, hostOf, sanitizeUntrusted } from "./pages.mjs";
import { UNTRUSTED_PAGE_NOTE, describePage, loadUrl, navigateWhere, openInNewTab, runAgentInPage, settle, sleep } from "./browser-agent.mjs";
import { describeTab, followFrames, frameByKey, placeFrame, runAgentInFrame, shiftRect, snapshotFrame, snapshotTab, splitRef, watchTab } from "./frames.mjs";
import { readSecrets, secretSiteOk } from "./skills.mjs";
import { folderLines, folderPath, planSteps, runSteps, spaceFolders, tabPlace } from "./zen-tabs.mjs";
import { shortTitle, toolLine } from "./panel-parts.mjs";

// ---------------------------------------------------------------------------
// Browser actions: deciding whether one may run (approval cards, "Allow on
// this site", Allow all, protected fields, saved secrets, tab switching and
// organizing) and running it in the page agent. Everything is per ACTOR: the
// chat's own AI, or one of its agents (see chat-controller.mjs). An actor has
// its own one-shot grants, page reads, screenshots and pending approvals;
// nothing here is shared between actors.
//
// actor: { kind, browser: { active, allowed, seen, shots, frames, tabs, waiting },
//          pending, allowedSites, allowAll, setAllowAll(on), secretAccess, scope,
//          live(), token(), tab(), setTab(tab), startTab(), name(), line(kind, text, code),
//          status(text), clearStatus(), place(el, block), taint() }
// ---------------------------------------------------------------------------
// Browser state of one actor (never shared between actors)
export function newBrowserState() {
  // images: screenshots kept for documents (shot1…), see newImageStore;
  // files: attached and made files edit_file may change (newFileStore)
  return { active: false, allowed: new Map(), seen: new WeakMap(), shots: new WeakMap(), frames: new WeakMap(), tabs: new WeakSet(), waiting: false, images: newImageStore(), files: newFileStore() };
}

export function createBrowserController({ approvals, overlay }) {
  // -------------------------------------------------------------------------
  // Browser agent: Claude acting in the tab you were on when you sent the message
  // -------------------------------------------------------------------------
  const QUIET_BROWSER_TOOLS = new Set(["browser_read", "browser_scroll", "browser_screenshot", "browser_wait"]);

  const DENIED = "The user denied this. Don't retry it; ask the user what they'd like to do instead.";

  // Next look at any tab sends the whole page again (and points need a new screenshot)
  function forgetPages(actor) {
    actor.browser.seen = new WeakMap();
    actor.browser.shots = new WeakMap();
    actor.browser.frames = new WeakMap();
  }

  // Frames from other sites that Claude reads along with a tab (it read or
  // acted in them, or they're big): their keys
  function openFrames(actor, browser) {
    if (!actor.browser.frames.has(browser)) actor.browser.frames.set(browser, new Set());
    return actor.browser.frames.get(browser);
  }

  function agentTab(actor) {
    const tab = actor.tab();
    if (!tab || !tab.linkedBrowser || tab.isConnected === false) throw new Error("The tab the assistant was working in is closed.");
    return tab;
  }

  // Other tabs Claude can switch to (browser_switch_tab, or browser_navigate
  // to a page that's open already): web pages in the Space of the tab it's
  // working in. Ids (t1, t2…) last as long as the window.
  const tabIds = new WeakMap();

  // Every tab in the Space gets a line (and an id), so "all my tabs" means all
  const MAX_TAB_LIST = 400;

  let nextTabId = 1;

  function tabId(tab) {
    if (!tabIds.has(tab)) tabIds.set(tab, "t" + nextTabId++);
    return tabIds.get(tab);
  }

  const tabUrl = (tab) => { try { return tab.linkedBrowser.currentURI.spec; } catch (e) { return ""; } };

  // Zen folders get ids too (g1, g2…), for browser_organize_tabs
  const folderIds = new WeakMap();

  let nextFolderId = 1;

  function folderId(folder) {
    if (!folderIds.has(folder)) folderIds.set(folder, "g" + nextFolderId++);
    return folderIds.get(folder);
  }

  const spaceOf = (actor) => agentTab(actor).getAttribute("zen-workspace-id") || "";

  // What browser_organize_tabs may touch: this Space's tabs and folders
  function organizeContext(actor) {
    const tabs = spaceTabs(actor);
    const folders = spaceFolders(spaceOf(actor));
    if (!actor.browser.wasPinned) actor.browser.wasPinned = new WeakSet();
    return {
      tabs, folders, working: agentTab(actor), idOf: tabId, wasPinned: actor.browser.wasPinned,
      tabById: (id) => tabs.find((t) => tabId(t) === id) || null,
      folderById: (id) => folders.find((f) => folderId(f) === id) || null,
    };
  }

  // A few tab titles for a card or a line: “A”, “B” and 2 more
  const tabTitles = (tabs) => tabs.slice(0, 3).map((t) => `“${shortTitle(t.label || tabUrl(t), 40)}”`).join(", ") + (tabs.length > 3 ? ` and ${tabs.length - 3} more` : "");

  function spaceTabs(actor) {
    const cur = agentTab(actor);
    const space = cur.getAttribute("zen-workspace-id");
    let all = [];
    try { all = Array.from(typeof gZenWorkspaces !== "undefined" && gBrowser.tabs ? gBrowser.tabs : gBrowser.visibleTabs); } catch (e) {}
    const inSpace = (t) => !space || t.hasAttribute("zen-essential") || t.getAttribute("zen-workspace-id") === space;
    // An agent's tab belongs to that agent while it works: never listed for anyone else
    const othersTab = (t) => { const o = ownerOf(t); return !!o && o !== actor; };
    return all.filter((t) => t === cur || (!t.closing && inSpace(t) && !othersTab(t) && /^(https?|file):/i.test(tabUrl(t))));
  }

  // Tabs an agent works in: tab → that agent's actor. Exclusive while it runs:
  // the chat's AI and other agents can't act there or switch to it, so two
  // actors never take turns on one page with stale refs.
  const tabOwners = new WeakMap();
  function ownerOf(tab) {
    const a = tab && tabOwners.get(tab);
    return a && a.live() ? a : null;
  }
  // An agent's tab stays open for the user when it ends; only the claim goes
  function releaseTabs(actor) {
    let tab = null;
    try { tab = actor.tab(); } catch (e) {}
    if (tab && tabOwners.get(tab) === actor) tabOwners.delete(tab);
  }

  // Checked before anything else, at permission time and again when it runs:
  // "" or why this actor can't do this
  function actorRule(actor, tool, input) {
    if (actor.kind === "agent") {
      if (tool === "browser_switch_tab" || tool === "browser_organize_tabs") return "Agents work only in the tab they opened: they can't switch to or organize the user's tabs.";
      if (!actor.tab() && (tool !== "browser_navigate" || !/^https?:\/\//i.test(String((input && input.url) || "").trim()))) {
        return "Open your own tab first: browser_navigate with an http(s) url opens a new background tab for you.";
      }
    }
    let tab = null;
    try { tab = actor.tab(); } catch (e) {}
    const owner = ownerOf(tab);
    if (owner && owner !== actor) return `${owner.from || "An agent"} is working in that tab. Wait for it (agent_wait) or stop it (agent_cancel) first.`;
    return "";
  }

  // An agent's first page: a card for opening it in a new background tab
  // (its own grants and sites only; nothing carries over from the chat)
  async function agentOpenPermission(actor, input, allow, deny) {
    const url = String(input.url || "").trim();
    const target = hostOf(url);
    if (actor.allowAll) {
      actor.line("warn", `Open ${target} in a background tab · all actions allowed for ${actor.scope}`);
      return allow();
    }
    if (target && actor.allowedSites.has(target)) {
      actor.line("ok", `Open ${target} in a background tab · allowed for ${actor.scope}`);
      return allow();
    }
    const choice = await approvals.card(actor, { browser: true, icon: "globe", title: `Open ${target}`, sub: "in a new background tab of its own (your tabs stay as they are)", detail: url, site: target || null });
    if (choice === "deny") return deny(DENIED);
    if (choice === "site" && target) actor.allowedSites.add(target);
    if (choice === "all") setAllowAll(actor, true);
    return allow();
  }

  // The same page: the same address, give or take a #part or a final /
  function samePage(a, b) {
    try {
      const x = new URL(a);
      const y = new URL(b);
      x.hash = "";
      y.hash = "";
      return x.href.replace(/\/$/, "") === y.href.replace(/\/$/, "");
    } catch (e) {
      return false;
    }
  }

  // Another tab that already shows url, if any
  function tabWith(actor, url) {
    const cur = agentTab(actor);
    return spaceTabs(actor).find((t) => t !== cur && samePage(tabUrl(t), url)) || null;
  }

  const fieldName = (item) => (item.label ? `“${item.label}”` : `the ${item.role} (${item.ref})`);

  // browser_drag's words: "onto", "before", "after"; "120 px right, 40 px up"
  const dropWord = (position) => (position === "before" || position === "after" ? position : "onto");

  function offsetText(by) {
    const x = Math.round(Number(by && by.x) || 0);
    const y = Math.round(Number(by && by.y) || 0);
    return [x ? `${Math.abs(x)} px ${x > 0 ? "right" : "left"}` : "", y ? `${Math.abs(y)} px ${y > 0 ? "down" : "up"}` : ""].filter(Boolean).join(", ");
  }

  // A point Claude gave (from its screenshot) as numbers, or null
  const pointOf = (p) => (p && typeof p === "object" && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) ? { x: Number(p.x), y: Number(p.y) } : null);

  // What the page agent needs to find a screenshot's point on the page
  const shotArgs = (shot) => ({ ratio: shot.ratio, sx: shot.sx, sy: shot.sy, doc: shot.doc, ox: shot.ox || 0, oy: shot.oy || 0 });

  const NEED_SHOT = "Take a browser_screenshot first: points are read off your latest screenshot of this tab, and any action since it may have changed the page.";

  // A spot from a point: “its label”, or "the marked spot" (the card shows it)
  const spotName = (s) => (s.label ? `“${s.label}”` : "the marked spot");

  const spotKind = (s) => (s.role === "spot" ? s.what : s.role);

  // " in a frame from survey.example.com": for things inside a frame from another site
  const inFrame = (it) => (it && it.frameHost ? ` in a frame from ${it.frameHost}` : "");

  function shownValue(item, value) {
    if (item.role === "checkbox" || item.role === "radio" || item.role === "switch") {
      return /^(true|yes|y|1|on|checked|check|selected)$/i.test(String(value).trim()) ? "✓ Checked" : "Unchecked";
    }
    return String(value == null ? "" : value) || "(empty)";
  }

  function blockedField(actor, item) {
    actor.line("warn", `Skipped ${fieldName(item)}: ${item.protected} fields are yours to fill in`);
    return {
      behavior: "deny",
      message: `That's a ${item.protected} field. ${actor.name()} never fills passwords, card or bank numbers, ID numbers or one-time codes. Tell the user to fill it in themselves.`,
    };
  }

  // A saved secret Claude named by its label, checked against the field it's
  // for: { secret, alwaysAsk, warn } or { error }. Passwords on one of their
  // own sites follow the usual rules; anything else asks every time.
  async function secretFor(actor, label, item, site) {
    if (!actor.secretAccess) return { error: "Saved secrets aren't available in this chat: only a skill that lists secrets under access: can use them. Ask the user to fill that field in." };
    const all = (await readSecrets()) || [];
    const secret = all.find((x) => x.label.toLowerCase() === String(label).trim().toLowerCase());
    if (!secret) return { error: `There's no saved secret called “${label}”.${all.length ? ` The saved ones: ${all.map((x) => `“${x.label}”`).join(", ")}.` : ""}` };
    const an = (w) => (/^(ID|[aeiou])/i.test(w) ? "an " : "a ") + w;
    if (item.protected !== secret.kind) {
      return { error: item.protected ? `${fieldName(item)} is ${an(item.protected)} field and “${secret.label}” is ${an(secret.kind)}, so it can't go there.` : `${fieldName(item)} isn't a protected field, so a saved secret can't go there.` };
    }
    const host = item.frameHost || site;
    const listed = secretSiteOk(secret, host);
    const warns = [];
    if (secret.kind !== "password") warns.push(`This fills your saved ${secret.kind}. That always asks first.`);
    if (!listed && secret.sites.length) warns.push(`${host} isn't on this secret's list (${secret.sites.join(", ")}). Only allow it if you trust this site.`);
    else if (!listed && secret.kind === "password") warns.push(`This password has no sites listed, so it asks every time. Only allow it if you trust ${host}.`);
    return { secret, alwaysAsk: secret.kind !== "password" || !listed, warn: warns.join(" ") };
  }

  // Decides whether a browser action may run: asks with a card unless the
  // site is allowed for this actor. Submitting/sending/paying/Enter always asks.
  async function browserPermission(actor, tool, rawInput) {
    let input = rawInput || {};
    const allow = () => {
      // Each allowed action can run exactly once (see runBrowserTool)
      actor.browser.allowed.set(tool, (actor.browser.allowed.get(tool) || 0) + 1);
      return { behavior: "allow", updatedInput: input };
    };
    const deny = (message) => ({ behavior: "deny", message });
    if (!actor.live()) return deny("The user stopped this reply.");
    const rule = actorRule(actor, tool, input);
    if (rule) return deny(rule);
    if (actor.kind === "agent") {
      // An agent only ever navigates its own tab (the first time: a new one)
      if (tool === "browser_navigate") input = { ...input, tab: actor.tab() ? "current" : "new" };
      if (!actor.tab()) return agentOpenPermission(actor, input, allow, deny);
    }
    if (tool === "browser_switch_tab") {
      if (!input.tab) return allow(); // just the list
      let tab = null;
      try { tab = spaceTabs(actor).find((t) => tabId(t) === String(input.tab).trim()); } catch (e) { return deny(e.message); }
      if (!tab) return deny(`There's no tab ${input.tab} in this Space. Call browser_switch_tab without tab to list them.`);
      return (await tabPermission(actor, tab)) ? allow() : deny(DENIED);
    }
    if (QUIET_BROWSER_TOOLS.has(tool)) return allow();
    if (tool === "browser_organize_tabs") return organizePermission(actor, input, allow, deny);
    let tab;
    try { tab = agentTab(actor); } catch (e) { return deny(e.message); }
    const browser = tab.linkedBrowser;
    const here = browserInfo(browser);
    const site = hostOf(here.url) || here.url;
    overlay.show(actor, true);

    if (tool === "browser_navigate") {
      const url = String(input.url || "").trim();
      const back = url.toLowerCase() === "back";
      if (!back && !/^https?:\/\//i.test(url)) return deny("Only http(s) web addresses can be opened.");
      // Open already: that's switching tabs (nothing new loads)
      const open = back || input.tab === "new" || input.tab === "current" ? null : tabWith(actor, url);
      if (open) return (await tabPermission(actor, open)) ? allow() : deny(DENIED);
      const target = back ? "" : hostOf(url);
      if (actor.allowAll) {
        const otherSite = !back && target !== hostOf(here.url);
        actor.line(otherSite ? "warn" : "ok", `${back ? "Go back a page" : `Open ${target}`}${navigateWhere(input, here.url) === "new" ? " in a new tab" : ""} · all actions allowed`);
        return allow();
      }
      if (target && actor.allowedSites.has(target)) {
        actor.line("ok", `Open ${target}${navigateWhere(input, here.url) === "new" ? " in a new tab" : ""} · allowed for ${actor.scope}`);
        return allow();
      }
      const where = navigateWhere(input, here.url);
      const sub = back
        ? `in the tab ${actor.name()} is using (on ${site})`
        : where === "new"
          ? "in a new tab (your current tab stays as it is)"
          : target === hostOf(here.url) ? `in this tab (same site)` : `in this tab, replacing ${site}`;
      const d = { browser: true, icon: "globe", title: back ? "Go back a page" : `Open ${target}`, sub, detail: back ? "" : url, site: target || null };
      const choice = await approvals.card(actor, d);
      if (choice === "deny") return deny(DENIED);
      if (choice === "site" && target) actor.allowedSites.add(target);
      if (choice === "all") setAllowAll(actor, true);
      return allow();
    }

    const fields = tool === "browser_fill_form" ? (Array.isArray(input.fields) ? input.fields.filter((f) => f && f.ref) : []) : null;
    // fill_form's then_click: the button to press once every field is filled
    const thenClick = fields && input.then_click ? String(input.then_click) : "";
    const refs = fields ? [...fields.map((f) => f.ref), ...(thenClick ? [thenClick] : [])]
      : tool === "browser_drag" ? [input.from, input.to].filter(Boolean).map(String)
      : input.ref ? [input.ref] : [];
    // Points in Claude's latest screenshot, for things without a ref
    const pts = {
      at: tool === "browser_click" && !input.ref ? pointOf(input.point) : null,
      from: tool === "browser_drag" && !input.from ? pointOf(input.from_point) : null,
      to: tool === "browser_drag" && !input.to ? pointOf(input.to_point) : null,
    };
    const pointKeys = Object.keys(pts).filter((k) => pts[k]);
    const shot = pointKeys.length ? actor.browser.shots.get(browser) : null;
    if (pointKeys.length) {
      if (!shot) return deny(NEED_SHOT);
      if (pointKeys.some((k) => pts[k].x < 0 || pts[k].y < 0 || pts[k].x >= shot.w || pts[k].y >= shot.h)) {
        return deny(`Points have to be inside your latest screenshot (${shot.w}×${shot.h} px).`);
      }
      if (pts.from && pts.to && Math.hypot(pts.from.x - pts.to.x, pts.from.y - pts.to.y) < 2) return deny("from_point and to_point are the same spot.");
      input = { ...input };
      if (pts.at) input.point = pts.at;
      if (pts.from) input.from_point = pts.from;
      if (pts.to) input.to_point = pts.to;
    }
    if (!refs.length && !pointKeys.length && tool !== "browser_press_key") {
      return deny(tool === "browser_click" || tool === "browser_drag" ? "Give a ref from browser_read, or a point in your latest browser_screenshot." : "Give a ref from browser_read.");
    }
    // One action acts in one frame (f2.e5 is in frame f2; e5 in the tab itself)
    if (new Set(refs.map((r) => splitRef(r).frame)).size > 1) {
      return deny(tool === "browser_drag" ? "Both ends of the drag have to be in the same frame." : "These refs are in different frames: do one frame at a time.");
    }
    let items = [];
    const spot = {};
    let scroll = { x: 0, y: 0 };
    if (refs.length || pointKeys.length) {
      // (Nothing is scrolled into view when there are points: they'd move)
      const info = await describeTab(browser, refs, { focus: !pointKeys.length, points: pointKeys.map((k) => pts[k]), shot: shot && shotArgs(shot) });
      if (info.error) return deny(info.error);
      items = info.items || [];
      const gone = items.find((i) => !i.found);
      if (gone) return deny(gone.error || `${gone.ref} isn't on the page anymore. Call browser_read again.`);
      const spots = info.spots || [];
      const lost = spots.find((s) => !s.found);
      if (lost) return deny(lost.error || "That point isn't on the page anymore. Take a new browser_screenshot.");
      pointKeys.forEach((k, i) => (spot[k] = spots[i]));
      if (info.scroll) scroll = info.scroll;
    }
    // A ref'd element's centre in the screenshot's pixels (for the preview)
    const inShot = (r) => ({ x: (r.x + r.w / 2 - (shot.ox || 0) + scroll.x - shot.sx) * shot.ratio, y: (r.y + r.h / 2 - (shot.oy || 0) + scroll.y - shot.sy) * shot.ratio });
    const item = items[0];
    let d;
    let warn = "";
    const secretChecks = []; // saved secrets this action fills (secretFor)
    switch (tool) {
      case "browser_click": {
        const it = spot.at || item;
        if (it.submits) warn = `This ${it.submits}${it.submits.startsWith("is labeled") ? ", so it might send, buy, delete or change something" : ""}. Check before allowing.`;
        d = spot.at
          ? { icon: "pointer", title: `Click ${spotName(spot.at)}`, sub: `${spotKind(spot.at)}${inFrame(spot.at)} on ${site}`, preview: { shot, marks: [{ kind: "click", ...pts.at }] } }
          : { icon: "pointer", title: `Click ${fieldName(item)}`, sub: `${item.role}${inFrame(item)} on ${site}` };
        break;
      }
      case "browser_type":
        if (input.secret != null && input.secret !== "") {
          if (input.text) return deny("Give text or secret, not both.");
          const sv = await secretFor(actor, input.secret, item, site);
          if (sv.error) return deny(sv.error);
          secretChecks.push(sv);
          d = { icon: "shield", title: `Fill your saved “${sv.secret.label}” into ${fieldName(item)}`, sub: `${item.protected} field${inFrame(item)} on ${site}` };
          break;
        }
        if (item.protected) return blockedField(actor, item);
        d = { icon: "edit", title: `Type into ${fieldName(item)}`, sub: item.math ? `${item.math} math box${inFrame(item)} on ${site}` : `${inFrame(item).trim()} on ${site}`.trim(), detail: String(input.text == null ? "" : input.text) };
        break;
      case "browser_select":
        if (item.protected) return blockedField(actor, item);
        d = { icon: "list", title: `Choose “${shortTitle(input.option, 50)}” in ${fieldName(item)}`, sub: `${inFrame(item).trim()} on ${site}`.trim() };
        break;
      case "browser_press_key": {
        const key = String(input.key || "");
        if (key === "Enter") warn = "Enter can submit a form or send a message. Check before allowing.";
        d = { icon: "keyboard", title: `Press ${key}${item ? ` in ${fieldName(item)}` : ""}`, sub: `${inFrame(item).trim()} on ${site}`.trim() };
        break;
      }
      case "browser_fill_form": {
        const hasSecret = (f) => f.secret != null && f.secret !== "";
        for (const [i, f] of fields.entries()) {
          if (!hasSecret(f)) continue;
          if (f.value) return deny(`${f.ref}: give value or secret, not both.`);
          const sv = await secretFor(actor, f.secret, items[i], site);
          if (sv.error) return deny(sv.error);
          secretChecks.push(sv);
        }
        const usable = fields.filter((f, i) => !items[i].protected || hasSecret(f));
        if (!usable.length) return blockedField(actor, items.find((i) => i.protected));
        const rows = fields.map((f, i) => ({
          label: items[i].label || `${items[i].role} ${items[i].ref}`,
          value: hasSecret(f) ? `Your saved “${secretChecks.find((x) => x.secret.label.toLowerCase() === String(f.secret).trim().toLowerCase()).secret.label}”` : shownValue(items[i], f.value),
          skipped: items[i].protected && !hasSecret(f) ? items[i].protected : "",
        }));
        const btn = thenClick ? items[fields.length] : null;
        if (btn && btn.role !== "button" && btn.role !== "link") return deny("then_click has to be a button or link; click other things separately.");
        input = { ...input, fields: usable };
        delete input.then_click;
        if (btn && usable.length < fields.length) {
          // A field is left for the user, so the button waits for them too
          rows.push({ label: "Then click", value: "", skipNote: `Not yet: ${fieldName(btn)} waits until you've filled the field above` });
        } else if (btn) {
          rows.push({ label: "Then click", value: fieldName(btn) });
          input.then_click = thenClick;
          if (btn.submits) warn = `After filling, it clicks ${fieldName(btn)}, which ${btn.submits}${btn.submits.startsWith("is labeled") ? ", so it might send, buy, delete or change something" : ""}. Check before allowing.`;
        }
        const n = `${usable.length} field${usable.length === 1 ? "" : "s"}`;
        const where = `${inFrame(items[0]).trim()} on ${site}`.trim();
        d = input.then_click
          ? { icon: "form", title: `Fill ${n}, then click ${fieldName(btn)}`, sub: where, fields: rows }
          : { icon: "form", title: `Fill ${n}`, sub: `${where} · nothing gets submitted`, fields: rows };
        break;
      }
      case "browser_drag": {
        // Each end is a ref or a point
        const source = input.from ? items[0] : spot.from;
        const target = input.to ? items[input.from ? 1 : 0] : null;
        const toSpot = spot.to || null;
        if (!source) return deny("Say what to drag: from (a ref) or from_point.");
        if (!target && !toSpot && !offsetText(input.by)) return deny("Say where to drag it: to (a ref), to_point, or by ({x, y} in pixels).");
        if (new Set([source, target, toSpot].filter(Boolean).map((e) => e.frame || "")).size > 1) return deny("Both ends of the drag have to be in the same frame.");
        if (refs.some((r) => splitRef(r).frame) && pointKeys.length) return deny("Inside a frame, give both ends as refs or both as points.");
        const what = input.from ? fieldName(source) : spotName(source);
        const where = target ? `${dropWord(input.position)} ${fieldName(target)}` : toSpot ? `to ${spotName(toSpot)}` : `by ${offsetText(input.by)}`;
        // Dropping something into a bin can delete it
        const bin = target || (toSpot && toSpot.label ? toSpot : null);
        if (bin && /\b(trash|delete|remove|bin|discard|archive)\b/i.test(bin.label || "")) {
          warn = `Dropping it onto ${target ? fieldName(target) : spotName(toSpot)} might delete or remove it. Check before allowing.`;
        }
        const title = spot.from && toSpot && !spot.from.label && !toSpot.label ? "Drag between the marked spots" : `Drag ${what} ${where}`;
        d = { icon: "move", title, sub: `${input.from ? source.role : spotKind(source)}${inFrame(source)} on ${site}` };
        if (pointKeys.length) {
          const start = pts.from || inShot(source.rect);
          const by = { x: Number(input.by && input.by.x) || 0, y: Number(input.by && input.by.y) || 0 };
          const end = pts.to || (target ? inShot(target.rect) : { x: start.x + by.x, y: start.y + by.y });
          d.preview = { shot, marks: [{ kind: "from", ...start }, { kind: "to", ...end }] };
        }
        break;
      }
      default:
        return deny("Unknown browser action.");
    }
    const first = spot.at || spot.from || item;
    // A saved card, bank or ID number, or a secret off its own sites: always a card
    const mustAsk = secretChecks.some((x) => x.alwaysAsk);
    warn = [warn, ...secretChecks.map((x) => x.warn).filter(Boolean)].filter(Boolean).join(" ");
    Object.assign(d, { browser: true, warn, site: warn ? null : site, rect: first && first.rect, noAllowAll: mustAsk });
    if (mustAsk) {
      const choice = await approvals.card(actor, d);
      if (choice === "deny") return deny(DENIED);
      return allow();
    }
    // The user allowed all actions in this actor (protected fields were refused above)
    if (actor.allowAll) {
      overlay.highlight(actor, d.rect);
      actor.line(warn ? "warn" : "ok", `${d.title} · all actions allowed`);
      return allow();
    }
    if (!warn && actor.allowedSites.has(site)) {
      overlay.highlight(actor, d.rect);
      actor.line("ok", `${d.title} · allowed on this site`);
      return allow();
    }
    const choice = await approvals.card(actor, d);
    if (choice === "deny") return deny(DENIED);
    if (choice === "site") actor.allowedSites.add(site);
    if (choice === "all") setAllowAll(actor, true);
    return allow();
  }

  // Organizing this Space's tabs (folders, pinning, closing): one card for
  // all the steps. Closing always asks (no Allow all); the rest follows
  // Allow all. "Allow on this site" doesn't apply (it's not a page action).
  async function organizePermission(actor, input, allow, deny) {
    let ctx;
    try { ctx = organizeContext(actor); } catch (e) { return deny(e.message); }
    const { plan, error } = planSteps(input.steps, ctx);
    if (error) return deny(error);
    const rows = plan.flatMap((p) => {
      switch (p.do) {
        case "create_folder": return { label: `New folder “${p.name}”`, value: tabTitles(p.tabs) };
        case "move_to_folder": return { label: `Into “${folderPath(p.folder)}”`, value: tabTitles(p.tabs) };
        case "remove_from_folder": return { label: "Out of their folder", value: tabTitles(p.tabs) };
        case "rename_folder": return { label: `Rename “${folderPath(p.folder)}”`, value: `“${p.name}”` };
        case "pin": return { label: "Pin", value: tabTitles(p.tabs) };
        case "unpin": return { label: "Unpin", value: tabTitles(p.tabs) };
        case "unload": return { label: "Unload", value: tabTitles(p.tabs) };
        default: {
          const plain = p.close.filter((t) => !p.closePinned.includes(t));
          return [
            plain.length ? { label: "Close", value: tabTitles(plain) } : null,
            p.closePinned.length ? { label: "Close pinned (leaves your sidebar)", value: tabTitles(p.closePinned) } : null,
            p.unload.length ? { label: "Unload, not close (pinned)", value: tabTitles(p.unload) } : null,
          ].filter(Boolean);
        }
      }
    });
    const closeTabs = plan.flatMap((p) => p.close || []);
    const unloadTabs = plan.flatMap((p) => (p.do === "unload" ? p.tabs : p.unload || []));
    const closing = closeTabs.length;
    const closingPinned = plan.reduce((n, p) => n + ((p.closePinned || []).length), 0);
    // Every tab that closes or unloads, in full: the rows only show a few
    const listOf = (tabs) => tabs.map((t) => `${shortTitle(t.label || tabUrl(t), 60)}  ${hostOf(tabUrl(t))}`).join("\n");
    const detail = [
      closing ? `Closes (${closing}):\n${listOf(closeTabs)}` : "",
      unloadTabs.length ? `Unloads, staying in the sidebar (${unloadTabs.length}):\n${listOf(unloadTabs)}` : "",
    ].filter(Boolean).join("\n\n");
    const line = `Organize tabs: ${rows.map((r) => `${r.label} ${r.value}`).join("; ")}`;
    const d = {
      browser: true, icon: "folder",
      title: plan.length > 1 || rows.length > 1 ? "Organize your tabs" : ["pin", "unpin", "unload", "close"].includes(plan[0].do) ? `${rows[0].label} ${rows[0].value}` : rows[0].label,
      sub: `in this Space · ${plan.length} step${plan.length === 1 ? "" : "s"}`, fields: rows, site: null, detail,
      line,
      warn: closing
        ? `This closes ${closing} tab${closing === 1 ? "" : "s"}${closingPinned ? `, including ${closingPinned} pinned: they'll be gone from your sidebar, not just unloaded` : unloadTabs.length ? " (pinned ones are only unloaded)" : ""}. Closing always asks; you can reopen closed tabs with ⇧⌘T.`
        : "",
      noAllowAll: !!closing,
    };
    if (!closing && actor.allowAll) {
      actor.line("ok", `${line} · all actions allowed`);
      return allow();
    }
    const choice = await approvals.card(actor, d);
    if (choice === "deny") return deny(DENIED);
    if (choice === "all") setAllowAll(actor, true);
    return allow();
  }

  // Switching to another open tab: back to one Claude has worked in during
  // this actor needs no card; any other tab of the user's asks (its site
  // allowed, or Allow all, counts). Resolves true if allowed.
  async function tabPermission(actor, tab) {
    const title = shortTitle(tab.label || tabUrl(tab) || "Tab", 60);
    const host = hostOf(tabUrl(tab));
    if (tab === agentTab(actor)) return true;
    const owner = ownerOf(tab);
    if (owner && owner !== actor) return false;
    if (actor.browser.tabs.has(tab)) {
      actor.line("ok", `Back to “${title}”`);
      return true;
    }
    if (actor.allowAll) {
      actor.line("ok", `Switch to “${title}” · all actions allowed`);
      return true;
    }
    if (host && actor.allowedSites.has(host)) {
      actor.line("ok", `Switch to “${title}” · allowed on this site`);
      return true;
    }
    const choice = await approvals.card(actor, { browser: true, icon: "tabs", title: `Switch to “${title}”`, sub: `your open tab on ${host || "this page"} · ${actor.name()} works there next`, site: host || null });
    if (choice === "deny") return false;
    if (choice === "site" && host) actor.allowedSites.add(host);
    if (choice === "all") setAllowAll(actor, true);
    return true;
  }

  // "Allow all actions in this chat" (from an approval card), or back to
  // asking (from the shield popover). Never saved: a reopened actor asks again.
  function setAllowAll(actor, on) {
    actor.setAllowAll(on);
    // Other cards already waiting for this actor are covered too
    if (on) approvals.allowWaitingBrowser(actor);
    overlay.place();
  }

  // Runs a browser tool (after browserPermission said yes). Returns MCP content.
  // Tabs where Zen AI filled a saved card, bank or ID number into a field that
  // shows it (browser → the frames it's in, null for the tab): screenshots
  // there wait until it's no longer on screen (secretOnScreen)
  const secretTabs = new WeakMap();

  function noteSecretFill(browser, kind, frame) {
    if (kind === "password") return;
    if (!secretTabs.has(browser)) secretTabs.set(browser, new Set());
    secretTabs.get(browser).add(frame ? frame.bc : null);
  }

  // "" or the kind of saved secret still showing on screen in this tab
  async function secretOnScreen(browser) {
    const where = browser && secretTabs.get(browser);
    if (!where || !where.size) return "";
    const results = await Promise.all([...where].map((bc) => (bc ? runAgentInFrame(bc, { action: "secretShown" }, 3000) : runAgentInPage(browser, { action: "secretShown" }, 3000)).catch(() => null)));
    const hit = results.find((r) => r && r.shown);
    return hit ? hit.shown : "";
  }

  // The value of a saved secret, read when the action runs (never kept)
  async function secretValue(actor, label) {
    if (!actor.secretAccess) throw new Error("Saved secrets aren't available in this chat.");
    const secret = ((await readSecrets()) || []).find((x) => x.label.toLowerCase() === String(label).trim().toLowerCase());
    if (!secret) throw new Error(`There's no saved secret called “${label}” any more.`);
    return secret;
  }

  async function runBrowserTool(actor, name, a) {
    // Checked again when it runs: the tab may have changed hands since the card
    const rule = actorRule(actor, name, a);
    if (rule) throw new Error(rule);
    // Safety belt: never act without a permission decision that allowed it
    const allowedCount = actor.browser.allowed.get(name) || 0;
    if (allowedCount < 1) throw new Error("This action wasn't approved.");
    actor.browser.allowed.set(name, allowedCount - 1);
    // An agent's first page opens its own background tab, which it then owns
    let fresh = false;
    if (actor.kind === "agent" && !actor.tab()) {
      const url = String(a.url || "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) web addresses can be opened.");
      const tab = openInNewTab(url, { background: true, near: actor.anchorTab(), space: actor.spaceId() });
      tabOwners.set(tab, actor);
      actor.setTab(tab);
      actor.browser.tabs.add(tab);
      fresh = true;
    }
    const browser = agentTab(actor).linkedBrowser;
    overlay.show(actor, true);
    const before = fresh ? "about:blank" : browserInfo(browser).url;
    // Claude's latest screenshot of this tab. Any action may change the page,
    // so points need a screenshot taken since the last one (actions at a
    // point take a new one themselves).
    const shot = actor.browser.shots.get(browser) || null;
    if (name !== "browser_read" && name !== "browser_screenshot") actor.browser.shots.delete(browser);
    const needShot = () => {
      if (!shot) throw new Error(NEED_SHOT);
      return shotArgs(shot);
    };
    // A screenshot Claude can point at: kept with the scroll position and
    // scale, so its points can be found on the page later
    // crop: a close-up of part of the view (cropFor), else all of it
    // record: false for a screenshot Claude doesn't see (keep_only), so its
    // points still refer to the last one it saw; sharp: drawn at 2× for documents
    const takeShot = async (crop = null, { record = true, sharp = false } = {}) => {
      const shown = await secretOnScreen(browser);
      if (shown) throw new Error(`A saved ${shown} that Zen AI filled in is showing on the page, so screenshots are off until it's gone (scrolled out of view, cleared or submitted). Use browser_read instead; points need a screenshot, so use refs.`);
      const view = await runAgentInPage(browser, { action: "viewport" }, 3000);
      const s = await captureVisible(browser, crop, { sharp });
      actor.taint();
      const ok = view && !view.error;
      if (ok && record) actor.browser.shots.set(browser, { ratio: s.ratio, w: s.width, h: s.height, sx: view.sx, sy: view.sy, doc: view.doc, ox: s.ox, oy: s.oy, dataUrl: s.dataUrl });
      return { s, pointable: ok };
    };
    // Every screenshot is kept (memory only) so a document can show it
    const keepShot = (s, label) => {
      try { return actor.browser.images.add("shot", s, label, s.ratio ? s.width / s.ratio : s.width); } catch (e) { return null; }
    };
    // Where a ref (an element, or a frame from another site like f2) is on
    // screen, with a little room around it: brought into view first
    const cropFor = async (ref) => {
      const key = String(ref).trim();
      let rect;
      if (/^f\d+$/.test(key)) {
        const frame = frameByKey(browser, key);
        openFrames(actor, browser).add(key);
        rect = await placeFrame(browser, frame, true);
      } else {
        const info = await describeTab(browser, [key], { focus: true });
        if (!info || info.error) throw new Error((info && info.error) || "The page couldn't be read.");
        const it = info.items[0];
        if (!it || !it.found) throw new Error((it && it.error) || `${key} isn't on the page anymore. Call browser_read again.`);
        rect = it.rect;
      }
      const view = await runAgentInPage(browser, { action: "viewport" }, 3000);
      const vw = (view && view.w) || 0;
      const vh = (view && view.h) || 0;
      const pad = 12;
      const x = Math.max(0, Math.floor(rect.x - pad));
      const y = Math.max(0, Math.floor(rect.y - pad));
      const w = Math.min(vw, Math.ceil(rect.x + rect.w + pad)) - x;
      const h = Math.min(vh, Math.ceil(rect.y + rect.h + pad)) - y;
      if (!(w >= 8 && h >= 8)) throw new Error(`${key} isn't visible on screen. Scroll to it, or take a browser_screenshot without ref.`);
      return { x, y, w, h };
    };
    const run = async (args, ms) => {
      const r = await runAgentInPage(browser, args, ms);
      if (r && r.error) throw new Error(r.error);
      return r;
    };
    // Runs an action where its ref lives: the tab (key "") or a frame from
    // another site (f2.e5 → frame f2, ref e5), whose <iframe> is brought into
    // view first. Resolves { r, frame }.
    const runAt = async (key, args, ms) => {
      if (!key) return { r: await run(args, ms), frame: null };
      const frame = frameByKey(browser, key);
      openFrames(actor, browser).add(key);
      try { await placeFrame(browser, frame, true); } catch (e) {}
      const r = await runAgentInFrame(frame.bc, args, ms);
      if (r && r.error) throw new Error(r.error);
      return { r, frame };
    };
    // The page agent passed the action on (a point or focus in a frame from
    // another site): run it there. fwd(forward) gives the frame's arguments.
    const follow = async (r, fwd, ms) => {
      if (!r || !r.forward) return { r, frame: null };
      const out = await followFrames(browser, r, fwd, ms);
      if (out.frame) openFrames(actor, browser).add(out.frame.key);
      return { r: out.result, frame: out.frame };
    };
    // Where something an action used is, in the tab (for the highlight)
    const tabRect = async (r, frame) => {
      if (!frame || !r || !r.rect) return r && r.rect;
      try { return shiftRect(r.rect, await placeFrame(browser, frame)); } catch (e) { return null; }
    };
    const inKey = (frame) => (frame ? ` in frame ${frame.key}` : "");
    const reply = (text) => [{ type: "text", text }];
    // The page as Claude should see it now: only what changed since its last
    // look at this tab, or everything for a new page. null if it can't be read.
    // Frames from other sites are read along (see snapshotTab).
    const look = async (b, opts = {}) => {
      // An automatic look after an action gives up sooner than an explicit read
      const snap = await snapshotTab(b, { open: openFrames(actor, b), timeoutMs: opts.must ? 15000 : 6000, withText: !!opts.withText });
      if (!snap || snap.error) {
        if (opts.must) throw new Error((snap && snap.error) || "The page couldn't be read.");
        return null;
      }
      const pageText = [opts.pageText, snap.frameText].filter(Boolean).join("\n\n");
      const d = describePage(opts.full ? null : actor.browser.seen.get(b), snap, { full: opts.full, pageText });
      actor.browser.seen.set(b, d.state);
      actor.taint();
      return d.text;
    };
    // An action's result carries the page's changes, so Claude can usually
    // take the next step without a separate browser_read
    // typing: true for actions that only change the page right away (typing, filling)
    // frame: the frame from another site it acted in (it settles too)
    const afterAction = async (what, typing = false, frame = null) => {
      const quiet = frame ? runAgentInFrame(frame.bc, { action: "settle", minMs: typing ? 0 : 350, quietMs: 150, maxMs: 1500 }, 2500) : null;
      const [s] = await Promise.all([settle(browser, before, 5000, false, typing ? 0 : 350), quiet]);
      const where = s.navigated ? ` The page changed to ${s.url} (“${shortTitle(s.title, 80)}”).` : "";
      const page = await look(browser);
      return reply(page ? `${what}${where}\n\nThe page now:\n${page}` : `${what}${where} Call browser_read to see the result before the next step.`);
    };
    // After acting at a point: the page's changes and a new screenshot (to
    // check it worked; later points refer to it)
    const afterPoint = async (what, frame = null) => {
      const out = await afterAction(what, false, frame);
      try {
        const { s } = await takeShot();
        const id = keepShot(s, `the page after ${what.replace(/\.$/, "").slice(0, 60)}`);
        out.push({ type: "image", data: s.base64, mimeType: s.mediaType }, { type: "text", text: `The visible page now, ${s.width}×${s.height} px (untrusted page content${id ? `; image id ${id}` : ""}). Later points refer to this screenshot.` });
      } catch (e) {
        out.push({ type: "text", text: "(A new screenshot couldn't be taken; take one with browser_screenshot before using points again.)" });
      }
      return out;
    };
    const opened = async (b, text) => {
      const page = await look(b);
      return reply(page ? `${text}\n\nThe page:\n${page}` : `${text} Call browser_read before acting.`);
    };
    // Claude works in another open tab from now on (the user sees it, if
    // it's in the Space they're looking at); a tab that wasn't loaded loads now
    const switchTo = async (tab, why = "") => {
      const b = tab.linkedBrowser;
      actor.setTab(tab);
      actor.browser.tabs.add(tab);
      try { if (gBrowser.visibleTabs.includes(tab)) gBrowser.selectedTab = tab; } catch (e) {}
      overlay.place();
      const s = await settle(b, browserInfo(b).url, 8000, false, 0);
      return opened(b, `${why}Switched to the tab “${shortTitle(s.title || tab.label, 80)}” (${s.url}). You're now working in it.`);
    };
    switch (name) {
      case "browser_wait":
        return browserWait(actor, browser, a, look);
      case "browser_organize_tabs": {
        actor.status("Organizing tabs…");
        // Checked again: tabs may have closed or moved since the card
        const ctx = organizeContext(actor);
        const { plan, error } = planSteps(a.steps, ctx);
        if (error) throw new Error(error);
        const done = await runSteps(plan, { space: spaceOf(actor), idOf: tabId, folderId, wasPinned: ctx.wasPinned });
        const folders = folderLines(spaceFolders(spaceOf(actor)), folderId);
        return reply(`${done.join("\n")}${folders.length ? `\n\nFolders in this Space now:\n${folders.join("\n")}` : ""}`);
      }
      case "browser_switch_tab": {
        const tabs = spaceTabs(actor);
        if (!a.tab) {
          actor.line("ok", "Looked at the tabs open in this Space");
          const cur = agentTab(actor);
          const start = actor.startTab();
          const rows = tabs.slice(0, MAX_TAB_LIST).map((t) => {
            const notes = [t === cur ? "you're working here" : "", t === start && t !== cur ? "where the user asked" : "", ...tabPlace(t, folderId), t.hasAttribute("pending") ? "not loaded yet" : ""].filter(Boolean);
            const url = tabUrl(t).replace(/^https?:\/\/(www\.)?/, "").slice(0, 100);
            return `${tabId(t)} “${shortTitle(t.label || "", 80)}” ${url}${notes.length ? " · " + notes.join(", ") : ""}`;
          });
          const more = tabs.length > MAX_TAB_LIST ? `\n…and ${tabs.length - MAX_TAB_LIST} more (not listed)` : "";
          const folders = folderLines(spaceFolders(spaceOf(actor)), folderId);
          const folderText = folders.length ? `\n\nFolders in this Space (organize with browser_organize_tabs):\n${folders.join("\n")}` : "";
          return reply(`Tabs open in this Space (switch with browser_switch_tab and an id):\n${UNTRUSTED_PAGE_NOTE}\n<untrusted_content>\n${sanitizeUntrusted(rows.join("\n") + more + folderText)}\n</untrusted_content>`);
        }
        const tab = tabs.find((t) => tabId(t) === String(a.tab).trim());
        if (!tab) throw new Error(`There's no tab ${a.tab} in this Space. Call browser_switch_tab without tab to list them.`);
        if (tab === agentTab(actor)) return reply(`You're already working in ${a.tab}.`);
        actor.status("Switching tabs…");
        return switchTo(tab);
      }
      case "browser_read": {
        actor.status("Reading the page…");
        if (a.frame) {
          // One frame from another site, in full; from now on it's read along with the tab
          const key = String(a.frame).trim();
          const r = await snapshotFrame(browser, key, { withText: !!a.include_text });
          openFrames(actor, browser).add(key);
          const seen = actor.browser.seen.get(browser);
          if (seen) for (const [ref, line] of r.rows) seen.rows.set(ref, line);
          actor.taint();
          return reply(`${UNTRUSTED_PAGE_NOTE}\n<untrusted_content>\n${sanitizeUntrusted(r.text.slice(0, 60000))}\n</untrusted_content>`);
        }
        const pageText = a.include_text ? await getPageText(browser, 20000) : "";
        return reply(await look(browser, { must: true, full: !!a.full, pageText: pageText || "", withText: !!a.include_text }));
      }
      case "browser_screenshot": {
        actor.status(a.keep_only ? "Taking a screenshot…" : "Looking at the page…");
        const crop = a.ref ? await cropFor(a.ref) : null;
        const { s, pointable } = await takeShot(crop, { record: !a.keep_only, sharp: !!a.keep_only });
        const what = crop ? `A close-up of ${String(a.ref).trim()} on ${before}` : `The visible part of ${before}`;
        const id = keepShot(s, crop ? `close-up of ${String(a.ref).trim()} on ${shortTitle(browserInfo(browser).title || "the page", 50)}` : shortTitle(browserInfo(browser).title || "the page", 60));
        const kept = id ? ` Image id ${id}: ![caption](${id}) on its own line puts it in create_pdf, create_docx or a notebook's Markdown cell.` : "";
        // Kept for a document only: Claude gets the id, not the picture (far cheaper)
        if (a.keep_only) return reply(id ? `${what} is saved for documents as ${id} (${s.width}×${s.height} px; not shown to you).${kept}` : "That screenshot couldn't be kept.");
        return [{ type: "image", data: s.base64, mimeType: s.mediaType }, {
          type: "text",
          text: (pointable
            ? `${what}, ${s.width}×${s.height} px (untrusted page content). For something without a ref, browser_click and browser_drag take points in this image's pixels.`
            : `${what} (untrusted page content).`) + kept,
        }];
      }
      case "browser_scroll": {
        const direction = a.direction === "up" ? "up" : "down";
        const target = a.ref ? splitRef(a.ref) : { frame: "", ref: null };
        let { r, frame } = await runAt(target.frame, { action: "scroll", direction, ref: target.ref });
        if (r.forward) ({ r, frame } = await follow(r, () => ({ action: "scroll", direction, ref: null })));
        // Until lazy-loaded content stops arriving (the old fixed 300 ms if the page can't be watched)
        const calm = { action: "settle", quietMs: 150, maxMs: 1200 };
        const quiet = await (frame ? runAgentInFrame(frame.bc, calm, 2500) : runAgentInPage(browser, calm, 2500));
        if (!quiet || quiet.error) await sleep(300);
        const done = `Scrolled${inKey(frame)}; now ${r.percent}% down the ${frame ? "frame" : "page"}.`;
        const page = await look(browser);
        return reply(page ? `${done}\n\n${page}` : `${done} Call browser_read to see what's there.`);
      }
      case "browser_click": {
        actor.status("Clicking…");
        const at = !a.ref ? pointOf(a.point) : null;
        if (at) {
          const { r, frame } = await follow(await run({ action: "click", at, shot: needShot() }), (fw) => ({ action: "click", at: { x: fw.x, y: fw.y }, local: true }));
          overlay.highlight(actor, await tabRect(r, frame));
          return afterPoint(`Clicked ${r.label ? `“${r.label}”` : r.what}${inKey(frame)} at (${Math.round(at.x)}, ${Math.round(at.y)}) in your screenshot.${r.note ? " " + r.note : ""}`, frame);
        }
        const target = splitRef(a.ref);
        const { r, frame } = await runAt(target.frame, { action: "click", ref: target.ref });
        overlay.highlight(actor, await tabRect(r, frame));
        return afterAction(`Clicked “${r.label}”${inKey(frame)}.${r.note ? " " + r.note : ""}`, false, frame);
      }
      case "browser_type": {
        actor.status("Typing…");
        const target = splitRef(a.ref);
        if (a.secret != null && a.secret !== "") {
          const secret = await secretValue(actor, a.secret);
          const { r, frame } = await runAt(target.frame, { action: "type", ref: target.ref, secret: { value: secret.value, kind: secret.kind } });
          noteSecretFill(browser, secret.kind, frame);
          overlay.highlight(actor, await tabRect(r, frame));
          return afterAction(`Filled the saved “${secret.label}” into “${r.label}”${inKey(frame)}.${r.note ? " " + r.note : ""}`, true, frame);
        }
        const { r, frame } = await runAt(target.frame, { action: "type", ref: target.ref, text: String(a.text == null ? "" : a.text), append: !!a.append });
        overlay.highlight(actor, await tabRect(r, frame));
        return afterAction(`Typed into “${r.label}”${inKey(frame)}.${r.note ? " " + r.note : ""}`, true, frame);
      }
      case "browser_select": {
        const target = splitRef(a.ref);
        const { r, frame } = await runAt(target.frame, { action: "select", ref: target.ref, option: String(a.option == null ? "" : a.option) });
        overlay.highlight(actor, await tabRect(r, frame));
        return afterAction(`Chose “${r.chosen}” in “${r.label}”${inKey(frame)}.`, false, frame);
      }
      case "browser_fill_form": {
        actor.status("Filling the form…");
        // (browserPermission made sure the fields and then_click are in one frame)
        const fields = Array.isArray(a.fields) ? a.fields : [];
        const key = fields.length ? splitRef(fields[0].ref).frame : "";
        // Saved secrets go in by value here, straight to the page (Claude only named them)
        const secrets = [];
        const sent = [];
        for (const f of fields) {
          if (f.secret != null && f.secret !== "") {
            const secret = await secretValue(actor, f.secret);
            secrets.push(secret);
            sent.push({ ref: splitRef(f.ref).ref, secret: { value: secret.value, kind: secret.kind } });
          } else sent.push(Object.assign({}, f, { ref: splitRef(f.ref).ref }));
        }
        const { r, frame } = await runAt(key, { action: "fill", fields: sent }, 30000);
        for (const secret of secrets) noteSecretFill(browser, secret.kind, frame);
        overlay.highlight(actor, await tabRect(r, frame));
        const results = (r.results || []).map((x, i) => Object.assign({}, x, { ref: fields[i] ? fields[i].ref : x.ref }));
        const filled = results.filter((x) => x.status === "filled");
        const failed = results.filter((x) => x.status === "failed");
        if (failed.length) actor.line("denied", `Couldn't fill ${failed.map((x) => (x.label ? `“${x.label}”` : x.ref)).join(", ")}`);
        const lines = results.map((x) => `- ${x.ref}${x.label ? ` “${x.label}”` : ""}: ${x.status}${x.note ? ` (${x.note})` : ""}`);
        // then_click: only once every field is in
        if (a.then_click && filled.length === results.length && results.length) {
          actor.status("Clicking…");
          const c = (await runAt(key, { action: "click", ref: splitRef(a.then_click).ref })).r;
          overlay.highlight(actor, await tabRect(c, frame));
          return afterAction(`Filled ${filled.length} of ${results.length} fields${inKey(frame)}, then clicked “${c.label}”.${c.note ? " " + c.note : ""}\n${lines.join("\n")}\n`, false, frame);
        }
        const held = a.then_click ? `\nDidn't click ${a.then_click}: not every field was filled.` : "";
        return afterAction(`Filled ${filled.length} of ${results.length} fields${inKey(frame)}. Nothing was submitted.${held}\n${lines.join("\n")}\n`, true, frame);
      }
      case "browser_drag": {
        actor.status("Dragging…");
        // Either end can be a point in Claude's screenshot
        const fromAt = !a.from ? pointOf(a.from_point) : null;
        const toAt = !a.to ? pointOf(a.to_point) : null;
        const xy = (p) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
        const from = a.from ? splitRef(a.from) : null;
        const to = a.to ? splitRef(a.to) : null;
        const key = (from && from.frame) || (to && to.frame) || "";
        const position = a.position || "onto";
        let { r, frame } = await runAt(key, {
          action: "drag", from: from ? from.ref : null, to: to ? to.ref : null, fromAt, toAt,
          shot: fromAt || toAt ? needShot() : null, position, by: a.by || null,
        }, 20000);
        // Points in a frame from another site: that frame drags
        if (r.forward) ({ r, frame } = await follow(r, (fw) => ({ action: "drag", fromAt: fw.fromAt, toAt: fw.toAt, by: fw.by, local: true, position }), 20000));
        overlay.highlight(actor, await tabRect(r, frame));
        const what = fromAt ? `${r.label ? `“${r.label}”` : r.what} from ${xy(fromAt)}` : `“${r.label}”`;
        const where = toAt ? ` to ${xy(toAt)}${r.to ? `, on “${r.to}”` : ""}` : r.to ? ` ${dropWord(a.position)} “${r.to}”` : ` by ${offsetText(a.by)}`;
        const text = `Dragged ${what}${where}${inKey(frame)}.${r.note ? " " + r.note : ""}`;
        return fromAt || toAt ? afterPoint(text, frame) : afterAction(text, false, frame);
      }
      case "browser_press_key": {
        const keyName = String(a.key || "");
        const target = a.ref ? splitRef(a.ref) : { frame: "", ref: null };
        let { r, frame } = await runAt(target.frame, { action: "key", key: keyName, ref: target.ref });
        // Focus is in a frame from another site: the key goes there
        if (r.forward) ({ r, frame } = await follow(r, () => ({ action: "key", key: keyName, ref: null })));
        return afterAction(`Pressed ${a.key} in ${r.target === "the page" ? `the ${frame ? "frame" : "page"}` : `“${r.target}”`}${inKey(frame)}.`, false, frame);
      }
      case "browser_navigate": {
        const url = String(a.url || "").trim();
        if (fresh) {
          actor.status("Opening the page…");
          const s = await settle(browser, "about:blank", 15000, true);
          return opened(browser, `Opened ${s.url} (“${shortTitle(s.title, 80)}”) in your own new background tab. You work only in this tab; the user's tabs are untouched.`);
        }
        const back = url.toLowerCase() === "back";
        if (!back && !/^https?:\/\//i.test(url)) throw new Error("Only http(s) web addresses can be opened.");
        actor.status("Opening the page…");
        if (back) {
          browser.goBack();
          const s = await settle(browser, before, 12000);
          return opened(browser, `Went back to ${s.url} (“${shortTitle(s.title, 80)}”).`);
        }
        // Open already in another tab: go there instead of opening it again
        const open = a.tab === "new" || a.tab === "current" ? null : tabWith(actor, url);
        if (open) return switchTo(open, "That page was already open, so nothing new was opened. ");
        if (navigateWhere(a, before) === "new") {
          const tab = openInNewTab(url);
          actor.browser.tabs.add(tab);
          actor.setTab(tab); // the AI keeps working in the new tab
          overlay.place();
          const s = await settle(tab.linkedBrowser, "about:blank", 15000, true);
          return opened(tab.linkedBrowser, `Opened ${s.url} (“${shortTitle(s.title, 80)}”) in a new tab; the user's previous tab is untouched. You're now working in the new tab.`);
        }
        loadUrl(browser, url);
        const s = await settle(browser, before, 12000, true);
        return opened(browser, `Now on ${s.url} (“${shortTitle(s.title, 80)}”) in the same tab.`);
      }
      default:
        throw new Error(`Unknown browser tool ${name}`);
    }
  }

  // 3:05
  const clockText = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

  function videoText(v) {
    if (!v) return "";
    if (v.ended) return `the video has ended${v.duration ? ` (${clockText(v.duration)})` : ""}`;
    if (!v.duration && !v.time && v.paused) return "the video hasn't started";
    return `the video is at ${clockText(v.time)}${v.duration ? ` of ${clockText(v.duration)}` : ""}, ${v.paused ? "paused" : "playing"}`;
  }

  // browser_wait: waits until the time is up, a condition is met, the user
  // ends it, or the reply stops. It only reads the page (every 2 s); the wait
  // shows in the chat with a countdown and "Stop waiting".
  async function browserWait(actor, browser, a, look) {
    const token = actor.token();
    const max = clamp(Math.round(Number(a.seconds) || 0), 1, WAIT_MAX_SECONDS);
    const reason = shortTitle(String(a.reason || "").trim(), 80);
    const want = {
      text: String(a.until_text || "").trim(),
      gone: String(a.until_text_gone || "").trim(),
      ref: String(a.until_changed || "").trim(),
      video: !!a.until_video_ends,
    };
    // (the tab and its frames from other sites: an embedded video player is often in one)
    const check = () => watchTab(browser, { text: want.text, gone: want.gone, ref: want.ref });
    const first = await check();
    if (first.error) throw new Error(first.error);
    if (want.ref && first.ref === null) throw new Error(`${want.ref} isn't on the page anymore. Call browser_read for fresh refs.`);
    if (want.video && !first.video && !want.text && !want.gone && !want.ref) {
      return [{ type: "text", text: "There's no video on this page or in its frames that can be watched. Wait with seconds instead, or until_text if the page shows when it's done." }];
    }
    // What counts as done (checked every poll, and once up front)
    const met = (r) => {
      if (want.text && r.text) return `“${shortTitle(want.text, 40)}” is on the page`;
      if (want.gone && r.gone) return `“${shortTitle(want.gone, 40)}” is gone from the page`;
      if (want.ref && r.ref !== first.ref) return r.ref === null ? `${want.ref} is gone from the page` : `${want.ref} changed`;
      if (want.video && r.video && r.video.ended) return "the video ended";
      return "";
    };
    const already = met(first);
    if (already) return [{ type: "text", text: `No need to wait: ${already} already.${first.video ? ` Right now ${videoText(first.video)}.` : ""}` }];

    // In the chat: what Claude waits for, a countdown, and a way to end it
    const start = Date.now();
    let ended = false; // by the user
    const label = `Waiting${reason ? " " + reason : ""}`;
    const left = h("span", { class: "zai-wait-left" });
    const line = h("div", { class: "zai-toolline zai-waiting", role: "status" },
      icon("clock", 14, 2.2),
      h("span", { class: "zai-wait-what", text: label, title: label }),
      left,
      h("button", { class: "zai-wait-stop", onclick: () => (ended = true) }, "Stop waiting")
    );
    const block = { type: "line", kind: "ok", text: "", pending: true }; // saved once it's over
    const tick = () => (left.textContent = `${clockText(Math.max(0, max - (Date.now() - start) / 1000))} left`);
    tick();
    actor.clearStatus();
    actor.place(line, block);
    actor.browser.waiting = true;
    overlay.place();
    const timer = setInterval(tick, 1000);

    let outcome = "";
    let last = first;
    let tabGone = false;
    try {
      while (!outcome) {
        // Sleep until the next check, waking for Stop or "Stop waiting"
        const next = Math.min(start + max * 1000, Date.now() + WAIT_POLL_MS);
        while (Date.now() < next && !ended && actor.token() === token) await sleep(Math.min(250, next - Date.now()));
        if (actor.token() !== token) { outcome = "stopped"; break; }
        if (ended) { outcome = "you ended the wait"; break; }
        try { agentTab(actor); } catch (e) { tabGone = true; outcome = "the tab was closed"; break; }
        const r = await check();
        if (!r.error) {
          last = r;
          outcome = met(r);
        }
        if (!outcome && Date.now() - start >= max * 1000 - 50) outcome = "time's up";
      }
    } finally {
      clearInterval(timer);
      actor.browser.waiting = false;
      overlay.place();
    }
    const took = clockText((Date.now() - start) / 1000);
    const endText = `Waited ${took}${reason ? " " + reason : ""} · ${outcome}`;
    Object.assign(block, { kind: "ok", text: endText, pending: false });
    line.replaceWith(toolLine("ok", endText));
    if (outcome === "stopped") return [{ type: "text", text: "The user stopped the reply." }];
    if (actor.live()) actor.status("Working…");

    const video = last.video ? ` Right now ${videoText(last.video)}.` : "";
    let text;
    if (outcome === "the tab was closed") text = `The tab was closed after ${took} of waiting.`;
    else if (outcome === "you ended the wait") text = `The user ended the wait after ${took} (of up to ${clockText(max)}); they may want you to check now.${video}`;
    else if (outcome === "time's up") {
      const notYet = [want.text && `“${want.text}” isn't on the page yet`, want.gone && `“${want.gone}” is still there`, want.ref && `${want.ref} hasn't changed`, want.video && "the video hasn't ended"].filter(Boolean);
      text = `Waited the full ${took}.${notYet.length ? " " + notYet.join("; ") + "." : ""}${video} Call browser_wait again to keep waiting.`;
    } else text = `After ${took}: ${outcome}.${video}`;
    if (tabGone) return [{ type: "text", text }];
    // The page as it is now (only what changed since Claude's last look)
    const page = await look(browser).catch(() => null);
    return [{ type: "text", text: page ? `${text}\n\nThe page now:\n${page}` : text }];
  }

  async function browserToolHook(actor, name, args) {
    try {
      return await runBrowserTool(actor, name, args);
    } catch (e) {
      if (actor.live() && !QUIET_BROWSER_TOOLS.has(name)) actor.line("denied", `Couldn't do that: ${(e && e.message) || e}`);
      throw e;
    }
  }

  return {
    permission: browserPermission,
    run: browserToolHook,
    forgetPages,
    releaseTabs,
    setAllowAll,
    // The capture button: null when no saved secret was filled in this tab,
    // else a promise of the kind still showing ("" if none)
    secretShowing: (browser) => (secretTabs.has(browser) ? secretOnScreen(browser) : null),
  };
}
