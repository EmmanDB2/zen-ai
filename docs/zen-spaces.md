# Zen's Space API (what Zen AI relies on)

Read from Zen **1.23.2b** on this Mac: `/Applications/Zen.app/Contents/Resources/browser/omni.ja`,
extracted to `.zen-src/` (gitignored; re-extract with
`unzip -o /Applications/Zen.app/Contents/Resources/browser/omni.ja -d .zen-src`; the
"central directory" warning unzip prints is normal for omni.ja). Line numbers are
for that version. Zen calls Spaces **workspaces** in code.

## The object

`window.gZenWorkspaces`, one per browser window, an `nsZenWorkspaces`
(`.zen-src/modules/zen/ZenSpaceManager.mjs:43`, created at `:3577`).

| What | How | Where |
|---|---|---|
| Active Space id | `gZenWorkspaces.activeWorkspace` (a uuid string, `""` before init) | getter `:669` |
| Active Space object | `gZenWorkspaces.getActiveWorkspace()` → `{ uuid, name, icon, theme, containerTabId, ... }` | `:1403`, shape `:2726` |
| All Spaces | `gZenWorkspaces.getWorkspaces()` (a copy of `_workspaceCache`) | `:739` |
| One Space | `gZenWorkspaces.getWorkspaceFromId(uuid)` | `:731` |
| Space icon | `workspace.icon`: an emoji, a `chrome://….svg` URL, or empty. `getWorkspaceIcon(ws)` falls back to the name's first letter | `:1411`; rendering in `ZenSpaceIcons.mjs:126-158` |
| Ready | `gZenWorkspaces.promiseInitialized` resolves once Spaces are restored and the first switch (`onInit`) is done | `:83`, resolved `:887` |
| Enabled | `gZenWorkspaces.workspaceEnabled` (false in hidden/popup windows) | `:723` |
| Private window | `gZenWorkspaces.isPrivateWindow` = `PrivateBrowsingUtils.isWindowPrivate(window)` | `:707` |

The active id is per window (`#activeWorkspace`), also saved to the pref
`zen.workspaces.active` (`:685`) for the next start. Space ids are shared by all
synced windows (`ZenWindowSync.sys.mjs`), so the same uuid means the same Space
in every normal window.

## Switching Spaces

There is **no DOM event for a switch**. The hook is a listener list:

```js
gZenWorkspaces.addChangeListeners(fn)      // :1787, fn({ workspace, onInit })
gZenWorkspaces.removeChangeListeners(fn)   // :1799
```

`changeWorkspace()` (`:1813`) → `#performWorkspaceChange()` (`:1843`) sets
`activeWorkspace` **first** (`:1849`), selects the Space's last tab
(`_handleTabSelection`, `:2488`, which fires the normal `TabSelect`), animates,
then `#updateWorkspaceState()` awaits each change listener in turn (`:2578-2585`).
So a listener should return quickly (it holds up the rest of the switch) and
`TabSelect` during a switch already sees the new `activeWorkspace`.

Listeners also run once on startup with `onInit: true` (`onWindowRestored`,
`:850-892`).

Selecting a tab that lives in another Space switches Spaces too
(`onBeforeTabSelect` `:2419`, `onLocationChange` `:3008-3055`).

Other events (not switches):
- `ZenWorkspacesUIUpdate` on `window`, `detail.activeIndex` = active uuid
  (`:2622`): fired on startup and when Spaces are added/removed/edited, **not**
  on every switch.
- `ZenWorkspaceDataChanged` on `window` (`:1436`): a Space was renamed,
  re-iconed, created or deleted.
- `AfterWorkspacesSessionRestore` (`:1060`).

## Tabs

- A tab's Space: attribute **`zen-workspace-id`** = Space uuid (`:250`, `:1692`,
  `:2442`).
- **Essentials** have `zen-essential="true"` and belong to no Space: they show in
  every Space (`_shouldShowTab`, `:2440-2475`; with
  `zen.workspaces.separate-essentials` they're per container).
- **Pinned** tabs are normal tabs with a `zen-workspace-id`; they belong to their
  Space.
- The empty new-tab placeholder has `zen-empty-tab` (`:2429`).
- `gBrowser.visibleTabs` is already only the active Space's tabs plus Essentials.

## Private windows and unsynced windows

`privateWindowOrDisabled` (`:719`): private windows (and "unsynced" windows) get
their own throwaway Space ("Incognito", `#createWorkspaceData` `:2712-2725`) and
don't save it.

## What Zen AI does with this

- Current Space = `gZenWorkspaces.activeWorkspace` (not the tab's attribute: an
  Essential has none, and its chat is the Space you're in).
- Switches: `addChangeListeners` (removed on window unload), plus a `TabSelect`
  check of `activeWorkspace` as a backup in case the listener API changes.
- Space name for "Recent in <Space>": `getWorkspaceFromId(id).name`.
- No `gZenWorkspaces`, or it throws: one chat list for the window (Space id
  `"default"`). Private window: nothing is saved.
