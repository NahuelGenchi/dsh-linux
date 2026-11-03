# Testing

Every check below ran on the package itself, unpacked from its `.tar.xz`, one after another. They all pass, apart from one miss that didn't come back, described under [Known limits](#known-limits). The figures are for release `0.2.1-rc.5`, 228.0 MB, with a SHA-256 that starts with `81b691e054e88ed0`.

## Results

"Before" is the first build of the port, before any of the work on size, speed, security and updates.

| Measure | Before | Now | Change |
|---|---|---|---|
| Package size | 252.6 MB | 228.0 MB | **-9.7%** |
| Installed size | 1,054 MB | 990 MB | **-6.1%** |
| Update after the download | 13.5 s | 7.6 s | **-44%** |
| Disk used by two versions after an update | 2.21 GB | 1.16 GB | **-48%** |
| `import pandas` | 778 ms | 207 ms | **-73%** |
| `import docx, pptx, openpyxl` | 570 ms | 185 ms | **-68%** |
| Cold start to the main window | 1,848 ms | about 1,800 ms | no clear change, runs vary by about 250 ms |
| Idle memory, 7 processes | 428 MB | 430 MB | no change |

The update figures come from an update to the same release, so everything could be reused. That is the best case. About 3 s of the update goes to the Apple signature check, which needs every file in the release unpacked, and about 1 s goes to starting the new build once to test it.

## Security

| Check | Result |
|---|---|
| Hostile archives fed to the extractors | 20 of 20 safe |
| Packaging scripts attacked with awkward paths and modes | 22 of 22 safe |
| Generated AppArmor rule read by the real parser | Accepted |
| Tampered releases, under Node | 17 of 17 refused |
| Tampered releases, under the app's own Electron | 17 of 17 refused |
| Tampered release through the in-app update | 2 of 2 refused, current version kept |
| npm look-alike package | Declared package picked |
| Which sandbox rules are accepted | 8 of 8 correct |
| Agent sandbox | Writes outside blocked, also through links and `/proc`. Display, sound, other processes, local services and a real `gh` login all reachable |
| A browser under the agent's sandbox | Chrome keeps its own sandbox on and opens a window, and a page reaches a running Chrome |
| `xdg-open` under the agent's sandbox | What it opens runs outside the sandbox and keeps running |
| Package contents | No user name or email, all files owned by root, no setuid, nothing writable by others |

## The app

| Check | Result |
|---|---|
| Every native part | 12 of 12 |
| Agent turn with a stand-in model | Wrote inside the workspace, write outside refused |
| Word, Excel and PowerPoint rendering | 3 of 3 |
| Voice, English and Chinese | Both correct |
| Title bar, buttons on the right and on the left | Nothing overlaps |
| Close, reopen, Ctrl+Q | 0 processes after 3 s |
| Stop signals, install paths, rollback, uninstall | 12 of 12 |

## Updates

| Check | Result |
|---|---|
| Full update against DeepSeek's live feed | Prepared in 15 s, switched, relaunched, window shown |
| Failures: no write access, stall, cut connection, wrong hash, bad archive, silent feed | 6 of 6 show the normal message, nothing left behind |
| Quitting during an update, after a failure, and after one is ready | 3 of 3 exit cleanly, nothing left behind |
| Updater cases, including a real ENOSPC | 47 of 47 safe |
| Patch rules | 19 of 19 |
| Engine fix cases | 28 of 28 safe |
| New engine over a first-build install | 10 s, old binary unchanged, 4,112 files shared |

[updates.md](updates.md) has the checks on moved code, start tests, engine fixes and forced updates.

## Other systems

Each started from a bare container. The first install lists what is missing and prints a command. That command works, and the second install succeeds.

| System | Fix command | Native parts | Main window | Agent turn |
|---|---|---|---|---|
| Ubuntu 22.04 | `apt`, with `libasound2` | 12 of 12 | 2 s | Pass |
| Ubuntu 24.04 | `apt`, with `libasound2t64` | 12 of 12 | 3 s | Pass |
| Debian 12 | `apt`, with `libasound2` | 12 of 12 | 2 s | Pass |
| Fedora 44 | `dnf` | 12 of 12 | 2 s | Pass |

Containers block user namespaces, so the app correctly runs there without Chromium's sandbox and says so.

## Known limits

**One start that didn't come back.** In one run of the update failure checks, one start showed no main window within 40 s, and the next start worked. It didn't happen again in 3 more full runs and 65 more starts, 40 of them repeating the moment it happened, under load. The cause isn't known, because that test overwrote its log at the time. It now keeps a log for each start.

**Future releases.** A release that moves code a required patch needs stops the update, on purpose, and the current version stays. [updates.md](updates.md) covers what can and can't go wrong now.

**Ctrl+Q while an update dialog is open.** The dialog holds the keyboard, so the key does nothing until it is dismissed.

**The agent's sandbox limits writes only.** As on macOS, commands can read your files and reach local services and other apps. [SECURITY.md](../SECURITY.md) says what that means.

**Account name and balance.** A signed-in account can show "Signed in to DeepSeek" instead of a name or email. The sign-in itself is fine, and the label is the app's own fallback for when the profile request fails. The likely cause is the firewall in front of `platform.deepseek.com`, which answered the Linux app's headers with a CloudFront 403, sent with an invalid token. The port doesn't try to get past that firewall, because pretending to be a browser would hide the problem rather than solve it. Models use `api.deepseek.com`, so chatting should not be affected.

## Not verified

| What | Why |
|---|---|
| The firewall's answer to a real signed-in request | Tested with an invalid token only |
| Whether a Mac gets past the same firewall | No Mac was available, and sending the Mac label from Linux would imitate another client |
| Automated checks with a real account | Tests use a stand-in model and no account |
| Automated checks on real GNOME Wayland with a GPU | The app is used there by hand. Automated checks use a private X display with the GPU off, apart from one start test on a real session |
| A truly full disk | Covered by a real ENOSPC on a redirected write, not a full filesystem |
| A newer release that changes Electron, Node or Python | Only older releases exist to test. One on Electron 44.0.0 and Node 24.18.1 built and started, with its Office patches treated as optional |
| KDE, Xfce, ARM and other systems | Not available |

## Running the checks

The helpers are in [`test/`](../test). They use throwaway homes, so they never touch a real install. Several draw on a private X server in Docker, which `test/display.sh start` brings up and `test/display.sh stop` removes. To run several at once, give each its own `DSH_TEST_CONTAINER`, `DSH_TEST_DISPLAY` and `DSH_TEST_PORT`.

Each helper says at its top what it needs. For example, these two take an unpacked package and DeepSeek's release:

```bash
test/lifecycle.sh my-run dist/unpacked/dsh-linux-0.2.1-rc.5-x64
```

```bash
test/update-failures.sh my-run dist/unpacked/dsh-linux-0.2.1-rc.5-x64 deepseek-harness-mac-arm64.zip
```

`test/measure.mjs` times startup, idle memory and updates the same way every time.

Never run the app's binary by hand to test it, because it opens the app with your real home folder. Use `test/env.sh <run> <command>`, which gives it a throwaway home.
