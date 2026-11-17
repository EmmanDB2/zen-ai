import { AGENT_MAX_PER_SKILL, AUTOCOMPACT_CHOICES, BLUR_MODES, CLAUDE_DEFAULT_PATH, GLASS_DEFAULTS, HOTKEY, HTML_NS, MOD_VERSION, UPDATER_RULES_FILE, UPDATE_DEFAULTS, agentsOn, autocompactSetting, lessonsNote, newInfoNote, prefs } from "./config.mjs";
import { EFFORTS, FALLBACK_MODELS, clamp, modelInfo } from "./dom.mjs";
import { ABOUT_ME_FILE, ensureDefaultSkills, revealBackups, revealSkillsFolder, skillsDir } from "./skills.mjs";
import { backupsToKeep, updaterEffort, updaterModel, updaterRules, updatesOn } from "./skill-updates.mjs";
import { RESUME_MINUTES, chatsDir } from "./chats.mjs";
import { checkClaude, findClaude } from "./session.mjs";
import { AGY_DEFAULT_PATH, AGY_VERIFIED_VERSION, checkAgy, findAgy } from "./antigravity.mjs";
import { PROVIDERS, defaultProvider } from "./providers.mjs";

// ---------------------------------------------------------------------------
// Settings: a "Zen AI" pane in Zen's own settings (about:preferences#zenAI),
// built like Zen's panes (a nav button, register_module, groupboxes that
// carry data-category). The browser window builds it into each settings page
// as it loads in one of its tabs (watchSettingsPages), before the page sets
// itself up, so a link to #zenAI opens on it. (fx-autoconfig only injects
// into such pages with a global pref; this needs none.) Each control writes
// its zenai.* pref; the chat windows pick changes up (the look at once, the
// rest the next time they're used).
// ---------------------------------------------------------------------------
export const SETTINGS_PANE = "paneZenAI";
export const SETTINGS_URL = "about:preferences#zenAI";
const BLUR_CHOICES = [
  ["snapshot", "Frosted glass: a blurred copy of the page behind"],
  ["native", "Zen's acrylic blur"],
  ["none", "Solid"],
];
// The nav button's icon: a sparkle, filled in the nav's own colour (context-fill)
const NAV_ICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="context-fill"><path d="M7 1.5c.5 3.6 1.9 5 5.5 5.5-3.6.5-5 1.9-5.5 5.5-.5-3.6-1.9-5-5.5-5.5 3.6-.5 5-1.9 5.5-5.5z"/><path d="M12.75 10.5c.2 1.4.85 2.05 2.25 2.25-1.4.2-2.05.85-2.25 2.25-.2-1.4-.85-2.05-2.25-2.25 1.4-.2 2.05-.85 2.25-2.25z"/></svg>');
const SETTINGS_CSS = `
#zenAiClaudePath, #zenAiAgyPath { flex: 1; min-width: 12em; font-family: monospace; }
.zai-set-row { margin-block: 6px; gap: 8px; }
.zai-set-row > label:first-child { min-width: 9em; }
.zai-set-status { margin-block: 4px 0; }
.zai-set-status.zai-ok { color: var(--text-color-success, #2a8f3b); }
.zai-set-status.zai-bad { color: var(--text-color-error, #d70022); }
.zai-set-range { width: 16em; }
.zai-set-value { min-width: 3.5em; font-variant-numeric: tabular-nums; }
#zenAiResumeMinutes, #zenAiBackups { width: 5em; }
.zai-set-added { margin-block: 6px; }
.zai-set-added > summary { cursor: pointer; }
.zai-set-added > pre { white-space: pre-wrap; font-size: 0.9em; margin: 6px 0 0; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, currentColor 6%, transparent); }
`;

const isSettingsPage = (doc) => !!doc && /^about:(preferences|settings)\b/.test(String(doc.documentURI));

// Builds the pane into each settings page that loads in this browser window
// (DOMContentLoaded from a tab's page reaches the window first), and into any
// open already. Returns a function that stops watching.
export function watchSettingsPages(win) {
  const loaded = (e) => {
    if (isSettingsPage(e.target)) {
      try { initSettingsPane(e.target); } catch (err) { console.error("[Zen AI] Couldn't add the settings pane:", err); }
    }
  };
  win.addEventListener("DOMContentLoaded", loaded, true);
  for (const b of win.gBrowser.browsers || []) {
    try { if (!b.isRemoteBrowser && isSettingsPage(b.contentDocument)) initSettingsPane(b.contentDocument); } catch (e) {}
  }
  return () => win.removeEventListener("DOMContentLoaded", loaded, true);
}

