// ---------------------------------------------------------------------------
// Zen's own way of organizing tabs, for the tab list Claude gets and for
// browser_organize_tabs. Folders are Firefox tab groups (<zen-folder>) whose
// tabs are pinned; a new one gets an empty placeholder tab (zen-empty-tab).
// Essentials (zen-essential) belong to every Space, so Claude only reads
// them. Zen's own functions do the work: gZenFolders.createFolder,
// gBrowser.pinTab / unpinTab / ungroupTab / removeTab (unpinning a tab in a
// folder also takes it out), gBrowser.explicitUnloadTabs. Pinned tabs (and
// so every tab in a folder) are never closed: "close" unloads them, the way
// Zen's own close shortcut does, so they stay in the sidebar. Checked in
// real Zen (test/zen/organize.test.mjs).
// ---------------------------------------------------------------------------
export const MAX_ORGANIZE_STEPS = 12;
const STEP_KINDS = ["create_folder", "move_to_folder", "remove_from_folder", "rename_folder", "pin", "unpin", "unload", "close"];

export const isFolder = (g) => !!(g && g.isZenFolder);
export const isEssential = (tab) => tab.hasAttribute("zen-essential");
export const folderOf = (tab) => (isFolder(tab.group) ? tab.group : null);
export const hasFolders = () => typeof gZenFolders !== "undefined" && !!gZenFolders && typeof gZenFolders.createFolder === "function";

// "Research / Papers" for a folder inside another
export function folderPath(folder) {
  const names = [];
  for (let f = folder; f && names.length < 6; f = isFolder(f.group) ? f.group : null) names.unshift(f.label || "Folder");
  return names.join(" / ");
}

// The folder's real tabs (not its empty placeholder)
export const folderTabs = (folder) => (folder.tabs || []).filter((t) => !t.hasAttribute("zen-empty-tab"));

// Folders in a Space (all of them without Spaces)
export function spaceFolders(space) {
  try {
    return [...(gBrowser.tabGroups || [])].filter((g) => isFolder(g) && (!space || !g.getAttribute("zen-workspace-id") || g.getAttribute("zen-workspace-id") === space));
  } catch (e) {
    return [];
  }
}

// What the tab list says about a tab's place: Essential, pinned, folder
export function tabPlace(tab, folderId) {
  if (isEssential(tab)) return ["Essential (in every Space)"];
  const out = [];
  const folder = folderOf(tab);
  if (folder) out.push(`in folder ${folderId(folder)} “${folderPath(folder)}”`);
  else if (tab.pinned) out.push("pinned");
  return out;
}

// One line per folder for the tab list
export function folderLines(folders, folderId) {
  return folders.map((f) => {
    const n = folderTabs(f).length;
    return `${folderId(f)} folder “${folderPath(f)}”: ${n} tab${n === 1 ? "" : "s"}${f.collapsed ? ", collapsed" : ""}`;
  });
}

// Claude's steps → a checked plan, or { error }. ctx: { tabs (this Space's
// tabs Claude may use), folders, tabById(id), folderById(id), working (the
// tab Claude works in, wasPinned (tabs Claude unpinned in this chat: they
// still count as pinned, so unpinning can't be a way around unloading) }.
// Each planned step: { do, tabs, folder, name }; "close" also splits its
// tabs into close and unload (pinned ones, unless pinned: true, which the
// user confirms on a card), and closePinned (the pinned ones it closes).
export function planSteps(steps, ctx) {
  if (!Array.isArray(steps) || !steps.length) return { error: "Give at least one step." };
  if (steps.length > MAX_ORGANIZE_STEPS) return { error: `At most ${MAX_ORGANIZE_STEPS} steps at a time.` };
  const plan = [];
  for (const [i, s] of steps.entries()) {
    const n = `Step ${i + 1}`;
    const kind = s && String(s.do || "");
    if (!STEP_KINDS.includes(kind)) return { error: `${n}: “do” has to be one of ${STEP_KINDS.join(", ")}.` };
    const needsFolder = kind === "move_to_folder" || kind === "rename_folder";
    const needsTabs = kind !== "rename_folder";
    if ((kind === "create_folder" || needsFolder) && !hasFolders()) return { error: "Folders aren't available in this browser." };
    const tabs = [];
    if (needsTabs) {
      const ids = Array.isArray(s.tabs) ? s.tabs.map(String) : [];
      if (!ids.length) return { error: `${n}: list the tabs (ids from browser_switch_tab).` };
      for (const id of ids) {
        const tab = ctx.tabById(id.trim());
        if (!tab || !ctx.tabs.includes(tab)) return { error: `${n}: there's no tab ${id} in this Space. Call browser_switch_tab to list them.` };
        if (isEssential(tab)) return { error: `${n}: ${id} is an Essential, shared by every Space, so it's left as it is.` };
        if ((kind === "close" || kind === "unload") && tab === ctx.working) return { error: `${n}: ${id} is the tab you're working in; switch to another tab before ${kind === "close" ? "closing" : "unloading"} it.` };
        // Unloading the tab on screen would switch the user away from it
        if ((kind === "unload" || (kind === "close" && tab.pinned && s.pinned !== true)) && tab.selected) return { error: `${n}: ${id} is the tab the user is looking at, so it isn't unloaded.` };
        if (!tabs.includes(tab)) tabs.push(tab);
      }
    }
    let folder = null;
    if (needsFolder) {
      folder = ctx.folderById(String(s.folder || "").trim());
      if (!folder || !ctx.folders.includes(folder)) return { error: `${n}: there's no folder ${s.folder || "(none given)"} in this Space. browser_switch_tab lists them.` };
    }
    let name = "";
    if (kind === "create_folder" || kind === "rename_folder") {
      name = String(s.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!name) return { error: `${n}: give the folder a name.` };
    }
    if (kind === "remove_from_folder") {
      const loose = tabs.find((t) => !folderOf(t));
      if (loose) return { error: `${n}: ${ctx.idOf(loose)} isn't in a folder.` };
    }
    const step = { do: kind, tabs, folder, name };
    if (s.pinned === true && kind !== "close") return { error: `${n}: pinned: true only goes with close.` };
    if (kind === "close") {
      const pinned = (t) => t.pinned || !!(ctx.wasPinned && ctx.wasPinned.has(t));
      if (s.pinned === true) {
        step.close = tabs;
        step.unload = [];
        step.closePinned = tabs.filter(pinned);
      } else {
        step.close = tabs.filter((t) => !pinned(t));
        step.unload = tabs.filter(pinned);
        step.closePinned = [];
      }
    }
    plan.push(step);
  }
  return { plan };
}

