# Bugs fixed

21 bugs fixed, 5 of them high severity.
The worst ones stopped the app from starting, or left it stuck with no message.
The app still behaves like the Windows and macOS builds, apart from what Linux needs.

All regression helpers pass. Bug 16 could not be run because it needs root, and bug 18 is partly verified. Apart from bugs 20 and 21, which turned up after the first release, these results come from the round of work on bugs alone, and [testing.md](testing.md) has the checks on the current package.

## Bugs

| # | Bug | Severity | Status | How it was verified |
|---|-----|----------|--------|---------------------|
| 1 | AppArmor rule names another path: silent crash at start | High | Fixed | `test/lifecycle.sh`: window opens |
| 2 | Disk full during an update: raw JavaScript error, then a hang | High | Fixed | `test/update-failures.sh`, simulated with `/dev/full` |
| 3 | Install or home path with non-ASCII letters: stuck at "Loading plugins…" forever | High | Fixed | `test/lifecycle.sh`, plus a full in-app update under such a path |
| 4 | Missing `libX11-xcb.so.1`: installer passes, then silent crash at start | High on minimal systems | Fixed | Ubuntu 22.04 and Debian 12 containers |
| 5 | Stop signal with a task running: the app asks a question and stays alive | Medium | Fixed | `test/lifecycle.sh`: gone within 4 s |
| 6 | Stalled update download or feed: waits forever | Medium | Fixed | `test/update-failures.sh`, feed also on the old build |
| 7 | Failed update shows "Node.js v24.21.0" instead of the reason, and leaves a folder behind | Medium | Fixed | `test/update-failures.sh` |
| 8 | Quit during update preparation leaves the engine running | Medium | Fixed | `test/update-failures.sh` |
| 9 | Installing a newer package keeps the old version forever (2.1 GB) and offers no rollback | Medium | Fixed | `test/lifecycle.sh` |
| 10 | Installer's fix command fails on Ubuntu 24.04, and there is none for Fedora | Medium | Fixed | Commands run as printed in four containers |
| 11 | Uninstall while the app runs says "removed" and the app keeps running from deleted files | Medium | Fixed | `test/lifecycle.sh` |
| 12 | User namespaces blocked with no readable setting: silent crash at start | Medium | Fixed | Container, old build and new build |
| 13 | Uninstall leaves a dangling `dsh` link, a marker file and `dsh://` entries | Low | Fixed | `test/lifecycle.sh`: nothing left |
| 14 | Home with no `~/.config`: link handler not registered, empty temp file left | Low | Fixed | `test/lifecycle.sh` |
| 15 | Paths with `$`, a backtick, `"`, `%` or `\` break the menu entry | Low | Fixed | `test/lifecycle.sh` with `desktop-file-validate` |
| 16 | Sandbox setup writes the wrong rule for nested home paths | Low | Fixed, not run, later replaced by an exact-path rule | Read through only, loading a rule needs root |
| 17 | Background notice promises a tray icon many desktops do not show | Low | Fixed | Seen on a display with no tray |
| 18 | Updates need a system `xz` program, which some systems lack | Low | Fixed, partly verified | `tar` failure shown, full update with no `xz` not run |
| 19 | No `xdg-open`: no warning that links will not open | Low | Fixed | Note seen in containers |
| 20 | With `bubblewrap` installed, the agent's commands are cut off from the desktop, sound, other apps and a `gh` login kept in the keyring | High | Fixed | `test/sandbox-reach.mjs`, plus a real desktop |

## High severity

### 1. AppArmor rule names another path

**What:** The launcher only checked that the rule file exists, not what it names. With a custom home or a second install, it kept Chromium's sandbox on, and Chromium stopped with exit 133.

**Why it matters:** Nothing appears on screen. The app just does not open.

**What changed:** The launcher checks that the rule names this install. If not, it starts without the sandbox and says so, as it already did when there is no rule.

**How it was checked:** `test/lifecycle.sh` shows "Running without Chromium's sandbox" and an open window. The same check gives the right answer for the default path with the real rule.

### 2. Disk full during an update

**What:** The download stream had no error handler, so a full disk raised a raw JavaScript error dialog from the main process, and the update then hung.

**Why it matters:** The user sees a stack trace and a stuck app.

**What changed:** The download now fails through the normal path and removes its partial file.

**How it was checked:** `test/update-failures.sh` points the download at `/dev/full`. The normal dialog appears with "ENOSPC: no space left on device, write" under details, and nothing is left behind. A real full disk was not used.

### 3. Non-ASCII install or home path

**What:** In Node mode, Electron on Linux does not recognize `app.asar` under a path with non-ASCII letters. The backend failed with `Cannot find module`, and the app stayed at "Loading plugins…".

**Why it matters:** It hits anyone whose user name or home folder has an accent or non-Latin letters, and no message explains it.

**What changed:** Under such a path, the installer and the update engine expand `app.asar` into a real folder of the same name. Other paths keep the file as before.

**How it was checked:** Install under `Ñandú 文档` opens the window and reaches a working backend. A full in-app update under that path also passes: prepared, `current` moved, `previous` set, relaunched, backend up.

### 4. Missing `libX11-xcb.so.1`

**What:** Chromium loads this library at start with `dlopen`, so `ldd` does not list it and the installer's check passed. Without it the app dies with exit 133 and no message.

**Why it matters:** It affects minimal Ubuntu 22.04 and Debian 12 systems. Full desktops normally have it.

**What changed:** The installer also looks for it with `ldconfig -p` and names the package.

**How it was checked:** Reproduced with `strace` and `gdb` in containers. After the fix the installer lists it, and the app starts once it is installed.

## Medium severity

### 5. Stop signal with a task running

**What:** With a task running, `SIGTERM` or `SIGHUP` to the main process led to the "quit?" dialog, and the app stayed alive.

**Why it matters:** Under `kill`, `systemctl stop`, or anything else that stops only the main process, nobody may be there to answer. The app keeps running until it is killed hard.

**What changed:** On Linux both signals now count as the session ending, the same path upstream uses for system shutdown.

**How it was checked:** `test/lifecycle.sh` starts a task, sends each signal, and finds the app and its tasks gone within 4 s. `test/quit.sh` still passes, and Ctrl+Q with a task running still asks first.

### 6. Stalled update download or feed

**What:** A download that stopped receiving data stayed at 0% forever. The feed request had no time limit at all.

**Why it matters:** The user waits with no sign of a problem and no way to retry.

**What changed:** A 60 second idle limit on both, through upstream's `DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS` setting.

**How it was checked:** `test/update-failures.sh` runs with a short limit. The download shows "desktop update: the download stopped receiving data". The feed shows "Could not check for updates". The old build still showed "Checking for updates…" after 105 s.

### 7. Failed update hides the reason

**What:** Any failure inside the update engine ended its message with "Node.js v24.21.0", because that is the last line of an uncaught error. An empty `.partial` folder stayed behind.

**Why it matters:** The details box told the user nothing, and leftovers piled up.

**What changed:** The engine prints the reason last and removes its work folders on failure and on signals. Stale work files are also removed before the next update.

**How it was checked:** With a damaged release the details now name the real cause, and staging is empty.

### 8. Quit during update preparation

**What:** The engine kept running after the app quit.

**Why it matters:** It keeps using CPU and disk for an update nobody will see.

**What changed:** The app stops the engine as it quits.

**How it was checked:** `test/update-failures.sh`: engine running 1, gone after 3 s, nothing left in staging.

### 9. Installing a newer package

**What:** `install.sh` kept every older version and did not set `previous`.

**Why it matters:** Each manual upgrade cost 2.1 GB more, and the rollback that in-app updates offer did not exist.

**What changed:** It now does what an in-app update does: the old `current` becomes `previous`, and anything older is removed.

**How it was checked:** `test/lifecycle.sh` checks both, then rolls back.

### 10. Installer's fix command

**What:** The printed `apt` command named `libasound2`, which Ubuntu 24.04 no longer has (`E: Package 'libasound2' has no installation candidate`). There was no `dnf` command.

**Why it matters:** The one line meant to fix the problem failed.

**What changed:** The hint picks `libasound2t64` when the system offers it, and Fedora gets its own command.

**How it was checked:** Run as printed in Ubuntu 22.04, Ubuntu 24.04, Debian 12 and Fedora 44 containers. A second install then succeeded on each.

### 11. Uninstall while the app runs

**What:** Uninstall deleted the files and said "removed" while the app kept running from them.

**Why it matters:** The user believes the app is gone, and it fails in odd ways later.

**What changed:** Uninstall refuses with exit 1 while the app runs.

**How it was checked:** `test/lifecycle.sh`.

### 12. User namespaces blocked with no readable setting

**What:** The launcher decided about the sandbox from readable system settings. Containers and hardened systems can block user namespaces with no such setting.

**Why it matters:** Chromium stops at start with exit 133, and nothing appears on screen.

**What changed:** The launcher also tries `unshare --user true`, and starts without the sandbox if that fails.

**How it was checked:** In a container with a rule file present, the old build stops with `FATAL` from `setuid_sandbox_host.cc`, exit 133. The new build, with a rule naming the install, starts without the sandbox.

## Low severity

### 13. Uninstall leftovers

**What:** A dangling `~/.local/bin/dsh`, its marker file, and `dsh://` lines in `mimeapps.list` stayed behind.

