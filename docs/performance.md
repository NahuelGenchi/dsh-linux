# Performance

The package is 9.7% smaller and an installed copy is 5.5% smaller, with nothing the app can do removed.
An in-app update now takes 4.7 s instead of 13.5 s after the download, and a copy that has updated uses 40% less disk.
Python loads its Office and data packages about three times faster. Start time and idle memory did not change, and a full build is slower.

These figures come from the round of work on size and speed alone, measured before the later security and update work. [testing.md](testing.md) has the figures for the current package.

## Results

Release 0.2.1-rc.5. Before is the first build of the port, and after is the build at the end of this work. Both sides used the same method and ran in turns. Figures are medians.

| Measure | Before | After | Change |
|---|---|---|---|
| Package size | 252.6 MB | 228.0 MB | **-9.7%** |
| Installed size | 1,078 MB | 1,018 MB | **-5.5%** |
| Files in the package | 8,905 | 6,271 | -30% |
| Update after the download, cold disk cache | 13.5 s | 4.7 s | **-65%** |
| Update after the download, warm disk cache | 13.9 s | 4.9 s | **-65%** |
| Disk used by two versions after an update | 2.21 GB | 1.32 GB | **-40%** |
| `import pandas` | 778 ms | 235 ms | **-70%** |
| `import docx, pptx, openpyxl` | 570 ms | 223 ms | **-61%** |
| Cold start to the main window | 1,848 ms | 1,806 ms | no measurable change |
| Warm start to the main window | 1,610 ms | 1,566 ms | no measurable change |
| Idle memory after a cold start, 7 processes | 428 MB | 429 MB | no change |
| Idle memory after a warm start, 7 processes | 506 MB | 503 MB | no change |
| Build at default settings | 70.3 s | 156.7 s | slower, +86 s |
| Build peak memory at default settings | 1.07 GB | 3.65 GB | higher |
| Build at the old compression, `XZ_OPT='-T8 -6'` | 70.3 s, 252.6 MB | 54.3 s, 246.4 MB | -23% time, -2.5% size |
| Unpacking the package with `tar -xf` | 1.3 s | 3.0 s | slower, +1.7 s once per install |

