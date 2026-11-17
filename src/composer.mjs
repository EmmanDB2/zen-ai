import { CREATE_SKILL_BODY, CREATE_SKILL_DESCRIPTION, CREATE_SKILL_NAME, PREF_ROOT, SVG_NS, prefs } from "./config.mjs";
import { EFFORTS, FALLBACK_MODELS, gaugeIcon, h, icon, modelInfo } from "./dom.mjs";
import { browserInfo, encodeForClaude, getSelectionText, hostOf, thumbnailUrl } from "./pages.mjs";
import { MAX_ATTACHMENTS, MAX_ATTACH_BYTES, extensionOf, isImageFile, readDocument, readImage } from "./attachments.mjs";
import { loadSkills, revealSkillsFolder } from "./skills.mjs";
import { PROVIDERS, aiName, installedProviders, providerInfo, providerModelsPref } from "./providers.mjs";
import { USAGE_PREF, formatAge, readUsage, saveUsage, usageFromEvent, usageLine, usageView } from "./usage.mjs";
import { attachmentIcon, chip, chipIcon, contextLabels, currentBrowser, currentTabInfo, formatSize, isReadableUrl, selectionLabel, tabInfo } from "./panel-parts.mjs";
import { createCapture } from "./capture.mjs";

// ---------------------------------------------------------------------------
// The composer: the message box, what goes with the next message (page and
// selection chips, tabs, attachments, the skill pill), the "/" and "@"
// pickers, the model and effort menu, the usage ring around Send, and
// dropping/pasting files. It never starts a session or runs a tool: Send,
// a model pick, effort and typing are callbacks to the chat controller.
// ---------------------------------------------------------------------------
export function createComposer({ panel, flashEl, flash, hideTip, tipMore, menus, popovers, isOpen, isDocked, openPanel, getActive,
  setPanelLabel, secretShowing, onSend, onModelPick, onEffort, onContinue, onTyping }) {
  const state = {
    effort: EFFORTS[prefs.get("effort", "medium")] ? prefs.get("effort", "medium") : "medium",
    model: prefs.get("model", "default") || "default",
    // Claude Code's model list for this account (cached from its last start)
    models: (() => { try { const m = JSON.parse(prefs.get("models", "")); return Array.isArray(m) && m.length ? m : FALLBACK_MODELS; } catch (e) { return FALLBACK_MODELS; } })(),
    otherModels: {},
    installed: ["claude"],
    // Context for the next message
    skill: null,          // the selected skill (shown as a pill)
    tabs: [],             // extra tabs attached with Tabs / @
    attachments: [],      // screenshots and files: { id, kind, name, ... }
    selection: "",        // current text selection on the page
    skipPage: false,      // user removed the page chip for this message
    skipSelection: false, // user removed the selection chip for this message
  };
  // A chip's × removes its thing, then the chips and Send update
  const removing = (fn) => () => { fn(); renderChips(); updateSend(); };

  // --- Composer ---
  const input = h("textarea", { class: "zai-input", rows: "1", placeholder: "Ask about this page, / for skills, @ for tabs", "aria-label": "Message Claude" });

  const attachBtn = h("button", { class: "zai-icon-btn", "aria-label": "Attach files", "data-tip": "Attach files (or drop / paste them)" }, icon("plus"));

  const tabsBtn = h("button", { class: "zai-icon-btn", "aria-label": "Add tabs", "data-tip": "Add tabs", "aria-expanded": "false" }, icon("tabs"));

  const captureBtn = h("button", { class: "zai-icon-btn", "aria-label": "Screenshot an area", "data-tip": "Screenshot an area", "aria-pressed": "false" }, icon("capture"));

  const effortBtn = h("button", { class: "zai-icon-btn zai-model-btn", "aria-haspopup": "menu", "aria-expanded": "false" });

  const sendBtn = h("button", { class: "zai-send", "aria-label": "Send", "data-tip": "Send", "data-tip-align": "end" }, icon("send", 17, 2.2));

  // The usage ring around Send (see showUsage): a rounded square drawn from the top middle, clockwise
  const svgEl = (tag, attrs) => { const el = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

  const ringPath = (() => {
    const a = 1.25, b = 40.75, r = 10.75;
    return `M21 ${a} H${b - r} A${r} ${r} 0 0 1 ${b} ${a + r} V${b - r} A${r} ${r} 0 0 1 ${b - r} ${b} H${a + r} A${r} ${r} 0 0 1 ${a} ${b - r} V${a + r} A${r} ${r} 0 0 1 ${a + r} ${a} Z`;
  })();

  const ringValue = svgEl("path", { class: "zai-usage-value", d: ringPath, pathLength: "100", "stroke-dasharray": "0 100" });

  const usageRing = svgEl("svg", { class: "zai-usage-ring", viewBox: "0 0 42 42", "aria-hidden": "true" });

  usageRing.append(svgEl("path", { class: "zai-usage-track", d: ringPath }), ringValue);

  const sendWrap = h("div", { class: "zai-send-wrap" }, sendBtn, usageRing);

  const chipsRow = h("div", { class: "zai-chips", hidden: true });

  const pillSlot = h("span", { hidden: true });

  const composer = h("div", { class: "zai-composer" },
    chipsRow,
    h("div", { class: "zai-input-row" }, pillSlot, input),
    h("div", { class: "zai-toolbar" }, attachBtn, tabsBtn, captureBtn, h("div", { class: "zai-spacer" }), effortBtn, sendWrap)
  );

  const picker = h("div", { class: "zai-picker", role: "listbox", hidden: true });

  // Effort: one compact row (Low · Medium · High), under the model list
  const menuItems = Object.entries(EFFORTS).map(([key, e]) =>
    h("button", { class: "zai-effort-btn", role: "menuitemradio", "aria-checked": "false", "data-effort": key, "data-tip": e.desc, onclick: () => setEffort(key) },
      gaugeIcon(key),
      h("span", { text: e.title })
    )
  );

  const modelItems = h("div", { class: "zai-menu-group", role: "group", "aria-label": "Model" });

  const menu = h("div", { class: "zai-menu", role: "menu", "aria-label": "Model and effort", hidden: true },
    h("div", { class: "zai-menu-label", text: "Model" }),
    modelItems,
    h("div", { class: "zai-menu-sep", role: "separator" }),
    h("div", { class: "zai-menu-label", text: "Effort" }),
    h("div", { class: "zai-effort-row", role: "group", "aria-label": "Effort" }, menuItems)
  );

  // Claude Code deleted this chat's transcript: it can be read, not continued
  const expiredBar = h("div", { class: "zai-expired", role: "status", hidden: true },
    icon("history", 15),
    h("span", { text: "Claude Code no longer has this chat, so it can't continue it." }),
    h("button", { class: "zai-expired-btn", text: "Continue in a new chat", onclick: () => onContinue() })
  );

  const composerWrap = h("div", { class: "zai-composer-wrap" }, menu, picker, flashEl, expiredBar, composer);

  const dropZone = h("div", { class: "zai-drop", hidden: true, "aria-hidden": "true" },
    icon("attach", 24, 1.8),
    h("span", { text: "Drop to attach" }),
    h("span", { class: "zai-drop-sub", text: "Images, PDFs, text and code, Word, PowerPoint, Excel" })
  );

  function prefill(text) {
    input.value = text;
    autosize();
    updateSend();
    input.focus();
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(Math.max(input.scrollHeight, 30), 144) + "px";
  }

  function updateSend() {
    const hasSomething = input.value.trim().length > 0 || !!state.skill || state.attachments.length > 0 || state.tabs.length > 0;
    const active = getActive();
    sendBtn.classList.toggle("zai-ready", !active.streaming && !active.expired && hasSomething);
  }

  // An expired chat shows the banner instead of taking messages
  function updateReadOnly() {
    const active = getActive();
    const readOnly = active.expired;
    expiredBar.querySelector("span").textContent = `${(providerInfo(active.provider) || {}).label || "The provider"} no longer has this chat, so it can't continue it.`;
    input.setAttribute("aria-label", `Message ${aiName(active)}`);
    setPanelLabel(`${aiName(active)} chat`);
    expiredBar.hidden = !readOnly;
    composer.classList.toggle("zai-readonly", readOnly);
    input.disabled = readOnly;
    updateSend();
  }

  function setEffort(level) {
    state.effort = level;
    prefs.set("effort", level);
    onEffort(level);
    for (const item of menuItems) item.setAttribute("aria-checked", String(item.dataset.effort === level));
    updateModelButton();
    setMenu(false);
  }

  // --- Model ---
  function modelsFor(provider) {
    if (provider === "claude") return state.models;
    if (!state.otherModels[provider]) {
      let models;
      try { models = JSON.parse(prefs.get(providerModelsPref(provider), "")); } catch (e) {}
      state.otherModels[provider] = Array.isArray(models) && models.length ? models : [{ value: "default", displayName: "Default", description: "" }];
    }
    return state.otherModels[provider];
  }

  function currentModel() {
    return modelsFor(getActive().provider).find((m) => m.value === state.model) || { value: state.model, displayName: state.model, description: "" };
  }

  // What the button says: the model that will actually answer
  function modelLabel() {
    const m = currentModel();
    return m.value === "default" && !m.description ? "Default" : modelInfo(m).name;
  }

  function buttonTip() {
    return `${modelLabel()} · ${(providerInfo(getActive().provider) || {}).label || getActive().provider} · ${EFFORTS[state.effort].title} effort`;
  }

  function updateModelButton() {
    effortBtn.replaceChildren(h("span", { class: "zai-model-name", text: modelLabel() }), gaugeIcon(state.effort));
    effortBtn.setAttribute("aria-label", `Model and effort: ${buttonTip()}`);
    if (menu.hidden) effortBtn.setAttribute("data-tip", buttonTip());
  }

  function renderModels() {
    const active = getActive();
    modelItems.replaceChildren(...PROVIDERS.filter((p) => state.installed.includes(p.id) || p.id === active.provider).flatMap((provider) => [
      h("div", { class: "zai-menu-label", text: provider.label }),
      ...modelsFor(provider.id).map((m) => {
      const info = modelInfo(m);
      const isDefault = m.value === "default";
      const title = isDefault ? "Default" : info.name;
      const desc = isDefault ? (m.description ? `${info.name}, ${provider.label}'s pick` : `${provider.label}'s pick`) : info.blurb;
      return h("button", { class: "zai-menu-item", role: "menuitemradio", "aria-checked": String(provider.id === active.provider && m.value === state.model), "data-model": m.value, "data-provider": provider.id, onclick: () => onModelPick(m.value, provider.id) },
        h("span", { class: "zai-menu-text" }, h("span", { class: "zai-menu-title", text: title }), desc ? h("span", { class: "zai-menu-desc", text: desc }) : null),
        icon("check", 16, 2.2, "zai-check")
      );
    })]));
  }

  function setMenu(open) {
    menu.hidden = !open;
    if (open) {
      installedProviders().then((ids) => { state.installed = ids; renderModels(); }).catch(() => {});
      // Never taller than the room above the button (a short floating window)
      menu.style.maxHeight = "";
      menu.style.maxHeight = Math.max(160, Math.floor(menu.getBoundingClientRect().bottom) - 8) + "px";
    }
    effortBtn.setAttribute("aria-expanded", String(open));
    if (open) effortBtn.removeAttribute("data-tip");
    else effortBtn.setAttribute("data-tip", buttonTip());
  }

  // -------------------------------------------------------------------------
  // Usage: the ring around Send fills with the fuller of the plan's 5-hour and
  // weekly limits (green, amber, red); a longer hover on Send lists both. The
  // numbers live in a pref (usage.mjs), so every window shows the latest.
  // -------------------------------------------------------------------------
  let usage = readUsage();

  let usageTimer = null;

  function showUsage() {
    clearTimeout(usageTimer);
    const now = Date.now();
    const view = usageView(getActive().provider === "claude" ? usage : null, now);
    sendWrap.classList.toggle("zai-has-usage", !!view);
    if (!view) {
      sendBtn.removeAttribute("aria-description");
      return;
    }
    sendWrap.setAttribute("data-level", view.level);
    ringValue.setAttribute("stroke-dasharray", `${(view.fill * 100).toFixed(1)} 100`);
    ringValue.style.display = view.fill < 0.01 ? "none" : "";
    sendBtn.setAttribute("aria-description", view.rows.map((r) => usageLine(r, now)).join(". "));
    // A limit that resets empties its share of the ring then
    const next = Math.min(...view.rows.filter((r) => r.resets && !r.passed).map((r) => r.resets));
    if (Number.isFinite(next)) usageTimer = setTimeout(showUsage, Math.min(next - now + 1000, 6 * 3600000));
  }

  function noteUsage(info) {
    const u = usageFromEvent(info);
    if (!u) return;
    usage = u;
    saveUsage(u);
    showUsage();
  }

  tipMore.set(sendBtn, () => {
    const now = Date.now();
    const view = usageView(getActive().provider === "claude" ? usage : null, now);
    if (!view) return null;
    return [...view.rows.map((r) => ({ text: usageLine(r, now) })), { text: `Updated ${formatAge(view.updated, now)}`, note: true }];
  });

  function pageWillBeSent(chat = getActive()) {
    const browser = currentBrowser();
    if (!browser || state.skipPage) return false;
    const { url } = browserInfo(browser);
    return isReadableUrl(url) && !chat.sentPages.has(url);
  }

  function selectionWillBeSent(chat = getActive()) {
    return !!state.selection && !state.skipSelection && state.selection !== chat.lastSentSelection;
  }

  function attachmentChip(att) {
    const hasThumb = att.kind === "image" && att.thumbUrl;
    const meta = [att.label, att.size ? formatSize(att.size) : ""].filter(Boolean).join(" · ");
    return chip({
      lead: hasThumb ? h("img", { class: "zai-chip-thumb", src: att.thumbUrl, alt: "" }) : icon(attachmentIcon(att), 14),
      label: att.name,
      tip: att.loading ? `${att.name} · reading…` : hasThumb ? `${att.name} · right-click to copy` : `${att.name}${meta ? " · " + meta : ""}`,
      loading: att.loading,
      onRemove: removing(() => { state.attachments = state.attachments.filter((a) => a !== att); }),
      onContextMenu: hasThumb ? (e) => menus.openImageMenu(e, att, () => {
        state.attachments = state.attachments.filter((a) => a !== att);
        renderChips();
        updateSend();
      }) : null,
    });
  }

  // Chips for what will be sent with the next message.
  // Only chips that weren't showing before get the pop-in animation.
  let shownChipKeys = new Set();

  const tabKeys = new WeakMap();

  let tabKeyCount = 0;

  function tabKey(tab) {
    if (!tabKeys.has(tab)) tabKeys.set(tab, ++tabKeyCount);
    return "tab:" + tabKeys.get(tab);
  }

  function renderChips() {
    const active = getActive();
    const items = [];
    // "Continue in a new chat": the earlier chat's recap goes with the first message
    if (active.recap) {
      items.push({
        key: "recap:" + active.id,
        node: chip({
          lead: icon("history", 14),
          label: "Earlier chat",
          tip: `A recap of “${active.recap.title}” goes with your message`,
          onRemove: removing(() => { active.recap = null; }),
        }),
      });
    }
    const page = pageWillBeSent() && !state.skill ? currentTabInfo() : null;
    const labels = contextLabels([...(page ? [page] : []), ...state.tabs.map(tabInfo)]);
    if (page) {
      items.push({
        key: "page:" + page.url,
        node: chip({
          lead: chipIcon(page.icon, "doc"),
          label: labels.shift(),
          tip: `${page.title || page.url} · goes with your message`,
          onRemove: removing(() => { state.skipPage = true; }),
        }),
      });
    }
    if (selectionWillBeSent()) {
      items.push({
        key: "sel:" + state.selection.length + ":" + state.selection.slice(0, 60),
        node: chip({
          lead: icon("selection", 14),
          label: selectionLabel(state.selection),
          tip: state.selection.slice(0, 300),
          onRemove: removing(() => { state.skipSelection = true; }),
        }),
      });
    }
    for (const tab of state.tabs) {
      const info = tabInfo(tab);
      items.push({
        key: tabKey(tab),
        node: chip({
          lead: chipIcon(info.icon, "tabs"),
          label: labels.shift(),
          tip: info.title || info.url,
          onRemove: removing(() => { state.tabs = state.tabs.filter((t) => t !== tab); }),
        }),
      });
    }
    for (const att of state.attachments) items.push({ key: "att:" + att.id, node: attachmentChip(att) });

    for (const item of items) if (!shownChipKeys.has(item.key)) item.node.classList.add("zai-pop");
    shownChipKeys = new Set(items.map((item) => item.key));
    chipsRow.replaceChildren(...items.map((item) => item.node));
    chipsRow.hidden = items.length === 0;
  }

  async function refreshSelection() {
    const browser = currentBrowser();
    const text = browser ? await getSelectionText(browser) : "";
    if (text !== state.selection) {
      state.selection = text;
      state.skipSelection = false;
    }
    renderChips();
  }

  // After sending: clear what went with that message (attachments added
  // while it was being read stay for the next one)
  function resetNextMessageContext(usedAttachments = state.attachments) {
    state.skill = null;
    state.tabs = [];
    state.attachments = state.attachments.filter((a) => !usedAttachments.includes(a));
    state.skipPage = false;
    state.skipSelection = false;
    renderPill();
    renderChips();
    updateSend();
  }

  // -------------------------------------------------------------------------
  // Attachments: + button, drag and drop, paste
  // -------------------------------------------------------------------------
  let attachmentCount = 0;

  // work(att) fills in the attachment; until then its chip shows as loading
  function addAttachment(att, work) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      flash(`Up to ${MAX_ATTACHMENTS} attachments per message`);
      return null;
    }
    att.id = ++attachmentCount;
    att.loading = true;
    state.attachments.push(att);
    att.ready = Promise.resolve()
      .then(() => work(att))
      .then(
        () => { att.loading = false; },
        (e) => {
          att.failed = true;
          state.attachments = state.attachments.filter((a) => a !== att);
          flash((e && e.message) || `Couldn't attach ${att.name}`);
        }
      )
      .finally(() => {
        renderChips();
        updateSend();
      });
    renderChips();
    updateSend();
    return att;
  }

  // source: { name, size, type, read: () => Promise<Uint8Array> }
  function attachFile(source) {
    const name = source.name || "file";
    if (source.size > MAX_ATTACH_BYTES) {
      flash(`${name} is over ${MAX_ATTACH_BYTES / 1048576} MB`);
      return;
    }
    const image = isImageFile(name, source.type);
    addAttachment({ kind: image ? "image" : "file", name, size: source.size || 0, source: "file" }, async (att) => {
      let bytes;
      try {
        bytes = await source.read();
      } catch (e) {
        throw new Error(`Couldn't read ${name}`);
      }
      att.size = bytes.length;
      if (!image) att.bytes = bytes; // kept so edit_file can change a copy of it
      const type = source.type || "";
      Object.assign(att, image
        ? await readImage(new Blob([bytes], { type: type || "image/" + (extensionOf(name) === "jpg" ? "jpeg" : extensionOf(name)) }), name)
        : await readDocument({ name, type, bytes }));
    });
  }

  function attachDomFiles(files) {
    for (const file of files) {
      attachFile({
        name: file.name === "image.png" ? "Pasted image.png" : file.name,
        size: file.size,
        type: file.type,
        read: async () => new Uint8Array(await file.arrayBuffer()),
      });
    }
  }

  function pickFiles() {
    let fp;
    try {
      fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      try {
        fp.init(window.browsingContext, "Attach files", Ci.nsIFilePicker.modeOpenMultiple);
      } catch (e) {
        fp.init(window, "Attach files", Ci.nsIFilePicker.modeOpenMultiple);
      }
    } catch (e) {
      console.error("[Zen AI] Couldn't open the file picker:", e);
      flash("Couldn't open the file picker");
      return;
    }
    fp.open((result) => {
      if (result !== Ci.nsIFilePicker.returnOK) return;
      const files = [];
      try {
        const list = fp.files;
        while (list.hasMoreElements()) files.push(list.getNext().QueryInterface(Ci.nsIFile));
      } catch (e) {
        if (fp.file) files.push(fp.file);
      }
      if (!isOpen()) openPanel();
      attachNsFiles(files);
      input.focus();
    });
  }

  // Files as Firefox's nsIFile (from the file picker, or some drags from Finder)
  function attachNsFiles(files) {
    for (const file of files) {
      try {
        if (file.isDirectory()) {
          flash(`${file.leafName} is a folder. Attach the files inside it instead.`);
          continue;
        }
      } catch (e) {}
      let size = 0;
      try { size = file.fileSize; } catch (e) {}
      attachFile({ name: file.leafName, size, type: "", read: () => IOUtils.read(file.path) });
    }
  }

  // -------------------------------------------------------------------------
  // Skill pill
  // -------------------------------------------------------------------------
  function renderPill() {
    if (state.skill) {
      pillSlot.replaceChildren(h("span", { class: "zai-pill", title: state.skill.description, text: state.skill.name }));
      pillSlot.hidden = false;
      input.placeholder = state.skill.builtin ? "What should the skill do? (or send it empty to write one yourself)" : "Add details (optional)";
    } else {
      pillSlot.replaceChildren();
      pillSlot.hidden = true;
      input.placeholder = "Ask about this page, / for skills, @ for tabs";
    }
    renderChips();
    updateSend();
  }

  // The built-in /create-skill (a file skill with the same name is hidden)
  const CREATE_SKILL = {
    name: CREATE_SKILL_NAME, builtin: true, description: CREATE_SKILL_DESCRIPTION, body: CREATE_SKILL_BODY,
    context: [], access: [], accessSkills: [], skillFiles: {}, lessons: false, lessonNotes: "", agents: 0, agentsError: "",
    folder: "", file: "", clashes: [],
  };
  async function allSkills() {
    return [CREATE_SKILL, ...(await loadSkills()).filter((s) => s.name !== CREATE_SKILL_NAME)];
  }

  function setSkill(skill) {
    state.skill = skill;
    renderPill();
    input.focus();
  }

  async function runSkillByName(name) {
    const skill = (await allSkills()).find((s) => s.name === name);
    if (!skill) {
      flash(`No "${name}" skill found`);
      return;
    }
    setSkill(skill);
    onSend();
  }

  // -------------------------------------------------------------------------
  // Picker ("/" skills, "@" and Tabs button for tabs)
  // -------------------------------------------------------------------------
  let pick = null; // { items, index, onChoose, keepOpen, footer }

  function closePicker() {
    pick = null;
    picker.hidden = true;
    picker.replaceChildren();
    tabsBtn.setAttribute("aria-expanded", "false");
    tabsBtn.setAttribute("data-tip", "Add tabs");
  }

  function renderPicker() {
    if (!pick) return;
    const rows = [];
    pick.items.forEach((item, i) => {
      // A heading where a new group starts (skill folders); headings aren't items
      if (item.group && item.group !== (pick.items[i - 1] || {}).group) rows.push(h("div", { class: "zai-pick-group", role: "presentation", text: item.group }));
      rows.push(h("button", {
        class: "zai-pick" + (i === pick.index ? " zai-active" : ""),
        role: "option",
        "aria-selected": String(i === pick.index),
        onmousedown: (e) => e.preventDefault(), // keep focus in the input
        onclick: () => choosePick(i),
      },
        item.iconNode,
        h("span", { class: "zai-pick-text" },
          h("span", { class: "zai-pick-title", text: item.title }),
          item.desc ? h("span", { class: "zai-pick-desc", text: item.desc }) : null,
          item.note ? h("span", { class: "zai-pick-note", text: item.note }) : null
        ),
        item.checked ? icon("check", 16, 2.2, "zai-check" + (item.tab && item.tab === pick.toggled ? " zai-pop" : "")) : null
      ));
    });
    pick.toggled = null;
    if (!rows.length) rows.push(h("div", { class: "zai-pick-empty", text: pick.emptyText || "Nothing here" }));
    if (pick.footer) rows.push(h("div", { class: "zai-pick-footer" }, pick.footer));
    picker.replaceChildren(...rows);
    picker.hidden = false;
    const chosen = picker.querySelector(".zai-active");
    if (chosen) chosen.scrollIntoView({ block: "nearest" });
  }

  function openPicker(options) {
    popovers.closeOthers(pickerEntry);
    pick = { index: 0, ...options };
    const fromTabsButton = pick.kind === "tab-button";
    tabsBtn.setAttribute("aria-expanded", String(fromTabsButton));
    if (fromTabsButton) tabsBtn.removeAttribute("data-tip");
    else tabsBtn.setAttribute("data-tip", "Add tabs");
    renderPicker();
  }

  function choosePick(i) {
    if (!pick || !pick.items[i]) return;
    const item = pick.items[i];
    const keepOpen = pick.keepOpen;
    pick.onChoose(item);
    if (keepOpen && pick) {
      pick.toggled = item.tab; // its checkmark pops
      pick.items = pick.buildItems();
      pick.index = Math.min(i, pick.items.length - 1);
      renderPicker();
    } else {
      closePicker();
    }
  }

  // "/": every skill, grouped under its folder's name (loose ones first).
  // Typing searches all of them (names, descriptions, folders), with each
  // row saying which folder it's in.
  async function openSkillPicker(query) {
    const skills = await allSkills();
    const q = query.toLowerCase();
    const items = skills
      .filter((s) => !q || s.name.startsWith(q) || s.name.startsWith(q.replace(/_/g, "-")) || s.description.toLowerCase().includes(q) || s.folder.toLowerCase().includes(q))
      .map((s) => ({
        title: "/" + s.name,
        desc: q ? [s.folder, s.description].filter(Boolean).join(" · ") : s.description,
        note: s.builtin ? "Built in" : s.clashes.length ? `Same name as ${s.clashes.join(", ")}, which isn't used. Rename one.` : "",
        group: q ? "" : s.folder,
        iconNode: icon("spark", 16, 2),
        skill: s,
      }));
    openPicker({
      kind: "skill",
      items,
      emptyText: "No matching skills",
      onChoose: (item) => {
        input.value = input.value.replace(/^\/[\w-]*\s?/, "");
        autosize();
        setSkill(item.skill);
      },
      footer: h("button", {
        class: "zai-pick",
        onmousedown: (e) => e.preventDefault(),
        onclick: () => { closePicker(); revealSkillsFolder(); },
      }, icon("folder", 16), h("span", { class: "zai-pick-text" },
        h("span", { class: "zai-pick-title", text: "Open skills folder" }),
        h("span", { class: "zai-pick-desc", text: "Add a .md file to make a new skill; folders group them" })
      )),
    });
  }

  function tabItems(query) {
    const q = (query || "").toLowerCase();
    let tabs = [];
    try { tabs = gBrowser.visibleTabs.filter((t) => t !== gBrowser.selectedTab); } catch (e) {}
    return tabs
      .filter((t) => !q || (t.label || "").toLowerCase().includes(q))
      .slice(0, 50)
      .map((t) => {
        let url = "";
        try { url = t.linkedBrowser.currentURI.spec; } catch (e) {}
        const unloaded = t.hasAttribute("pending");
        return {
          title: t.label || url || "Tab",
          desc: unloaded ? "Not loaded yet · open it once to share" : hostOf(url),
          iconNode: chipIcon(t.getAttribute("image"), "tabs"),
          checked: state.tabs.includes(t),
          tab: t,
        };
      });
  }

  function toggleTab(tab) {
    if (state.tabs.includes(tab)) state.tabs = state.tabs.filter((t) => t !== tab);
    else state.tabs = [...state.tabs, tab];
    renderChips();
  }

  // fromButton: multi-select list that stays open. From "@": pick one and close.
  function openTabPicker(fromButton, query = "") {
    const build = () => tabItems(query);
    openPicker({
      kind: fromButton ? "tab-button" : "tab",
      items: build(),
      buildItems: build,
      keepOpen: fromButton,
      emptyText: "No other tabs in this space",
      onChoose: (item) => {
        if (!fromButton) {
          const before = input.value.slice(0, input.selectionStart).replace(/(^|\s)@[^\s@]*$/, "$1");
          input.value = before + input.value.slice(input.selectionStart);
          autosize();
          if (!state.tabs.includes(item.tab)) toggleTab(item.tab);
        } else {
          toggleTab(item.tab);
        }
      },
    });
  }

  // Watch the input for "/" and "@"
  function updatePickerFromInput() {
    const value = input.value;
    const caret = input.selectionStart;
    const skillMatch = !state.skill && value.match(/^\/([\w-]*)$/);
    if (skillMatch) {
      openSkillPicker(skillMatch[1]);
      return;
    }
    const mention = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    if (mention) {
      openTabPicker(false, mention[1]);
      return;
    }
    if (pick && pick.kind !== "tab-button") closePicker();
  }

  function updateSendButton() {
    const streaming = getActive().streaming;
    sendBtn.classList.toggle("zai-stop", streaming);
    sendBtn.replaceChildren(streaming ? icon("stop", 17) : icon("send", 17, 2.2));
    const label = streaming ? "Stop" : "Send";
    sendBtn.setAttribute("aria-label", label);
    sendBtn.setAttribute("data-tip", label);
    updateSend();
  }

  // --- Drop files onto the chat ---
  const draggingFiles = (dt) => !!dt && Array.from(dt.types || []).some((t) => t === "Files" || t === "application/x-moz-file");

  let dropTimer = null;

  function showDropZone(show) {
    clearTimeout(dropTimer);
    dropZone.hidden = !show;
    // In case the drag ends somewhere we don't hear about
    if (show) dropTimer = setTimeout(() => (dropZone.hidden = true), 1200);
  }

  attachBtn.addEventListener("click", () => pickFiles());

  tabsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pick && pick.kind === "tab-button") closePicker();
    else openTabPicker(true);
  });

  captureBtn.addEventListener("click", async () => {
    if (capture.isActive()) return capture.end();
    // Not while a card/bank/ID number Zen AI filled shows on the page
    const browser = currentBrowser();
    const check = browser && secretShowing(browser); // null: no saved secret was filled in this tab
    if (check) {
      const shown = await check.catch(() => "");
      if (shown) return flash(`Your saved ${shown} is showing on the page. Scroll it away or clear it first.`);
    }
    capture.start();
  });

  effortBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    popovers.closeOthers(menuEntry);
    setMenu(menu.hidden);
  });

  sendBtn.addEventListener("click", () => onSend());

  input.addEventListener("input", () => {
    autosize();
    updateSend();
    updatePickerFromInput();
    onTyping(); // a reopened chat's Claude Code starts once you type
  });

  input.addEventListener("focus", () => refreshSelection());

  // Pasting an image (e.g. a screenshot) attaches it. Text pastes stay text,
  // even when the clipboard also carries a picture of it (Excel, Keynote…).
  input.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    const files = Array.from((data && data.files) || []);
    if (!files.length || (data.getData("text/plain") || "").trim()) return;
    e.preventDefault();
    attachDomFiles(files);
  });

  input.addEventListener("keydown", (e) => {
    // Picker navigation
    if (pick && !picker.hidden) {
      const count = pick.items.length;
      if (e.key === "ArrowDown" && count) {
        e.preventDefault();
        pick.index = (pick.index + 1) % count;
        renderPicker();
        return;
      }
      if (e.key === "ArrowUp" && count) {
        e.preventDefault();
        pick.index = (pick.index - 1 + count) % count;
        renderPicker();
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && count && pick.kind !== "tab-button") {
        e.preventDefault();
        choosePick(pick.index);
        return;
      }
    }
    // "/solve " + space turns into the pill too
    if (e.key === " " && !state.skill) {
      const m = input.value.match(/^\/([\w-]+)$/);
      if (m && input.selectionStart === input.value.length) {
        allSkills().then((skills) => {
          const typed = m[1].toLowerCase();
          const skill = skills.find((s) => s.name === typed) || skills.find((s) => s.builtin && s.name === typed.replace(/_/g, "-"));
          if (skill && input.value.startsWith("/" + m[1])) {
            input.value = input.value.slice(m[0].length).replace(/^\s/, "");
            autosize();
            closePicker();
            setSkill(skill);
          }
        });
      }
    }
    // Backspace on an empty box removes the pill
    if (e.key === "Backspace" && state.skill && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault();
      state.skill = null;
      renderPill();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onSend();
    }
  });

  for (const type of ["dragenter", "dragover"]) {
    panel.addEventListener(type, (e) => {
      if (!draggingFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      showDropZone(true);
    });
  }

  panel.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget || !panel.contains(e.relatedTarget)) showDropZone(false);
  });

  panel.addEventListener("drop", (e) => {
    if (!draggingFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    showDropZone(false);
    const dt = e.dataTransfer;
    const files = Array.from(dt.files || []);
    if (files.length) {
      attachDomFiles(files);
    } else {
      // Some drags only carry the files as nsIFile
      const nsFiles = [];
      for (let i = 0; i < (dt.mozItemCount || 0); i++) {
        try {
          const file = dt.mozGetDataAt("application/x-moz-file", i);
          if (file instanceof Ci.nsIFile) nsFiles.push(file);
        } catch (err) {}
      }
      if (!nsFiles.length) {
        flash("Drop files from Finder to attach them");
        return;
      }
      attachNsFiles(nsFiles);
    }
    input.focus();
  });

  // Another window heard newer numbers from Claude Code
  const usageObserver = { observe: () => { usage = readUsage(); showUsage(); } };

  // Screenshot an area: the picture becomes an attachment
  const capture = createCapture({
    panel, button: captureBtn, isOpen, isDocked, flash,
    beforeStart: () => { hideTip(); popovers.closeOthers(); },
    focusInput: () => input.focus(),
    onCaptured: (canvas) => {
      if (!isOpen()) openPanel();
      const earlier = state.attachments.filter((a) => a.source === "screenshot").length;
      addAttachment({
        kind: "image",
        name: earlier ? `Screenshot ${earlier + 1}` : "Screenshot",
        source: "screenshot",
        label: "Screenshot",
        thumbUrl: thumbnailUrl(canvas),
      }, async (att) => {
        await new Promise((resolve) => setTimeout(resolve, 0)); // the chip shows first
        att.image = encodeForClaude(canvas);
        att.blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        att.size = att.blob ? att.blob.size : 0;
      });
    },
  });

  const pickerEntry = popovers.register({
    isOpen: () => !!pick,
    close: closePicker,
    contains: (path) => path.includes(picker) || path.includes(tabsBtn) || path.includes(input),
  });

  const menuEntry = popovers.register({
    isOpen: () => !menu.hidden,
    close: () => setMenu(false),
    contains: (path) => path.includes(menu) || path.includes(effortBtn),
  });
  Services.prefs.addObserver(PREF_ROOT + USAGE_PREF, usageObserver);

  return {
    el: composerWrap, dropZone, input,
    focus: () => input.focus(),
    prefill, autosize, updateSend, updateSendButton, updateReadOnly,
    // The message box's text: taken when sending, put back if sending failed
    takeText() { const text = input.value.trim(); input.value = ""; autosize(); return text; },
    restoreText(text) { if (input.value) return; input.value = text; autosize(); updateSend(); },
    text: () => input.value.trim(),
    clear() { input.value = ""; autosize(); updateSend(); },
    // What goes with the next message
    next: () => ({ skill: state.skill, tabs: state.tabs.slice(), attachments: state.attachments.slice() }),
    selection: () => state.selection,
    webContentPending: () => state.tabs.length > 0 || state.attachments.length > 0,
    pageWillBeSent, selectionWillBeSent, refreshSelection, renderChips,
    resetNextMessage: resetNextMessageContext,
    // Switching Spaces: attached tabs belong to the other Space
    forgetTabs() { state.tabs = []; state.skipPage = false; },
    pageChanged() { state.skipPage = false; },
    setSkill, runSkillByName, openTabPicker, pickFiles, startCapture: () => capture.start(),
    // Model and effort
    effort: () => state.effort, setEffort,
    model: () => state.model, setModelValue(value) { state.model = value; },
    modelsFor, claudeModels: () => state.models,
    setModels(provider, models) { if (provider === "claude") state.models = models; else state.otherModels[provider] = models; },
    renderModels, updateModelButton, modelLabel, setMenu,
    showUsage, noteUsage,
    dispose() {
      Services.prefs.removeObserver(PREF_ROOT + USAGE_PREF, usageObserver);
      clearTimeout(usageTimer);
      clearTimeout(dropTimer);
      capture.dispose();
    },
  };
}