**Why it matters:** A broken command stays on the path, and `dsh://` links point at nothing.

**What changed:** Uninstall removes them. The link goes only if it points into this install.

**How it was checked:** `test/lifecycle.sh` lists what is left: nothing.

### 14. Home with no `~/.config`

**What:** `xdg-mime` failed and left an empty `mimeapps.list.new`.

**Why it matters:** `dsh://` links did not reach the app.

**What changed:** The folder is created first.

**How it was checked:** `test/lifecycle.sh` on a fresh home.

### 15. Menu entry escaping

**What:** The `Exec` line was not escaped.

**Why it matters:** An install path with `$`, a backtick, `"`, `%` or `\` gave a broken menu entry.

**What changed:** The path is escaped the way the desktop entry format asks.

**How it was checked:** `test/lifecycle.sh` installs under such a path, runs `desktop-file-validate`, and parses the entry through Gio.

### 16. Sandbox setup and nested homes

**What:** The shell pattern for the `@{HOME}` form also matched homes like `/home/a/b`. AppArmor's `@{HOME}` covers only one level.

**Why it matters:** The rule would not attach to that install.

**What changed:** Those paths now get a literal rule, and the launcher's new check uses the same paths.

**How it was checked:** Read through only. Loading a rule needs root, so this was not run.

### 17. Background notice

**What:** Closing the window with a task running said to reopen from the tray icon.

**Why it matters:** Stock GNOME and several other desktops do not show one.

**What changed:** It now reads "Reopen the window from the tray icon or your app menu.", and the same in Chinese.

**How it was checked:** Seen on a display with no tray host. `test/quit.sh` passes with the new text.

### 18. Updates need `xz`

**What:** The update engine downloaded Node as `.tar.xz`, and `tar` needs a separate `xz` program for that.

**Why it matters:** An update would fail on a system with no `xz`.

**What changed:** It downloads the `.tar.gz` build instead.

**How it was checked:** In an Ubuntu 24.04 container with no `xz`, `tar` on a `.tar.xz` fails with `xz: Cannot exec`. The final build was made with the `.tar.gz`, and `test/update-e2e.sh` passes. A full in-app update on a system with no `xz` was not run.

### 19. No `xdg-open`

**What:** Nothing warned at install that it was missing.

**Why it matters:** Links do not open. The app's "Browser didn't open automatically?" fallback covers sign-in.

**What changed:** The installer prints a note.

**How it was checked:** Note seen in containers without it.

## Found after the first release

### 20. Agent's commands cut off from the desktop

**What:** With `bubblewrap` installed, commands ran with a private `/tmp`, a bare `/dev` and no view of other processes. A patch from this port also hid the session's runtime folder. So `gh` said "Requires authentication", Chrome wouldn't start, and there was no display or sound. On macOS, the same sandbox limits file writes and nothing else.

**Why it matters:** Anything that needs the desktop failed on Linux and worked on macOS, with messages that pointed at the wrong thing.

**What changed:** The app now picks Landlock first, and lets commands write to the workspace, temporary folders, `/dev`, `/proc` and the runtime folder. The hiding patch is gone, and `xdg-open` runs outside the sandbox, as `open` does on macOS. `bubblewrap` is only the fallback for kernels without Landlock.

**How it was checked:** `test/sandbox-reach.mjs` covers what stays blocked and what stays open. On a real desktop, `gh api user` returned the account, Wayland, X11, PipeWire and Docker answered, a Chrome window opened from inside the sandbox, and a page reached a running Chrome.

### 21. Reading an image killed the app

**What:** When the agent read an image or one was attached, the app's background process died and "DeepSeek Harness is unavailable" appeared. `sharp`'s Linux build carries its own copy of GLib, and Electron has the system's loaded already. Some of `sharp`'s calls reached the system's copy with objects made by its own, and jumped to an empty address. There was no error message, only `sharp`'s warning as the last line of the log.

**Why it matters:** Any task that looks at images ended in a crash, and reopening the same task could crash again. An earlier round of testing saw that warning and judged it harmless, because the native check only used a case that happens to survive.

**Fix:** The package now uses `sharp`'s WebAssembly build, which needs nothing from the system, and `sharp` falls back to it by itself when no native build is there. Loading the native build with its own libraries first was tried and crashed in a new way, because Electron replaces `malloc` for the whole process. The native check now reads every image format the app accepts, so a build that crashes this way can't become current, and `test/read-image.sh` runs a real agent turn over images.

## Not fixed, on purpose

**`SIGTERM` to every process at once.** This is what `systemd` does at logout. The main process ends with Chromium's "GPU process isn't usable. Goodbye." and exit 133, because the helper processes died first. Everything is gone within 3 s, and the next start works with its sessions listed. The old build ends the same way. Changing GPU settings for this is not justified.

**`desktop-mac` client identity.** Kept, and the README now says why. Linux follows the macOS releases, so update notices for those releases must reach it. One anonymous `check_client_update` comparison gave the same answer for `desktop-mac`, `desktop-win`, `desktop-linux` and `linux`, which shows nothing either way. Sign-in could not be tested without an account. `device_model` and `os_version` already report Linux truthfully.

**"Unable to create default workspace".** Appears only when `xdg-user-dir DOCUMENTS` is missing or returns the home folder. It is upstream's deliberate rule, and its message says what to do next. With normal user folders it creates `~/Documents/deepseek-harness/default-workspace`.

**One AppArmor rule, one install.** The rule file names a single path, so a second install's setup replaces it. The first install then runs without Chromium's sandbox instead of crashing (bug 1).

**The package itself is `.tar.xz`.** Unpacking it needs `xz`, and `tar`'s error names it. Desktop systems normally have it, so this stayed.

## Checked and found working

- Voice, end to end: the bundled engine on English and Chinese recordings, about 150 to 210 ms; the app's own setup downloading models; Start recording with a fake device; Stop and transcribe giving the right text.
- Tray on a stand-in host (`test/tray-host.py`): tooltip, icon, Open and Quit menu, activate reopens, Quit exits 0.
- Package scan: no Mach-O files and no non-x64 ELF files. The 8 Windows executables are vendored inside pip and pnpm.
- Workspace with spaces and non-ASCII letters; `load_workspace_dependencies`; Python, Node and pnpm in the runtime.
- No `bwrap`, on Ubuntu 24.04: a write outside the workspace is denied by Landlock.
- Sign-in opens `platform.deepseek.com/dsh/authorize` (stub browser). The feedback link, configuration file and shortcuts page work, with Ctrl shown.
- Simulated file drop with a space and an accent in the name attaches correctly.
- Wayland on a private headless compositor at 2x, and X11 at 1.5x: title bar, overlay and menus fine.
- Mandatory update window on a throwaway copy: title, detail, new version and download shown; it stays up on close; a bad release gives a retry.
- Update check failures (HTTP 500, bad YAML, no files, bad version, other host, connection refused) and download failures (bad hash, cut connection) all show normal messages.
- Reinstalling the same version over a running app is harmless. Ctrl+Q with a running task asks first, and Cancel keeps it running.
- `WM_CLASS`, window icon, Open in Files, terminal panel, `window.open`, `dsh://open`, clipboard, `dsh` install, `--version`, `--help`.