The update figures come from an update to the same release, so Electron, Node, Python and every native package could be reused. That is the best case. See [Not verified](#not-verified).

## 1. Updates reuse what is installed

**What.** An update used to copy Electron, Node and Python from the installed version, and fetch every native package again.

**Why it matters.** Most of a release does not change. Copying it cost time and doubled the disk use until the old version was removed.

**What changed.** `port/port.mjs` and `port/lib/asar.mjs` now hard-link unchanged files from the installed version, and fall back to a copy when they cannot. Native packages of the same version are taken from the installed copy. Anything the engine changes is written as a new file and renamed into place, so the older version keeps its own bytes.

**How it was checked.** `test/update-e2e.sh` passes with the real feed. After it, 5,042 files (739 MB) were shared and the new version added only 272 MB on disk. `--rollback` then started the older version, which ran an agent turn and a terminal command. An update onto a tmpfs, where links cannot work, finished in 4 s with a full copy.

**Who gets this.** Each installed copy updates with the engine it carries, and passes that engine on. A copy of the old build gets these savings only after the new package is installed once.

<details><summary>Time per engine step, one run each on a cold disk cache</summary>

| Step | Before | After |
|---|---|---|
| Reading the release | 1.91 s | 0.52 s |
| Electron | 0.42 s | 0.00 s |
| Unpacking the application | 0.70 s | 0.33 s |
| Linux native packages | 4.18 s | 0.60 s |
| Adapting the application | 0.60 s | 0.76 s |
| Packing the application | 0.64 s | 0.34 s |
| Node | 1.07 s | 0.28 s |
| Python | 1.73 s | 0.77 s |
| Checking every native part | 1.90 s | 0.83 s |

</details>

## 2. Third-party files nothing can load

**What.** TypeScript sources and type files, C and C++ sources, build files, Markdown and test folders inside third-party npm packages.

**Why it matters.** These were 3,935 of the 17,552 files in the application, 36 MB in all. `zod` alone held 23 MB of `.ts` files across 8 copies.

**What changed.** New file `port/lib/trim.mjs`, which runs in the engine, so a first install and every update get the same tree. `app.asar` went from 177.9 MB to 142.8 MB, and its unpacked folder from 222.7 MB to 220.8 MB. DeepSeek's own packages stay whole, because their skills and manuals are read at run time. Every license text stays.

**How it was checked.** I compared the expanded application before and after. The only code files removed sit inside the test folders of third-party packages. A scan of all 279 third-party packages checked every entry point and every reference to a removed file type in their code. The `.ts` entries are behind conditions such as `source`, which only development tools use. `bowser` exports its own README, and nothing imports it. `undici` mentions `.d.ts` files only in comments, and `pi-ai` names `.ts` files but loads the `.js` twin. The app then started, ran an agent turn and opened a terminal.

## 3. Node binary stripped

**What.** The bundled `node` carried its symbol table.

**Why it matters.** Removing it takes `node` from 126.6 MB to 108.5 MB. Only native debuggers use that table.

**What changed.** The engine runs `strip` on a temporary copy and renames the result into place. It keeps the original when `strip` is missing or does not help.

**How it was checked.** Node ran crypto and zlib, loaded the `reflink` native addon and ran `pnpm --version`. With `strip` taken off `PATH`, the engine still finished, and Node stayed at full size and worked.

## 4. Python trimmed and precompiled

**What.** Python carried 1,833 terminal database files it never reads, `tests` folders in its packages and pip's Windows launchers. It also had no bytecode for the Office and data packages.

**Why it matters.** Without bytecode, Python compiles those packages each time it cannot save its cache, and the sandbox keeps that folder read-only. `import pandas` took 778 ms each time and now takes 235 ms.

**What changed.** The engine removes those files and adds 929 bytecode files, 18.9 MB. Python as a whole still shrinks by 3.5 MB. The bytecode uses checked hashes, so an edited `.py` file still takes effect and no bytecode can go stale. Checked and unchecked hashes timed the same. The files hold relative paths, so no build path ends up in the package.

**How it was checked.** All Office and data imports pass, along with `curses` with a real terminal lookup, `pip check`, a new `venv` and `f2py`. `strace` showed Python only searches the system's terminal databases. Appending a line to `six.py` changed what `import six` did. Timing used `python3 -I -B`, which behaves like a Python that cannot write its cache.

## 5. Stronger compression, in a better order

**What.** The package used `xz -T8 -6` with files in folder order.

**Why it matters.** Download size is the first thing a user meets.

**What changed.** `build-package.sh` now uses `xz -T4 --x86 --lzma2=preset=9e`, and places files of one type side by side. The archive also stores owner 0 instead of the build machine's user name. Setting `XZ_OPT='-T8 -6'` gives a quick test build.

**What it costs.** A default build takes 86 s longer and peaks at 3.65 GB of memory. Unpacking takes 1.7 s longer. Updates do not use the package, so they are unaffected.

**How it was checked.** I tried each option alone. The final package passed all checks below.

<details><summary>Compression trials</summary>

| Tree | Settings | Size | xz time |
|---|---|---|---|
| Before | `-T8 -6` | 252.0 MB | 37 s |
| Before | `-T8 -9` | 241.7 MB | 82 s |
| Before | `-T4 -9e` | 241.1 MB | 127 s |
| Before | `-T4 --x86 -9e` | 236.8 MB | 127 s |
| Before | sorted by type, `-T4 -9e` | 237.2 MB | 131 s |
| Before | sorted by type, `-T4 --x86 -9e` | 233.3 MB | 130 s |
| After | sorted by type, `-T4 --x86 -9e` (chosen) | 228.0 MB | about 125 s |
| After | sorted by type, `-T2 --x86 -9e`, 128 MiB dictionary | 226.3 MB | 234 s |

The last row saves only 0.8% for 100 s more, so I left it out. xz picks its block size from the preset, not the thread count, so `-T4` should only limit memory. More threads were not measured, because that run needs more memory than the machine had free.

</details>

## 6. Faster build steps

**What.** The engine unpacked macOS native packages and the macOS Node and Python, then deleted them. It also compiled the terminal addon in Docker on every build.

**Why it matters.** At the same compression, a build now takes 54.3 s instead of 70.3 s.

**What changed.** `port/port.mjs` skips those files while unpacking, and caches the compiled addon under a hash of its source, version and build image.

**How it was checked.** A scan of the final tree found no Mach-O binary, no `.dylib`, no `.DS_Store` and no `.exe`. The engine's native check passes on every build, and the terminal works.

## 7. Start time and memory: no saving found

**What.** I traced a launch and measured all processes while idle. Nothing here was changed.

**Why it matters.** Start time and memory are mostly upstream code. Most of the host's start is loading modules and reading manifests. In warm runs, the host is ready at about 950 ms and the main window at about 1,500 ms. The launcher costs about 12 ms. Idle memory is mostly the host at 263 MB, the renderer at 144 MB and the main process at 122 MB.

**How it was checked.** Copies differ more from each other than the builds do. Two comparisons showed the new build 75 to 100 ms slower on cold start. A later one with four copies showed it 27 ms faster on the same two copies, and 42 ms faster on fresh installs of both. Both builds read the same amount at launch, about 127 MB in the main process and 42 MB in the host. So I report no measurable change.

<details><summary>Start time runs, in milliseconds</summary>

| Test | Before | After |
|---|---|---|
| Cold, 6 runs each, older installs | 1,928 | 2,004 |
| Cold, 11 pairs, older installs | 1,931 | 2,030 |
| Cold, 8 rounds, older installs | 1,941 | 1,915 |
| Cold, 8 rounds, installs made at the same time (used in the table) | 1,848 | 1,806 |
| Warm, 6 runs each | 1,514 | 1,686 |
| Warm, 15 pairs (used in the table) | 1,610 | 1,566 |
| Best warm run in those 15 pairs | 1,451 | 1,450 |

</details>

## Looked at and left alone

| Candidate | Size or gain | Why it stays |
|---|---|---|
| V8 compile cache | about 85 ms on a warm start | Needs a new logic patch, and adds code on disk that V8 trusts. Worth a separate decision. |
| `libpython3.12.so.1.0` | 31 MB, about 7 MB compressed | Needed for embedding and for tools such as PyInstaller. |
| `LICENSES.chromium.html` | 20 MB | Legal notices. |
| Chromium `locales` | 8.7 MB | Native interface languages. |
| SwiftShader | 5 MB | The fallback on machines with no usable GPU. |
| Stripping `.so` files in Python wheels | about 5 MB | Those libraries have been patched by the wheel tools, and the risk is higher than the gain. |
| `musl` package variants | 1.2 MB | Too small. |
| File list in `desktop-runtime.json` | 9 ms | Too small, and a later release could break it. |
| `soffice.wasm` | 29.5 MB compressed | Cannot shrink without rebuilding it. |
| Duplicate packages in `app.asar` | not measured | Linking versions together is risky, and xz already removes much of the repeat. |
| Launcher | about 12 ms | Too small. |
| Memory flags | not measured | I found none that is safe at the port level. |

## Regression checks on the final build

No security setting changed, and `port/lib/patches.mjs` is untouched. The last column ran the new engine over an install of the old build, and gave the same file list and the same size as a fresh build.

| Check | Fresh install | After an update | After rollback | Update from an old install |
|---|---|---|---|---|
| Terminal tab in the app | pass | pass | pass | pass |
| Agent turn, inside write works, outside write blocked | pass | pass | pass | pass |
| Office rendering, docx, xlsx, pptx (`test/office.sh`) | pass | pass | not run | pass |
| Sandbox, bwrap (`test/sandbox.mjs`) | pass | pass | not run | pass |
| Sandbox, landlock (`test/sandbox.mjs`) | pass | pass | not run | pass |
| Python imports, `pip`, `venv`, `curses` | pass | pass | not run | pass |
| Node, `pnpm`, `reflink`, ripgrep | pass | pass | not run | pass |

| Helper | Result |
|---|---|
| `test/update-e2e.sh` | pass, switched to the new version with the old one kept as previous |
| `test/quit.sh` | pass, reopen and Ctrl+Q work, tray problems logged: 0 |
| `test/titlebar.sh`, buttons on the left | pass |
| `test/titlebar.sh`, buttons on the right | pass |
| Scan of the package for personal data | 0 matches |

<details><summary>Method</summary>

Machine: a desktop PC on Ubuntu 26.04 and ext4. It was running other work during the tests, so the two builds ran in turns.

- **Start time.** `test/measure.mjs start`. It clears the app's files from the disk cache for a cold run, launches on a private X server with `--disable-gpu`, and stops the clock when the main window's menu exists.
- **Idle memory.** The same helper waits 30 s, then takes the median of 3 samples of PSS, summed over every process of the copy. 6 runs each.
- **Update.** `test/measure.mjs update` and a matching shell loop run the engine the way the updater does, with an empty engine cache. The time excludes the download and the relaunch. 3 runs each.
- **Disk after an update.** `du -sm` on the versions folder, which counts a hard-linked file once.
- **Python.** 3 rounds of 7 runs each. The table gives the median of the 3 round medians.
- **Build.** 3 builds each with a filled download cache, timed with `/usr/bin/time`.
- **Unpacking.** `tar -xf`, 3 runs each.
- **Installed size.** `du -sb` on the installed version folder.

</details>

## Not verified

- **An update that changes Node or Python.** No such release was available. The engine downloads only the changed part and links the rest, so it should take longer than the figures here, on both builds. The downloaded path did run in every full build, with trimming, stripping and bytecode.
- **A real screen and GPU.** All start and memory figures come from a private X server with `--disable-gpu`, not GNOME on Wayland.
- **Other distributions.** Everything ran on Ubuntu 26.04.
