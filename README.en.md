# RDPilot

**A local remote desktop connection manager for Windows.** Keep RDP hosts scattered across
registry entries, spreadsheets and shortcuts in one place: groups, search, reachability probes,
saved credentials and tabbed sessions for tens to hundreds of machines.

RDPilot does not install an agent, run a relay server, or provide unattended access — connections
use the RDP service that is already on the target. Configuration, passwords and logs stay on your
machine.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%201809%2B%20%7C%20Windows%2011-0078D4)
[![CI](https://github.com/1728578755/rdpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/1728578755/rdpilot/actions/workflows/ci.yml)

---

## Features

- Import existing Remote Desktop history from the registry (`Terminal Server Client` MRU), with de-duplication
- Card and list views, four layouts (1 / 2 / 3 columns, list)
- OS detection from the host name, with matching icons
- Live search over name, address, port, user name and notes
- Groups: create, rename, move; deleting a group moves its connections back to "Ungrouped"
- Reachability probe with online / offline / unknown states (timeouts are "unknown", not "offline")
- Three executors: built-in `RdpHost` (default, uses the system `mstscax.dll`), system `mstsc.exe`,
  and bundled FreeRDP 3.32.2
- Independent session window with browser-style tabs for multiple hosts
- Password storage through Windows DPAPI; passwords are piped to child processes over stdin,
  never written to disk or passed on the command line
- Atomic data writes with rolling backups; log redaction; no telemetry, accounts or cloud checks
- Chinese / English, light / dark theme
- CLI: `--list`, `--probe`, `--connect`, `--disconnect`, `--diagnose` (see [docs/CLI.md](docs/CLI.md))

---

## Download

Prebuilt packages are on the [Releases](https://github.com/1728578755/rdpilot/releases/latest) page:

- `RDPilot-1.0.0-x64-setup.exe` — NSIS installer
- `RDPilot-1.0.0-x64-portable.exe` — portable single file
- `SHA256SUMS.txt` — verify with `sha256sum -c SHA256SUMS.txt`

The binaries are unsigned, so the first run triggers SmartScreen.

---

## Build from source

Requirements: Windows 10 1809+ / Windows 11 (x64), Node.js 22+, and the `csc.exe` that ships with
.NET Framework 4.8 (present by default on Windows 10/11).

```bash
npm ci
npm run build:native   # compiles resources/RdpHost.exe and resources/CertProbe.exe
npm run dev            # development mode with renderer hot reload
npm run build:win      # NSIS installer + portable exe + SHA256SUMS.txt in release/
```

Quality gates:

```bash
npm run typecheck
npm run verify         # typecheck + source-level suites + smoke test, no GUI required
```

---

## Project layout

```
src/main/       main process: data store, state machine, window lifecycle, IPC
src/preload/    contextBridge API (ipcRenderer is not exposed)
src/renderer/   React 18 UI
src/shared/     types, channel names, error model shared by all three layers
native/         C# components: RdpHost (session host), CertProbe (certificate CN lookup)
resources/      icons and bundled FreeRDP
scripts/        verification, smoke and release scripts
```

Stack: Electron 33, React 18, TypeScript, Tailwind CSS, Zustand. No UI component library;
the only production dependencies are React, React DOM and Zustand.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and security boundaries.

---

## Data and privacy

Everything is stored in `%APPDATA%\rdpilot\`:

```
data.json              connections, groups, settings (plain JSON, no passwords)
data.backup.json       previous snapshot
data.backup.1–5.json   rolling backups
credentials.json       encrypted passwords (DPAPI, bound to the current Windows account)
window-state.json      window position and size
logs/main.log          runtime log (rotates at 2MB, 3 history files, 8MB total)
```

Nothing is uploaded. Uninstalling the NSIS package does not delete this directory.
See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

---

## Known limitations

1. Windows only — history import uses the registry, credentials use DPAPI.
2. The default executor needs the Windows Remote Desktop components; slim Windows images can use
   the bundled FreeRDP or `mstsc.exe` instead.
3. The mstsc fallback writes a temporary `.rdp` containing a DPAPI ciphertext, then overwrites and
   deletes it after 3 seconds.
4. FreeRDP runs as an external process and does not join the built-in tabbed window yet.
5. The `cmdkey` fallback puts a plaintext password on a child process command line; it is only used
   when DPAPI fails.
6. Remote host certificate validation is skipped by default (can be enabled in settings).
7. Builds are unsigned and there is no auto-update.
8. The native session host and certificate probe require .NET Framework 4.8; run
   `npm run build:native` before starting from source.

---

## Contributing

Issues and pull requests are welcome. Please make sure `npm run typecheck` and `npm run verify`
pass, and never commit real host names, addresses or credentials. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Bundled FreeRDP and its dependencies keep their own licenses — see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
