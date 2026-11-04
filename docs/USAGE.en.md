# RDPilot usage guide

## First launch

A short welcome screen appears once, explaining what RDPilot is, where your data lives
and how to start. It offers two main actions:

- **Import from Windows** — closes the welcome screen and opens the history import wizard
- **New connection** — closes the welcome screen and opens the connection form
- **Later** — closes the welcome screen; the next launch falls back to the normal
  import-wizard startup behavior if the library is still empty

The welcome screen and the import wizard never open at the same time. On the main
screen, press **F1** (or click **Help** above Settings in the sidebar) for quick start,
shortcuts, troubleshooting and data/privacy details.

## Importing Windows history

The import wizard:

1. Scans the registry and lists every Remote Desktop entry it finds
2. Lets you check individual entries, or use Select all / Deselect all
3. Enables “Group by subnet on import” by default (for example `10.68 Intranet`, `Public`)
4. Imports the selection, or cancels with “Maybe later, don't ask again” (remembered)

Import only adds connection metadata. Existing entries have empty fields filled in; your
names, groups and favorites are never overwritten. No passwords are imported.

## Creating a connection

Click **New connection** in the top bar or press `Ctrl + N`. **Only the address is required**;
everything except the password has a default:

| Field | Required | Notes |
|---|---|---|
| Address | Yes | You can paste `IP:port`; the port is split out automatically (3389 by default) |
| User name / domain | No | Leave empty to use the Windows credential or the connection-time prompt |
| Password | No | “Save password” is on by default; only a filled password creates a DPAPI-encrypted credential. Turn it off to use the password for this session only |

Name, group, color tag, note and remote settings live under **More settings**
(collapsed for new connections, expanded when editing):

| Field | Notes |
|---|---|
| Name | Falls back to the host address when empty |
| Group, color tag, note | Notes are searchable |
| Remote settings | Display mode (full screen / window / multi-monitor), resolution, color depth, audio |

**Save and connect** starts the session immediately.

## Session window

Settings → **Connection & session** offers three protocol engines:

- **Built-in RdpHost** (default): RDPilot's own window using the Windows RDP control; clipboard,
  audio, multi-monitor and dynamic resolution match the native client. With no saved password it
  uses the **current Windows credentials** (CredSSP); a saved password takes precedence.
- **System mstsc**: the Windows client, as a compatibility fallback.
- **FreeRDP (bundled)**: FreeRDP 3.32.2 ships with the app and does not depend on the Windows RDP
  components. It needs a saved password; Windows SSO and the in-app B2 shape are next. It currently
  runs as an external process, so its window/taskbar are managed by FreeRDP.

The built-in session window is **independent**: it opens at about 50% of the work area, is freely
resizable, and leaves the main RDPilot window usable while connected. Multiple sessions open as
browser-style tabs in one window; the tab `×` closes the current session, and the `+` at the right
end of the tab strip starts a new connection (after saving and connecting it is appended as a new
tab). The window has no native title bar; double-click the title bar to maximize/restore, and `F11`
enters full screen with all chrome hidden; the top bar offers More / scale / full-screen / minimize /
maximize / close (reconnect and disconnect moved into the More and tab context menus).
By default the app keeps a single taskbar entry; Settings can give the session window its own icon.
Closing the session window immediately marks the connection disconnected in the main UI. Right-click
a tab for connection info, connection speed, clipboard/drive/printer/audio toggles, or “Edit connection”.
The remote-identity confirmation dialog is off by default; turn off “Skip the remote identity warning”
for strict validation.

## Layout, sorting and filtering

The top bar only handles search and layout (one / two / three columns, list). Sorting,
filters and density live in the toolbar above the host list:

- **One column**: widest cards, full names and user names
- **Two columns**: balanced
- **Three columns**: more hosts on screen; automatically falls back to two/one on narrow windows
- **List**: table with a 1, 2, 3… ordinal column and sortable headers (host / address / user /
  state / last connected). **A single click only selects; double-click connects** — same rule as
  cards, so a glance never opens a production machine.

The left side of the toolbar shows counts and filters (All / Online / Offline / Connected /
Saved pwd / Ungrouped, combinable); the right side has sorting, sort direction, density and
refresh connectivity. When searching, the count becomes “matching M / total N”, and matches
in names, addresses, user names and notes are highlighted.

Filters, sorting, direction, density, layout and column visibility are remembered. In a
narrow window, secondary filters collapse into a “Filters” menu.

## Batch actions

List rows have no checkboxes: click selects, `Ctrl` toggles, `Shift` selects a range, `Space`
toggles, `Shift+↑/↓` extends. Selecting at least two rows reveals a bottom action bar:
**Move to group / Favorite / Delete / Cancel**. Batch delete shows one confirmation with a
single **Undo**, which restores the whole batch (groups, favorites, notes, credential flags
included).