## Not tested

| What | Why |
|------|-----|
| AppArmor rule attach, `bwrap` under the real rule, a rule with a non-ASCII path | Needs root |
| Real microphone | Fake device used |
| Real sign-in | No account, and real credentials were off limits |
| Real tray hosts (GNOME extension, KDE) | Stand-in host used |
| Real GNOME Wayland, fractional scale | Private headless compositor only; native buttons not captured |
| KDE, Xfce and other desktops, ARM, Debian 13, Arch | Not available here |
| Real file manager drag, notifications on screen | Simulated drop only; notification display not checked |
| Real full disk | Simulated with `/dev/full` |
| Full update with no `xz` | Not run (bug 18) |
| `bwrap` on other distros | Docker blocks user namespaces |

## Distros

Final build in containers, from a bare image. Each row: first install lists what is missing and prints a command, that command works, second install succeeds.

| System | Fix command | Native check | Main window | Mock agent turn |
|--------|-------------|--------------|-------------|-----------------|
| Ubuntu 22.04 | `apt`, with `libasound2` | Pass | 3 s | Pass |
| Ubuntu 24.04 | `apt`, with `libasound2t64` | Pass | 3 s | Pass |
| Debian 12 | `apt`, with `libasound2` | Pass | 3 s | Pass |
| Fedora 44 | `dnf` | Pass | 3 s | Pass |

