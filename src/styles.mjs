import { ANIM_MS, DOCK_GAP, PANEL_WIDTH } from "./config.mjs";

// ---------------------------------------------------------------------------
// Styles — built entirely on Zen's own variables so it always matches
// ---------------------------------------------------------------------------
export const CSS = `
/* One radius scale for everything. Nested corners are concentric:
   window 22 → composer/cards 14 (8px inset) → buttons/chips 8 (6px inset) → 5 → favicons 4 */
:root {
  --zai-r-window: 22px;
  --zai-r-card: 14px;
  --zai-r-control: 8px;
  --zai-r-mini: 5px;
  --zai-r-icon: 4px;
  --zai-r-pill: 999px;
  --zai-dur: ${ANIM_MS}ms;
  --zai-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --zai-spring: cubic-bezier(0.34, 1.4, 0.64, 1);
}

@keyframes zai-pop-in { from { opacity: 0; transform: scale(0.86); } to { opacity: 1; transform: none; } }
@keyframes zai-pop-out { to { opacity: 0; transform: scale(0.86); } }
@keyframes zai-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes zai-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes zai-menu-up { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes zai-menu-down { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes zai-flash-in { from { opacity: 0; transform: translate(-50%, 4px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes zai-pulse { 50% { opacity: 0.45; } }
@keyframes zai-shimmer { from { background-position: 100% 0; } to { background-position: 0% 0; } }

#zai-panel {
  --zai-fg: light-dark(#18171c, #ebeaee);
  --zai-muted: light-dark(#6b6872, #a3a0aa);
  --zai-faint: light-dark(rgba(24, 23, 28, 0.06), rgba(255, 255, 255, 0.08));
  --zai-hover: var(--zen-toolbar-element-bg-hover, light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.1)));
  --zai-press: color-mix(in srgb, var(--zai-fg) 15%, transparent);
  --zai-accent: var(--zen-primary-color, #1683ff);
  --zai-accent-soft: color-mix(in srgb, var(--zai-accent) 16%, transparent);
  --zai-surface: var(--zen-dialog-background, light-dark(#fafbff, #1c1c1c));
  /* --zai-tint-pct / --zai-input-pct / --zai-blur are set from about:config (zenai.glass.*) */
  --zai-glass: color-mix(in srgb, var(--zai-surface) var(--zai-tint-pct, 48%), transparent);
  --zai-input: color-mix(in srgb, var(--zai-surface) var(--zai-input-pct, 70%), transparent);
  --zai-sheen: light-dark(rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0.12));
  --zai-edge: light-dark(rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.10));
  --zai-ring: light-dark(rgba(20, 18, 30, 0.10), rgba(255, 255, 255, 0.08));
  --zai-warn-bg: light-dark(#fcebcb, rgba(255, 190, 90, 0.18));
  --zai-warn-bg-hover: light-dark(#f8dfae, rgba(255, 190, 90, 0.27));
  --zai-warn-fg: light-dark(#8a5300, #ffc36b);
  --zai-danger-bg: light-dark(rgba(196, 50, 30, 0.10), rgba(255, 120, 100, 0.16));
  --zai-danger-bg-hover: light-dark(rgba(196, 50, 30, 0.16), rgba(255, 120, 100, 0.24));
  --zai-danger-fg: light-dark(#b4321e, #ff9b8a);

  position: fixed;
  z-index: 2147483000;
  width: ${PANEL_WIDTH}px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--zai-fg);
  font: 14px/1.5 -apple-system, system-ui, sans-serif;
  isolation: isolate;
  background: var(--zai-glass);
  border: 1px solid var(--zai-edge);
  border-radius: var(--zai-r-window);
  box-shadow: inset 0 1px 0 var(--zai-sheen), 0 0 0 0.5px var(--zai-ring), 0 24px 60px rgba(10, 8, 20, 0.24),
    var(--zen-big-shadow, 0 3px 8px rgba(0, 0, 0, 0.24));
  /* Opening and closing use the exact same motion, just reversed */
  transition: opacity var(--zai-dur) var(--zai-ease), transform var(--zai-dur) var(--zai-ease);
}
#zai-panel.zai-closed {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
  pointer-events: none;
  visibility: hidden;
  transition: opacity var(--zai-dur) var(--zai-ease), transform var(--zai-dur) var(--zai-ease), visibility 0s linear var(--zai-dur);
}
/* Docked: slides off the right edge, in step with the page sliding back */
#zai-panel.zai-docked.zai-closed { transform: translateX(calc(100% + ${DOCK_GAP}px)); }
#zai-panel.zai-dragging { transition: none; user-select: none; }

/* --- Blur modes (floating only) --- */
/* snapshot: a small, frequently refreshed capture of the page behind, blurred */
#zai-panel.zai-blur-snapshot:not(.zai-docked) { background: var(--zai-surface); }
/* native: Zen's own acrylic recipe */
#zai-panel.zai-blur-native:not(.zai-docked) {
  backdrop-filter: var(--zen-backdrop-underlay,) blur(calc(var(--zai-blur, 12px) * 2.5)) saturate(1.8);
}
.zai-backdrop, .zai-tint {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: inherit;
}
.zai-backdrop { overflow: hidden; }
.zai-backdrop canvas {
  position: absolute;
  left: calc(-1 * var(--zai-snap-pad));
  top: calc(-1 * var(--zai-snap-pad));
  width: calc(100% + 2 * var(--zai-snap-pad));
  height: calc(100% + 2 * var(--zai-snap-pad));
  filter: blur(var(--zai-blur, 12px)) saturate(1.8);
}
.zai-tint {
  background: var(--zai-glass);
  box-shadow: inset 0 1px 0 var(--zai-sheen), inset 0 0 0 1px light-dark(rgba(255, 255, 255, 0.25), rgba(255, 255, 255, 0.04));
}
#zai-panel:not(.zai-blur-snapshot) .zai-backdrop,
#zai-panel:not(.zai-blur-snapshot) .zai-tint,
#zai-panel.zai-docked .zai-backdrop,
#zai-panel.zai-docked .zai-tint { display: none; }
.zai-header, .zai-thread, .zai-composer-wrap { position: relative; z-index: 1; }

/* --- Docked: no card, the text sits right on Zen's background --- */
#zai-panel.zai-docked {
  --zai-fg: var(--toolbox-textcolor, light-dark(#18171c, #ebeaee));
  --zai-muted: color-mix(in srgb, var(--zai-fg) 62%, transparent);
  --zai-faint: color-mix(in srgb, var(--zai-fg) 8%, transparent);
  --zai-input: var(--zen-toolbar-element-bg, light-dark(rgba(255, 255, 255, 0.5), rgba(0, 0, 0, 0.2)));
  top: ${DOCK_GAP}px !important;
  bottom: ${DOCK_GAP}px;
  right: 0;
  left: auto !important;
  max-height: none !important;
  color: var(--zai-fg);
  background: transparent;
  backdrop-filter: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  width: var(--zai-dock-width, ${PANEL_WIDTH}px) !important;
}
#zai-panel.zai-docked .zai-header { padding-inline: 2px 4px; }
#zai-panel.zai-docked .zai-thread { padding-inline: 12px 10px; }
#zai-panel.zai-docked .zai-composer-wrap { padding: 8px 8px 0 4px; }
#zai-panel.zai-docked .zai-composer { box-shadow: none; }
#zai-panel.zai-docked .zai-composer:focus-within { box-shadow: 0 0 0 1px color-mix(in srgb, var(--zai-accent) 40%, transparent); }
#zai-panel.zai-docked .zai-bubble {
  background: var(--zai-faint);
  color: var(--zai-fg);
}
/* The page makes room for the docked chat; zai-dock-anim is only set while
   opening/closing/docking, so the page slides both ways and never otherwise */
:root[zai-docked] #tabbrowser-tabbox { margin-inline-end: var(--zai-dock-width, ${PANEL_WIDTH}px) !important; }
:root[zai-dock-anim] #tabbrowser-tabbox { transition: margin-inline-end var(--zai-dur) var(--zai-ease) !important; }
:root[zai-resizing] #tabbrowser-tabbox { transition: none !important; }
:root[zai-resizing], :root[zai-resizing] * { user-select: none !important; }

/* Resize handles */
.zai-resize { position: absolute; z-index: 6; }
.zai-r-l { left: 0; top: 18px; bottom: 18px; width: 6px; cursor: ew-resize; }
.zai-r-r { right: 0; top: 18px; bottom: 18px; width: 6px; cursor: ew-resize; }
.zai-r-b { bottom: 0; left: 18px; right: 18px; height: 6px; cursor: ns-resize; }
.zai-r-bl { left: 0; bottom: 0; width: 16px; height: 16px; cursor: nesw-resize; }
.zai-r-br { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
#zai-panel.zai-docked .zai-resize:not(.zai-r-l) { display: none; }
#zai-panel.zai-docked .zai-r-l { top: 0; bottom: 0; left: -3px; width: 8px; }
#zai-panel.zai-docked .zai-r-l::after {
  content: "";
  position: absolute;
  left: 3px;
  top: 30%;
  bottom: 30%;
  width: 2px;
  border-radius: 2px;
  background: var(--zai-accent);
  opacity: 0;
  transition: opacity 150ms ease;
}
#zai-panel.zai-docked .zai-r-l:hover::after,
:root[zai-resizing] #zai-panel.zai-docked .zai-r-l::after { opacity: 0.6; }
#zai-panel [hidden] { display: none !important; }
/* Zero-specificity reset, so every class rule below (hover states included) wins */
:where(#zai-panel) button {
  appearance: none;
  font: inherit;
  color: inherit;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: default;
}
#zai-panel button:focus-visible { outline: 2px solid var(--zai-accent); outline-offset: 1px; }
#zai-panel svg { flex-shrink: 0; }

/* One shared tooltip that lives outside the window, so nothing clips it */
#zai-tooltip {
  position: fixed;
  z-index: 2147483001;
  left: 0;
  top: 0;
  max-width: 260px;
  padding: 4px 8px;
  border-radius: var(--zai-r-control);
  background: light-dark(#1c1b1f, #f2f1f4);
  color: light-dark(#ffffff, #1c1b1f);
  font: 500 12px/1.4 -apple-system, system-ui, sans-serif;
  white-space: normal;
  pointer-events: none;
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 120ms ease, transform 120ms ease;
}
#zai-tooltip.zai-show { opacity: 1; transform: none; }
#zai-tooltip.zai-tip-wide { max-width: 340px; }
#zai-tooltip .zai-tip-more { font-weight: 400; margin-top: 2px; white-space: nowrap; }
#zai-tooltip .zai-tip-note { font-weight: 400; font-size: 11px; opacity: 0.62; margin-top: 3px; }
#zai-tooltip[hidden] { display: none; }

/* Screenshot mode */
#zai-capture {
  position: fixed;
  z-index: 2147483000;
  overflow: hidden;
  outline: none;
  cursor: crosshair;
  background: rgba(18, 16, 26, 0.28);
  font: 13px/1.4 -apple-system, system-ui, sans-serif;
  animation: zai-fade 120ms ease;
}
#zai-capture.zai-has-sel { background: transparent; }
#zai-capture.zai-busy { cursor: progress; }
.zai-cap-sel {
  position: absolute;
  border-radius: var(--zai-r-icon);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.95), 0 0 0 100000px rgba(18, 16, 26, 0.45);
  pointer-events: none;
}
.zai-cap-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
}
.zai-cap-size {
  position: absolute;
  left: 0;
  top: -32px;
  height: 24px;
  padding: 0 9px;
  border-radius: var(--zai-r-control);
  background: rgba(18, 16, 26, 0.85);
  color: #ffffff;
  font: 500 12px ui-monospace, "SF Mono", Menlo, monospace;
  display: flex;
  align-items: center;
  white-space: nowrap;
}
.zai-cap-sel.zai-label-inside .zai-cap-size { top: 6px; left: 6px; }
.zai-cap-hint {
  position: absolute;
  left: 50%;
  top: 18px;
  transform: translateX(-50%);
  height: 34px;
  padding: 0 14px;
  border-radius: var(--zai-r-pill);
  background: rgba(18, 16, 26, 0.78);
  color: #ffffff;
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  pointer-events: none;
}
.zai-cap-hint kbd {
  font: 500 11.5px ui-monospace, "SF Mono", Menlo, monospace;
  padding: 2px 6px;
  border-radius: var(--zai-r-mini);
  background: rgba(255, 255, 255, 0.16);
}
.zai-cap-dot { opacity: 0.55; }

/* Icon buttons: a tinted box on hover, accent tint while a tool is open/active */
.zai-icon-btn {
  width: 34px;
  height: 34px;
  border-radius: var(--zai-r-control);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--zai-muted);
  transition: background-color 140ms ease, color 140ms ease, transform 180ms var(--zai-spring);
}
.zai-icon-btn:hover { background: var(--zai-hover); color: var(--zai-fg); }
.zai-icon-btn:active { background: var(--zai-press); transform: scale(0.9); }
.zai-icon-btn[aria-expanded="true"],
.zai-icon-btn[aria-pressed="true"] { background: var(--zai-accent-soft); color: var(--zai-accent); }

/* Header */
.zai-header {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 48px;
  padding: 0 8px 0 6px;
  flex-shrink: 0;
}
.zai-grip {
  width: 22px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--zai-muted);
  opacity: 0.6;
  transition: opacity 140ms ease;
}
.zai-header:hover .zai-grip { opacity: 0.9; }
#zai-panel:not(.zai-docked) .zai-grip,
#zai-panel:not(.zai-docked) .zai-header { cursor: grab; }
#zai-panel.zai-dragging .zai-header,
#zai-panel.zai-dragging .zai-grip { cursor: grabbing; }
#zai-panel.zai-docked .zai-grip { visibility: hidden; width: 6px; }
.zai-spacer { flex: 1; align-self: stretch; }

/* Shield: web content is in this chat. Click for the tools toggle. */
.zai-shield {
  width: 30px;
  height: 30px;
  margin-left: 2px;
  background: var(--zai-warn-bg);
  color: var(--zai-warn-fg);
  animation: zai-pop-in 260ms var(--zai-spring);
}
.zai-shield:hover, .zai-shield[aria-expanded="true"] { background: var(--zai-warn-bg-hover); color: var(--zai-warn-fg); }
.zai-shield.zai-unlocked { background: var(--zai-danger-bg); color: var(--zai-danger-fg); }
.zai-shield.zai-unlocked:hover, .zai-shield.zai-unlocked[aria-expanded="true"] { background: var(--zai-danger-bg-hover); color: var(--zai-danger-fg); }
.zai-popover {
  position: absolute;
  top: 46px;
  left: 8px;
  z-index: 14;
  width: 290px;
  max-width: calc(100% - 16px);
  box-sizing: border-box;
  padding: 12px;
  border-radius: var(--zai-r-card);
  background: var(--zai-surface);
  color: var(--zai-fg);
  box-shadow: 0 0 0 1px var(--zai-ring), 0 12px 32px rgba(10, 8, 20, 0.22);
  transform-origin: top left;
  animation: zai-menu-down 160ms var(--zai-ease);
  overflow-y: auto;
  scrollbar-width: thin;
}
.zai-pop-section + .zai-pop-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--zai-ring); }
.zai-pop-head { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; }
.zai-pop-icon {
  width: 26px;
  height: 26px;
  border-radius: var(--zai-r-control);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--zai-warn-bg);
  color: var(--zai-warn-fg);
}
.zai-pop-icon.zai-unlocked { background: var(--zai-danger-bg); color: var(--zai-danger-fg); }
.zai-pop-body { margin: 8px 0 12px; font-size: 12.5px; line-height: 1.5; color: var(--zai-muted); }
.zai-pop-btn {
  width: 100%;
  height: 32px;
  border-radius: var(--zai-r-control);
  background: var(--zai-faint);
  font-size: 13px;
  font-weight: 600;
  transition: background-color 140ms ease, transform 180ms var(--zai-spring);
}
.zai-pop-btn:hover { background: var(--zai-hover); }
.zai-pop-btn:active { transform: scale(0.97); }
.zai-pop-btn.zai-primary { background: var(--zai-fg); color: var(--zai-surface); }
.zai-pop-btn.zai-primary:hover { background: color-mix(in srgb, var(--zai-fg) 86%, transparent); }

/* History: this Space's chats (a popover under the clock button) */
.zai-icon-btn.zai-has-unread { position: relative; }
.zai-icon-btn.zai-has-unread::after {
  content: "";
  position: absolute;
  top: 7px;
  right: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--zai-accent);
  box-shadow: 0 0 0 2px var(--zai-surface);
  animation: zai-pop-in 240ms var(--zai-spring);
}
.zai-popover.zai-history { width: 320px; padding: 6px; }
.zai-hist-search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  margin-bottom: 4px;
  border-radius: var(--zai-r-control);
  background: var(--zai-faint);
  color: var(--zai-muted);
}
.zai-hist-search-row:focus-within { box-shadow: 0 0 0 1px color-mix(in srgb, var(--zai-accent) 45%, transparent); }
.zai-hist-search {
  flex: 1;
  min-width: 0;
  appearance: none;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--zai-fg);
  font: inherit;
  font-size: 13.5px;
}
.zai-hist-search::placeholder { color: var(--zai-muted); opacity: 1; }
.zai-hist-search::-webkit-search-cancel-button { display: none; }
.zai-hist-list { display: flex; flex-direction: column; gap: 1px; overflow-y: auto; scrollbar-width: thin; }
.zai-hist-group {
  padding: 8px 10px 3px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--zai-muted);
  user-select: none;
}
.zai-hist-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 4px 0 10px;
  border-radius: var(--zai-r-control);
  cursor: default;
  outline: none;
  user-select: none;
  transition: background-color 100ms ease;
}
.zai-hist-row:hover, .zai-hist-row:focus-visible { background: var(--zai-hover); }
.zai-hist-row[aria-current="true"] { background: var(--zai-faint); }
.zai-hist-row[aria-current="true"]:hover { background: var(--zai-hover); }
.zai-hist-row.zai-leaving { animation: zai-pop-out 140ms ease forwards; pointer-events: none; }
.zai-hist-title { flex: 1; min-width: 0; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-hist-row[aria-current="true"] .zai-hist-title { font-weight: 600; }
.zai-hist-time { flex-shrink: 0; font-size: 12px; color: var(--zai-muted); }
.zai-hist-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--zai-accent);
  animation: zai-pop-in 240ms var(--zai-spring);
}
.zai-hist-dot.zai-live { animation: zai-pulse 1.4s ease-in-out infinite; }
.zai-hist-del {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  margin-inline-start: -4px;
  border-radius: var(--zai-r-mini);
  display: none;
  align-items: center;
  justify-content: center;
  color: var(--zai-muted);
  transition: background-color 120ms ease, color 120ms ease;
}
.zai-hist-row:hover .zai-hist-del, .zai-hist-row:focus-within .zai-hist-del, .zai-hist-row.zai-confirm .zai-hist-del { display: inline-flex; }
.zai-hist-row:hover .zai-hist-time, .zai-hist-row:focus-within .zai-hist-time { display: none; }
.zai-hist-del:hover { background: var(--zai-danger-bg); color: var(--zai-danger-fg); }
.zai-hist-row.zai-confirm .zai-hist-time { display: none; }
.zai-hist-row.zai-confirm .zai-hist-del {
  width: auto;
  padding: 0 8px;
  background: var(--zai-danger-bg);
  color: var(--zai-danger-fg);
  font-size: 12.5px;
  font-weight: 600;
  animation: zai-pop-in 200ms var(--zai-spring);
}
.zai-hist-row.zai-confirm .zai-hist-del:hover { background: var(--zai-danger-bg-hover); }
.zai-hist-empty { padding: 14px 10px; font-size: 13px; color: var(--zai-muted); }

/* Thread */
.zai-thread {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 18px 8px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scrollbar-width: thin;
}
.zai-greeting { display: flex; align-items: center; gap: 12px; padding: 12px 4px 4px; animation: zai-rise 280ms var(--zai-ease) both; }
.zai-greeting h1 {
  margin: 0;
  font: 400 28px/1.2 ui-serif, "New York", Georgia, serif;
  letter-spacing: -0.01em;
}
.zai-greeting svg { color: var(--zai-accent); }
.zai-actions { display: flex; flex-direction: column; gap: 2px; margin: 0 -8px; }
.zai-action {
  height: 42px;
  border-radius: var(--zai-r-control);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  text-align: start;
  transition: background-color 140ms ease, transform 180ms var(--zai-spring);
  animation: zai-rise 280ms var(--zai-ease) both;
}
.zai-action:nth-child(1) { animation-delay: 40ms; }
.zai-action:nth-child(2) { animation-delay: 70ms; }
.zai-action:nth-child(3) { animation-delay: 100ms; }
.zai-action:nth-child(4) { animation-delay: 130ms; }
.zai-action:hover { background: var(--zai-hover); }
.zai-action:active { transform: scale(0.985); }
.zai-action svg { color: var(--zai-muted); transition: color 140ms ease; }
.zai-action:hover svg { color: var(--zai-accent); }
.zai-action-hint { margin-inline-start: auto; font-size: 12px; color: var(--zai-muted); }
/* "Recent in <Space>": the quick-action rows, for the Space's last chats */
.zai-recent { display: flex; flex-direction: column; gap: 2px; margin: -4px -8px 0; }
.zai-recent-label {
  padding: 0 12px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--zai-muted);
  animation: zai-rise 280ms var(--zai-ease) 150ms both;
}
.zai-action.zai-recent-row { height: 38px; animation-delay: 170ms; }
.zai-recent-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-action.zai-recent-row .zai-action-hint { flex-shrink: 0; }
.zai-user { align-self: flex-end; max-width: 82%; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.zai-user.zai-enter { animation: zai-rise 240ms var(--zai-ease); }
.zai-bubble {
  background: light-dark(#1c1b1f, #ecebef);
  color: light-dark(#f7f6f3, #1c1b1f);
  padding: 9px 14px;
  border-radius: var(--zai-r-card) var(--zai-r-card) var(--zai-r-mini) var(--zai-r-card);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.zai-media { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.zai-thumb {
  display: block;
  height: 72px;
  min-width: 40px;
  max-width: 180px;
  object-fit: cover;
  border-radius: var(--zai-r-card);
  box-shadow: 0 0 0 1px var(--zai-ring);
  transition: transform 180ms var(--zai-spring);
}
.zai-thumb:hover { transform: scale(1.03); }
.zai-assistant { min-width: 0; overflow-wrap: anywhere; font-size: 14.5px; line-height: 1.6; }
/* Messages are selectable (Firefox turns selection off in its own UI by default) */
#zai-panel .zai-thread { user-select: text; cursor: auto; }
#zai-panel .zai-thread :is(button, .zai-chip, .zai-thumb, .zai-pill, .zai-msg-actions, .zai-greeting, .zai-actions) { user-select: none; }
#zai-panel ::selection { background: color-mix(in srgb, var(--zai-accent) 30%, transparent); }
#zai-panel .zai-bubble ::selection, #zai-panel .zai-bubble::selection { background: color-mix(in srgb, var(--zai-accent) 55%, transparent); }
.zai-msg-actions { display: flex; align-items: center; gap: 2px; transition: opacity 160ms ease; }
.zai-msg-actions .zai-act-btn { width: 28px; height: 28px; }
.zai-act-btn.zai-copied { color: light-dark(#2f6b4f, #7fd1a6); }
.zai-act-btn.zai-copied svg { animation: zai-pop-in 240ms var(--zai-spring); }
.zai-assistant > .zai-reply-actions { margin: 4px 0 0 -6px; opacity: 0; }
.zai-assistant:hover > .zai-reply-actions, .zai-assistant:last-child > .zai-reply-actions, .zai-reply-actions:focus-within { opacity: 1; }
.zai-time { margin-inline-start: 6px; font-size: 12px; color: var(--zai-muted); }
.zai-user-actions { justify-content: flex-end; margin: -4px -4px -8px 0; opacity: 0; }
.zai-user-actions .zai-act-btn { width: 26px; height: 26px; }
.zai-user:hover .zai-user-actions, .zai-user-actions:focus-within { opacity: 1; }
.zai-assistant p { margin: 0 0 8px; white-space: pre-wrap; }
.zai-assistant > :last-child { margin-bottom: 0; }
.zai-assistant .zai-list { margin: 0 0 8px; padding-inline-start: 20px; }
.zai-assistant li { margin: 2px 0; }
.zai-assistant .zai-h { margin: 12px 0 6px; font-size: 15px; font-weight: 600; }
.zai-inline-code {
  font: 12.5px ui-monospace, "SF Mono", Menlo, monospace;
  padding: 1px 5px;
  border-radius: var(--zai-r-mini);
  background: var(--zai-faint);
}
.zai-link { color: var(--zai-accent); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.zai-codebox {
  margin: 4px 0 10px;
  border-radius: var(--zai-r-card);
  background: var(--zai-input);
  box-shadow: 0 0 0 1px var(--zai-ring);
  overflow: hidden;
}
.zai-codebox-head {
  height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 6px 0 12px;
  border-bottom: 1px solid var(--zai-ring);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--zai-muted);
}
.zai-codebox-head span { flex: 1; }
.zai-copy-btn { width: 26px; height: 26px; }
.zai-copy-btn.zai-copied { color: light-dark(#2f6b4f, #7fd1a6); }
.zai-copy-btn.zai-copied svg { animation: zai-pop-in 240ms var(--zai-spring); }
.zai-codebox pre {
  margin: 0;
  padding: 10px 12px;
  font: 12.5px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
  white-space: pre;
  overflow-x: auto;
  color: var(--zai-fg);
}
.zai-tablebox {
  position: relative;
  margin: 4px 0 10px;
  border-radius: var(--zai-r-card);
  background: var(--zai-input);
  box-shadow: 0 0 0 1px var(--zai-ring);
  overflow: hidden;
}
.zai-table-scroll { overflow-x: auto; scrollbar-width: thin; }
.zai-table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.45; }
.zai-table th, .zai-table td { max-width: 240px; padding: 7px 10px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--zai-ring); }
.zai-table th + th, .zai-table td + td { border-left: 1px solid var(--zai-ring); }
.zai-table th { font-weight: 600; background: var(--zai-faint); white-space: nowrap; }
.zai-table tbody tr:last-child td { border-bottom: 0; }
.zai-table tbody tr { transition: background-color 120ms ease; }
.zai-table tbody tr:hover { background: color-mix(in srgb, var(--zai-faint) 70%, transparent); }
.zai-table .zai-al-center { text-align: center; }
.zai-table .zai-al-right { text-align: right; font-variant-numeric: tabular-nums; }
.zai-table-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  background: var(--zai-surface);
  box-shadow: 0 0 0 1px var(--zai-ring);
  opacity: 0;
  transition: opacity 140ms ease, background-color 140ms ease, transform 180ms var(--zai-spring);
}
.zai-tablebox:hover .zai-table-copy, .zai-table-copy:focus-visible, .zai-table-copy.zai-copied { opacity: 1; }
.zai-hr { border: 0; border-top: 1px solid var(--zai-ring); margin: 12px 0; }
.zai-quote {
  margin: 0 0 8px;
  padding: 2px 0 2px 12px;
  border-left: 3px solid color-mix(in srgb, var(--zai-accent) 55%, transparent);
  color: var(--zai-muted);
  white-space: pre-wrap;
}
.zai-codebox.zai-textbox pre { font: 14px/1.55 -apple-system, system-ui, sans-serif; white-space: pre-wrap; }
.zai-status { color: var(--zai-muted); font-size: 13.5px; width: fit-content; }
/* "Reading… / Thinking…" get a soft moving shine */
.zai-status.zai-live {
  color: transparent;
  background: linear-gradient(90deg, var(--zai-muted) 35%, var(--zai-fg) 50%, var(--zai-muted) 65%);
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  animation: zai-shimmer 1.8s linear infinite;
}
.zai-error {
  margin-top: 4px;
  padding: 8px 12px;
  border-radius: var(--zai-r-card);
  font-size: 13.5px;
  white-space: pre-wrap;
  color: light-dark(#a1361b, #ffab91);
  background: light-dark(rgba(185, 85, 58, 0.08), rgba(255, 140, 110, 0.10));
  animation: zai-rise 220ms var(--zai-ease);
}
.zai-note { color: var(--zai-muted); }
.zai-seg { animation: zai-fade 220ms ease; }
.zai-seg:empty { display: none; }
.zai-seg + .zai-seg, .zai-assistant > * + * { margin-top: 8px; }

/* Approval card */
.zai-approval {
  margin: 4px 0;
  border-radius: var(--zai-r-card);
  background: var(--zai-input);
  box-shadow: 0 0 0 1px var(--zai-ring), 0 6px 18px rgba(20, 18, 30, 0.08);
  overflow: hidden;
  animation: zai-rise 240ms var(--zai-ease);
}
.zai-approval-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px 8px; }
.zai-approval-icon {
  width: 28px;
  height: 28px;
  border-radius: var(--zai-r-control);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--zai-fg);
  color: var(--zai-surface);
}
.zai-approval-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.zai-approval-title { font-weight: 600; font-size: 14px; }
.zai-approval-sub { font-size: 12.5px; color: var(--zai-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-approval pre {
  margin: 0 12px;
  padding: 10px 12px;
  max-height: 180px;
  overflow: auto;
  border-radius: var(--zai-r-control);
  background: #1c1b1f;
  color: #ecebe8;
  font: 12px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}
.zai-approval-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 12px 12px; }
.zai-approval-actions button {
  height: 32px;
  padding: 0 14px;
  border-radius: var(--zai-r-control);
  font-size: 13px;
  font-weight: 500;
  transition: background-color 140ms ease, transform 180ms var(--zai-spring);
}
.zai-approval-actions button:active { transform: scale(0.95); }
.zai-deny { background: var(--zai-faint); }
.zai-deny:hover { background: var(--zai-hover); }
.zai-allow { background: var(--zai-fg); color: var(--zai-surface); font-weight: 600; }
.zai-allow:hover { background: color-mix(in srgb, var(--zai-fg) 86%, transparent); }
/* A new skill's settings (skill-form.mjs): /create-skill's panel and the "New skill" card */
.zai-sf { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; padding: 0 12px 4px; }
.zai-skill-card { overflow: visible; }
.zai-sf-anchor { position: relative; display: inline-flex; }
.zai-sf-select {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 8px 0 10px; max-width: 260px;
  border-radius: var(--zai-r-control); background: var(--zai-faint); color: var(--zai-fg); font-size: 12.5px;
}
.zai-sf-select:hover { background: var(--zai-hover); }
.zai-sf-select span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-sf-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 5;
  min-width: 220px; max-width: 300px; padding: 4px;
  border-radius: var(--zai-r-card); background: var(--zai-surface);
  box-shadow: 0 0 0 1px var(--zai-ring), 0 10px 28px rgba(20, 18, 30, 0.16);
  display: flex; flex-direction: column; gap: 1px;
  animation: zai-rise 160ms var(--zai-ease);
}
.zai-sf-menu > .zai-sf-input { flex: none; margin: 2px 2px 4px; }
.zai-sf-menu-list { display: flex; flex-direction: column; gap: 1px; max-height: 180px; overflow-y: auto; }
.zai-sf-item {
  display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px;
  border-radius: var(--zai-r-control); color: var(--zai-fg); font-size: 12.5px; text-align: start;
}
.zai-sf-item:hover, .zai-sf-item:focus-visible { background: var(--zai-hover); }
.zai-sf-item:focus { outline: none; }
.zai-sf-menu.zai-sf-up { top: auto; bottom: calc(100% + 4px); }
.zai-sf-item span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-sf-item-check { width: 14px; display: inline-flex; color: var(--zai-accent); flex-shrink: 0; }
.zai-sf-menu-sep { height: 1px; margin: 3px 4px; background: var(--zai-ring); }
.zai-sf-newfolder { display: flex; gap: 4px; padding: 2px; }
.zai-sf-empty { padding: 6px 8px; color: var(--zai-muted); }
.zai-sf-bad { outline: 2px solid var(--zai-danger-bg) !important; }
.zai-sf-checklabel { display: inline-flex; align-items: center; gap: 6px; height: 24px; margin-right: 10px; cursor: default; }
.zai-sf-checkbox { margin: 0; width: 15px; height: 15px; accent-color: var(--zai-accent); }
.zai-sf-chip { padding-right: 4px; }
.zai-sf-x { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; margin-left: 2px; border-radius: 50%; color: inherit; }
.zai-sf-x:hover { background: var(--zai-accent-soft); }
.zai-sf-add { color: var(--zai-muted); }
.zai-sf-instructions {
  display: block; box-sizing: border-box; width: 100%; margin-top: 6px; min-height: 120px; 
  padding: 8px 10px; border: none; border-radius: var(--zai-r-control); resize: vertical;
  background: var(--zai-faint); color: var(--zai-fg);
  font: 12px/1.55 ui-monospace, "SF Mono", Menlo, monospace;
}
.zai-sf-instructions:focus { outline: 2px solid var(--zai-accent-soft); }
.zai-sf-row { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.zai-sf-label { flex: 0 0 52px; padding-top: 4px; color: var(--zai-muted); font-size: 12px; }
.zai-sf-opts { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.zai-sf-opt {
  display: inline-flex; align-items: center; gap: 3px;
  height: 24px; padding: 0 9px;
  border-radius: var(--zai-r-pill);
  background: var(--zai-faint);
  color: var(--zai-fg);
  font-size: 12px;
  white-space: nowrap;
  transition: background-color 120ms ease, transform 160ms var(--zai-spring);
}
.zai-sf-opt:hover { background: var(--zai-hover); }
.zai-sf-opt:active { transform: scale(0.95); }
.zai-sf-opt.zai-on {
  background: light-dark(var(--zai-accent-soft), color-mix(in srgb, var(--zai-accent) 30%, transparent));
  color: light-dark(var(--zai-accent), color-mix(in srgb, var(--zai-accent) 35%, white));
  font-weight: 600;
}
.zai-sf-slash { color: var(--zai-muted); font-weight: 600; margin-right: -2px; }
.zai-sf-input {
  flex: 1; min-width: 0; height: 26px; padding: 0 8px;
  border: none; border-radius: var(--zai-r-control);
  background: var(--zai-faint); color: var(--zai-fg);
  font: inherit; font-size: 12.5px;
}
.zai-sf-input:focus { outline: 2px solid var(--zai-accent-soft); }
.zai-sf-note { color: var(--zai-warn-fg); font-size: 11.5px; }
.zai-sf-check { color: var(--zai-danger-fg); font-size: 12px; }
.zai-sf-check.zai-sf-hint { color: var(--zai-muted); }
.zai-skill-card .zai-allow:disabled { opacity: 0.35; }
.zai-sf-off { pointer-events: none; opacity: 0.6; }
.zai-sf-summary { padding: 0 12px 4px 50px; font-size: 12.5px; color: var(--zai-muted); }
.zai-sf-preview { margin: 2px 0 0; font-size: 12.5px; }
.zai-sf-preview summary { cursor: default; color: var(--zai-muted); padding: 2px 0; }
.zai-skill-card.zai-decided .zai-sf-preview { margin-bottom: 10px; }

/* Watches (watch-view.mjs): the card and the eye button's list */
.zai-wc-rows { display: flex; flex-direction: column; gap: 5px; padding: 0 12px 2px; font-size: 13px; }
.zai-wc-row { display: flex; gap: 8px; }
.zai-wc-label { flex: 0 0 52px; color: var(--zai-muted); font-size: 12px; padding-top: 1px; }
.zai-wc-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.zai-wc-then .zai-wc-text { font-weight: 600; }
.zai-wc-note { color: var(--zai-muted); font-size: 12px; margin-top: 2px; }
.zai-wc-allow { margin: 4px 0 0; height: auto; min-height: 24px; }
.zai-wc-warn { margin-top: 8px; }
.zai-watch-card.zai-decided .zai-wc-rows { padding-bottom: 10px; }
.zai-watch-btn { position: relative; }
.zai-watch-count {
  position: absolute; top: 2px; right: 1px; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box;
  border-radius: 7px; background: var(--zai-accent); color: #fff; font-size: 9.5px; font-weight: 700; line-height: 14px; text-align: center;
}
.zai-watches { width: 320px; padding: 4px 4px 6px; display: flex; flex-direction: column; }
.zai-watch-head { padding: 10px 12px 4px; font-size: 12px; font-weight: 600; color: var(--zai-muted); }
.zai-watch-list { display: flex; flex-direction: column; gap: 2px; padding: 4px; max-height: 340px; overflow-y: auto; }
.zai-watch-row { display: flex; align-items: flex-start; gap: 8px; padding: 7px 8px; border-radius: var(--zai-r-control); }
.zai-watch-row:hover { background: var(--zai-faint); }
.zai-watch-row.zai-ended { opacity: 0.7; }
.zai-watch-icon { display: inline-flex; padding-top: 2px; color: var(--zai-muted); }
.zai-watch-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.zai-watch-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-watch-sub { font-size: 12px; color: var(--zai-muted); overflow-wrap: anywhere; }
.zai-watch-stop { height: 24px; padding: 0 10px; border-radius: var(--zai-r-control); background: var(--zai-faint); font-size: 12px; flex-shrink: 0; }
.zai-watch-stop:hover { background: var(--zai-danger-bg); color: var(--zai-danger-fg); }
.zai-watch-x { flex-shrink: 0; }

/* What a reply cost (turn-stats.mjs): one muted line under it */
.zai-turn-stats { display: flex; align-items: center; gap: 6px; margin: 6px 0 0; font-size: 12px; color: var(--zai-muted); }
.zai-turn-stats span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Helper agents: a compact box per agent, grouped in the reply (agent-view.mjs) */
.zai-tasks { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
.zai-task {
  border-radius: var(--zai-r-card);
  background: var(--zai-input);
  box-shadow: 0 0 0 1px var(--zai-ring);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  animation: zai-rise 240ms var(--zai-ease);
}
.zai-task-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.zai-task-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--zai-muted); }
.zai-task[data-state="starting"] .zai-task-dot,
.zai-task[data-state="working"] .zai-task-dot { background: var(--zai-accent); animation: zai-pulse 1.4s ease-in-out infinite; }
.zai-task[data-state="waiting"] .zai-task-dot { background: var(--zai-warn-fg); }
.zai-task[data-state="done"] .zai-task-dot { background: light-dark(#2f8a4a, #7fd498); }
.zai-task[data-state="failed"] .zai-task-dot { background: var(--zai-danger-fg); }
.zai-task-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.zai-task-who { color: var(--zai-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.zai-task-state { color: var(--zai-muted); font-size: 12px; white-space: nowrap; flex-shrink: 0; }
.zai-task[data-state="waiting"] .zai-task-state { color: var(--zai-warn-fg); font-weight: 600; }
.zai-task[data-state="failed"] .zai-task-state { color: var(--zai-danger-fg); }
#zai-panel .zai-task-stop {
  flex-shrink: 0;
  border: none;
  border-radius: var(--zai-r-control);
  padding: 2px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--zai-fg);
  background: var(--zai-faint);
  cursor: pointer;
}
#zai-panel .zai-task-stop:hover { background: var(--zai-hover); }
.zai-task-activity { color: var(--zai-muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 14px; }
.zai-task-cards:empty { display: none; }
.zai-task-cards .zai-approval { margin: 4px 0 2px; }
.zai-approval-from { padding: 8px 12px 0; font-size: 12px; font-weight: 600; color: var(--zai-accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#zai-panel .zai-task-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 10px;
  border: none;
  background: none;
  padding: 1px 4px;
  border-radius: var(--zai-r-control);
  font: inherit;
  font-size: 12px;
  color: var(--zai-muted);
  cursor: pointer;
}
#zai-panel .zai-task-toggle:hover { color: var(--zai-fg); background: var(--zai-faint); }
.zai-task-details { display: flex; flex-direction: column; gap: 2px; padding: 4px 0 2px 14px; max-height: 320px; overflow: auto; }
.zai-task-details[hidden] { display: none; }
.zai-task-note { color: var(--zai-muted); font-size: 12.5px; }
.zai-task-update { display: flex; gap: 6px; font-size: 12.5px; color: var(--zai-muted); }
.zai-task-label { flex-shrink: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
.zai-task-result { margin-top: 4px; font-size: 13px; }
.zai-task-error { color: var(--zai-danger-fg); font-size: 12.5px; }
.zai-toolline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--zai-muted);
  overflow: hidden;
  animation: zai-rise 220ms var(--zai-ease);
}
.zai-toolline span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-toolline code { font: 12px ui-monospace, "SF Mono", Menlo, monospace; }
.zai-toolline.zai-denied { color: light-dark(#a1361b, #ffab91); }
.zai-toolline.zai-warned { color: var(--zai-warn-fg); }
/* browser_wait: what Claude waits for, a countdown, and "Stop waiting" */
.zai-toolline.zai-waiting { color: var(--zai-fg); }
.zai-toolline.zai-waiting > svg { color: var(--zai-accent); animation: zai-wait-pulse 1.6s ease-in-out infinite; }
@keyframes zai-wait-pulse { 50% { opacity: 0.35; } }
.zai-toolline .zai-wait-left { flex-shrink: 0; color: var(--zai-muted); font-variant-numeric: tabular-nums; }
.zai-wait-stop {
  flex-shrink: 0;
  margin-left: auto;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--zai-r-mini);
  font-size: 12px;
  color: var(--zai-muted);
  background: var(--zai-faint);
  transition: background-color 140ms ease, color 140ms ease;
}
.zai-wait-stop:hover { background: var(--zai-hover); color: var(--zai-fg); }
.zai-toolline.zai-warned, .zai-toolline.zai-denied { align-items: flex-start; }
.zai-toolline.zai-warned span, .zai-toolline.zai-denied span { white-space: normal; }
.zai-toolline.zai-warned svg, .zai-toolline.zai-denied svg { margin-top: 2px; }
.zai-approval-warn {
  margin: 0 12px 8px;
  padding: 7px 10px;
  border-radius: var(--zai-r-control);
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: var(--zai-warn-bg);
  color: var(--zai-warn-fg);
  font-size: 12.5px;
  line-height: 1.45;
}
.zai-approval-warn svg { margin-top: 1px; }
/* Skill-update card (skill-updates.mjs): lists, diff, safety, the finished line */
.zai-update-note { margin: 0 12px 4px; font-size: 13px; line-height: 1.45; color: var(--zai-muted); }
.zai-update-note.zai-update-bad { color: var(--zai-danger-fg); }
.zai-update-list { margin: 6px 12px 0; font-size: 13px; line-height: 1.45; }
.zai-update-list-title { font-size: 11.5px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: var(--zai-muted); margin-bottom: 2px; }
.zai-update-list ul, .zai-update-summary { margin: 0; padding-inline-start: 18px; }
.zai-update-list li, .zai-update-summary li { margin: 1px 0; }
.zai-update-unclear li, .zai-update-flags li { color: var(--zai-warn-fg); }
.zai-update-problems li { color: var(--zai-danger-fg); }
.zai-update-diffbar { margin: 8px 12px 0; }
.zai-update-toggle {
  padding: 3px 9px;
  border-radius: var(--zai-r-mini);
  background: var(--zai-faint);
  color: var(--zai-fg);
  font-size: 12.5px;
}
.zai-update-toggle:hover { background: var(--zai-hover); }
.zai-diff {
  margin: 6px 12px 0;
  max-height: 260px;
  overflow: auto;
  border-radius: var(--zai-r-control);
  background: light-dark(rgba(24, 23, 28, 0.04), rgba(255, 255, 255, 0.05));
  box-shadow: inset 0 0 0 1px var(--zai-ring);
  font: 12px/1.55 ui-monospace, "SF Mono", Menlo, monospace;
  padding: 4px 0;
}
.zai-diff[hidden] { display: none; }
.zai-diff > div { display: flex; gap: 6px; padding: 0 10px; white-space: pre-wrap; word-break: break-word; }
.zai-diff-sign { flex-shrink: 0; width: 1ch; color: var(--zai-muted); user-select: none; }
.zai-diff-add { background: light-dark(rgba(47, 158, 68, 0.13), rgba(90, 208, 114, 0.14)); }
.zai-diff-add .zai-diff-sign { color: light-dark(#2f9e44, #5ad072); }
.zai-diff-del { background: light-dark(rgba(217, 54, 43, 0.11), rgba(255, 122, 107, 0.14)); }
.zai-diff-del .zai-diff-sign { color: light-dark(#d9362b, #ff7a6b); }
.zai-diff-del > span:last-child { text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 35%, transparent); }
.zai-diff-same { color: var(--zai-muted); }
.zai-diff-gap { color: var(--zai-muted); font-style: italic; padding: 2px 10px !important; }
.zai-update.zai-update-safety { box-shadow: 0 0 0 1.5px var(--zai-warn-fg), 0 6px 18px rgba(20, 18, 30, 0.08); }
.zai-update.zai-update-compact { background: transparent; box-shadow: none; animation: none; }
.zai-update-done { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--zai-muted); padding: 2px 0; }
.zai-update-done > span { flex: 1; min-width: 0; }
.zai-update-done > svg { color: light-dark(#2f9e44, #5ad072); flex-shrink: 0; }
.zai-update-undo { padding: 2px 9px; border-radius: var(--zai-r-mini); background: var(--zai-faint); color: var(--zai-fg); font-size: 12.5px; }
.zai-update-undo:hover { background: var(--zai-hover); }
.zai-update-compact .zai-update-summary { font-size: 12.5px; color: var(--zai-muted); margin: 2px 0 2px 22px; }
/* A point from Claude's screenshot: a close-up with the spot(s) marked */
.zai-shot {
  margin: 0 12px 8px;
  max-height: 200px;
  border-radius: var(--zai-r-control);
  overflow: hidden;
  background: var(--zai-faint);
  box-shadow: 0 0 0 1px var(--zai-ring);
}
.zai-shot-pic { display: block; width: 100%; height: 100%; max-height: 200px; }
.zai-shot-mark { stroke: #fff; stroke-width: 2.5px; vector-effect: non-scaling-stroke; }
.zai-shot-click, .zai-shot-from { fill: var(--zai-accent); }
.zai-shot-to { fill: color-mix(in srgb, var(--zai-accent) 25%, transparent); stroke: var(--zai-accent); }
.zai-shot-path, .zai-shot-halo { fill: none; vector-effect: non-scaling-stroke; stroke-linecap: round; }
.zai-shot-halo { stroke: rgba(255, 255, 255, 0.85); stroke-width: 5px; }
.zai-shot-path { stroke: var(--zai-accent); stroke-width: 2px; stroke-dasharray: 5 4; }
.zai-fields {
  margin: 0 12px;
  padding: 8px 10px;
  border-radius: var(--zai-r-control);
  background: var(--zai-faint);
  display: grid;
  grid-template-columns: minmax(0, 42%) minmax(0, 1fr);
  gap: 5px 12px;
  max-height: 220px;
  overflow: auto;
  font-size: 12.5px;
}
.zai-f-label { color: var(--zai-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-f-value { overflow-wrap: anywhere; font-weight: 500; }
.zai-f-value.zai-f-skip { color: var(--zai-warn-fg); font-weight: 400; }
.zai-allow-site { background: var(--zai-faint); }
.zai-allow-site:hover { background: var(--zai-hover); }
.zai-allow.zai-risky { background: var(--zai-warn-fg); color: var(--zai-surface); }
.zai-allow.zai-risky:hover { background: color-mix(in srgb, var(--zai-warn-fg) 86%, transparent); }
/* "Allow all actions in this chat": a quiet link under the buttons */
.zai-approval-more { display: flex; justify-content: flex-end; margin: -6px 12px 8px; }
.zai-allow-all {
  height: 24px;
  padding: 0 6px;
  border-radius: var(--zai-r-mini);
  font-size: 12px;
  color: var(--zai-muted);
  transition: background-color 140ms ease, color 140ms ease;
}
.zai-allow-all:hover { background: var(--zai-danger-bg); color: var(--zai-danger-fg); }

/* Claude is using a tab: glowing border, Stop pill, element highlight */
#zai-agent {
  position: fixed;
  z-index: 2147482990;
  pointer-events: none;
  border-radius: var(--zen-native-inner-radius, 10px);
  animation: zai-fade 200ms ease;
}
#zai-agent[hidden] { display: none; }
#zai-agent::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--zen-primary-color, #1683ff) 85%, transparent),
    inset 0 0 30px color-mix(in srgb, var(--zen-primary-color, #1683ff) 40%, transparent);
  animation: zai-breathe 2.4s ease-in-out infinite;
}
@keyframes zai-breathe { 50% { opacity: 0.55; } }
.zai-agent-pill {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  height: 32px;
  padding: 0 4px 0 12px;
  border-radius: var(--zai-r-pill);
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(18, 16, 26, 0.84);
  color: #ffffff;
  font: 500 12.5px/1 -apple-system, system-ui, sans-serif;
  white-space: nowrap;
  box-shadow: 0 8px 24px rgba(10, 8, 20, 0.3);
  pointer-events: auto;
}
.zai-agent-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--zai-r-pill);
  background: var(--zen-primary-color, #1683ff);
  animation: zai-pulse 1.2s ease-in-out infinite;
}
#zai-agent .zai-agent-stop {
  appearance: none;
  border: 0;
  margin: 0;
  height: 24px;
  padding: 0 11px;
  border-radius: var(--zai-r-pill);
  background: rgba(255, 255, 255, 0.16);
  color: #ffffff;
  font: inherit;
  cursor: default;
  transition: background-color 140ms ease, transform 180ms var(--zai-spring);
}
#zai-agent .zai-agent-stop:hover { background: rgba(255, 255, 255, 0.26); }
#zai-agent .zai-agent-stop:active { transform: scale(0.94); }
.zai-agent-hl {
  position: absolute;
  border-radius: var(--zai-r-control);
  box-shadow: 0 0 0 2px var(--zen-primary-color, #1683ff), 0 0 0 6px color-mix(in srgb, var(--zen-primary-color, #1683ff) 25%, transparent);
  pointer-events: none;
}
.zai-agent-hl.zai-hl-pop { animation: zai-pop-in 260ms var(--zai-spring); }

/* File card */
.zai-filecard {
  margin: 4px 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: var(--zai-r-card);
  background: var(--zai-input);
  box-shadow: 0 0 0 1px var(--zai-ring);
  animation: zai-rise 240ms var(--zai-ease);
}
.zai-files { display: flex; flex-direction: column; gap: 6px; margin: 8px 0 4px; }
.zai-files > .zai-filecard { margin: 0; }
.zai-file-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  border-radius: var(--zai-r-control);
  cursor: default;
}
.zai-file-main:focus-visible { outline: 2px solid var(--zen-primary-color, #1683ff); outline-offset: 2px; }
.zai-file-main:active { cursor: grabbing; }
.zai-file-tile {
  position: relative;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--zai-r-mini);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 5px;
  box-sizing: border-box;
  background: var(--zai-accent-soft);
  color: var(--zai-accent);
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.zai-file-tile[data-ext="pdf"] { background: light-dark(#fde8e6, #4a2420); color: light-dark(#c62f22, #ff8a7a); }
.zai-file-tile:is([data-ext="docx"], [data-ext="doc"]) { background: light-dark(#e3edfd, #1f2f4d); color: light-dark(#2459c4, #8fb4ff); }
.zai-file-tile:is([data-ext="xlsx"], [data-ext="csv"], [data-ext="tsv"]) { background: light-dark(#e2f4e8, #1c3b27); color: light-dark(#1d7a3f, #7fd69e); }
.zai-file-tile[data-ext="ipynb"] { background: light-dark(#fdeedd, #48311a); color: light-dark(#c45f00, #ffb169); }
.zai-file-icon { position: absolute; inset: 0; width: 40px; height: 40px; opacity: 0; }
.zai-file-tile.zai-has-icon { background: none; }
.zai-file-tile.zai-has-icon .zai-file-icon { opacity: 1; }
.zai-file-tile.zai-has-icon .zai-file-ext { visibility: hidden; }
.zai-file-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.zai-file-name { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-file-meta { font-size: 12px; color: var(--zai-muted); }
.zai-file-btn { background: var(--zai-faint); }

/* Chips: context and attachments above the input, and on sent messages */
.zai-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 0 4px; }
.zai-chip {
  max-width: 100%;
  height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 3px 0 6px;
  border-radius: var(--zai-r-control);
  background: var(--zai-faint);
  color: var(--zai-fg);
  font-size: 12.5px;
  box-sizing: border-box;
}
.zai-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
.zai-chip-icon { width: 14px; height: 14px; border-radius: var(--zai-r-icon); flex-shrink: 0; object-fit: contain; }
.zai-chip-thumb {
  width: 28px;
  height: 18px;
  flex-shrink: 0;
  border-radius: var(--zai-r-icon);
  object-fit: cover;
  box-shadow: 0 0 0 0.5px var(--zai-ring);
}
.zai-chip svg { color: var(--zai-muted); }
.zai-chip-x {
  width: 20px;
  height: 20px;
  border-radius: var(--zai-r-mini);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--zai-muted);
  transition: background-color 120ms ease, color 120ms ease, transform 180ms var(--zai-spring);
}
.zai-chip-x:hover { background: var(--zai-hover); color: var(--zai-fg); }
.zai-chip-x:active { transform: scale(0.85); }
.zai-chip.zai-pop { animation: zai-pop-in 240ms var(--zai-spring); }
.zai-chip.zai-leaving { animation: zai-pop-out 140ms ease forwards; pointer-events: none; }
.zai-chip.zai-loading { animation: zai-pulse 1.1s ease-in-out infinite; }
.zai-user .zai-chips { justify-content: flex-end; padding: 0; }
.zai-user .zai-chip { padding-inline-end: 8px; color: var(--zai-muted); }

/* Skill pill inside the input row */
.zai-input-row { display: flex; align-items: flex-start; gap: 6px; padding: 0 2px 0 8px; }
.zai-input-row .zai-input { flex: 1; min-width: 0; }
.zai-pill {
  flex-shrink: 0;
  margin-top: 5px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  padding: 0 9px;
  border-radius: var(--zai-r-pill);
  background: var(--zai-accent-soft);
  color: var(--zai-accent);
  font-size: 13px;
  font-weight: 600;
  animation: zai-pop-in 240ms var(--zai-spring);
}
.zai-user .zai-pill { margin-top: 0; animation: none; }

/* "/" and "@" picker */
.zai-picker {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% - 4px);
  max-height: 280px;
  overflow-y: auto;
  padding: 6px;
  box-sizing: border-box;
  border-radius: var(--zai-r-card);
  background: var(--zai-surface);
  box-shadow: 0 0 0 1px var(--zai-ring), 0 12px 32px rgba(10, 8, 20, 0.22);
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 12;
  transform-origin: bottom center;
  animation: zai-menu-up 160ms var(--zai-ease);
}
/* A long list scrolls; its rows never squeeze to fit */
.zai-picker > * { flex-shrink: 0; }
.zai-pick {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 6px 10px;
  border-radius: var(--zai-r-control);
  text-align: start;
  transition: background-color 100ms ease;
}
.zai-pick.zai-active, .zai-pick:hover { background: var(--zai-hover); }
.zai-pick img { width: 16px; height: 16px; border-radius: var(--zai-r-icon); object-fit: contain; }
.zai-pick svg { color: var(--zai-muted); }
.zai-pick-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.zai-pick-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-pick-desc { font-size: 12px; color: var(--zai-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zai-pick-note { font-size: 12px; color: var(--zai-warn-fg); overflow-wrap: anywhere; }
/* Folder headings stay at the top while you scroll through their skills
   (and a row picked with the arrow keys scrolls into view below them) */
.zai-picker:has(.zai-pick-group) .zai-pick { scroll-margin-top: 30px; }
/* Folder headings stay at the top while you scroll through their skills */
.zai-pick-group {
  position: sticky;
  top: -6px;
  z-index: 1;
  margin: 0 -6px;
  background: var(--zai-surface);
  padding: 8px 16px 5px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--zai-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zai-pick .zai-check { color: var(--zai-accent); }
.zai-pick .zai-check.zai-pop { animation: zai-pop-in 220ms var(--zai-spring); }
.zai-pick-footer { border-top: 1px solid var(--zai-ring); margin-top: 4px; padding-top: 4px; }
.zai-pick-empty { padding: 10px; color: var(--zai-muted); font-size: 13px; }

/* Composer: 8px inside the window, so its 14px corners sit concentric with the window's 22px */
.zai-composer-wrap { position: relative; padding: 4px 8px 8px; flex-shrink: 0; }
.zai-composer {
  border-radius: var(--zai-r-card);
  background: var(--zai-input);
  box-shadow: 0 0 0 1px var(--zai-ring), 0 2px 8px rgba(20, 18, 30, 0.05);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: box-shadow 180ms ease;
}
.zai-composer:focus-within {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--zai-accent) 38%, var(--zai-ring)), 0 2px 10px rgba(20, 18, 30, 0.07);
}
.zai-input {
  appearance: none;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--zai-fg);
  font: inherit;
  font-size: 14.5px;
  line-height: 1.5;
  padding: 6px 0 2px;
  margin: 0;
  height: 30px;
  max-height: 144px;
  overflow-y: auto;
}
.zai-input::placeholder { color: var(--zai-muted); opacity: 1; }
.zai-toolbar { display: flex; align-items: center; gap: 2px; }
.zai-send {
  width: 34px;
  height: 34px;
  border-radius: var(--zai-r-control);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--zai-faint);
  color: var(--zai-muted);
  transition: background-color 160ms ease, color 160ms ease, transform 180ms var(--zai-spring);
}
/* The usage ring: 4px around Send, the stroke between them */
.zai-send-wrap { position: relative; display: inline-flex; margin-inline-start: 2px; }
.zai-send-wrap.zai-has-usage { margin-inline-start: 6px; }
.zai-usage-ring { position: absolute; inset: -4px; width: 42px; height: 42px; display: none; overflow: visible; pointer-events: none; }
.zai-has-usage .zai-usage-ring { display: block; }
.zai-usage-ring path { fill: none; stroke-width: 2.5; stroke-linecap: round; }
.zai-usage-track { stroke: color-mix(in srgb, var(--zai-fg) 13%, transparent); }
.zai-usage-value { stroke: var(--zai-usage); transition: stroke-dasharray 500ms var(--zai-ease), stroke 200ms ease; }
.zai-send-wrap[data-level="ok"] { --zai-usage: light-dark(#2f9e44, #5ad072); }
.zai-send-wrap[data-level="amber"] { --zai-usage: light-dark(#e08a00, #ffc23d); }
.zai-send-wrap[data-level="red"] { --zai-usage: light-dark(#d9362b, #ff7a6b); }
.zai-send svg { transition: transform 220ms var(--zai-spring); }
.zai-send:not(.zai-ready):not(.zai-stop) svg { transform: translateY(1px) scale(0.9); }
.zai-send:hover { background: var(--zai-hover); color: var(--zai-fg); }
.zai-send.zai-ready { background: var(--zai-accent); color: #ffffff; }
.zai-send.zai-ready:hover { background: color-mix(in srgb, var(--zai-accent) 86%, black); }
.zai-send.zai-stop { background: var(--zai-fg); color: var(--zai-surface); }
.zai-send:active { transform: scale(0.9); }
.zai-flash {
  position: absolute;
  left: 50%;
  bottom: calc(100% - 2px);
  transform: translateX(-50%);
  z-index: 13;
  white-space: nowrap;
  max-width: calc(100% - 24px);
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 5px 10px;
  border-radius: var(--zai-r-pill);
  background: light-dark(#1c1b1f, #f2f1f4);
  color: light-dark(#ffffff, #1c1b1f);
  font-size: 12px;
  font-weight: 500;
  pointer-events: none;
  transition: opacity 200ms ease;
  animation: zai-flash-in 200ms var(--zai-ease);
}

/* Effort menu */
.zai-menu {
  position: absolute;
  right: 46px;
  bottom: 52px;
  width: 236px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 6px;
  box-sizing: border-box;
  border-radius: var(--zai-r-card);
  background: var(--zai-surface);
  box-shadow: 0 0 0 1px var(--zai-ring), 0 12px 32px rgba(10, 8, 20, 0.22);
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 10;
  transform-origin: bottom right;
  animation: zai-menu-up 160ms var(--zai-ease);
}
.zai-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--zai-r-control);
  text-align: start;
  transition: background-color 100ms ease;
}
.zai-menu-item:hover { background: var(--zai-hover); }
.zai-menu-text { flex: 1; display: flex; flex-direction: column; }
.zai-menu-title { font-weight: 500; }
.zai-menu-desc { font-size: 12px; line-height: 1.35; color: var(--zai-muted); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.zai-menu-text { min-width: 0; }
.zai-menu-item .zai-check { color: var(--zai-accent); visibility: hidden; }
.zai-menu-item[aria-checked="true"] .zai-check { visibility: visible; }
.zai-menu-group { display: flex; flex-direction: column; gap: 2px; }
.zai-menu-group .zai-menu-desc { -webkit-line-clamp: 1; }
.zai-effort-row { display: flex; gap: 4px; padding: 2px 4px 4px; }
.zai-effort-btn {
  flex: 1;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-radius: var(--zai-r-control);
  background: var(--zai-faint);
  color: var(--zai-muted);
  font-size: 12.5px;
  font-weight: 500;
  transition: background-color 120ms ease, color 120ms ease, transform 180ms var(--zai-spring);
}
.zai-effort-btn svg { width: 15px; height: 15px; }
.zai-effort-btn:hover { background: var(--zai-hover); color: var(--zai-fg); }
.zai-effort-btn:active { transform: scale(0.96); }
.zai-effort-btn[aria-checked="true"] { background: var(--zai-accent-soft); color: var(--zai-accent); }
.zai-menu-label { padding: 6px 10px 2px; font-size: 11.5px; font-weight: 600; color: var(--zai-muted); }
.zai-menu-sep { height: 1px; margin: 4px 6px; background: var(--zai-ring); }

/* Model + effort button in the composer */
.zai-icon-btn.zai-model-btn { width: auto; gap: 3px; padding: 0 6px 0 9px; }
.zai-model-name { font-size: 12.5px; font-weight: 500; white-space: nowrap; max-width: 110px; overflow: hidden; text-overflow: ellipsis; }

/* Long chat hint, under the latest reply */
.zai-long-chat {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 8px 8px 10px;
  border-radius: var(--zai-r-card);
  background: var(--zai-faint);
  color: var(--zai-muted);
  font-size: 12.5px;
  line-height: 1.4;
  user-select: none;
  animation: zai-fade 200ms ease;
}
.zai-long-chat > svg { flex-shrink: 0; }
.zai-long-chat > span { flex: 1; min-width: 0; }
.zai-long-chat-btn {
  flex-shrink: 0;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--zai-r-control);
  background: var(--zai-surface);
  box-shadow: 0 0 0 1px var(--zai-ring);
  color: var(--zai-fg);
  font-size: 12.5px;
  font-weight: 600;
  transition: background-color 140ms ease, transform 180ms var(--zai-spring);
}
.zai-long-chat-btn:hover { background: var(--zai-hover); }
.zai-long-chat-btn:active { transform: scale(0.96); }

/* An expired chat: read it, or carry on in a new one */
.zai-expired {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 8px 8px 12px;
  border-radius: var(--zai-r-card);
  background: var(--zai-faint);
  color: var(--zai-muted);
  font-size: 12.5px;
  line-height: 1.4;
  user-select: none;
  animation: zai-fade 200ms ease;
}
.zai-expired > svg { flex-shrink: 0; }
.zai-expired > span { flex: 1 1 220px; min-width: 0; }
.zai-expired-btn {
  flex-shrink: 0;
  margin-inline-start: auto;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--zai-r-control);
  background: var(--zai-fg);
  color: var(--zai-surface);
  font-size: 12.5px;
  font-weight: 600;
  transition: background-color 140ms ease, transform 180ms var(--zai-spring);
}
.zai-expired-btn:hover { background: color-mix(in srgb, var(--zai-fg) 86%, transparent); }
.zai-expired-btn:active { transform: scale(0.96); }
/* Read-only: the banner takes the composer's place */
.zai-composer.zai-readonly { display: none; }

/* Drag files onto the chat */
.zai-drop {
  position: absolute;
  inset: 8px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: var(--zai-r-card);
  border: 1.5px dashed color-mix(in srgb, var(--zai-accent) 60%, transparent);
  background: color-mix(in srgb, var(--zai-surface) 88%, var(--zai-accent));
  color: var(--zai-accent);
  font-size: 13.5px;
  font-weight: 600;
  pointer-events: none;
  animation: zai-fade 120ms ease;
}
.zai-drop svg { animation: zai-pop-in 260ms var(--zai-spring); }
.zai-drop-sub { font-size: 12px; font-weight: 500; color: var(--zai-muted); }

@media (prefers-reduced-motion: reduce) {
  #zai-panel, #zai-panel *, #zai-tooltip, #zai-capture, #zai-capture *, #zai-agent, #zai-agent * {
    animation: none !important;
    transition-duration: 0s !important;
  }
  :root[zai-dock-anim] #tabbrowser-tabbox { transition: none !important; }
}
`;