// Builds the pane in an about:preferences document; false if it isn't one
// (or the pane is there already)
export function initSettingsPane(doc) {
  const page = doc.defaultView;
  const nav = doc.getElementById("categories");
  const main = doc.getElementById("mainPrefPane");
  if (!page || !nav || !main || typeof page.register_module !== "function" || doc.getElementById("category-zen-ai")) return false;
  page.windowUtils.loadSheetUsingURIString("data:text/css;charset=utf-8," + encodeURIComponent(SETTINGS_CSS), page.windowUtils.AUTHOR_SHEET);
  // HTML elements of that page
  const h = (tag, props = {}, ...kids) => {
    const el = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") el.textContent = v;
      else if (v != null) el.setAttribute(k, v);
    }
    el.append(...kids.filter((k) => k != null));
    return el;
  };

  // The nav button, after Zen's own panes
  const button = doc.createElementNS(HTML_NS, "moz-page-nav-button");
  Object.entries({ id: "category-zen-ai", view: SETTINGS_PANE, iconsrc: NAV_ICON }).forEach(([k, v]) => button.setAttribute(k, v));
  button.textContent = "Zen AI";
  const zenLast = doc.getElementById("category-zen-marketplace");
  if (zenLast) zenLast.after(button);
  else nav.prepend(button);

  // XUL elements, like Zen's panes (they get its styles)
  const xul = (tag, attrs = {}, ...kids) => {
    const el = doc.createXULElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
    el.append(...kids.filter((k) => k != null));
    return el;
  };
  const inPane = (el) => {
    el.setAttribute("data-category", SETTINGS_PANE);
    el.hidden = true;
    main.append(el);
    return el;
  };
  const describe = (text, attrs = {}) => xul("description", { class: "description-deemphasized", ...attrs }, text);
  const group = (id, title, about, ...rows) => inPane(xul("groupbox", { id, class: "highlighting-group" }, xul("label", {}, h("h2", { text: title })), about ? describe(about) : null, ...rows));
  const row = (...kids) => xul("hbox", { align: "center", class: "zai-set-row" }, ...kids);
  const btn = (label, onCommand, id) => {
    const b = xul("button", { label, id });
    b.addEventListener("command", onCommand);
    return b;
  };

  inPane(xul("hbox", { id: "zenAiCategory", class: "subcategory" }, h("h1", { text: "Zen AI" })));

  const providerChoice = xul("radiogroup", { id: "zenAiProvider", orient: "horizontal", "aria-label": "Default provider for new chats" },
    ...PROVIDERS.map((p) => xul("radio", { label: p.label, value: p.id })));
  providerChoice.addEventListener("command", () => { if (PROVIDERS.some((p) => p.id === providerChoice.value)) prefs.set("provider", providerChoice.value); });
  group("zenAiProvidersGroup", "Providers", "Choose the provider for new chats. Existing chats keep their provider and conversation history.",
    row(xul("label", { control: "zenAiProvider" }, "New chats"), providerChoice));

  // --- Claude Code ---
  const path = h("input", { type: "text", id: "zenAiClaudePath", spellcheck: "false", "aria-label": "Where Claude Code is" });
  const status = describe("", { id: "zenAiClaudeStatus", class: "description-deemphasized zai-set-status" });
  const say = (text, kind = "") => {
    status.textContent = text;
    status.classList.toggle("zai-ok", kind === "ok");
    status.classList.toggle("zai-bad", kind === "bad");
  };
  const check = async () => {
    const p = path.value.trim();
    say("Checking…");
    const r = await checkClaude(p);
    if (path.value.trim() !== p) return; // changed meanwhile
    if (r.ok) say(`Found Claude Code ${r.version}.`, "ok");
    else say(`${r.why} In Terminal, run “which claude” and paste what it prints here, or try Find it.`, "bad");
  };
  const save = () => {
    const p = path.value.trim();
    if (p) prefs.set("claudePath", p);
    else Services.prefs.clearUserPref("zenai.claudePath");
    check();
  };
  path.addEventListener("change", save);
  // Compacting earlier: every request re-reads the chat, so a long skill run
  // with a smaller history uses much less of the plan
  const compact = xul("menulist", { id: "zenAiAutocompact" }, xul("menupopup", {}, ...AUTOCOMPACT_CHOICES.map(([value, label]) => xul("menuitem", { value, label }))));
  compact.addEventListener("command", () => prefs.set("autocompact", compact.value));
  group("zenAiClaudeGroup", "Claude Code",
    "Zen AI chats through Claude Code on this Mac, signed in with your Claude account: it uses your plan, with no API key. A new path is used the next time a chat starts.",
    row(
      xul("label", { control: "zenAiClaudePath" }, "Where it is"),
      path,
      btn("Check", check, "zenAiClaudeCheck"),
      btn("Find it", async () => {
        say("Looking…");
        const found = await findClaude();
        if (!found) return say("Couldn't find it in the usual places. In Terminal, run “which claude” and paste what it prints here.", "bad");
        path.value = found;
        save();
      }, "zenAiClaudeFind"),
    ),
    status,
    row(xul("label", { control: "zenAiAutocompact" }, "Summarize a chat's history at"), compact),
    describe("Every step of a reply re-reads the whole chat, so a long skill run (like filling a multi-page form) gets more expensive as it goes. Summarizing earlier keeps it light; very old details may be summarized away. Takes effect the next time a chat starts Claude Code (2.1.221 or newer)."),
  );

  const agyPath = h("input", { type: "text", id: "zenAiAgyPath", spellcheck: "false", "aria-label": "Where Antigravity is" });
  const agyStatus = describe("", { id: "zenAiAgyStatus", class: "description-deemphasized zai-set-status" });
  const sayAgy = (text, ok = false) => { agyStatus.textContent = text; agyStatus.classList.toggle("zai-ok", ok); agyStatus.classList.toggle("zai-bad", !ok); };
  const checkAgyPath = async () => {
    const value = agyPath.value.trim();
    agyStatus.textContent = "Checking…";
    const result = await checkAgy(value);
    if (agyPath.value.trim() !== value) return;
    sayAgy(result.ok ? `Found Antigravity ${result.version}.` : result.why, result.ok);
  };
  const saveAgy = () => {
    const value = agyPath.value.trim();
    if (value) prefs.set("agyPath", value); else Services.prefs.clearUserPref("zenai.agyPath");
    checkAgyPath();
  };
  agyPath.addEventListener("change", saveAgy);
  group("zenAiAgyGroup", "Antigravity",
    `Uses the models available through your Antigravity account; sign in by running agy in Terminal. This build supports CLI ${AGY_VERIFIED_VERSION}. Built-in search, browser, scheduling and subagents are disabled; web access uses Zen AI's browser tools and approvals.`,
    row(xul("label", { control: "zenAiAgyPath" }, "Where it is"), agyPath,
      btn("Check", checkAgyPath, "zenAiAgyCheck"),
      btn("Find it", async () => {
        agyStatus.textContent = "Looking…";
        const found = await findAgy();
        if (!found) return sayAgy(`Couldn't find a supported Antigravity CLI. In Terminal, run “which agy” and paste its location here.`);
        agyPath.value = found; saveAgy();
      }, "zenAiAgyFind")), agyStatus);

  // --- The look of the chat window ---
  const blur = xul("menulist", { id: "zenAiBlur" }, xul("menupopup", {}, ...BLUR_CHOICES.map(([value, label]) => xul("menuitem", { value, label }))));
  blur.addEventListener("command", () => prefs.set("blur", blur.value));
  const slider = (id, name, max, fallback, unit) => {
    const input = h("input", { type: "range", id, class: "zai-set-range", min: "0", max: String(max), step: "1" });
    const shown = h("span", { class: "zai-set-value" });
    const show = () => (shown.textContent = input.value + unit);
    input.addEventListener("input", () => { show(); prefs.set(name, input.value); });
    return { input, shown, load: () => { const n = parseFloat(prefs.get(name, String(fallback))); input.value = String(Number.isFinite(n) ? clamp(n, 0, max) : fallback); show(); } };
  };
  const tint = slider("zenAiTint", "glass.tint", 100, GLASS_DEFAULTS.tint, "%");
  const blurPx = slider("zenAiBlurAmount", "glass.blur", 60, GLASS_DEFAULTS.blur, " px");
  group("zenAiLookGroup", "Look", "How the floating chat window looks over the page. Changes show right away.",
    row(xul("label", { control: "zenAiBlur" }, "Background"), blur),
    row(xul("label", { control: "zenAiTint" }, "Glass tint"), tint.input, tint.shown),
    row(xul("label", { control: "zenAiBlurAmount" }, "Blur"), blurPx.input, blurPx.shown),
    row(btn("Reset to defaults", () => {
      for (const p of ["blur", "glass.tint", "glass.blur"]) Services.prefs.clearUserPref("zenai." + p);
      load();
    }, "zenAiLookReset")),
  );

  // --- Chats ---
  const minutes = h("input", { type: "number", id: "zenAiResumeMinutes", min: "0", max: "1440", step: "5" });
  minutes.addEventListener("change", () => {
    const n = clamp(Math.round(Number(minutes.value) || 0), 0, 1440);
    minutes.value = String(n);
    prefs.set("resumeMinutes", n);
  });
  group("zenAiChatsGroup", "Chats", "Chats are saved per Space in your Zen profile (never in private windows).",
    row(xul("label", { control: "zenAiResumeMinutes" }, "Pick up the last chat if you come back within"), minutes, xul("label", {}, "minutes")),
    describe("After that, opening Zen AI starts a new chat (the last one stays in History). 0 always starts a new one."),
    row(btn("Show chats in Finder", async () => {
      const dir = chatsDir();
      await IOUtils.makeDirectory(dir, { ignoreExisting: true }).catch(() => {});
      reveal(dir);
    }, "zenAiShowChats")),
  );

  // --- Skills ---
  // Exactly what Zen AI adds after a skill's own text, so none of it is hidden
  const added = (id, summary, text) => h("details", { id, class: "zai-set-added" }, h("summary", {}, summary), h("pre", {}, text));
  group("zenAiSkillsGroup", "Skills",
    "Skills are the / commands in the chat: each one is a Markdown file in your skills folder, and folders group them. A skill's header can list data files under access: (e.g. “- about-me” for _about-me.md), which Claude gets when it runs, and other skills (“- solve”, or “- /solve” if a data file has that name too), which it can read when it needs them. “lessons: true” asks for a Lessons section at the end of a run.",
    row(
      btn("Open skills folder", async () => { await ensureDefaultSkills().catch(() => {}); revealSkillsFolder(); }, "zenAiOpenSkills"),
      btn("Show “About me” file", async () => { await ensureDefaultSkills().catch(() => {}); reveal(PathUtils.join(skillsDir(), ABOUT_ME_FILE)); }, "zenAiAboutMe"),
    ),
    added("zenAiLessonsText", "What Zen AI adds for “lessons: true”", lessonsNote("<skill>", "<the skill's “## Lessons (notes for this skill)” lines, if any>", ["<other skills it lists under access:, if any>"])),
    added("zenAiNewInfoText", "What Zen AI adds for each file under access:", newInfoNote("_<file>.md")),
  );

  // --- Helper agents (agents: N in a skill's header) ---
  const agentsBox = xul("checkbox", { id: "zenAiAgents", label: "Let skills that allow it run helper agents" });
  agentsBox.addEventListener("command", () => prefs.set("agents.enabled", agentsBox.checked ? "true" : "false"));
  group("zenAiAgentsGroup", "Helper agents",
    `A skill with “agents: 1” or “agents: 2” in its header may hand independent parts of its task to helper agents, shown as small boxes in the reply. Each agent is a separate session of the chat's own provider and model, so it uses your plan's limits like any message; up to ${AGENT_MAX_PER_SKILL} work at once (4 across all windows). An agent sees only its task and the context it's given, can't use commands, files or web search, and works in its own background tab only if the skill's AI gives it the browser; every action still asks you. Stop stops them all.`,
    row(agentsBox),
  );

  // --- Skill updates: merging a run's Lessons / New info, always reviewed ---
  const offer = xul("checkbox", { id: "zenAiUpdatesOffer", label: "Offer to update a skill after a run that ends with Lessons or New info" });
  offer.addEventListener("command", () => prefs.set("updates.offer", offer.checked ? "true" : "false"));
  const accountModels = () => { try { const m = JSON.parse(prefs.get("models", "")); return Array.isArray(m) && m.length ? m : FALLBACK_MODELS; } catch (e) { return FALLBACK_MODELS; } };
  const model = xul("menulist", { id: "zenAiUpdaterModel" }, xul("menupopup", {}));
  model.addEventListener("command", () => prefs.set("updates.model", model.value));
  const effort = xul("menulist", { id: "zenAiUpdaterEffort" }, xul("menupopup", {}, ...Object.entries(EFFORTS).map(([value, e]) => xul("menuitem", { value, label: e.title }))));
  effort.addEventListener("command", () => prefs.set("updates.effort", effort.value));
  const backups = h("input", { type: "number", id: "zenAiBackups", min: "1", max: "50", step: "1" });
  backups.addEventListener("change", () => {
    const v = backups.value.trim() === "" ? NaN : Number(backups.value);
    const n = clamp(Math.round(Number.isFinite(v) ? v : UPDATE_DEFAULTS.backups), 1, 50);
    backups.value = String(n);
    prefs.set("updates.backups", n);
  });
  group("zenAiUpdatesGroup", "Skill updates",
    "When a skill run ends with a Lessons or New info section, Zen AI can merge it into the file for you. You always see the changes first; nothing is saved without your click, and the old version is kept as a backup.",
    row(offer),
    row(xul("label", { control: "zenAiUpdaterModel" }, "Model for updates"), model),
    row(xul("label", { control: "zenAiUpdaterEffort" }, "Effort"), effort),
    row(xul("label", { control: "zenAiBackups" }, "Backups to keep per file"), backups),
    row(
      btn("Edit update rules", async () => {
        await updaterRules(); // writes the defaults the first time
        const path = PathUtils.join(skillsDir(), UPDATER_RULES_FILE);
        try {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(path);
          file.launch();
        } catch (e) {
          reveal(path);
        }
      }, "zenAiEditRules"),
      btn("Show backups", () => revealBackups(), "zenAiShowBackups"),
    ),
  );

  // --- Shortcut, version ---
  group("zenAiAboutGroup", "Opening Zen AI", null,
    row(xul("label", {}, `${HOTKEY.label} opens and closes the chat window from any tab.`), btn("Open Zen AI", () => {
      try { page.browsingContext.topChromeWindow.ZenAIChat.open(); } catch (e) {}
    }, "zenAiOpen")),
    describe(`Zen AI ${MOD_VERSION}`, { id: "zenAiVersion" }),
  );

  // Fills every control from the prefs (on first show, and each time it's shown)
  function load() {
    providerChoice.value = defaultProvider();
    agyPath.value = prefs.get("agyPath", AGY_DEFAULT_PATH);
    path.value = prefs.get("claudePath", CLAUDE_DEFAULT_PATH);
    const mode = prefs.get("blur", "snapshot");
    blur.value = BLUR_MODES.includes(mode) ? mode : "snapshot";
    tint.load();
    blurPx.load();
    const n = parseInt(prefs.get("resumeMinutes", String(RESUME_MINUTES)), 10);
    minutes.value = String(Number.isFinite(n) && n >= 0 ? n : RESUME_MINUTES);
    offer.checked = updatesOn();
    agentsBox.checked = agentsOn();
    compact.value = autocompactSetting();
    const models = accountModels();
    const chosen = updaterModel();
    const items = models.map((m) => xul("menuitem", { value: m.value, label: m.value === "default" ? `Default (${modelInfo(m).name})` : modelInfo(m).name }));
    if (!models.some((m) => m.value === chosen)) items.push(xul("menuitem", { value: chosen, label: chosen.charAt(0).toUpperCase() + chosen.slice(1) }));
    model.menupopup.replaceChildren(...items);
    model.value = chosen;
    effort.value = EFFORTS[updaterEffort()] ? updaterEffort() : UPDATE_DEFAULTS.effort;
    backups.value = String(backupsToKeep());
  }
  page.register_module(SETTINGS_PANE, { init() { load(); check(); checkAgyPath(); } });
  doc.addEventListener("paneshown", (e) => { if (e.detail && e.detail.category === SETTINGS_PANE) load(); });
  return true;
}

function reveal(path) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    file.reveal();
  } catch (e) {
    console.error("[Zen AI] Couldn't show it in Finder:", e);
  }
}
