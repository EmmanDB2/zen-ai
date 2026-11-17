import { HTML_NS } from "./config.mjs";
import { clamp, h } from "./dom.mjs";

// ---------------------------------------------------------------------------
// Screenshot mode: drag to select an area of the page (Enter: the whole
// view, Escape: cancel). The area goes to onCaptured(canvas); the composer
// turns it into an attachment.
// ---------------------------------------------------------------------------
export function createCapture({ panel, button, isOpen, isDocked, flash, beforeStart, focusInput, onCaptured }) {
  const currentBrowser = () => { try { return gBrowser.selectedBrowser; } catch (e) { return null; } };
  // -------------------------------------------------------------------------
  // Screenshot mode: drag to select an area of the page
  // -------------------------------------------------------------------------
  let capture = null;

  function startCapture() {
    if (capture) return;
    const browser = currentBrowser();
    if (!browser) return;
    const browserRect = browser.getBoundingClientRect();
    if (!browserRect.width || !browserRect.height) return;
    beforeStart();

    // The floating window steps aside so it isn't in the way (docked stays put)
    const hidePanel = isOpen() && !isDocked();
    if (hidePanel) panel.classList.add("zai-closed");

    const overlay = h("div", { id: "zai-capture", tabindex: "-1", role: "application", "aria-label": "Drag over an area to attach it to your message. Enter takes the whole view, Escape cancels." });
    Object.assign(overlay.style, {
      left: browserRect.left + "px",
      top: browserRect.top + "px",
      width: browserRect.width + "px",
      height: browserRect.height + "px",
    });
    const hint = h("div", { class: "zai-cap-hint" },
      "Drag to capture",
      h("span", { class: "zai-cap-dot", text: "·" }),
      h("kbd", { text: "↵" }), "whole view",
      h("span", { class: "zai-cap-dot", text: "·" }),
      h("kbd", { text: "esc" })
    );
    overlay.append(hint);
    document.documentElement.appendChild(overlay);

    capture = { overlay, hint, browser, browserRect, sel: null, selEl: null, sizeEl: null, hidePanel, busy: false, onResize: () => endCapture() };
    overlay.addEventListener("pointerdown", onCapturePointerDown);
    overlay.addEventListener("keydown", onCaptureKey);
    overlay.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("resize", capture.onResize);
    button.setAttribute("aria-pressed", "true");
    overlay.focus();
  }

  function endCapture() {
    const c = capture;
    if (!c) return;
    capture = null;
    window.removeEventListener("resize", c.onResize);
    c.overlay.remove();
    button.setAttribute("aria-pressed", "false");
    if (c.hidePanel && isOpen()) panel.classList.remove("zai-closed");
    if (isOpen()) window.requestAnimationFrame(() => focusInput());
  }

  function clearSelection() {
    const c = capture;
    if (!c) return;
    c.sel = null;
    if (c.selEl) c.selEl.remove();
    c.selEl = c.sizeEl = null;
    c.overlay.classList.remove("zai-has-sel");
    c.hint.hidden = false;
  }

  function drawSelection(sel) {
    const c = capture;
    if (!c.selEl) {
      c.sizeEl = h("div", { class: "zai-cap-size" });
      const corners = [["-5px", "-5px", null, null], [null, "-5px", "-5px", null], ["-5px", null, null, "-5px"], [null, null, "-5px", "-5px"]]
        .map(([left, top, right, bottom]) => {
          const dot = h("div", { class: "zai-cap-handle" });
          Object.assign(dot.style, { left: left || "", top: top || "", right: right || "", bottom: bottom || "" });
          return dot;
        });
      c.selEl = h("div", { class: "zai-cap-sel" }, ...corners, c.sizeEl);
      c.overlay.append(c.selEl);
      c.overlay.classList.add("zai-has-sel");
      c.hint.hidden = true;
    }
    Object.assign(c.selEl.style, { left: sel.x + "px", top: sel.y + "px", width: sel.w + "px", height: sel.h + "px" });
    c.selEl.classList.toggle("zai-label-inside", sel.y < 36);
    c.sizeEl.textContent = `${Math.round(sel.w)} × ${Math.round(sel.h)}`;
  }

  function onCapturePointerDown(e) {
    const c = capture;
    if (!c || c.busy || e.button !== 0) return;
    e.preventDefault();
    clearSelection();
    const W = c.browserRect.width;
    const H = c.browserRect.height;
    const x0 = clamp(e.clientX - c.browserRect.left, 0, W);
    const y0 = clamp(e.clientY - c.browserRect.top, 0, H);
    c.overlay.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const x1 = clamp(ev.clientX - c.browserRect.left, 0, W);
      const y1 = clamp(ev.clientY - c.browserRect.top, 0, H);
      const sel = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      if (sel.w < 2 && sel.h < 2) return;
      c.sel = sel;
      drawSelection(sel);
    };
    const onUp = (ev) => {
      c.overlay.removeEventListener("pointermove", onMove);
      c.overlay.removeEventListener("pointerup", onUp);
      try { c.overlay.releasePointerCapture(ev.pointerId); } catch (err) {}
      if (!c.sel || c.sel.w < 6 || c.sel.h < 6) {
        clearSelection();
        return;
      }
      commitCapture(c.sel);
    };
    c.overlay.addEventListener("pointermove", onMove);
    c.overlay.addEventListener("pointerup", onUp);
  }

  // Let go → the area goes straight into the chat box, no menu
  async function commitCapture(sel) {
    const c = capture;
    if (!c || c.busy) return;
    c.busy = true;
    c.overlay.classList.add("zai-busy");
    let canvas;
    try {
      // Full-resolution frame of the page as it looks right now
      const windowGlobal = c.browser.browsingContext.currentWindowGlobal;
      const bitmap = await windowGlobal.drawSnapshot(null, window.devicePixelRatio || 1, "rgb(255,255,255)");
      try {
        const factor = bitmap.width / c.browserRect.width;
        canvas = document.createElementNS(HTML_NS, "canvas");
        canvas.width = Math.max(1, Math.round(sel.w * factor));
        canvas.height = Math.max(1, Math.round(sel.h * factor));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, sel.x * factor, sel.y * factor, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      } finally {
        if (bitmap.close) bitmap.close();
      }
    } catch (e) {
      if (capture === c) endCapture();
      flash("This page can't be captured");
      return;
    }
    if (capture !== c) return; // cancelled meanwhile
    endCapture();
    onCaptured(canvas);
  }

  function captureWholeView() {
    const c = capture;
    if (!c || c.busy) return;
    clearSelection();
    c.sel = { x: 0, y: 0, w: c.browserRect.width, h: c.browserRect.height };
    drawSelection(c.sel);
    commitCapture(c.sel);
  }

  function onCaptureKey(e) {
    if (!capture) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      endCapture();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      captureWholeView();
    }
  }

  return {
    start: startCapture,
    end: endCapture,
    isActive: () => !!capture,
    dispose() { if (capture) endCapture(); },
  };
}
