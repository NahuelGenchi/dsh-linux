# Updates

The port rebuilds each macOS release for Linux, so every DeepSeek release is a test it hasn't seen. Before this work, one small code change on DeepSeek's side could stop all updates, with no way to deliver a fix. Now ordinary changes no longer stop an update, a broken build never reaches the user, and fixes to the engine can be delivered.

This can't promise that every future release will work. It makes failures rarer, safe and fixable.

## Before and after

| When DeepSeek's release... | Before | Now |
|---|---|---|
| Moves code the port patches | Any of 39 patches stops the update | Of the 43 patches now, 24 are skipped and logged, and 19 still stop it on purpose |
| Contains the menu change already on DeepSeek's main branch | Every update stops | The patch fits both the old and the new code |
| Builds on Linux but can't start | The user is offered a restart into a broken app | Refused, and the current version stays |
| Needs a change to the engine | Wait for a new package, installed by hand | A signed engine fix reaches installed copies |
| Is required by DeepSeek but can't be built | The app stays locked | The user can keep this version until they quit |

## What changed

### Two kinds of patch

A required patch keeps the app safe, startable or updatable, or keeps its tools running. Without one, the update stops and the current version stays. The 19 required patches cover the updater hook, the token scrub, the sandbox masks and the Landlock launcher, among others.

An optional patch only changes how the app looks or behaves day to day, such as the title bar, the tray icon or Ctrl+Q. If DeepSeek moved that code, the build goes on without it, and the update log and `port-info.json` name what was left out. A package build still stops at any miss, so a new package always has them all.

Patches also stopped depending on exact spacing, so a bundler that reformats the code no longer breaks them.

### A start test before every update

After building, the engine starts the new version once in a throwaway home, with its windows kept off the screen, and waits for its first page. If that fails, it runs the same test on the version in use. If that version passes, the new build is refused. If that one fails too, the test isn't working on this machine, so it says nothing and the update goes on.

The test adds about 1 s to an update. A build that throws is refused in 8 s, and one that hangs is refused after the 60 s limit.

### Engine fixes

Before each update, the app asks this project's GitHub releases for a newer engine. It takes one only if the pinned Ed25519 key signed it, its number is higher than the engine it has, and its hash and files all check out. If there is no fix or anything goes wrong, the update carries on with the engine it has.

Each version runs its own copy of the fetch step, so a bad fix can be replaced by a later one. To turn it off for good, create an empty file named `no-engine-fixes` in `~/.local/share/deepseek-harness`.

### Forced updates

DeepSeek can require an update and block the app until it is done. If that update can't be prepared for Linux, the app now offers a native dialog: keep using this version, or go back to the block and try again. The choice lasts until quitting, and the next start blocks and tries again.

## Real older releases

These are DeepSeek's own releases, built by the new engine and really started.

| Release | Result | Time | Patches skipped |
|---|---|---|---|
| `0.2.1-rc.3` | Built and started | 9 s | 0 |
| `0.2.1-rc.2` | Built and started | 7 s | 0 |
| `0.2.1-rc.1` | Built and started | 7 s | 0 |
| `0.2.0-rc.2` | Refused at a required Office patch, nothing left behind | 9 s | Not reached |
| `0.2.0-rc.2`, Office patches made optional | Built and started on Electron 44.0.0 and Node 24.18.1 | 13 s | 2 |

The last row is the first time another Electron version has been started. It ran on a test copy of the engine, and it shows that a different Electron and Node do get through the whole path.

## Checks on the final package

Everything in [testing.md](testing.md) runs on the same package, and it all passes. These checks are about updates.

| Check | Result |
|---|---|
| Patch rules, including the menu patch on both forms of the code | 19 of 19 |
| Engine fix cases: forged, altered, older, oversized, bad paths, links, plain HTTP, off switch | 28 of 28 safe |
| Moved optional patches | Skipped and logged, and the build starts |
| Moved safety patch, or a required patch on a file that is gone | Refused, nothing left behind |
| Builds that die, throw or hang at start | 3 of 3 refused, nothing left running |
| Windows seen on a private display during a normal start test | 0 |
| No display at all | The test says nothing and the update goes on |
| Forged engine fix through the real app | Not used |
| Real engine fix through the real app | Arrived, built in 8 s, and the new version carries it and starts |
| Forced update that fails: the dialog, going back, retrying, keeping | All work, and real mouse clicks reach the app after keeping |
| Forced update that can be built | No dialog, installs and switches as usual |
| The new package against the previous one | Only the updater, the engine, its version record and one added line in `lib/main.js` differ |

The app doesn't start measurably slower. Over 8 starts each, taken in turns, the median went from 1,870 ms to 1,929 ms, inside the normal spread of about 250 ms. Idle memory stays at about 430 MB. An update takes about 8 s after the download, and about 1 s of that is the start test.

## What it still can't do

**A required patch that no longer fits still stops the update.** That is on purpose. The app is safer on its current version than on one without its safety patches. The fix then has to come through the engine channel or a new package.

**The start test proves that the app starts and reaches its first page.** It doesn't test every feature, so a release that starts but breaks something later gets through. `--rollback` undoes that, but under a forced update the block returns, and the update builds fine, so no keep-this-version choice appears.

**The network during the start test.** Chromium's own requests are blocked, but the app's Node side isn't. The throwaway home holds no account or token, so at most it sends what a fresh install sends at its first start. A key set in the environment stays visible to it, as it does to the app itself.

**Trusting the channel means trusting the key holder,** as with any auto-update, since an engine runs with the user's rights. If the key is lost, fixes need a new package and a new pinned key.

## Not verified

| What | Why |
|---|---|
| A release newer than the installed one | None exists yet. Older releases and simulated changes stand in for it |
| Whether anything flashes on a real GNOME Wayland screen | The engine ran on a real GNOME Wayland session, in a throwaway home, and passed in 9 s. Nobody was watching the screen, so "no windows" comes from the private X display and the code |
| An engine fix through the real GitHub channel | None has been needed yet. Tests use a local server with the real signing path |
| DeepSeek's view of the keep-this-version choice | The README asks them, under "For DeepSeek" |

## Delivering an engine fix

Fix the engine, raise `engine` in `port/pins.json`, then sign it. The private key stays outside this repository:

```bash
node tools/engine-release.mjs pack .work/engine-release
```

Upload the three files it makes to this repository's `engine` release, and installed copies pick them up at their next update. Create that release with `--latest=false`, because `get.sh` downloads from the release marked latest. An engine fix also has to keep the command line that older copies of `port/overlay/lib/linux-updater.js` use to start it.

## Publishing a package

Build it, give it the stable name `get.sh` asks for, and upload it with its hash:

```bash
./build-package.sh deepseek-harness-mac-arm64.zip
```

```bash
cp dist/dsh-linux-*-x64.tar.xz dist/dsh-linux-x64.tar.xz
```

```bash
(cd dist && sha256sum dsh-linux-x64.tar.xz > dsh-linux-x64.tar.xz.sha256)
```

```bash
gh release create v0.2.1-rc.5 dist/dsh-linux-x64.tar.xz dist/dsh-linux-x64.tar.xz.sha256
```
