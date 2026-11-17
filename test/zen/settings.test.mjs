// Zen AI's pane in Zen's settings, in real Zen: the panel's Settings button
// opens about:preferences on it, a link straight to #zenAI does too (the
// pane is there before the page picks one), the nav button sits after Zen's
// own panes, every control writes its zenai.* pref, the chat window's look
// follows at once, the Claude Code check (a stand-in that prints a version,
// a wrong path), and Zen's settings search finds it.
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checker, crash } from "../helpers/common.mjs";
import { realZen, sleep, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen();
  try {
    // A stand-in Claude Code that only knows --version
    const fakeClaude = join(zen.dir, "claude-version");
    writeFileSync(fakeClaude, '#!/bin/sh\necho "2.1.99 (Claude Code)"\n');
    chmodSync(fakeClaude, 0o755);
    await zen.chrome((p) => Services.prefs.setStringPref("zenai.claudePath", p), fakeClaude);
    const fakeAgy = join(zen.dir, "agy-version");
    writeFileSync(fakeAgy, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.5.9"; else echo "Usage: antigravity acp"; fi\n');
    chmodSync(fakeAgy, 0o755);
    await zen.chrome((p) => Services.prefs.setStringPref("zenai.agyPath", p), fakeAgy);

    await zen.open();
    await zen.chrome(() => document.querySelector(".zai-header [aria-label='Settings']").click());
    await zen.until(() => zen.chrome(() => gBrowser.selectedBrowser.currentURI.spec === "about:preferences#zenAI" && !!gBrowser.selectedBrowser.contentDocument.getElementById("zenAiClaudeGroup")), 10000, "the settings tab");
    await sleep(1500); // the Claude Code check runs when the pane is shown
    const page = await zen.chrome(() => {
      const d = gBrowser.selectedBrowser.contentDocument;
      const nav = [...d.querySelectorAll("#categories moz-page-nav-button")].map((b) => b.id).filter(Boolean);
      const shown = [...d.getElementById("mainPrefPane").children].filter((k) => !k.hidden && k.getAttribute("data-category")).map((k) => k.id);
      return {
        nav, shown,
        current: d.getElementById("categories").currentView,
        label: d.getElementById("category-zen-ai").textContent,
        path: d.getElementById("zenAiClaudePath").value,
        status: d.getElementById("zenAiClaudeStatus").textContent,
        blur: d.getElementById("zenAiBlur").value,
        tint: d.getElementById("zenAiTint").value,
        minutes: d.getElementById("zenAiResumeMinutes").value,
        version: d.getElementById("zenAiVersion").textContent,
        h2: [...d.querySelectorAll("[data-category=paneZenAI] h2")].map((x) => x.textContent),
        lessons: (() => { const x = d.getElementById("zenAiLessonsText"); return x ? { open: x.open, summary: x.querySelector("summary").textContent, text: x.querySelector("pre").textContent, visible: x.getBoundingClientRect().height > 0 } : null; })(),
        newInfo: (() => { const x = d.getElementById("zenAiNewInfoText"); return x ? x.querySelector("pre").textContent : ""; })(),
        updates: { offer: d.getElementById("zenAiUpdatesOffer").checked, model: d.getElementById("zenAiUpdaterModel").value, modelLabel: d.getElementById("zenAiUpdaterModel").label, effort: d.getElementById("zenAiUpdaterEffort").value, backups: d.getElementById("zenAiBackups").value },
      };
    });
    check("Settings in the panel opens Zen's settings on the Zen AI pane", page.current === "paneZenAI" && page.shown.join() === "zenAiCategory,zenAiProvidersGroup,zenAiClaudeGroup,zenAiAgyGroup,zenAiLookGroup,zenAiChatsGroup,zenAiSkillsGroup,zenAiAgentsGroup,zenAiUpdatesGroup,zenAiAboutGroup", page);
    check("its nav button, “Zen AI”, comes right after Zen's own panes", page.label === "Zen AI" && page.nav.indexOf("category-zen-ai") === page.nav.indexOf("category-zen-marketplace") + 1, page.nav);
    check("the sections include both providers and the default", page.h2.join(" | ") === "Providers | Claude Code | Antigravity | Look | Chats | Skills | Helper agents | Skill updates | Opening Zen AI", page.h2);
    const providers = await zen.chrome(() => {
      const d = gBrowser.selectedBrowser.contentDocument;
      const choice = d.getElementById("zenAiProvider");
      const before = choice.value;
      choice.value = "antigravity"; choice.dispatchEvent(new Event("command"));
      return { before, after: Services.prefs.getStringPref("zenai.provider"), path: d.getElementById("zenAiAgyPath").value, status: d.getElementById("zenAiAgyStatus").textContent };
    });
    check("Antigravity path is checked and default provider is saved", providers.before === "claude" && providers.after === "antigravity" && providers.path === fakeAgy && providers.status === "Found Antigravity 1.5.9.", providers);
    await zen.chrome(() => Services.prefs.setStringPref("zenai.provider", "claude"));
    check("the fields show the current settings", page.path.endsWith("claude-version") && page.blur === "snapshot" && page.tint === "48" && page.minutes === "60", page);
    check("it checked Claude Code when it opened", page.status === "Found Claude Code 2.1.99.", page.status);
    check("the version shows", page.version === "Zen AI 0.14.0", page.version);
    check("Skills shows exactly what Zen AI adds for lessons: true (folded)", page.lessons && page.lessons.visible && !page.lessons.open && /^What Zen AI adds for “lessons: true”$/.test(page.lessons.summary) && page.lessons.text.includes("`## Lessons for /<skill> (<run name>)`"), page.lessons);
    check("...and for each file under access:", page.newInfo.includes("`## New info for _<file>.md`"), page.newInfo.slice(0, 120));
    check("Skill updates: on, Opus, high effort, 3 backups by default", page.updates.offer === true && page.updates.model === "opus" && /^Opus/.test(page.updates.modelLabel) && page.updates.effort === "high" && page.updates.backups === "3", page.updates);
    // Changing them writes the prefs
    const upd = await zen.chrome(async () => {
      const d = gBrowser.selectedBrowser.contentDocument;
      const offer = d.getElementById("zenAiUpdatesOffer");
      offer.click();
      const model = d.getElementById("zenAiUpdaterModel");
      const sonnet = [...model.menupopup.children].find((i) => i.value === "sonnet");
      model.selectedItem = sonnet;
      model.dispatchEvent(new Event("command"));
      const effort = d.getElementById("zenAiUpdaterEffort");
      effort.selectedItem = [...effort.menupopup.children].find((i) => i.value === "medium");
      effort.dispatchEvent(new Event("command"));
      const b = d.getElementById("zenAiBackups");
      b.value = "0";
      b.dispatchEvent(new Event("change"));
      const read = (n) => Services.prefs.getStringPref("zenai." + n, "");
      const out = { offer: read("updates.offer"), model: read("updates.model"), effort: read("updates.effort"), backups: read("updates.backups"), field: b.value };
      for (const n of ["updates.offer", "updates.model", "updates.effort", "updates.backups"]) Services.prefs.clearUserPref("zenai." + n);
      return out;
    });
    // Helper agents: on by default; the switch saves the pref
    const agents = await zen.chrome(async () => {
      const d = gBrowser.selectedBrowser.contentDocument;
      const box = d.getElementById("zenAiAgents");
      const before = box.checked;
      box.click();
      const after = Services.prefs.getStringPref("zenai.agents.enabled", "");
      Services.prefs.clearUserPref("zenai.agents.enabled");
      const text = d.getElementById("zenAiAgentsGroup").textContent;
      return { before, after, usage: /usage limit|plan's limits/.test(text) };
    });
    check("Helper agents: on by default, the switch saves it, and the usage cost is explained", agents.before === true && agents.after === "false" && agents.usage, agents);
    check("...changing them saves them (backups at least 1)", upd.offer === "false" && upd.model === "sonnet" && upd.effort === "medium" && upd.backups === "1" && upd.field === "1", upd);

    // --- Claude Code: a wrong path, then back ---
    const setPath = (p) => zen.chrome(async (p) => {
      const d = gBrowser.selectedBrowser.contentDocument;
      const input = d.getElementById("zenAiClaudePath");
      input.value = p;
      input.dispatchEvent(new d.defaultView.Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      return { pref: Services.prefs.getStringPref("zenai.claudePath", ""), status: d.getElementById("zenAiClaudeStatus").textContent, bad: d.getElementById("zenAiClaudeStatus").classList.contains("zai-bad") };
    }, p);
    let r = await setPath("/nowhere/claude");
    check("a path with nothing there: saved, and the status says so in red", r.pref === "/nowhere/claude" && /^There's nothing at that path\. In Terminal, run “which claude”/.test(r.status) && r.bad, r);
    r = await setPath(fakeClaude);
    check("...and back to a working one", r.pref === fakeClaude && r.status === "Found Claude Code 2.1.99." && !r.bad, r);

    // --- The look: written to the prefs, and the chat window follows at once ---
    const look = await zen.chrome(async () => {
      const d = gBrowser.selectedBrowser.contentDocument;
      const blur = d.getElementById("zenAiBlur");
      blur.value = "native";
      blur.dispatchEvent(new d.defaultView.Event("command", { bubbles: true }));
      const tint = d.getElementById("zenAiTint");
      tint.value = "70";
      tint.dispatchEvent(new d.defaultView.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const panel = document.getElementById("zai-panel");
      return {
        prefs: [Services.prefs.getStringPref("zenai.blur", ""), Services.prefs.getStringPref("zenai.glass.tint", "")],
        shownTint: tint.nextSibling.textContent,
        panelNative: panel.classList.contains("zai-blur-native"),
        panelTint: panel.style.getPropertyValue("--zai-tint-pct"),
      };
    });
    check("background and tint are saved", look.prefs.join() === "native,70" && look.shownTint === "70%", look);
    check("...and the chat window changes right away", look.panelNative && look.panelTint === "70%", look);
    const reset = await zen.chrome(async () => {
      const d = gBrowser.selectedBrowser.contentDocument;
      d.getElementById("zenAiLookReset").doCommand();
      await new Promise((r) => setTimeout(r, 200));
      return { blur: d.getElementById("zenAiBlur").value, tint: d.getElementById("zenAiTint").value, set: ["blur", "glass.tint", "glass.blur"].filter((p) => Services.prefs.prefHasUserValue("zenai." + p)), panelSnapshot: document.getElementById("zai-panel").classList.contains("zai-blur-snapshot") };
    });
    check("Reset to defaults clears them, and the window goes back", reset.blur === "snapshot" && reset.tint === "48" && !reset.set.length && reset.panelSnapshot, reset);

    // --- Chats ---
    const minutes = await zen.chrome(() => {
      const d = gBrowser.selectedBrowser.contentDocument;
      const input = d.getElementById("zenAiResumeMinutes");
      input.value = "15.4";
      input.dispatchEvent(new d.defaultView.Event("change", { bubbles: true }));
      const a = [input.value, Services.prefs.getStringPref("zenai.resumeMinutes", "")];
      input.value = "-3";
      input.dispatchEvent(new d.defaultView.Event("change", { bubbles: true }));
      return [...a, input.value, Services.prefs.getStringPref("zenai.resumeMinutes", "")];
    });
    check("the minutes are saved as whole minutes, never below 0", minutes.join() === "15,15,0,0", minutes);

    // --- Zen's settings search finds it ---
    const found = await zen.chrome(async () => {
      const w = gBrowser.selectedBrowser.contentWindow;
      const d = gBrowser.selectedBrowser.contentDocument;
      w.gSearchResultsPane.searchInput.value = "Claude Code";
      w.gSearchResultsPane.searchInput.dispatchEvent(new w.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      return !d.getElementById("zenAiClaudeGroup").hidden;
    });
    check("searching Zen's settings for “Claude Code” shows the Zen AI section", found);

    // --- Find it: the real Claude Code on this Mac (if there is one) ---
    const finding = await zen.chrome(async () => {
      const d = gBrowser.selectedBrowser.contentDocument;
      d.getElementById("zenAiClaudePath").value = "/nowhere/claude";
      d.getElementById("zenAiClaudeFind").doCommand();
      const status = d.getElementById("zenAiClaudeStatus");
      for (let i = 0; i < 150 && !/^(Found|Couldn't)/.test(status.textContent); i++) await new Promise((r) => setTimeout(r, 100));
      return { status: status.textContent, field: d.getElementById("zenAiClaudePath").value, pref: Services.prefs.getStringPref("zenai.claudePath", "") };
    });
    const installed = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(process.env.HOME || "", ".claude/local/claude"), join(process.env.HOME || "", ".local/bin/claude")].find((p) => existsSync(p));
    if (installed) check("Find it finds the Claude Code on this Mac, saves it and checks it", /^Found Claude Code \d+\.\d+\.\d+\.$/.test(finding.status) && finding.field === finding.pref && existsSync(finding.pref) && finding.pref !== "/nowhere/claude", finding);
    else check("Find it says so when there's no Claude Code here", /^Couldn't find it/.test(finding.status), finding);

    // --- Open Zen AI ---
    const opening = await zen.chrome(async () => {
      window.ZenAIChat.close();
      await new Promise((r) => setTimeout(r, 300));
      const panel = document.getElementById("zai-panel");
      const before = panel.classList.contains("zai-closed");
      gBrowser.selectedBrowser.contentDocument.getElementById("zenAiOpen").doCommand();
      await new Promise((r) => setTimeout(r, 300));
      return { closedBefore: before, openAfter: !panel.classList.contains("zai-closed") };
    });
    check("Open Zen AI opens the chat window", opening.closedBefore && opening.openAfter, opening);

    // --- The minutes really decide whether the last chat comes back ---
    await zen.chrome((p) => Services.prefs.setStringPref("zenai.claudePath", p), zen.relayPath);
    const setMinutes = (n) => zen.chrome((n) => {
      const d = gBrowser.selectedBrowser.contentDocument;
      const input = d.getElementById("zenAiResumeMinutes");
      input.value = String(n);
      input.dispatchEvent(new d.defaultView.Event("change", { bubbles: true }));
    }, n);
    await setMinutes(60);
    await zen.send("Hello there");
    const reopen = () => zen.chrome(async () => {
      window.ZenAIChat.close();
      await new Promise((r) => setTimeout(r, 400));
      window.ZenAIChat.open();
      await new Promise((r) => setTimeout(r, 400));
      return { bubbles: document.querySelectorAll(".zai-thread .zai-bubble").length, greeting: !!document.querySelector(".zai-greeting") };
    });
    const kept = await reopen();
    check("reopened within the minutes (60): the last chat is back", kept.bubbles === 1 && !kept.greeting, kept);
    await setMinutes(0);
    const fresh = await reopen();
    check("set to 0 in settings: reopening starts a new chat", fresh.bubbles === 0 && fresh.greeting, fresh);

    // --- A link straight to #zenAI, in a fresh tab ---
    await zen.chrome(() => { gBrowser.selectedTab = gBrowser.addTab("about:preferences#zenAI", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); });
    await sleep(2500);
    const direct = await zen.chrome(() => {
      const b = gBrowser.selectedBrowser;
      const d = b.contentDocument;
      return { url: b.currentURI.spec, current: d.getElementById("categories").currentView, shown: !d.getElementById("zenAiClaudeGroup").hidden, panes: d.querySelectorAll("#category-zen-ai").length };
    });
    check("about:preferences#zenAI opens straight on the pane (once)", direct.url === "about:preferences#zenAI" && direct.current === "paneZenAI" && direct.shown && direct.panes === 1, direct);

    check("no errors in Zen's console", zen.errors().length === 0, zen.errors());
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
