// ---------------------------------------------------------------------------
// In-page agent: runs INSIDE the web page's process as a frame script, so it
// can only see its arguments (never anything else from this file).
// win = the page's window, args = { action, ... }, Components = Firefox's.
// ---------------------------------------------------------------------------
export function pageAgent(win, args, Components) {
  const REF = "data-zai-ref";
  const MAX_ITEMS = 250;
  const FIELD_ROLES = new Set(["textbox", "searchbox", "select", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "file", "color", "listbox"]);
  const WIDGET_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "listbox", "treeitem"]);
  const doc = win.document;

  const clean = (s, n = 80) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const quote = (s) => `"${String(s).replace(/"/g, "'")}"`;
  const viewOf = (el) => el.ownerDocument.defaultView;
  // The page's own shadow roots, open or closed. Not Firefox's widgets inside
  // inputs, videos and the like (they'd show up as unlabeled extra fields):
  // pages can only attach shadow roots to custom elements and a few others.
  const SHADOW_HOSTS = /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/;
  const shadowOf = (el) => {
    const tag = el.localName || "";
    if (!tag.includes("-") && !SHADOW_HOSTS.test(tag)) return null;
    let sr = null;
    try { sr = el.openOrClosedShadowRoot || el.shadowRoot || null; } catch (e) { sr = el.shadowRoot || null; }
    try { if (sr && typeof sr.isUAWidget === "function" && sr.isUAWidget()) return null; } catch (e) {}
    return sr;
  };
  const frameDoc = (el) => {
    if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") return null;
    try { return el.contentDocument && el.contentDocument.documentElement ? el.contentDocument : null; } catch (e) { return null; }
  };
  // A frame from another site runs in its own process: its document isn't
  // here, only its BrowsingContext id (the browser runs another copy of this
  // agent there). null for anything else.
  const remoteFrame = (el) => {
    if ((el.tagName !== "IFRAME" && el.tagName !== "FRAME") || frameDoc(el)) return null;
    try { return el.browsingContext ? el.browsingContext.id : null; } catch (e) { return null; }
  };

  // Every element in page order, including inside shadow roots and same-site frames
  function walk(root, visit) {
    const owner = root.nodeType === 9 ? root : root.ownerDocument;
    const tw = owner.createTreeWalker(root, 1);
    for (let el = tw.nextNode(); el; el = tw.nextNode()) {
      visit(el);
      const sr = shadowOf(el);
      if (sr) walk(sr, visit);
      const fd = frameDoc(el);
      if (fd) walk(fd, visit);
    }
  }

  // Math answer boxes: MathQuill, MathLive, or a styled box over a hidden input
  function mathKind(el) {
    if (el.tagName === "MATH-FIELD") return "MathLive";
    const cls = typeof el.className === "string" ? el.className : "";
    if (!cls) return "";
    if (/\bmq-editable-field\b|\bmathquill-editable\b/.test(cls)) return "MathQuill";
    if (/(math|equation|formula|expression)[-_]?(input|field|editor|entry|box)/i.test(cls)) {
      const inner = el.querySelector("textarea, input:not([type=hidden])");
      if (inner && !isVisible(inner)) return "math editor";
    }
    return "";
  }

  function insideMath(el) {
    const parent = el.parentElement;
    if (parent && parent.closest(".mq-editable-field, .mathquill-editable, math-field")) return true;
    const host = el.getRootNode().host;
    return !!(host && host.tagName === "MATH-FIELD");
  }

  // The page's own editor API (reached through Firefox's security wrappers)
  function mathApi(el, kind) {
    const unwrap = (o) => (o && o.wrappedJSObject) || o;
    try {
      const node = unwrap(el);
      if (kind === "MathLive" && typeof node.setValue === "function") {
        return {
          get: () => String(node.value || ""),
          set: (v, append) => (append ? node.insert(v) : node.setValue(v)),
        };
      }
      const pageWin = unwrap(viewOf(el));
      if (kind === "MathQuill" && pageWin.MathQuill) {
        const MQ = typeof pageWin.MathQuill.getInterface === "function" ? pageWin.MathQuill.getInterface(2) : pageWin.MathQuill;
        let field = null;
        try { field = typeof MQ === "function" ? MQ(node) : null; } catch (e) {}
        if (!field && MQ.MathField) field = MQ.MathField(node);
        if (field && typeof field.latex === "function") {
          return {
            get: () => String(field.latex()),
            set: (v, append) => {
              if (append) field.write(v);
              else field.latex(v);
              if (field.focus) field.focus();
            },
          };
        }
      }
    } catch (e) {}
    return null;
  }

  function roleOf(el) {
    if (mathKind(el)) return "mathbox";
    const role = (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
    switch (el.tagName) {
      case "A": return el.hasAttribute("href") ? (WIDGET_ROLES.has(role) ? role : "link") : WIDGET_ROLES.has(role) ? role : null;
      case "BUTTON": return WIDGET_ROLES.has(role) ? role : "button";
      case "SELECT": return "select";
      case "TEXTAREA": return "textbox";
      case "SUMMARY": return "button";
      case "INPUT": {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "hidden") return null;
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (["submit", "button", "reset", "image"].includes(type)) return "button";
        if (type === "range") return "slider";
        if (type === "file") return "file";
        if (type === "color") return "color";
        return "textbox";
      }
    }
    if (WIDGET_ROLES.has(role)) return role;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    if (isDraggable(el)) return "draggable";
    if (el.hasAttribute("onclick")) return "button";
    return null;
  }

  // Something the page lets you drag: HTML5 draggable, or a drag library's item
  function isDraggable(el) {
    if (el.getAttribute("draggable") === "true" || el.hasAttribute("aria-grabbed")) return true;
    if (el.hasAttribute("data-rbd-drag-handle-draggable-id") || el.hasAttribute("data-sortable-id")) return true;
    const cls = typeof el.className === "string" ? el.className : "";
    return /\bui-(draggable|sortable-handle)\b/.test(cls);
  }

  // Elements a page marks as drop targets
  const DROP_MARKS = "[ondrop], [ondragover], [aria-dropeffect]:not([aria-dropeffect='none']), .ui-droppable, .ui-sortable, [data-rbd-droppable-id], [data-droppable]";

  // Where things can be dropped: the lists or columns holding draggable items,
  // look-alikes next to them (so an empty column counts too), and marked targets
  function dropAreas(draggables, marked) {
    const areas = new Set(marked);
    const firstClass = (n) => (typeof n.className === "string" ? n.className.trim().split(/\s+/)[0] : "");
    const sameKind = (a, b) => a.tagName === b.tagName && firstClass(a) === firstClass(b) && (!!firstClass(a) || /^(UL|OL)$/.test(a.tagName));
    for (const item of draggables) {
      const box = item.parentElement;
      if (!box || box === doc.body || box === doc.documentElement) continue;
      areas.add(box);
      const col = box.parentElement;
      if (!col) continue;
      for (const sib of col.children) if (sib !== box && sameKind(sib, box)) areas.add(sib);
      if (!col.parentElement || col === doc.body) continue;
      for (const other of col.parentElement.children) {
        if (other === col || !sameKind(other, col)) continue;
        const twin = Array.from(other.getElementsByTagName(box.tagName)).find((n) => sameKind(n, box));
        if (twin) areas.add(twin);
      }
    }
    return areas;
  }

  // A drop area's name: its own label, a heading inside it or just before it
  function areaLabel(box) {
    const own = namedBy(box) || box.getAttribute("aria-label") || box.getAttribute("title");
    if (own) return clean(own, 60);
    const heads = "h1, h2, h3, h4, h5, h6, [role='heading'], legend, caption";
    const inItem = (n) => { for (let p = n; p && p !== box; p = p.parentElement) if (isDraggable(p)) return true; return false; };
    const inside = Array.from(box.querySelectorAll(heads)).find((n) => !inItem(n));
    if (inside) return clean(textOf(inside), 60);
    for (let n = box, i = 0; n && i < 2; n = n.parentElement, i++) {
      const prev = n.previousElementSibling;
      if (prev && !isDraggable(prev) && (prev.matches(heads) || textOf(prev).length <= 40) && textOf(prev)) return clean(textOf(prev), 60);
      const head = n.parentElement && Array.from(n.parentElement.children).find((c) => c !== n && c.matches(heads));
      if (head) return clean(textOf(head), 60);
    }
    return "";
  }

  const textOf = (node) => clean(node.innerText || node.textContent || "", 200);

  // A <label>'s own words, without the text of the controls inside it
  function labelText(label) {
    const controls = "select, textarea, input, button, [contenteditable], [role='textbox']";
    if (!label.querySelector(controls)) return textOf(label);
    const copy = label.cloneNode(true);
    copy.querySelectorAll(controls).forEach((n) => n.remove());
    return clean(copy.textContent, 200);
  }

  function namedBy(el) {
    const ids = el.getAttribute("aria-labelledby");
    if (!ids) return "";
    const root = el.getRootNode();
    const lookup = (id) => (root.getElementById ? root.getElementById(id) : null) || el.ownerDocument.getElementById(id);
    return ids.split(/\s+/).map(lookup).filter(Boolean).map(textOf).join(" ");
  }

  function labelOf(el) {
    const role = roleOf(el);
    let t = namedBy(el) || el.getAttribute("aria-label") || "";
    if (!t && role === "mathbox") {
      const inner = el.querySelector("textarea, input:not([type=hidden])");
      t = (inner && (namedBy(inner) || inner.getAttribute("aria-label") || inner.getAttribute("placeholder"))) || "";
      if (!t || /^math input$/i.test(t)) {
        const lbl = el.closest("label");
        t = lbl ? labelText(lbl) : t || "math answer";
      }
      return clean(t);
    }
    if (!t && el.labels && el.labels.length) t = Array.from(el.labels).map(labelText).join(" ");
    if (!t && el.tagName === "INPUT" && ["submit", "button", "reset"].includes((el.type || "").toLowerCase())) t = el.value;
    if (!t && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT" && role !== "textbox") t = textOf(el);
    if (!t) t = el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || "";
    if (!t && el.querySelector) {
      const inner = el.querySelector("img[alt], [aria-label], svg title");
      if (inner) t = inner.getAttribute("alt") || inner.getAttribute("aria-label") || inner.textContent || "";
    }
    if (!t) t = el.getAttribute("name") || "";
    return clean(t);
  }

  function groupOf(el) {
    const fs = el.closest("fieldset");
    if (fs) {
      const legend = fs.querySelector("legend");
      if (legend) return textOf(legend);
    }
    const group = el.closest('[role="radiogroup"], [role="group"]');
    if (group) return clean(namedBy(group) || group.getAttribute("aria-label") || "");
    return "";
  }

  function isVisible(el) {
    const view = viewOf(el);
    if (!view) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = view.getComputedStyle(el);
    if (!style || style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none") return false;
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    return true;
  }

  // Visually hidden checkboxes/radios that sit behind a visible label still count
  function isUsable(el, role) {
    if (isVisible(el)) return true;
    if ((role === "checkbox" || role === "radio") && el.labels) return Array.from(el.labels).some(isVisible);
    return false;
  }

  // Fields Claude must never fill: the user types these themselves
  function protectedKind(el) {
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && !el.isContentEditable && roleOf(el) !== "textbox") return "";
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return "password";
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/\bcc-/.test(ac)) return "payment card";
    if (/one-time-code/.test(ac)) return "one-time code";
    if (/(new|current)-password/.test(ac)) return "password";
    const hint = [el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"), namedBy(el),
      el.labels && el.labels.length ? Array.from(el.labels).map(labelText).join(" ") : ""].join(" ").toLowerCase();
    if (/card.?num|cc.?num|credit.?card|debit.?card|\bcvv|\bcvc|\bcsc\b|\bccv\b|security.?code|card.?exp|exp(iry|iration).?(date|month|year)|\bexp.?(mm|yy|month|year)\b/.test(hint)) return "payment card";
    if (/routing.?(number|no)|account.?(number|no)\b|\biban\b|\bswift\b|sort.?code/.test(hint)) return "bank account";
    if (/\bssn\b|social.?security|tax.?id|\bitin\b/.test(hint)) return "ID number";
    if (/one.?time|verification.?code|\b2fa\b|\botp\b|auth(entication)?.?code|security.?pin|\bpin\b/.test(hint)) return "one-time code";
    if (/password|passcode|passphrase/.test(hint)) return "password";
    return "";
  }

  // Clicking this probably submits, sends, pays or deletes something
  function submitsWhat(el) {
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "INPUT" && (type === "submit" || type === "image")) return "submits a form";
    if (tag === "BUTTON" && (type === "submit" || (!type && el.form))) return "submits a form";
    const text = labelOf(el).toLowerCase();
    const m = text.match(/\b(submit|send|pay|purchase|buy|checkout|check out|place order|order|confirm|delete|remove|post|publish|transfer|withdraw|donate|subscribe|unsubscribe|sign up|register|apply|book|reserve|accept|agree|log ?out|sign ?out|cancel|reply|share|upload|save|update|continue to payment)\b/);
    return m ? `is labeled ${quote(clean(labelOf(el), 40))}` : "";
  }

  function isTextField(el) {
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return !["checkbox", "radio", "submit", "button", "reset", "image", "range", "file", "color", "hidden"].includes((el.getAttribute("type") || "text").toLowerCase());
  }

  function deepActive(d) {
    let a = d.activeElement;
    while (a && shadowOf(a) && shadowOf(a).activeElement) a = shadowOf(a).activeElement;
    return a;
  }

  // Element position in the top window's viewport (adds same-site frame offsets)
  function topRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let view = viewOf(el);
    try {
      while (view && view !== win && view.frameElement) {
        const fr = view.frameElement.getBoundingClientRect();
        x += fr.left + view.frameElement.clientLeft;
        y += fr.top + view.frameElement.clientTop;
        view = viewOf(view.frameElement);
      }
    } catch (e) {}
    return { x, y, w: r.width, h: r.height };
  }

  function find(ref) {
    const id = String(ref || "").replace(/[^\w-]/g, "");
    const hits = [];
    walk(doc, (el) => { if (el.getAttribute(REF) === id) hits.push(el); });
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`${id || "That ref"} isn't on the page anymore. Call browser_read to get fresh refs.`);
    throw new Error(`${id} matches more than one element. Call browser_read again.`);
  }

  function checkedOf(el) {
    return el.tagName === "INPUT" ? !!el.checked : el.getAttribute("aria-checked") === "true";
  }

  function fire(el, type) {
    const view = viewOf(el);
    const Ev = type === "input" && view.InputEvent ? view.InputEvent : view.Event;
    el.dispatchEvent(new Ev(type, { bubbles: true, composed: true }));
  }

  // Sets a field's value so React/Vue/etc. notice it
  function setValue(el, value) {
    const view = viewOf(el);
    const proto = el.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? view.HTMLSelectElement.prototype : view.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    fire(el, "input");
  }

  function focusIt(el) {
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (err) {} }
    const root = el.getRootNode();
    return (root.activeElement || el.ownerDocument.activeElement) === el;
  }

  // Scrolls without animation, so positions read right after are where things are
  // (a site's scroll-behavior: smooth would otherwise leave them stale)
  function bringIntoView(el) {
    try { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); }
    catch (e) { el.scrollIntoView({ block: "center", inline: "nearest" }); }
  }

  // inner is outer or inside it (through shadow roots)
  function within(outer, inner) {
    for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  }

  // "span.mq-root-block", "textarea#focusable4": how notes name an element
  function nodeName(n) {
    if (!n || !n.tagName) return "nothing";
    const tag = n.tagName.toLowerCase();
    if (n.id) return clean(`${tag}#${n.id}`, 50);
    const cls = typeof n.className === "string" ? n.className.trim().split(/\s+/)[0] : "";
    return clean(cls ? `${tag}.${cls}` : tag, 50);
  }

  // The deepest element at a point, the way a real click would hit it
  function hitAt(el, x, y) {
    const root = el.getRootNode();
    const src = typeof root.elementFromPoint === "function" ? root : el.ownerDocument;
    let hit = typeof src.elementFromPoint === "function" ? src.elementFromPoint(x, y) : null;
    for (let i = 0; hit && i < 10; i++) {
      const sr = shadowOf(hit);
      const inner = sr && typeof sr.elementFromPoint === "function" ? sr.elementFromPoint(x, y) : null;
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  // The element under a point of the top window, through shadow roots and
  // same-site frames. Returns { el, x, y } with x, y in that element's own
  // window, or null. Over a frame from another site, remote is { bc, x, y }:
  // the point in that frame's own window (its agent finds what's there).
  function deepHit(x, y) {
    let d = doc;
    let lx = x;
    let ly = y;
    let hit = null;
    for (let i = 0; i < 10; i++) {
      hit = typeof d.elementFromPoint === "function" ? d.elementFromPoint(lx, ly) : null;
      for (let j = 0; hit && j < 10; j++) {
        const sr = shadowOf(hit);
        const inner = sr && typeof sr.elementFromPoint === "function" ? sr.elementFromPoint(lx, ly) : null;
        if (!inner || inner === hit) break;
        hit = inner;
      }
      const fd = hit && frameDoc(hit);
      const bc = hit && !fd ? remoteFrame(hit) : null;
      if (!fd && !bc) break;
      const r = hit.getBoundingClientRect();
      const fx = lx - r.left - hit.clientLeft;
      const fy = ly - r.top - hit.clientTop;
      if (bc) return { el: hit, x: lx, y: ly, remote: { bc, x: fx, y: fy } };
      lx = fx;
      ly = fy;
      d = fd;
    }
    return hit ? { el: hit, x: lx, y: ly } : null;
  }

  // A frame's name: its title or label, else nothing (the browser knows its address)
  const frameName = (el) => clean(el.getAttribute("title") || el.getAttribute("aria-label") || el.getAttribute("name") || "", 60);

  // A frame's inside (its content box) in the top window, and how much of it is on screen
  function frameBox(el) {
    const r = topRect(el);
    const x = r.x + el.clientLeft;
    const y = r.y + el.clientTop;
    const w = el.clientWidth || r.w;
    const h = el.clientHeight || r.h;
    const seenW = Math.max(0, Math.min(x + w, win.innerWidth) - Math.max(x, 0));
    const seenH = Math.max(0, Math.min(y + h, win.innerHeight) - Math.max(y, 0));
    return { x, y, w, h, seenW, seenH, visible: isVisible(el) };
  }

  function findFrame(bc) {
    let found = null;
    walk(doc, (el) => { if (!found && remoteFrame(el) === bc) found = el; });
    if (!found) throw new Error("That frame isn't on the page anymore. Call browser_read again.");
    return found;
  }

  // A window's top-left corner in the top window (0, 0 for the top window)
  function frameOffset(view) {
    let x = 0;
    let y = 0;
    try {
      while (view && view !== win && view.frameElement) {
        const fr = view.frameElement.getBoundingClientRect();
        x += fr.left + view.frameElement.clientLeft;
        y += fr.top + view.frameElement.clientTop;
        view = viewOf(view.frameElement);
      }
    } catch (e) {}
    return { x, y };
  }

  // The document's id (refs and screenshots belong to one document)
  function docId() {
    const root = doc.documentElement;
    let id = root.getAttribute("data-zai-doc");
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      root.setAttribute("data-zai-doc", id);
    }
    return id;
  }

  // A point in Claude's latest screenshot → where it is in the window now.
  // shot: { ratio (image px per CSS px), sx, sy (scroll when it was taken), doc,
  //         ox, oy (a close-up: where in the window it starts, CSS px) }
  function fromShot(pt, shot) {
    if (!shot || shot.doc !== docId()) throw new Error("The page changed since your screenshot. Take a new browser_screenshot and use points from it.");
    const ratio = Number(shot.ratio) || 1;
    const x = Number(pt && pt.x) / ratio + (Number(shot.ox) || 0) - (win.scrollX - (Number(shot.sx) || 0));
    const y = Number(pt && pt.y) / ratio + (Number(shot.oy) || 0) - (win.scrollY - (Number(shot.sy) || 0));
    if (!(x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight)) {
      throw new Error("That point isn't on screen anymore (the page has scrolled since your screenshot). Take a new browser_screenshot.");
    }
    return { x, y };
  }

  // A point in this window's own CSS pixels (a frame from another site gets
  // its points from the window around it, already mapped)
  function fromLocal(pt) {
    const x = Number(pt && pt.x);
    const y = Number(pt && pt.y);
    if (!(x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight)) throw new Error("That point isn't inside the frame anymore. Take a new browser_screenshot.");
    return { x, y };
  }

  // What's at a point: the control it's part of (a button, a slider…) if
  // any, else the shape itself, named by the nearest label around it.
  // shot: Claude's screenshot (pt in its pixels); local: pt is in this
  // window's CSS pixels instead.
  function spotAt(pt, shot, local = false) {
    const p = local ? fromLocal(pt) : fromShot(pt, shot);
    const hit = deepHit(p.x, p.y);
    if (!hit) throw new Error("There's nothing at that point.");
    if (hit.remote) {
      // A frame from another site: its own agent says what's there
      return { found: true, remote: hit.remote, el: hit.el, hit: hit.el, at: { x: hit.x, y: hit.y }, x: p.x, y: p.y, role: "frame", label: frameName(hit.el), what: nodeName(hit.el), frame: true, protected: "", submits: "", ref: "", rect: topRect(hit.el) };
    }
    const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
    let widget = null;
    for (let n = hit.el; n && n.nodeType === 1; n = up(n)) {
      if (n === n.ownerDocument.body || n === n.ownerDocument.documentElement) break;
      if (roleOf(n) || isArea(n)) { widget = n; break; }
    }
    let label = widget ? nameOf(widget) : "";
    for (let n = hit.el, i = 0; !widget && !label && n && n.nodeType === 1 && i < 5; n = up(n), i++) {
      const title = n.querySelector && n.querySelector(":scope > title");
      label = clean(namedBy(n) || n.getAttribute("aria-label") || n.getAttribute("title") || (title ? title.textContent : ""), 60);
    }
    const role = widget ? roleOf(widget) || "drop area" : "";
    const view = viewOf(hit.el);
    const off = frameOffset(view);
    return {
      found: true,
      el: widget || hit.el,
      hit: hit.el,
      at: { x: hit.x, y: hit.y }, // in the element's own window
      x: p.x,
      y: p.y,
      role: role === "select" ? "dropdown" : role === "mathbox" ? "math box" : role || "spot",
      label,
      what: nodeName(hit.el),
      frame: hit.el.tagName === "IFRAME" || hit.el.tagName === "FRAME",
      protected: widget ? protectedKind(widget) : "",
      submits: widget && (role === "button" || role === "link") ? submitsWhat(widget) : "",
      ref: widget ? widget.getAttribute(REF) || "" : "",
      rect: widget ? topRect(widget) : { x: off.x + hit.x - 14, y: off.y + hit.y - 14, w: 28, h: 28 },
    };
  }
  // A spot as plain data (what goes back to the browser)
  const spotData = (s) => {
    const out = Object.assign({}, s);
    delete out.el;
    delete out.hit;
    delete out.at;
    return out;
  };

  // Where to click: the centre, else a grid across the element, using the
  // first point whose hit-test lands on the element or inside it. A point
  // over something else is never used for a real click.
  function clickPoint(el) {
    const view = viewOf(el);
    const r = el.getBoundingClientRect();
    let over = null; // the element's parent at the point (e.g. el has pointer-events: none)
    let blocker = null;
    for (const fy of [0.5, 0.25, 0.75]) {
      for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) continue;
        const hit = hitAt(el, x, y);
        if (hit && within(el, hit)) return { x, y, hit, ok: true };
        if (hit && !over && within(hit, el)) over = { x, y, hit, ok: true };
        if (hit && !blocker) blocker = hit;
      }
    }
    return over || { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: null, ok: false, blocker };
  }

  // Where a mousedown would put focus: the nearest focusable element around the target
  function focusTargetOf(node) {
    const FOCUSABLE = "a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable='true'], [contenteditable='']";
    for (let n = node; n; n = n.parentNode || n.host) {
      if (n.nodeType === 1 && n.matches(FOCUSABLE) && !n.disabled) return n;
    }
    return null;
  }

  // Can be typed into: a text field, contenteditable, a textbox role or a math box
  function isTextEntry(el) {
    const role = roleOf(el);
    return isTextField(el) || el.isContentEditable || role === "textbox" || role === "searchbox" || role === "mathbox";
  }

  // After clicking into a text box: is focus in it? If not, focus its own
  // input (math editors keep a hidden textarea inside, or right next to it).
  // Returns the element typing should go to, or null.
  function focusTextEntry(el) {
    const now = deepActive(el.ownerDocument);
    if (now && within(el, now)) return { node: now, how: "" };
    const typable = (n) => !n.disabled && !n.readOnly && !protectedKind(n) &&
      (n.tagName === "TEXTAREA" || (n.tagName === "INPUT" && isTextField(n)) || n.isContentEditable);
    const inside = Array.from(el.querySelectorAll("textarea, input, [contenteditable]")).filter(typable);
    // A hidden input right next to the box, only if there's exactly one
    const near = !inside.length && el.parentElement
      ? Array.from(el.parentElement.querySelectorAll("textarea, input")).filter((n) => typable(n) && !within(n, el) && !isVisible(n))
      : [];
    for (const n of inside.length ? inside : near.length === 1 ? near : []) {
      if (focusIt(n)) return { node: n, how: "focused directly" };
    }
    return null;
  }

  // In Zen the page usually doesn't have keyboard focus while the user is in
  // the chat; some sites only react to focus once it does
  function pageFocusNote(el) {
    try { return el.ownerDocument.hasFocus() ? "" : " (The page itself doesn't have keyboard focus right now; it's in the browser's own UI.)"; } catch (e) { return ""; }
  }

  // Real mouse events, the way Firefox makes them for its own tests: trusted,
  // and hit-tested by the page like a person's. window.synthesizeMouseEvent
  // in current Firefox, windowUtils.sendMouseEvent in older ones; null where
  // neither exists (Chromium, in tests). toWindow keeps the events in this
  // window's process: the other route goes through the browser's parent
  // process, which closes the tab outside of Firefox's test builds.
  // o: { buttons, clickCount, pressure } (left out: what the type implies)
  function realMouse(view) {
    if (typeof view.synthesizeMouseEvent === "function") {
      return (type, x, y, o = {}) => view.synthesizeMouseEvent(type, x, y, { button: 0, buttons: o.buttons, clickCount: o.clickCount, pressure: o.pressure }, { toWindow: true });
    }
    const u = view.windowUtils;
    if (u && typeof u.sendMouseEvent === "function") {
      const press = (type) => type === "mousedown" || type === "mouseup";
      // (type, x, y, button, clickCount, modifiers, ignoreRootScrollFrame, pressure, inputSource: mouse, isDOMEventSynthesized, isWidgetEventSynthesized, buttons: -1 = from the type)
      return (type, x, y, o = {}) => u.sendMouseEvent(type, x, y, 0, o.clickCount === undefined ? (press(type) ? 1 : 0) : o.clickCount, 0, false, o.pressure || 0, 1, true, false, o.buttons === undefined ? -1 : o.buttons);
    }
    return null;
  }

  // Clicks like a person: real mouse events (Firefox) at a point a hit-test
  // confirms is on the element. If they don't reach it, mouse events are sent
  // straight to the element under that point. For text boxes, focus is
  // checked afterwards. Returns { note, focus } (focus: where typing goes).
  // at: a fixed point instead ({ x, y, hit, ok: true }, from a screenshot):
  // nothing is scrolled, so the point stays where Claude saw it.
  function clickElement(el, at = null) {
    const view = viewOf(el);
    const role = roleOf(el);
    if (!at) {
      bringIntoView(el);
      // Hidden native checkbox/radio behind a styled label: click it directly
      if ((role === "checkbox" || role === "radio") && el.tagName === "INPUT" && !isVisible(el)) {
        el.click();
        return { note: "", focus: null };
      }
    }
    const spot = at || clickPoint(el);
    const { x, y } = spot;
    const notes = [];
    if (!spot.ok) {
      const b = spot.blocker;
      const what = b ? labelOf(b) || textOf(b).slice(0, 40) : "";
      notes.push(b
        ? `Something was on top of it (${roleOf(b) || b.tagName.toLowerCase()}${what ? " " + quote(what) : ""}), so it was clicked directly. If nothing happened, close whatever covers it first.`
        : "It couldn't be scrolled into view, so it was clicked directly.");
    }

    // What the events should reach: the element, or the parent that takes its
    // clicks (pointer-events: none), so a click there isn't sent twice
    const aim = spot.ok && spot.hit && !within(el, spot.hit) ? spot.hit : el;
    let pressed = false;
    let clicked = false;
    const watchDown = (e) => { try { if (e.composedPath().includes(aim)) pressed = true; } catch (err) {} };
    const watchClick = (e) => { try { if (e.composedPath().includes(aim)) clicked = true; } catch (err) {} };
    view.addEventListener("mousedown", watchDown, true);
    view.addEventListener("click", watchClick, true);
    let real = false;
    try {
      // Real mouse events (Firefox), only at a point that's on the element
      const mouse = spot.ok ? realMouse(view) : null;
      if (mouse) {
        mouse("mousemove", x, y);
        mouse("mousedown", x, y);
        mouse("mouseup", x, y);
        real = true;
      }
    } catch (e) {}
    // Nothing reached it: send the events ourselves, to what's under the
    // point (a child like MathQuill's .mq-root-block), in a real click's order
    if (!pressed && !clicked) {
      const target = spot.ok && spot.hit && within(el, spot.hit) ? spot.hit : el;
      const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
      const P = view.PointerEvent || view.MouseEvent;
      const pointer = (type, buttons) => new P(type, Object.assign({ pointerId: 1, isPrimary: true, pointerType: "mouse" }, base, { buttons }));
      const mouse = (type, buttons, detail) => new view.MouseEvent(type, Object.assign({}, base, { buttons, detail }));
      try {
        target.dispatchEvent(pointer("pointerover", 0));
        target.dispatchEvent(mouse("mouseover", 0, 0));
        target.dispatchEvent(pointer("pointermove", 0));
        target.dispatchEvent(mouse("mousemove", 0, 0));
        target.dispatchEvent(pointer("pointerdown", 1));
        // Like a browser: focus moves on mousedown unless the page prevents it
        if (target.dispatchEvent(mouse("mousedown", 1, 1))) {
          const f = focusTargetOf(target);
          if (f) focusIt(f);
        }
        target.dispatchEvent(pointer("pointerup", 0));
        target.dispatchEvent(mouse("mouseup", 0, 1));
        target.dispatchEvent(mouse("click", 0, 1));
      } catch (e) {
        el.click();
      }
      if (spot.ok) notes.push(`Mouse events were sent straight to ${nodeName(target)}${real ? " (the real click didn't reach it)" : ""}.`);
    } else if (pressed && !clicked) {
      notes.push("It was pressed, but no click followed (the page changed under the pointer).");
    }
    view.removeEventListener("mousedown", watchDown, true);
    view.removeEventListener("click", watchClick, true);

    // A text box: say where focus ended up, and put it in the box if the click didn't
    let focus = null;
    if (isTextEntry(el)) {
      const got = focusTextEntry(el);
      focus = got && got.node;
      if (got && !got.how) notes.push(`Focus is in ${nodeName(got.node)}.`);
      else if (got) notes.push(`The click didn't focus it, so its ${nodeName(got.node)} was focused directly.`);
      else notes.push(`It didn't take focus (${nodeName(deepActive(el.ownerDocument))} has it), so typing won't reach it.${pageFocusNote(el)}`);
    }
    return { note: notes.join(" "), focus };
  }

  // A saved secret (from the user's _secrets.md, sent by the browser, never
  // by Claude) into a protected field of the same kind. Never says the value.
  // A field that shows it in plain text is marked, so screenshots wait.
  function fillSecret(el, secret) {
    const prot = protectedKind(el);
    if (!prot || prot !== secret.kind) throw new Error(prot ? `That's a ${prot} field, not a ${secret.kind} field.` : `That isn't a protected ${secret.kind} field, so a saved secret can't go there.`);
    if (!isTextField(el) && !el.isContentEditable) throw new Error("That field can't be typed into.");
    try { typeInto(el, String(secret.value), false); } catch (e) { throw new Error("Couldn't type into that field."); }
    if ((el.getAttribute("type") || "").toLowerCase() !== "password") el.setAttribute("data-zai-secret", secret.kind);
    return el.value === String(secret.value) ? "" : "The site changed how it shows the value (it may have reformatted it).";
  }

  function typeInto(el, text, append) {
    const d = el.ownerDocument;
    bringIntoView(el);
    if (isTextField(el)) {
      const before = el.value || "";
      const target = append ? before + text : text;
      const focused = focusIt(el);
      let ok = false;
      if (focused) {
        try {
          if (append) el.setSelectionRange(before.length, before.length);
          else el.select();
        } catch (e) {}
        try { ok = text === "" ? d.execCommand("delete") : d.execCommand("insertText", false, text); } catch (e) {}
      }
      if (!ok || el.value !== target) setValue(el, target);
      fire(el, "change");
      if (target && !el.value) throw new Error("The field is still empty after typing: the site cleared or rejected it.");
      return el.value === target ? "" : `The field now reads ${quote(clean(el.value, 60))} (the site may have reformatted it).`;
    }
    if (el.isContentEditable || roleOf(el) === "textbox") {
      const view = viewOf(el);
      focusIt(el);
      let ok = false;
      try {
        const sel = view.getSelection();
        const range = d.createRange();
        range.selectNodeContents(el);
        if (append) range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        ok = text === "" ? d.execCommand("delete") : d.execCommand("insertText", false, text);
      } catch (e) {}
      if (!ok) {
        el.textContent = append ? (el.textContent || "") + text : text;
        fire(el, "input");
      }
      if (text.trim() && !(el.textContent || "").trim()) throw new Error("The box is still empty after typing: the site cleared or rejected it.");
      return "";
    }
    throw new Error("That element isn't a text field.");
  }

  const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

  function keyTip(view) {
    try {
      const tip = Components.classes["@mozilla.org/text-input-processor;1"].createInstance(Components.interfaces.nsITextInputProcessor);
      return tip.beginInputTransactionForTests(view) ? tip : null;
    } catch (e) {
      return null;
    }
  }

  // Types text as separate key presses. {Right} {Left} {Up} {Down} {Backspace}
  // {Tab} press those keys (Enter isn't allowed here: it can submit).
  function typeKeys(el, text) {
    const d = el.ownerDocument;
    const view = viewOf(el);
    const tip = keyTip(view);
    const tokens = String(text).match(/\{(Right|Left|Up|Down|Backspace|Delete|Tab|Home|End)\}|[\s\S]/g) || [];
    for (const tok of tokens) {
      const special = tok.length > 1 ? tok.slice(1, -1) : "";
      const key = special ? (/^(Right|Left|Up|Down)$/.test(special) ? "Arrow" + special : special) : tok;
      const keyCode = special ? KEY_CODES[key] : /[a-z0-9]/i.test(tok) ? tok.toUpperCase().charCodeAt(0) : 0;
      if (tip) {
        try {
          const ev = new view.KeyboardEvent("", { key, code: special ? key : "", keyCode });
          tip.keydown(ev);
          tip.keyup(ev);
          continue;
        } catch (e) {}
      }
      const target = deepActive(d) || el;
      const init = { key, keyCode, which: keyCode, charCode: special ? 0 : tok.charCodeAt(0), bubbles: true, cancelable: true, composed: true };
      const go = target.dispatchEvent(new view.KeyboardEvent("keydown", init));
      if (!special && go) {
        target.dispatchEvent(new view.KeyboardEvent("keypress", init));
        let ok = false;
        try { ok = d.execCommand("insertText", false, tok); } catch (e) {}
        if (!ok && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) setValue(target, (target.value || "") + tok);
      }
      target.dispatchEvent(new view.KeyboardEvent("keyup", init));
    }
  }

  function mathText(el) {
    return clean(el.textContent || "", 80);
  }

  function typeMath(el, text, append) {
    const kind = mathKind(el);
    const wanted = /\S/.test(String(text).replace(/\{\w+\}/g, ""));
    bringIntoView(el);
    const api = mathApi(el, kind);
    if (api) {
      api.set(text, append);
      const now = clean(api.get(), 100);
      if (wanted && !now) throw new Error(`The ${kind} box is still empty after setting it. Click it and try again, or ask the user to type the answer.`);
      return `The ${kind} box now holds the LaTeX ${quote(now)}.`;
    }
    // No editor API reachable: click into it and press the keys one by one,
    // but only once focus is really in it (else keys would land elsewhere)
    const before = mathText(el);
    const { note, focus } = clickElement(el);
    if (!focus) throw new Error(`Couldn't get the cursor into the math box, so nothing was typed. ${note}`.trim());
    const stillThere = () => { const a = deepActive(el.ownerDocument); return a === focus || within(el, a); };
    if (!append) {
      const n = Math.min(200, (el.textContent || "").length + 8);
      typeKeys(el, "{End}" + "{Backspace}".repeat(n));
    }
    if (!stillThere()) throw new Error("Focus left the math box while clearing it, so nothing more was typed.");
    typeKeys(el, text);
    const after = mathText(el);
    if (wanted && (!after || (append && after === before))) {
      throw new Error(`Typed the keys, but the box ${after ? "didn't change" : "is still empty"}: they didn't reach it.${pageFocusNote(el)} Click the box and try again, or ask the user to type the answer.`);
    }
    return `Typed key by key; the box now shows ${quote(after)}.`;
  }

  function chooseOption(el, option) {
    if (el.tagName !== "SELECT") throw new Error("That's a custom dropdown: click it to open it (the result lists the options that appear), then click the option.");
    const want = clean(option, 200).toLowerCase();
    const opts = Array.from(el.options);
    const name = (o) => clean(o.label || o.text, 200).toLowerCase();
    const match = opts.find((o) => name(o) === want) || opts.find((o) => o.value.toLowerCase() === want) || opts.find((o) => want && name(o).includes(want));
    if (!match) throw new Error(`No option ${quote(option)}. The options are: ${opts.map((o) => clean(o.label || o.text, 40)).slice(0, 30).join(" | ")}`);
    bringIntoView(el);
    focusIt(el);
    setValue(el, match.value);
    fire(el, "change");
    return clean(match.label || match.text, 60);
  }

  function setChecked(el, want) {
    if (checkedOf(el) === want) return "it was already " + (want ? "checked" : "unchecked");
    if (roleOf(el) === "radio" && !want) throw new Error("A radio button can't be unchecked; pick a different option instead.");
    clickElement(el);
    if (checkedOf(el) !== want) throw new Error("It didn't change; it may need a different click target. Call browser_read and try clicking its label.");
    return "";
  }

  function truthy(v) {
    return /^(true|yes|y|1|on|checked|check|selected)$/i.test(String(v).trim());
  }

  // --- Reading the page ---
  // How long a slider's track is: the input itself, or (an ARIA slider's
  // thumb) the first ancestor much longer than it
  function sliderTrack(el) {
    const vertical = el.getAttribute("aria-orientation") === "vertical";
    const size = (n) => { const r = n.getBoundingClientRect(); return vertical ? r.height : r.width; };
    const own = size(el);
    if (el.tagName !== "INPUT") {
      for (let n = el.parentElement, i = 0; n && i < 3; n = n.parentElement, i++) {
        if (size(n) > own * 3) return { px: Math.round(size(n)), vertical };
      }
    }
    return { px: Math.round(own), vertical };
  }

  function describeValue(el, role, prot) {
    const bits = [];
    if (role === "textbox" && el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type !== "text") bits.push(`type=${type}`);
    }
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (ac && ac !== "on" && ac !== "off" && FIELD_ROLES.has(role)) bits.push(`autocomplete=${clean(ac, 30)}`);
    if (el.required || el.getAttribute("aria-required") === "true") bits.push("required");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
    if (el.readOnly) bits.push("read-only");
    if (prot) {
      bits.push(`PROTECTED ${prot}: never type it; use a matching saved secret if one is listed, else the user fills it in${el.value ? " (has a value)" : ""}`);
      return bits;
    }
    if (role === "droparea") {
      const n = Array.from(el.querySelectorAll("*")).filter(isDraggable).length;
      bits.push(n ? `(${n} item${n === 1 ? "" : "s"})` : "(empty)");
      return bits;
    }
    if (role === "mathbox") {
      const kind = mathKind(el);
      const api = mathApi(el, kind);
      bits.push(`(${kind})`);
      if (api) bits.push(`input=LaTeX value=${quote(clean(api.get(), 100))}`);
      else bits.push(`input=keys (type it like a calculator: ^ for a power, / for a fraction, \\sqrt for a square root, {Right} to step out of a power, fraction or root, e.g. x^2{Right}+1 or \\sqrt2{Right}/3) shows=${quote(mathText(el))}`);
      return bits;
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      bits.push(checkedOf(el) ? "checked" : "unchecked");
      const group = groupOf(el);
      if (group) bits.push(`group=${quote(clean(group, 60))}`);
    } else if (el.tagName === "SELECT") {
      const opts = Array.from(el.options);
      const chosen = opts.filter((o) => o.selected).map((o) => clean(o.label || o.text, 40));
      bits.push(`selected=${quote(chosen.join(", "))}`);
      bits.push(`options: ${opts.slice(0, 25).map((o) => clean(o.label || o.text, 40)).join(" | ")}${opts.length > 25 ? ` | …(${opts.length - 25} more)` : ""}`);
    } else if (isTextField(el)) {
      bits.push(`value=${quote(clean(el.value, 100))}`);
      const ph = el.getAttribute("placeholder");
      if (ph && clean(ph) !== labelOf(el)) bits.push(`placeholder=${quote(clean(ph, 50))}`);
    } else if (role === "textbox") {
      bits.push(`value=${quote(clean(el.innerText || el.textContent, 100))}`);
    } else if (role === "slider") {
      bits.push(`value=${clean(el.value || el.getAttribute("aria-valuenow"), 20)}`);
      // Range and track length, so a drag by an offset can be worked out
      const min = el.tagName === "INPUT" ? el.min || "0" : el.getAttribute("aria-valuemin");
      const max = el.tagName === "INPUT" ? el.max || "100" : el.getAttribute("aria-valuemax");
      if (min !== null && max !== null && min !== "" && max !== "") bits.push(`range=${clean(min, 12)}–${clean(max, 12)}`);
      const track = sliderTrack(el);
      if (track.px) bits.push(`track=${track.px}px${track.vertical ? " tall" : ""}`);
    } else if (role === "file") {
      bits.push("file upload: the user picks the file themselves");
    }
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) bits.push(expanded === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") bits.push("current");
    if (role === "link") {
      try {
        const url = new win.URL(el.href);
        const here = viewOf(el).location;
        bits.push("→ " + clean(url.host === here.host ? url.pathname + url.search : url.host + url.pathname, 70));
      } catch (e) {}
    }
    const sub = role === "button" || role === "link" ? submitsWhat(el) : "";
    if (sub === "submits a form") bits.push("(submits form)");
    return bits;
  }

  function snapshot() {
    // Refs stay the same while the page is open, so later looks can send
    // Claude just what changed. A new document starts over with a new id.
    const root = doc.documentElement;
    const id = docId();
    let nextRef = parseInt(root.getAttribute("data-zai-next"), 10) || 1;
    const hadRef = [];
    const candidates = [];
    const kept = new Set();
    const headings = [];
    const dialogs = [];
    const order = new Map(); // page order, to slot drop areas in
    const draggables = [];
    const marked = [];
    const graphics = []; // big <svg>s and <canvas>es (they may hold controls without refs)
    const remotes = []; // frames from other sites (read by their own agents)
    walk(doc, (el) => {
      order.set(el, order.size);
      if (el.matches(DROP_MARKS)) marked.push(el);
      if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && remotes.length < 20) {
        const bc = remoteFrame(el);
        if (bc !== null) remotes.push({ bc, el });
      }
      if ((el.tagName === "CANVAS" || (el.tagName.toLowerCase() === "svg" && !(el.parentElement && el.parentElement.closest("svg")))) && graphics.length < 40) {
        const r = el.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 60) graphics.push(el);
      }
      if (el.hasAttribute(REF)) {
        hadRef.push(el);
        const n = parseInt(String(el.getAttribute(REF)).slice(1), 10);
        if (n >= nextRef) nextRef = n + 1;
      }
      const tag = el.tagName;
      if (/^H[1-3]$/.test(tag)) {
        if (headings.length < 25 && isVisible(el)) headings.push("#".repeat(+tag[1]) + " " + textOf(el).slice(0, 90));
        return;
      }
      if ((tag === "DIALOG" && el.open) || (el.getAttribute("role") === "dialog" || el.getAttribute("role") === "alertdialog")) {
        if (isVisible(el)) dialogs.push(clean(namedBy(el) || el.getAttribute("aria-label") || textOf(el), 80));
      }
      const role = roleOf(el);
      if (!role) return;
      if (insideMath(el)) return;
      // A button/link inside another listed button/link is the same click target
      const outer = el.parentElement && el.parentElement.closest("a[href], button, [role='button'], [role='link']");
      if (outer && kept.has(outer) && !FIELD_ROLES.has(role)) return;
      if (!isUsable(el, role)) return;
      kept.add(el);
      candidates.push({ el, role });
      if (role === "draggable") draggables.push(el);
    });
    // Drop areas (only on pages with something to drag or marked targets)
    if (draggables.length || marked.length) {
      for (const box of dropAreas(draggables, marked)) {
        if (!kept.has(box) && order.has(box) && isVisible(box)) candidates.push({ el: box, role: "droparea" });
      }
      candidates.sort((a, b) => order.get(a.el) - order.get(b.el));
    }

    // Too many? Keep every field and button, then links in page order
    let chosen = candidates;
    if (candidates.length > MAX_ITEMS) {
      const important = candidates.filter((c) => c.role !== "link");
      const room = Math.max(0, MAX_ITEMS - important.length);
      const links = candidates.filter((c) => c.role === "link").slice(0, room);
      const keep = new Set([...important.slice(0, MAX_ITEMS), ...links]);
      chosen = candidates.filter((c) => keep.has(c));
    }

    // Elements that dropped off the list lose their ref
    const chosenEls = new Set(chosen.map((c) => c.el));
    for (const el of hadRef) if (!chosenEls.has(el)) el.removeAttribute(REF);

    const lines = [];
    const rows = []; // [ref, line without its position, position, group]
    const usedRefs = new Set();
    // Group = the form (or dialog/section) an element is in, so a list of
    // changes can also mention that form's buttons
    const groups = new Map();
    const groupOf = (el) => {
      const g = el.form || (el.closest && (el.closest("form") || el.closest("dialog, [role='dialog'], [role='alertdialog']") || el.closest("fieldset, section")));
      if (!g) return -1;
      if (!groups.has(g)) groups.set(g, groups.size);
      return groups.get(g);
    };
    let lastForm = null;
    const vh = win.innerHeight;
    // In a frame from another site: refs are shown with the frame's name
    // (f2.e5), and "in view" also means the frame itself is (offset: where
    // the frame is in the tab, vh: the tab's height)
    const P = String(args.prefix || "");
    const offY = args.offset ? Number(args.offset.y) || 0 : 0;
    const tabVh = Number(args.vh) || vh;
    chosen.forEach((c) => {
      let ref = c.el.getAttribute(REF);
      // New element, or a copy of one (cloned nodes carry the attribute)
      if (!ref || !/^e\d+$/.test(ref) || usedRefs.has(ref)) {
        ref = "e" + nextRef++;
        c.el.setAttribute(REF, ref);
      }
      usedRefs.add(ref);
      const form = c.el.form || (c.el.closest && c.el.closest("form"));
      if (form !== lastForm) {
        if (form) {
          const name = clean(namedBy(form) || form.getAttribute("aria-label") || form.getAttribute("name") || form.id || "", 50);
          lines.push(`— form${name ? " " + quote(name) : ""} —`);
        } else if (lastForm) {
          lines.push("— end of form —");
        }
        lastForm = form;
      }
      const prot = protectedKind(c.el);
      const label = labelOf(c.el);
      const r = topRect(c.el);
      const where = r.y + r.h < 0 || r.y + offY + r.h < 0 ? "(above view)" : r.y > vh || r.y + offY > tabVh ? "(below view)" : "";
      const role = c.role === "select" ? "dropdown" : c.role === "mathbox" ? "math box" : c.role === "droparea" ? "drop area" : c.role;
      const shown = c.role === "droparea" ? areaLabel(c.el) : label;
      const line = [`[${P}${ref}]`, role, shown ? quote(shown) : "(no label)", ...describeValue(c.el, c.role, prot)].filter(Boolean).join(" ");
      lines.push(where ? `${line} ${where}` : line);
      rows.push([P + ref, line, where, groupOf(c.el)]);
    });
    root.setAttribute("data-zai-next", String(nextRef));

    // Graphics with nothing listed inside them: sliders, graph points or
    // buttons drawn in SVG or on a canvas can only be reached by a point
    const bare = graphics.filter((g) => isVisible(g) && !chosen.some((c) => within(g, c.el) || within(c.el, g))).slice(0, 4).map((g) => {
      const r = g.getBoundingClientRect();
      const title = g.querySelector(":scope > title");
      const name = clean(namedBy(g) || g.getAttribute("aria-label") || g.getAttribute("title") || (title ? title.textContent : ""), 50);
      return `${g.tagName.toLowerCase()} ${Math.round(r.width)}×${Math.round(r.height)}${name ? " " + quote(name) : ""}`;
    });

    const scrollMax = Math.max(1, doc.documentElement.scrollHeight - vh);
    const pct = scrollMax <= 1 ? 100 : Math.round(Math.min(100, (win.scrollY / scrollMax) * 100));
    const out = [];
    if (dialogs.length) out.push(`A dialog is open: ${dialogs.map(quote).join(", ")}`);
    if (headings.length) out.push("Headings:\n" + headings.join("\n"));
    out.push(`Interactive elements (${chosen.length}${candidates.length > chosen.length ? ` of ${candidates.length}; scroll or use include_text for the rest` : ""}):\n` + (lines.length ? lines.join("\n") : "(none found)"));
    if (bare.length) out.push(`Drawn graphics with no refs inside: ${bare.join(", ")}. To click or drag something in one, take a browser_screenshot and use points from it.`);
    out.push(`Scrolled ${pct}% down the ${P ? "frame" : "page"}.`);
    const frames = remotes.map((f) => Object.assign({ bc: f.bc, name: frameName(f.el) }, frameBox(f.el)));
    const snap = { url: String(win.location.href), title: String(doc.title || ""), text: out.join("\n\n"), docId: id, rows, headings, dialogs, pct, frames, vw: win.innerWidth, vh };
    // A frame's words (the tab's own come from the browser's page reader)
    if (args.withText) snap.bodyText = String((doc.body && (doc.body.innerText || doc.body.textContent)) || "").replace(/[ \t\r]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 8000);
    return snap;
  }

  // A listed element with no role of its own is a drop area
  const isArea = (el) => !roleOf(el) && el.hasAttribute(REF);
  const nameOf = (el) => (isArea(el) ? areaLabel(el) : labelOf(el));

  function describe(refs, focus, points = [], shot = null, local = false) {
    const items = refs.map((ref, i) => {
      let el;
      try { el = find(ref); } catch (e) { return { ref, found: false, error: e.message }; }
      if (focus && i === 0) bringIntoView(el);
      const role = roleOf(el) || (isArea(el) ? "droparea" : el.tagName.toLowerCase());
      const item = {
        ref,
        found: true,
        role: role === "select" ? "dropdown" : role === "mathbox" ? "math box" : role === "droparea" ? "drop area" : role,
        label: nameOf(el),
        protected: protectedKind(el),
        submits: role === "button" || role === "link" ? submitsWhat(el) : "",
        rect: topRect(el),
        textField: isTextField(el) || el.isContentEditable || role === "textbox" || role === "mathbox",
        math: role === "mathbox" ? mathKind(el) : "",
      };
      if (el.tagName === "SELECT") item.options = Array.from(el.options).map((o) => clean(o.label || o.text, 40)).slice(0, 40);
      if (role === "checkbox" || role === "radio" || role === "switch") item.checked = checkedOf(el);
      return item;
    });
    // Points from Claude's screenshot (see fromShot)
    const spots = points.map((pt) => {
      try { return spotData(spotAt(pt, shot, local)); } catch (e) { return { found: false, error: e.message }; }
    });
    return { items, spots, scroll: { x: win.scrollX, y: win.scrollY }, url: String(win.location.href), title: String(doc.title || "") };
  }

  function pressKey(key, el) {
    const CODES = Object.assign({ Space: 32 }, KEY_CODES);
    if (!(key in CODES)) throw new Error(`Unsupported key ${quote(key)}.`);
    if (el) {
      bringIntoView(el);
      focusIt(el);
    }
    const target = deepActive(doc) || doc.body;
    const view = viewOf(target);
    const keyName = key === "Space" ? " " : key;
    const code = key === "Space" ? "Space" : key;
    const keyCode = CODES[key];
    let sent = false;
    try {
      // Real key presses (Firefox), so default actions like submitting a form happen naturally
      const tip = Components.classes["@mozilla.org/text-input-processor;1"].createInstance(Components.interfaces.nsITextInputProcessor);
      if (tip.beginInputTransactionForTests(view)) {
        const ev = new view.KeyboardEvent("", { key: keyName, code, keyCode });
        tip.keydown(ev);
        tip.keyup(ev);
        sent = true;
      }
    } catch (e) {}
    if (!sent) {
      const init = { key: keyName, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
      const go = target.dispatchEvent(new view.KeyboardEvent("keydown", init));
      if (keyName === "Enter" && go) {
        target.dispatchEvent(new view.KeyboardEvent("keypress", init));
        if (target.tagName === "INPUT" && target.form && isTextField(target)) {
          if (target.form.requestSubmit) target.form.requestSubmit();
          else target.form.submit();
        }
      }
      target.dispatchEvent(new view.KeyboardEvent("keyup", init));
    }
    return { target: target === doc.body ? "the page" : labelOf(target) || roleOf(target) || target.tagName.toLowerCase() };
  }

  // Timers for waits: Firefox's own in the frame script, the page's elsewhere (tests)
  const timers = []; // kept, so they aren't collected before they fire
  function later(fn, ms) {
    try {
      const t = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
      t.initWithCallback({ notify: fn }, ms, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
      timers.push(t);
    } catch (e) {
      win.setTimeout(fn, ms);
    }
  }
  const pause = (ms) => new Promise((resolve) => later(resolve, ms));

  // Waits until the page stops changing: at least minMs, then until there have
  // been no DOM changes for quietMs (maxMs at most). Resolves with how long it
  // took. Firefox's own timers in the frame script; the page's setTimeout
  // elsewhere (tests).
  function waitQuiet(minMs, quietMs, maxMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      let last = start;
      let changes = 0;
      let obs = null;
      try {
        obs = new win.MutationObserver(() => { last = Date.now(); changes++; });
        obs.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (e) {
        quietMs = Math.max(quietMs, 250); // can't watch: just wait a little
      }
      const tick = () => {
        const now = Date.now();
        if ((now - start >= minMs && now - last >= quietMs) || now - start >= maxMs) {
          try { if (obs) obs.disconnect(); } catch (e) {}
          resolve({ waited: now - start, changes, quiet: now - last >= quietMs });
        } else {
          later(tick, 30);
        }
      };
      later(tick, 30);
    });
  }

  // --- Drag and drop ---
  // Two kinds on the web: libraries that follow the mouse (sortable lists,
  // sliders, graph points) get a real press, moves and release; HTML5
  // draggable items get the drag events, sharing one DataTransfer.
  const DRAG_STEPS = 12;

  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    const view = viewOf(el);
    return r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth;
  };

  // Where to drop: on the target (a point a hit-test confirms is on it), or
  // before/after it in its list (its first or last quarter, along the way the
  // list runs)
  function dropPoint(target, position) {
    const r = target.getBoundingClientRect();
    if (position !== "before" && position !== "after") {
      const p = clickPoint(target);
      return { x: p.x, y: p.y };
    }
    const sib = target.previousElementSibling || target.nextElementSibling;
    let across = false;
    if (sib) {
      const s = sib.getBoundingClientRect();
      across = Math.abs(s.top - r.top) < r.height / 2 && Math.abs(s.left - r.left) >= r.width / 2;
    }
    const f = position === "before" ? 0.25 : 0.75;
    return across ? { x: r.left + r.width * f, y: r.top + r.height / 2 } : { x: r.left + r.width / 2, y: r.top + r.height * f };
  }

  // A small first move (libraries wait for a few pixels before a drag
  // starts), the way there in steps, and one last move on the spot
  function dragPath(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nudge = Math.min(6, len / 2);
    const pts = [{ x: from.x + (dx / len) * nudge, y: from.y + (dy / len) * nudge }];
    for (let i = 1; i <= DRAG_STEPS; i++) pts.push({ x: from.x + (dx * i) / DRAG_STEPS, y: from.y + (dy * i) / DRAG_STEPS });
    pts.push({ x: to.x, y: to.y });
    return pts;
  }

  async function dragMouse(source, from, to) {
    const view = viewOf(source);
    const path = dragPath(from, to);
    // A real press on a link or image would start the browser's own drag
    const noNativeDrag = (e) => e.preventDefault();
    view.addEventListener("dragstart", noNativeDrag, true);
    try {
      const synth = realMouse(view);
      let real = false;
      if (synth) {
        try {
          synth("mousemove", from.x, from.y, { buttons: 0 });
          synth("mousedown", from.x, from.y, { buttons: 1, pressure: 0.5 });
          real = true;
        } catch (e) {}
      }
      if (real) {
        for (const p of path) {
          await pause(16);
          synth("mousemove", p.x, p.y, { buttons: 1, pressure: 0.5 });
        }
        await pause(50);
        synth("mouseup", to.x, to.y, { buttons: 0 });
        return "";
      }
      // No real mouse: the same events, sent to what's under the pointer
      const P = view.PointerEvent || view.MouseEvent;
      const base = (p, buttons) => ({ bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y, button: 0, buttons });
      const pointer = (type, p, buttons) => new P(type, Object.assign(base(p, buttons), { pointerId: 1, isPrimary: true, pointerType: "mouse" }));
      const mouse = (type, p, buttons) => new view.MouseEvent(type, Object.assign(base(p, buttons), { detail: type === "mousemove" ? 0 : 1 }));
      const at = (p) => hitAt(source, p.x, p.y) || source.ownerDocument.documentElement;
      const hit = hitAt(source, from.x, from.y);
      const first = hit && within(source, hit) ? hit : source;
      first.dispatchEvent(pointer("pointerdown", from, 1));
      first.dispatchEvent(mouse("mousedown", from, 1));
      for (const p of path) {
        await pause(16);
        const t = at(p);
        t.dispatchEvent(pointer("pointermove", p, 1));
        t.dispatchEvent(mouse("mousemove", p, 1));
      }
      await pause(50);
      const last = at(to);
      last.dispatchEvent(pointer("pointerup", to, 0));
      last.dispatchEvent(mouse("mouseup", to, 0));
      return synth ? "The real mouse didn't work here, so mouse events were sent straight to the page." : "";
    } finally {
      view.removeEventListener("dragstart", noNativeDrag, true);
    }
  }

  async function dragHtml5(item, target, from, to) {
    const view = viewOf(item);
    let dt = null;
    try { dt = new view.DataTransfer(); } catch (e) {}
    const make = (type, p) => {
      const init = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y, button: 0, buttons: type === "drop" || type === "dragend" ? 0 : 1, dataTransfer: dt };
      try { return new view.DragEvent(type, init); } catch (e) { return new view.MouseEvent(type, init); }
    };
    if (!item.dispatchEvent(make("dragstart", from))) throw new Error("The page didn't let it be dragged.");
    const path = dragPath(from, to);
    let over = null;
    let accepted = false;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      await pause(16);
      item.dispatchEvent(make("drag", p));
      let t = hitAt(item, p.x, p.y);
      // The drop itself goes to the target, whatever is drawn on top of it
      if (i === path.length - 1 && target && (!t || !within(target, t))) t = target;
      if (!t) continue;
      if (t !== over) {
        if (over) over.dispatchEvent(make("dragleave", p));
        t.dispatchEvent(make("dragenter", p));
        over = t;
      }
      accepted = !t.dispatchEvent(make("dragover", p)); // a page accepts a drop by cancelling dragover
    }
    if (over && accepted) over.dispatchEvent(make("drop", to));
    else if (over) over.dispatchEvent(make("dragleave", to));
    item.dispatchEvent(make("dragend", to));
    return accepted ? "" : "Nothing there accepted the drop (the page ignored it).";
  }

  // from: element to drag; to: where to drop it (or by: {x, y} pixels).
  // at: fixed points from a screenshot ({ from, to }, in the top window's
  // coordinates): nothing is scrolled, so they stay where Claude saw them.
  async function dragElement(source, target, position, by, at = {}) {
    // (Two points can be on the same thing: a canvas, a slider's track)
    if (target && !at.to && within(source, target)) throw new Error("The target is the item itself or inside it.");
    const view = viewOf(source);
    const fixed = !!(at.from || at.to);
    // A point in the top window → in the dragged item's own window
    const off = frameOffset(view);
    const local = (p) => ({ x: p.x - off.x, y: p.y - off.y });
    if (!fixed) {
      bringIntoView(source);
      if (target && !onScreen(target)) {
        try { target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); } catch (e) { target.scrollIntoView(); }
      }
    } else if (!at.from && !onScreen(source)) {
      throw new Error("The item isn't on screen. Scroll to it, then take a new browser_screenshot.");
    } else if (target && !onScreen(target)) {
      throw new Error("The drop target isn't on screen. Scroll to it, then take a new browser_screenshot.");
    }
    const item = source.closest("[draggable='true']");
    const from = at.from ? Object.assign(local(at.from), { ok: true }) : clickPoint(source);
    // Real mouse moves need a point that's really on the item
    if (!item && !from.ok) {
      throw new Error(from.blocker ? `Something is on top of it (${nodeName(from.blocker)}), so it can't be picked up.` : "It isn't on screen, so it can't be picked up.");
    }
    let to;
    if (at.to) {
      to = local(at.to);
    } else if (target) {
      to = dropPoint(target, position);
    } else {
      const dx = Number(by && by.x) || 0;
      const dy = Number(by && by.y) || 0;
      if (!dx && !dy) throw new Error("Say where to drag it: to (a ref) or by ({x, y} in pixels).");
      to = { x: from.x + dx, y: from.y + dy };
    }
    if (!item && (!onScreen(source) || to.x < 0 || to.y < 0 || to.x >= view.innerWidth || to.y >= view.innerHeight)) {
      throw new Error("Both ends of the drag have to be on screen. Scroll so they are, or drag in smaller steps.");
    }
    const note = item ? await dragHtml5(item, target, from, to) : await dragMouse(source, from, to);
    return { how: item ? "drag events" : "mouse", note };
  }

  // --- Waiting (browser_wait): read-only checks, nothing is touched ---
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();

  // The page's visible text, with same-site frames
  function pageWords() {
    const parts = [];
    const add = (d) => { try { if (d.body) parts.push(d.body.innerText || d.body.textContent || ""); } catch (e) {} };
    add(doc);
    walk(doc, (el) => { const fd = frameDoc(el); if (fd) add(fd); });
    return norm(parts.join(" "));
  }

  // An element as a page read shows it (label, value, enabled…), or null if it's gone
  function stateOf(ref) {
    let el;
    try { el = find(ref); } catch (e) { return null; }
    const role = roleOf(el) || (isArea(el) ? "droparea" : "");
    return [role, nameOf(el), ...describeValue(el, role, protectedKind(el)), isVisible(el) ? "" : "hidden"].filter(Boolean).join(" ");
  }

  // watch_page's "until_button": a button or link with this label that's
  // there and can be clicked (shown, not disabled)
  function buttonReady(label) {
    const want = norm(label);
    let found = false;
    let ready = false;
    walk(doc, (el) => {
      if (ready) return;
      const role = roleOf(el);
      if (role !== "button" && role !== "link") return;
      if (!norm(nameOf(el)).includes(want)) return;
      found = true;
      const off = el.disabled || el.getAttribute("aria-disabled") === "true" || !!el.closest("fieldset[disabled]");
      if (!off && isVisible(el)) ready = true;
    });
    return { found, ready };
  }

  // The video that matters: one that's playing, else the biggest on screen
  function mainVideo() {
    const all = [];
    walk(doc, (el) => { if (el.tagName === "VIDEO") all.push(el); });
    if (!all.length) return null;
    const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
    const v = all.find((x) => !x.paused && !x.ended) || all.slice().sort((a, b) => area(b) - area(a))[0];
    const duration = Number(v.duration);
    const time = Number(v.currentTime) || 0;
    const known = isFinite(duration) && duration > 0;
    // (area: to pick the main one among frames)
    return { count: all.length, time, duration: known ? duration : null, paused: !!v.paused, ended: !!v.ended || (known && time >= duration - 0.5), area: Math.round(area(v)) };
  }

  // Where keys go: the focused element, through shadow roots and same-site frames
  function focused() {
    let d = doc;
    let a = deepActive(d);
    for (let i = 0; a && i < 10; i++) {
      const fd = frameDoc(a);
      if (!fd) break;
      d = fd;
      a = deepActive(d) || a;
    }
    return a;
  }

  function scrollPage(direction, el) {
    if (el) {
      bringIntoView(el);
    } else {
      const dy = (direction === "up" ? -1 : 1) * Math.round(win.innerHeight * 0.8);
      const before = win.scrollY;
      win.scrollBy(0, dy);
      if (win.scrollY === before) {
        // The page scrolls inside a box (mail apps, chats): scroll that instead
        let n = typeof doc.elementFromPoint === "function" ? doc.elementFromPoint(win.innerWidth / 2, win.innerHeight / 2) : null;
        let scrolled = false;
        for (; n && n !== doc.documentElement; n = n.parentElement) {
          const s = win.getComputedStyle(n);
          if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) {
            n.scrollBy(0, dy);
            scrolled = true;
            break;
          }
        }
        // ...or inside a frame from another site that fills the middle of it (an embedded player)
        const mid = scrolled ? null : deepHit(win.innerWidth / 2, win.innerHeight / 2);
        if (mid && mid.remote) return { forward: { bc: mid.remote.bc }, percent: 100 };
      }
    }
    const scrollMax = Math.max(1, doc.documentElement.scrollHeight - win.innerHeight);
    return { percent: Math.round(Math.min(100, (win.scrollY / scrollMax) * 100)) };
  }

  // --- Actions ---
  try {
    switch (args.action) {
      case "snapshot":
        return snapshot();
      case "describe":
        return describe(args.refs || [], !!args.focus, args.points || [], args.shot || null, !!args.local);
      case "viewport":
        return { w: win.innerWidth, h: win.innerHeight, sx: win.scrollX, sy: win.scrollY, doc: docId() };
      // Is a card/ID/bank number Zen AI filled from saved secrets still shown
      // in plain text on screen? (Then no screenshots: they'd carry it.)
      case "secretShown": {
        let shown = "";
        walk(doc, (el) => {
          if (shown || !el.hasAttribute("data-zai-secret")) return;
          if (!el.value || (el.getAttribute("type") || "").toLowerCase() === "password" || !isVisible(el)) return;
          const r = el.getBoundingClientRect();
          const v = viewOf(el);
          if (r.bottom > 0 && r.right > 0 && r.top < v.innerHeight && r.left < v.innerWidth) shown = el.getAttribute("data-zai-secret");
        });
        return { shown };
      }
      // A frame from another site, by its BrowsingContext id: where it is (and bring it into view)
      case "frameBox": {
        const el = findFrame(args.bc);
        if (args.show) {
          try { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); } catch (e) { el.scrollIntoView(); }
        }
        return frameBox(el);
      }
      case "click": {
        if (args.at) {
          // A point from Claude's screenshot (or, in a frame, from the window around it)
          const s = spotAt(args.at, args.shot, !!args.local);
          // Over a frame from another site: the browser passes it on to that frame
          if (s.remote) return { forward: s.remote };
          const { note } = clickElement(s.el, { x: s.at.x, y: s.at.y, hit: s.hit, ok: true });
          return { label: s.label, what: s.what, note: s.frame ? `${note} It's inside an embedded frame, which may not get the click.`.trim() : note, rect: s.rect };
        }
        const el = find(args.ref);
        const label = labelOf(el);
        const { note } = clickElement(el);
        return { label, note, rect: topRect(el) };
      }
      case "type": {
        const el = find(args.ref);
        const prot = protectedKind(el);
        if (args.secret) return { label: labelOf(el), note: fillSecret(el, args.secret), rect: topRect(el) };
        if (prot) throw new Error(`That's a ${prot} field. Claude doesn't fill those; ask the user to type it themselves.`);
        const text = String(args.text == null ? "" : args.text);
        const note = roleOf(el) === "mathbox" ? typeMath(el, text, !!args.append) : typeInto(el, text, !!args.append);
        return { label: labelOf(el), note, rect: topRect(el) };
      }
      case "select": {
        const el = find(args.ref);
        const prot = protectedKind(el);
        if (prot) throw new Error(`That's a ${prot} field. Claude doesn't fill those; ask the user to choose it themselves.`);
        const chosen = chooseOption(el, args.option);
        return { label: labelOf(el), chosen, rect: topRect(el) };
      }
      case "fill": {
        const results = [];
        let rect = null;
        for (const f of args.fields || []) {
          let el = null;
          try {
            el = find(f.ref);
            const label = labelOf(el);
            const prot = protectedKind(el);
            if (f.secret) {
              const note = fillSecret(el, f.secret);
              if (!rect) rect = topRect(el);
              results.push({ ref: f.ref, label, status: "filled", note });
              continue;
            }
            if (prot) {
              results.push({ ref: f.ref, label, status: "skipped", note: `${prot} field: the user fills it in` });
              continue;
            }
            const role = roleOf(el);
            const value = String(f.value == null ? "" : f.value);
            let note = "";
            if (role === "checkbox" || role === "radio" || role === "switch") note = setChecked(el, truthy(value));
            else if (role === "mathbox") note = typeMath(el, value, false);
            else if (el.tagName === "SELECT") note = "chose " + quote(chooseOption(el, value));
            else if (isTextField(el) || el.isContentEditable || role === "textbox") note = typeInto(el, value, false);
            else throw new Error(`a ${role || el.tagName.toLowerCase()} can't be filled; click it instead`);
            if (!rect) rect = topRect(el);
            results.push({ ref: f.ref, label, status: "filled", note });
          } catch (e) {
            results.push({ ref: f.ref, label: el ? labelOf(el) : "", status: "failed", note: String((e && e.message) || e) });
          }
        }
        return { results, rect };
      }
      case "key": {
        const el = args.ref ? find(args.ref) : null;
        // Focus is inside a frame from another site: the key goes there
        const now = el ? null : focused();
        const bc = now ? remoteFrame(now) : null;
        if (bc !== null) return { forward: { bc } };
        return pressKey(String(args.key || ""), el);
      }
      case "scroll":
        return scrollPage(args.direction, args.ref ? find(args.ref) : null);
      case "drag": {
        // Either end can be a point from Claude's screenshot instead of a ref
        const a = args.fromAt ? spotAt(args.fromAt, args.shot, !!args.local) : null;
        const b = args.toAt ? spotAt(args.toAt, args.shot, !!args.local) : null;
        // Points in a frame from another site: that frame drags (both ends have to be in it)
        if ((a && a.remote) || (b && b.remote)) {
          const ra = a && a.remote;
          const rb = b && b.remote;
          if ((a && !ra) || (b && !rb) || (ra && rb && ra.bc !== rb.bc) || (!a && args.from) || (!b && args.to)) {
            throw new Error("Both ends of the drag have to be inside the same frame.");
          }
          const scale = ra ? Number(args.shot && args.shot.ratio) || 1 : 1;
          const by = args.by ? { x: (Number(args.by.x) || 0) / scale, y: (Number(args.by.y) || 0) / scale } : null;
          return { forward: { bc: (ra || rb).bc, fromAt: ra ? { x: ra.x, y: ra.y } : null, toAt: rb ? { x: rb.x, y: rb.y } : null, by } };
        }
        const source = a ? a.hit : find(args.from);
        const target = b ? b.hit : args.to ? find(args.to) : null;
        // With a point, an offset is in screenshot pixels too
        const ratio = a ? Number(args.shot && args.shot.ratio) || 1 : 1;
        const by = args.by ? { x: (Number(args.by.x) || 0) / ratio, y: (Number(args.by.y) || 0) / ratio } : null;
        return dragElement(source, target, args.position, by, { from: a, to: b }).then(
          (r) => ({
            label: a ? a.label : nameOf(source),
            what: a ? a.what : "",
            to: b ? b.label : target ? nameOf(target) : "",
            note: r.note,
            how: r.how,
            rect: a ? a.rect : topRect(source),
          }),
          (e) => ({ error: String((e && e.message) || e) })
        );
      }
      case "settle":
        return waitQuiet(Number(args.minMs) || 0, Number(args.quietMs) || 150, Number(args.maxMs) || 1200);
      case "watch": {
        // browser_wait's check: only reads
        const out = { video: mainVideo(), url: String(win.location.href) };
        if (args.text || args.gone) {
          const words = pageWords();
          if (args.text) out.text = words.includes(norm(args.text));
          if (args.gone) out.gone = !words.includes(norm(args.gone));
        }
        if (args.ref) out.ref = stateOf(args.ref);
        if (args.button) out.button = buttonReady(args.button);
        return out;
      }
      default:
        throw new Error(`Unknown action ${args.action}`);
    }
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}