## Platform audit

`lib/main.js` has 51 `process.platform` uses, `preload-app.cjs` has 4, and 35 files in the bundled packages have more. Line numbers refer to the unpacked upstream `lib/main.js`.

- **Windows only, no Linux need:** rename retry (3315), `flashFrame` attention (9715-9719), `session-end` (12917), embedded mandatory UI (9777), `dsh.cmd` handling (7972-7998), login shell env (9429), hide before destroy (10477), tray icon option (12843), and the `dsh-win32-process`, `dsh-sandbox-windows-acl` and `dsh-pwsh-local` packages.
- **macOS only, no Linux need:** media access (7065-7080), dock bounce (9720), `isInApplicationsFolder` (12137), elevated command install (8095-8102), vibrancy and title bar (8594, 11960), app menu (11992), full-screen close (12891), focus steal (12841), `window-all-closed` (13074).
- **Already extended to Linux by patches:** title bar, tray, notice, menus, updater, policy platform, welcome window.
- **Upstream's own Linux paths:** shortcuts (12428), `xdg-open`, `gio`, zenity and kdialog chooser, `xdg-user-dir`, sandbox chains, Linux scope.
- **Kept, with a note:** `desktopClientHeaders` (6654), `DesktopPlatformView` win32-else-darwin (12189).