## What clicking a card does

- **Hovering highlights and selects a card/row; a single click keeps it selected; double-click connects.**
  When connected / connecting / not established, double-click also only selects.
- Right side of a card: **Connect** (or **Disconnect** when a session exists) and a **⋯** menu.
- **Name / IP / username / address text can be selected normally; double-click the text to copy**
  (this does not connect).
- Right-click: Connect/Disconnect, Edit, Copy (name / IP / address+port / username / full details),
  Share (copy share text / save `.rdp`), Favorite, Move to group, Delete.
- The `⋯` button and the context menu expose the same actions; list rows keep `▸` + `⋯`.
- Keyboard: `Tab` focuses cards, `Enter` connects (explicit), `Space` only selects, `F2` edits,
  `Shift+F10` or the Menu key opens the context menu; `↑` `↓` move between rows in the list.

The card title prefers the computer name: RDPilot reads the RDP server certificate CN
(`CertProbe.exe`), then falls back to DNS PTR / NetBIOS. If none is available it shows the
**IP/domain** itself; the username only appears as the `user@` prefix on the second line. The grey
second line uses the exact `Administrator@198.51.100.110:3389` form (username and address can be
double-clicked separately), and you can rename the connection at any time. Online/offline/latency
is no longer written as text: the status dot on the host icon means green = online/connected,
yellow = offline, amber breathing = connecting/probing.
The list state column only adds a word for offline or an active session.

## Multi-tab sessions and sharing

- Multiple sessions on the same PC open as **browser-style tabs in one RDPilot session window**;
  the `×` on a tab closes it. The top bar keeps only **6 action buttons** — `⋯` More / scale /
  full-screen / minimize / maximize / close. **Reconnect and Disconnect are no longer in the title
  bar**; they live in the More menu and the tab context menu.
- The session window is independent from the main window, so RDPilot remains usable while
  connected; `F11` enters full screen and sessions start windowed.
- **Tabs behave like browser tabs**: drag to reorder, drag out of the window (48px past the edge) to
  tear off, middle-click to close, `Ctrl+W` closes the current one, `Ctrl+1~9` jumps to a tab, the
  wheel scrolls the strip. Dragging a tab into the picture no longer tears it off.
- **Moving the window**: grab the handle at the far left of the top bar (brand mark + two dot columns,
  the cursor turns into a move cursor), drag any empty part of the bar, or hold `Ctrl` and drag a tab.
  **With only one tab left, dragging that tab moves the window** (browsers won't tear off the last tab
  either). Releasing at the top of the screen maximizes; leave full screen with `F11` first.
- **A dropped session keeps its tab**: when the remote host reboots or the network blips, the tab
  stays with an amber “Disconnected” state; use Reconnect in the More menu or the tab context menu to
  restore it in place. Only closing the tab ends the session.
- **Tabs show link quality, not desktop size**: title + latency (ms) + throughput (kbps, switched to
  Mbps above 10Mbps) + FPS (0 on a static desktop). Throughput comes from Windows TCP statistics and
  only shows when RDPilot runs elevated; otherwise the slot is omitted rather than showing a fake
  number. Tabs start compact and shrink together as more sessions open, then scroll/use the overflow
  list at the readable floor.
- **Original aspect ratio**: the remote desktop is centered with black bars when the window aspect
  differs; click a black bar or the “Keep original aspect ratio” context item to fill the window,
  and click it again to restore.
- **Edge resizing**: the outer edge shows a resize cursor and all four sides/corners drag; display
  renegotiation happens once on release, so dragging does not flash repeatedly.
- **Close confirmation**: with Settings → “Confirm before disconnect” enabled, the tab `×`,
  `Ctrl+W`, the full-screen bar `×`, and closing the whole session window all ask first (default is
  No). “Disconnect all” on the main window still asks only once.
- Startup “Maximized” is a real maximize (header and taskbar remain); use `F11` or full-screen
  startup for borderless immersive mode.
- Right-click empty list space or the toolbar text: New, Import from clipboard, Import Windows
  history, Copy all settings, Import/Export configuration file.
- **Sharing**: right-click a connection → Share → copy share text, then paste into another
  RDPilot via “Import from clipboard”; or save a standard `.rdp` file. Neither contains a
  password — the receiving side is prompted normally on first connect.

## Passwords and system credentials

Check “Save this password (DPAPI-encrypted, this PC only)” and enter a password: the
ciphertext is stored in `%APPDATA%\rdpilot\credentials.json`. RDPilot writes the ciphertext
into a temporary `.rdp` file for mstsc; plaintext is never written to disk. Editing the
connection fills the saved password back in (masked by default); click the eye or **View
password** to reveal it. Reveal only happens in the main-window edit drawer, is decrypted on
demand, and is cleared when the drawer closes; there is no bulk plaintext export API.
Windows Credential Manager is normally **not** written to; only when local encryption fails
does RDPilot fall back to writing a system credential once.