// Unloads tabs (Zen's explicitUnloadTabs, else Firefox's discardBrowser).
// Resolves with the ones that were loaded.
async function unload(tabs) {
  const loaded = tabs.filter((t) => !t.hasAttribute("pending") && !t.selected);
  if (!loaded.length) return [];
  if (typeof gBrowser.explicitUnloadTabs === "function") {
    await gBrowser.explicitUnloadTabs(loaded);
    for (const t of loaded) t.removeAttribute("discarded");
  } else {
    for (const t of loaded) gBrowser.discardBrowser(t);
  }
  return loaded;
}

// Runs a checked plan with Zen's own functions. Returns one line per step.
// wasPinned: tabs it unpins are added (they still count as pinned for closing)
export async function runSteps(plan, { space, idOf, folderId, wasPinned = null }) {
  const done = [];
  const ids = (tabs) => tabs.map(idOf).join(", ");
  const settle = () => new Promise((r) => setTimeout(r, 120));
  for (const s of plan) {
    const live = s.tabs.filter((t) => !t.closing && t.isConnected);
    switch (s.do) {
      case "create_folder": {
        const folder = gZenFolders.createFolder(live, { label: s.name, ...(space ? { workspaceId: space } : {}) });
        await settle();
        done.push(`Created folder ${folderId(folder)} “${s.name}” with ${ids(live)}.`);
        break;
      }
      case "move_to_folder":
        for (const t of live) if (!t.pinned) gBrowser.pinTab(t);
        s.folder.addTabs(live);
        await settle();
        done.push(`Moved ${ids(live)} into ${folderId(s.folder)} “${folderPath(s.folder)}”.`);
        break;
      case "remove_from_folder":
        for (const t of live) if (folderOf(t)) gBrowser.ungroupTab(t);
        await settle();
        done.push(`Took ${ids(live)} out of their folder (still pinned).`);
        break;
      case "rename_folder": {
        const before = folderPath(s.folder);
        s.folder.label = s.name;
        s.folder.dispatchEvent(new CustomEvent("ZenFolderRenamed", { bubbles: true }));
        done.push(`Renamed ${folderId(s.folder)} “${before}” to “${s.name}”.`);
        break;
      }
      case "pin":
        for (const t of live) if (!t.pinned) gBrowser.pinTab(t);
        done.push(`Pinned ${ids(live)}.`);
        break;
      case "unpin":
        for (const t of live) if (t.pinned) { if (wasPinned) wasPinned.add(t); gBrowser.unpinTab(t); }
        done.push(`Unpinned ${ids(live)} (out of any folder too).`);
        break;
      case "unload": {
        const n = await unload(live);
        done.push(n.length ? `Unloaded ${ids(n)} (still in the sidebar).` : `${ids(live)} ${live.length === 1 ? "was" : "were"} already unloaded.`);
        break;
      }
      case "close": {
        // (Split when the plan was made, before any step unpinned anything)
        const isLive = (t) => !t.closing && t.isConnected;
        const closing = s.close.filter(isLive);
        const pinned = s.unload.filter(isLive);
        for (const t of closing) gBrowser.removeTab(t, { animate: false });
        await unload(pinned);
        const closedPinned = s.closePinned.filter((t) => closing.includes(t));
        done.push([
          closing.length ? `Closed ${ids(closing)}${closedPinned.length ? ` (the user confirmed closing the pinned ${ids(closedPinned)})` : ""}.` : "",
          pinned.length ? `Unloaded the pinned ${ids(pinned)} instead of closing them: they stay in the user's sidebar. Don't unpin them or take them out of folders to close them. Ask the user whether they want the pinned tabs closed too; only if they say yes, close them with pinned: true (they confirm on a card).` : "",
        ].filter(Boolean).join(" "));
        break;
      }
    }
  }
  return done;
}