Reading these branches alone turned up nothing to change. The bugs above came from walking real flows and breaking edges.

## Results on the final build

| Check | Result |
|-------|--------|
| `test/quit.sh` | Pass: close hides with a notice, reopen works, Ctrl+Q leaves 0 processes in 3 s |
| `test/titlebar.sh`, buttons on the right | Pass |
| `test/titlebar.sh`, buttons on the left | Pass |
| `test/update-e2e.sh` | Pass: prepared in 23 s, switched, `previous` set, relaunched, window up |
| `test/lifecycle.sh` | 12 of 12 |
| `test/update-failures.sh` | 7 of 7 |
| `test/office.sh` | Pass: docx, xlsx and pptx each render a page |
| `test/voice.mjs` | Pass: English and Chinese text correct |
| Containers | 4 of 4 |
| Package scan for personal data | 0 files |

<details>
<summary>Lifecycle output</summary>

```
PASS dsh:// handler on a fresh home: deepseek-harness.desktop
PASS SIGTERM with a task running: task started: yes, gone after 4s, processes left 0, tasks left 0
PASS SIGHUP with a task running: task started: yes, gone after 3s, processes left 0, tasks left 0
PASS SIGTERM to every process at once: task started: yes, gone after 3s, processes left 0, tasks left 0
PASS starts again after that, with its sessions: window ready yes, sessions listed 1
PASS sandbox rule for another path: Running without Chromium's sandbox
PASS upgrade keeps one version to go back to: previous: versions/0.0.2, versions: 0.0.2 0.2.1-rc.5
PASS rollback after upgrade: current: versions/0.0.2
PASS uninstall refuses while the app runs: exit 1
PASS uninstall leaves nothing of itself: left: nothing
PASS install path: Ñandú 文档: window ready yes, workspace area shown yes
PASS install path: dollar $HOME `x` 100% "q": window ready yes, workspace area shown yes
lifecycle: 0 failed
```

</details>

<details>
<summary>Update failure output</summary>

```
PASS disk full during download: 0s, left behind 0, "ENOSPC: no space left on device, write"
PASS download stalls: 1s, left behind 0, "desktop update: the download stopped receiving data"
PASS connection cut: 1s, left behind 0, "net::ERR_CONTENT_LENGTH_MISMATCH"
PASS wrong hash: 0s, left behind 0, "desktop update: the downloaded release failed verification"
PASS release is not a real archive: 1s, left behind 0, "DeepSeek Harness could not prepare the Linux build of 99.0.0, so the current version stays installed."
PASS feed never answers: 8s, "Could not check for updates. Please try again later."
PASS quit while preparing an update: engine was running: 1, gone after 3s, left behind 0
update failures: 0 failed
```

The helper sets a short idle limit, so these times do not reflect the 60 second default.

</details>
