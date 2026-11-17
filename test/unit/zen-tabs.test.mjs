// Organizing tabs without Zen (src/zen-tabs.mjs): what the tab list says
// about a tab's place, folder lines, and the checks on Claude's steps.
// The steps themselves run in real Zen: test/zen/organize.test.mjs.
import { checker, crash } from "../helpers/common.mjs";
import { folderLines, folderPath, planSteps, tabPlace } from "../../src/zen-tabs.mjs";

const { check, done } = checker();
const folder = (label, parent = null) => ({ isZenFolder: true, label, group: parent, collapsed: false, tabs: [] });
const tab = (id, { pinned = false, essential = false, group = null } = {}) => ({ id, pinned, group, label: id, hasAttribute: (a) => (a === "zen-essential" ? essential : false) });

(async () => {
  globalThis.gZenFolders = { createFolder() {} };
  const research = folder("Research");
  const papers = folder("Papers", research);
  const t1 = tab("t1");
  const t2 = tab("t2", { pinned: true });
  const t3 = tab("t3", { pinned: true, group: papers });
  const t4 = tab("t4", { essential: true, pinned: true });
  papers.tabs = [{ hasAttribute: (a) => a === "zen-empty-tab" }, t3];
  const ids = new Map([[research, "g1"], [papers, "g2"]]);
  const fid = (f) => ids.get(f);

  check("a tab's place: folder (with its parent), pinned, Essential", tabPlace(t3, fid).join() === "in folder g2 “Research / Papers”" && tabPlace(t2, fid).join() === "pinned" && tabPlace(t4, fid).join() === "Essential (in every Space)" && !tabPlace(t1, fid).length);
  check("folder lines count real tabs, not the empty placeholder", folderLines([papers], fid)[0] === "g2 folder “Research / Papers”: 1 tab" && folderPath(papers) === "Research / Papers");

  const ctx = { tabs: [t1, t2, t3, t4], folders: [research, papers], working: t1, idOf: (t) => t.id, tabById: (id) => [t1, t2, t3, t4].find((t) => t.id === id) || null, folderById: (id) => [...ids].find(([, v]) => v === id)?.[0] || null };
  let r = planSteps([{ do: "create_folder", name: "  Errands  ", tabs: ["t2", "t2", "t3"] }, { do: "rename_folder", folder: "g2", name: "Readings" }], ctx);
  check("a good plan: names trimmed, repeated tabs once", !r.error && r.plan[0].name === "Errands" && r.plan[0].tabs.length === 2 && r.plan[1].folder === papers, r.error);
  const err = (steps) => planSteps(steps, ctx).error || "";
  r = planSteps([{ do: "close", tabs: ["t2", "t3"] }], ctx);
  check("close: pinned tabs (and folder tabs) are split off to be unloaded", !r.error && !r.plan[0].close.length && r.plan[0].unload.map((t) => t.id).join() === "t2,t3", r.error);
  r = planSteps([{ do: "unpin", tabs: ["t2"] }, { do: "close", tabs: ["t2"] }], ctx);
  check("unpin then close in one call: still only unloaded (split before anything runs)", !r.error && !r.plan[1].close.length && r.plan[1].unload[0] === t2);
  const was = new WeakSet([t1]);
  r = planSteps([{ do: "close", tabs: ["t1"] }], { ...ctx, working: null, wasPinned: was });
  check("a tab Claude unpinned earlier in the chat still counts as pinned", !r.error && !r.plan[0].close.length && r.plan[0].unload[0] === t1);
  r = planSteps([{ do: "close", tabs: ["t2", "t3"], pinned: true }], ctx);
  check("pinned: true closes pinned tabs (the card asks the user)", !r.error && r.plan[0].close.length === 2 && r.plan[0].closePinned.length === 2 && !r.plan[0].unload.length);
  check("pinned: true only with close", /only goes with close/.test(planSteps([{ do: "unload", tabs: ["t2"], pinned: true }], ctx).error || ""));
  check("unload is a step of its own", !planSteps([{ do: "unload", tabs: ["t2"] }], ctx).error);
  t2.selected = true;
  check("the tab on screen isn't unloaded (it would switch the user away)", /t2 is the tab the user is looking at/.test(planSteps([{ do: "close", tabs: ["t2"] }], ctx).error || ""));
  t2.selected = false;
  check("unknown step kinds", /“do” has to be one of/.test(err([{ do: "delete_everything", tabs: ["t2"] }])));
  check("no tabs given", /list the tabs/.test(err([{ do: "pin" }])));
  check("a tab from elsewhere", /no tab t9 in this Space/.test(err([{ do: "pin", tabs: ["t9"] }])));
  check("Essentials are left alone", /t4 is an Essential/.test(err([{ do: "unpin", tabs: ["t4"] }])));
  check("not closing the working tab", /the tab you're working in/.test(err([{ do: "close", tabs: ["t1"] }])));
  check("a folder needs a name", /give the folder a name/.test(err([{ do: "create_folder", name: " ", tabs: ["t2"] }])));
  check("taking a tab out that isn't in a folder", /t2 isn't in a folder/.test(err([{ do: "remove_from_folder", tabs: ["t2"] }])));
  check("an unknown folder", /no folder g9/.test(err([{ do: "move_to_folder", folder: "g9", tabs: ["t2"] }])));
  check("too many steps", /At most 12 steps/.test(err(Array.from({ length: 13 }, () => ({ do: "pin", tabs: ["t2"] })))));
  delete globalThis.gZenFolders;
  check("without Zen's folders, folder steps are refused", /Folders aren't available/.test(err([{ do: "create_folder", name: "x", tabs: ["t2"] }])) && !err([{ do: "pin", tabs: ["t2"] }]));
  done();
})().catch(crash);