The asymmetry matters: this app **may write** a system credential (fallback only) but
**never deletes** one, so cleanup is manual. The entry `TERMSRV/<host>` is shared with the
one mstsc creates when you check “Remember me”; deleting it could remove your own credential.

To clear a saved password: edit the connection and click **Clear saved password (this app
only, Windows Credential Manager is untouched)**, or turn off “Save this password” and save.
This only removes RDPilot's ciphertext. If you checked “Remember me” in mstsc, that entry
remains: open Credential Manager → Windows Credentials → delete `TERMSRV/<host>`.

**Migration**: `credentials.json` is tied to the current Windows account and cannot be
decrypted elsewhere. Move only `data.json` (it contains no passwords) and re-enter passwords
on the new machine.

## Clearing all connections

Settings → Data & backup → Clear all connections:

- Deletes every connection and group saved by this app and disconnects active sessions;
  the import blocklist is cleared too, so deleted hosts may reappear on the next import
- Does **not** touch Windows Credential Manager: entries you created in mstsc remain, so
  passwordless sign-in may still work until you delete them manually

## Language and theme

Settings → Appearance: theme Light / Dark / Follow system (default), language Simplified
Chinese / English / Follow system (default). Changes apply immediately.

## Connection state colors

| State | Color / shape | Meaning |
|---|---|---|
| Connected | Solid green | Session established; can be disconnected from the app |
| Connecting | Amber (breathing) | mstsc started, waiting for the session |
| Not established | Orange | mstsc process is alive but no desktop yet — often a login or error dialog |
| Failed | Red | mstsc failed to start, or exited before the session was established |
| Disconnected | Gray | Session ended |

The connectivity dot on a card is separate: it only reports TCP reachability:

- **Solid green dot**: online, followed by latency (e.g. “Online · 18 ms”)
- **Hollow gray ring**: unknown — not probed yet, probe blocked, or startup probe still running; **not offline**
- **No dot**: connectivity checking is disabled in Settings

Non-3389 ports show a neutral badge (e.g. `:30389`) so two entries for the same machine on
different ports are easy to tell apart.

## Settings & diagnostics

Settings is one vertically scrolling page: Appearance / Startup & window / Connection & session /
Data & backup / Shortcuts / About & diagnostics are all visible; there are no horizontal tabs.
A clickable section index on the left jumps straight to any section and follows the scroll.

- **Appearance**: theme, language, and interface size (90% / 100% / 110% / 125%), applied immediately.
  Interface size scales the RDPilot window only; remote desktop resolution is unchanged.
- **Startup & window**: close-to-tray, auto-scan history, connectivity probing with an automatic
  interval (30 seconds–5 minutes, or open/manual only), session-window taskbar mode
  (merged into the main icon, or its own icon), start-maximized, hostname detection, subnet
  grouping on import — each row explains its side effects
- **Connection & session**: protocol engine (built-in RdpHost / system mstsc / bundled FreeRDP /
  in-app B2 planned), use Windows sign-in credentials when no password is saved, skip the
  remote computer identity warning. FreeRDP can point at a local `wfreerdp.exe` (empty = bundled)
  and requires a saved password.
- **Data & backup**: import Windows history, export/import configuration, clear all connections
  (dangerous; requires typing a confirmation word)
- **About & diagnostics**: version and runtime, history channel (`reg.exe` / PowerShell),
  session state detection, DPAPI availability, data and log folders (copy or open), mstsc
  path (redetect), copy diagnostics, restore default settings. Restoring defaults resets
  preferences only, never connections or groups.

All data stays in `%APPDATA%\rdpilot\`: `data.json` (connections/groups/settings, no
passwords), `credentials.json` (DPAPI ciphertext), `logs\main.log`, and `window-state.json`
(window position; not backed up). The portable build writes no registry keys and installs
no services; deleting the executable uninstalls it.

## Shortcuts

| Key | Action |
|---|---|
| `Ctrl + F` | Focus search |
| `Ctrl + N` | New connection |
| `Ctrl + Enter` | Connect the selected host (respects filters; never connects to an invisible host) |
| `Enter` | Connect the focused item |
| `Ctrl + A` | Select all visible results |
| `Delete` | Delete selected connections (with confirmation) |
| `↑` `↓` | Move the selection |
| `F2` | Edit the focused connection |
| `Shift + F10` / Menu key | Open the context menu |
| `Esc` | Close the topmost overlay (drawer, dialog, menu) |
| `F1` | Open help |
| `Ctrl + S` / `Ctrl + Shift + S` | Save / Save and connect (inside the drawer) |
