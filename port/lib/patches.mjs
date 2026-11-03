// Source patches that turn the upstream macOS payload into a Linux application.
// A patch must match exactly once. Without one the app needs to stay safe, start, update
// again or run its tools, porting stops with a clear error and the installed version keeps
// running. One marked OPTIONAL only changes how the app looks or behaves day to day, so a
// release that moved its code is built without it and the update log says so.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TITLEBAR = 'process.platform === "win32" || process.platform === "linux"';
const OPTIONAL = 'optional';

/** Patches relative to the expanded app.asar. */
const APP_PATCHES = {
  'lib/main.js': [
    // Updates: follow the upstream feed and rebuild for Linux (see overlay/linux-updater.js).
    ['const { autoUpdater } = electronUpdater;',
      'const autoUpdater = process.platform === "linux" ? (await import("./linux-updater.js")).linuxAutoUpdater : electronUpdater.autoUpdater;'],
    // The mandatory update policy keeps working: Linux follows the same releases as macOS.
    ['if (!["win32", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error("desktop policy: unsupported platform");',
      'if (!["win32", "darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error("desktop policy: unsupported platform");'],
    // Main window: the frameless title bar with the in-page menu, as on Windows.
    ['...process.platform === "win32" && primary ? {\n\t\t\ttitleBarStyle: "hidden",',
      `...(${TITLEBAR}) && primary ? {\n\t\t\ttitleBarStyle: "hidden",`, OPTIONAL],
    ['\t\twidth: 1280,\n\t\theight: 820,',
      '\t\t...process.platform === "linux" ? { icon: join(process.resourcesPath, "icon.png") } : {},\n\t\twidth: 1280,\n\t\theight: 820,', OPTIONAL],
    ['if (process.platform === "darwin" || process.platform === "win32") {\n\t\tconst sendFullscreen',
      'if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") {\n\t\tconst sendFullscreen', OPTIONAL],
    ['...process.platform === "win32" && item.role !== void 0 && item.role in messages ? { label: messages[item.role] } : {},',
      `...(${TITLEBAR}) && item.role !== void 0 && item.role in messages ? { label: messages[item.role] } : {},`, OPTIONAL],
    // Electron labels the Exit item Ctrl+Q on Linux, but a key only works from the application menu.
    // DeepSeek's main branch has already renamed this list, so any name will do.
    [/Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(process\.platform === "win32"\s*\? ([\w$]+) : \[\{/u,
      'Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === "win32" ? $1 : process.platform === "linux" ? [...$1, { role: "quit", visible: false }] : [{', OPTIONAL],
    // A forced update this port cannot follow must not end in a locked app (see overlay/lib/linux-updater.js).
    ['mandatoryPolicy.check("launch").then((state) => {',
      'if (process.platform === "linux") autoUpdater.watchForcedUpdate(mandatoryPolicy, () => mandatoryUI?.sync());\n\t\tmandatoryPolicy.check("launch").then((state) => {', OPTIONAL],
    // Closing the window keeps tasks running, so Linux gets Windows' tray icon and one-time notice.
    ['const trayIconPath = development ? join(app.getAppPath(), "resources", "tray-windows.ico") : join(process.resourcesPath, "tray.ico");\n\tif (process.platform === "win32") try {',
      `const trayIconPath = process.platform === "linux" ? join(process.resourcesPath, "linux-port", "packaging", "icons", "48.png") : development ? join(app.getAppPath(), "resources", "tray-windows.ico") : join(process.resourcesPath, "tray.ico");\n\tif (${TITLEBAR}) try {`, OPTIONAL],
    ['const backgroundNotice = process.platform === "win32" ? new DesktopBackgroundNotice({',
      `const backgroundNotice = ${TITLEBAR} ? new DesktopBackgroundNotice({`, OPTIONAL],
    ['if (process.platform === "win32") {\n\t\tipcMain.handle(DESKTOP_IPC.windowsMenu,',
      `if (${TITLEBAR}) {\n\t\tipcMain.handle(DESKTOP_IPC.windowsMenu,`, OPTIONAL],
    // The application menu entries that differ per platform.
    ['process.platform === "win32" ? {\n\t\t\tlabel: currentDesktopLocale().messages.aboutMenu,\n\t\t\tclick: () => {',
      `${TITLEBAR} ? {\n\t\t\tlabel: currentDesktopLocale().messages.aboutMenu,\n\t\t\tclick: () => {`, OPTIONAL],
    ['...process.platform === "darwin" || process.platform === "win32" ? [{\n\t\t\tlabel: currentDesktopLocale().messages.cliCommandMenu,',
      '...process.platform === "darwin" || process.platform === "win32" || process.platform === "linux" ? [{\n\t\t\tlabel: currentDesktopLocale().messages.cliCommandMenu,', OPTIONAL],
    [': process.platform === "win32" ? { label: currentDesktopLocale().messages.exitApplication } : {}',
      `: ${TITLEBAR} ? { label: currentDesktopLocale().messages.exitApplication } : {}`, OPTIONAL],
    // Bring the window forward after an update restart.
    ['let raiseAfterUpdate = process.platform === "win32" && process.argv.includes("--updated");',
      `let raiseAfterUpdate = (${TITLEBAR}) && process.argv.includes("--updated");`, OPTIONAL],
    // Welcome window: same frameless layout, opaque because Linux has no acrylic material.
    ['\t\t...platform === "win32" ? {\n\t\t\ttitleBarStyle: "hidden",\n\t\t\ttitleBarOverlay: {\n\t\t\t\tcolor: "#00000000",\n\t\t\t\tsymbolColor: "#0F1115",\n\t\t\t\theight: 42\n\t\t\t},\n\t\t\tbackgroundMaterial: "acrylic"\n\t\t} : {},',
      '\t\t...platform === "win32" ? {\n\t\t\ttitleBarStyle: "hidden",\n\t\t\ttitleBarOverlay: {\n\t\t\t\tcolor: "#00000000",\n\t\t\t\tsymbolColor: "#0F1115",\n\t\t\t\theight: 42\n\t\t\t},\n\t\t\tbackgroundMaterial: "acrylic"\n\t\t} : {},\n\t\t...platform === "linux" ? {\n\t\t\ticon: join(process.resourcesPath, "icon.png"),\n\t\t\ttitleBarStyle: "hidden",\n\t\t\ttitleBarOverlay: {\n\t\t\t\tcolor: nativeTheme.shouldUseDarkColors ? "#1b1b1c" : "#FFFFFF",\n\t\t\t\tsymbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0F1115",\n\t\t\t\theight: 42\n\t\t\t}\n\t\t} : {},', OPTIONAL],
    ['backgroundColor: platform === "darwin" || platform === "win32" ? "#00000000" : "#FFFFFF",',
      'backgroundColor: platform === "darwin" || platform === "win32" ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#1b1b1c" : "#FFFFFF",', OPTIONAL],
    // Logout and service managers end a session with SIGTERM, and nobody is there to answer the quit question.
    ['if (process.platform !== "win32") powerMonitor.on("shutdown", () => {\n\t\tsessionEnding = true;\n\t});',
      'if (process.platform !== "win32") powerMonitor.on("shutdown", () => {\n\t\tsessionEnding = true;\n\t});\n\tif (process.platform === "linux") for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => {\n\t\tsessionEnding = true;\n\t\tapp.quit();\n\t});', OPTIONAL],
    // Many Linux desktops show no tray icons, so the notice must not promise one.
    ['backgroundNoticeBody: "Running tasks will continue. You can reopen the window from the system tray.",',
      'backgroundNoticeBody: "Running tasks will continue. Reopen the window from the tray icon or your app menu.",', OPTIONAL],
    ['backgroundNoticeBody: "正在运行的任务不会中断，可在系统托盘中重新打开窗口",',
      'backgroundNoticeBody: "正在运行的任务不会中断，可通过托盘图标或应用菜单重新打开窗口",', OPTIONAL],
  ],
  'lib/preload-app.cjs': [
    ['if (process.platform !== "darwin" && process.platform !== "win32") return;',
      'if (process.platform !== "darwin" && process.platform !== "win32" && process.platform !== "linux") return;', OPTIONAL],
    ['function syncWindowsAppearance() {\n\tif (process.platform !== "win32") return;',
      'function syncWindowsAppearance() {\n\tif (process.platform !== "win32" && process.platform !== "linux") return;', OPTIONAL],
  ],
};

/** The in-process Office engine resolver must also send the WASM engine to .asar.unpacked. */
const ENGINE_REQUEST = ['/^@deepseek-ai\\/libreoffice-kit-(?:darwin|win32|linux)-/u', '/^@deepseek-ai\\/libreoffice-kit-(?:(?:darwin|win32|linux)-|wasm)/u'];
const ENGINE_TARGET = ['/\\/node_modules\\/@deepseek-ai\\/libreoffice-kit-(?:darwin|win32|linux)-[^/]+\\//u', '/\\/node_modules\\/@deepseek-ai\\/libreoffice-kit-(?:(?:darwin|win32|linux)-[^/]+|wasm)\\//u'];
for (const file of ['dsh-desktop-host/lib/index.js', 'dsh-desktop-host/lib/cli.js']) {
  APP_PATCHES[`dsh/node_modules/@deepseek-ai/${file}`] = [ENGINE_REQUEST, ENGINE_TARGET];
}

// Electron's archive fs returns null for a missing path, which the kit reads as "installed".
// Only Linux can reach this check without an engine, so upstream never met it.
const ENGINE_PROBE = ['{ throwIfNoEntry: false }) !== void 0)', '{ throwIfNoEntry: false }) != null)'];
for (const file of ['libreoffice-kit/lib/index.js', 'libreoffice-kit/lib/cli.js']) {
  APP_PATCHES[`dsh/node_modules/@deepseek-ai/${file}`] = [ENGINE_PROBE];
}

// Landlock is Linux-only, so upstream never had to run this launcher from a packaged app:
// a binary inside app.asar cannot be spawned, its unpacked copy can.
APP_PATCHES['dsh/node_modules/@deepseek-ai/node-addon-system/lib/index.js'] = [
  ["return join(dirname(resolvePackageJson(`${platformPackage}/package.json`)), 'bin', LAUNCHER_BIN);",
    "return join(dirname(resolvePackageJson(`${platformPackage}/package.json`)), 'bin', LAUNCHER_BIN).replace(/\\.asar([/\\\\])/u, '.asar.unpacked$1');"],
];

// Keeps the local web token out of what the app passes on to its own output. The app gets the URL
// over IPC, so nothing else changes.
APP_PATCHES['lib/main.js'].push(['child.stdout?.pipe(process.stdout);', `let stdoutLine = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			const lines = (stdoutLine + chunk).split("\\n");
			stdoutLine = lines.pop();
			for (const line of lines) process.stdout.write(\`\${line.replace(/([?&]token=)[^\\s&]+/gu, "$1hidden")}\\n\`);
		});`]);

// Limits only file writes, as macOS's sandbox does, so the agent's commands still reach the desktop, other apps and local services.
APP_PATCHES['dsh/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js'] = [
  ['linux: ["bwrap", "landlock"],', 'linux: ["landlock", "bwrap"],', OPTIONAL],
  // Shared memory, terminals and graphics live in /dev. Chrome sets up its own sandbox through /proc.
  ['const readWrite = ["/dev/null"];\n\tif (policy.mode === "workspace-write") readWrite.push("/tmp", policy.workspaceRoot);',
    `const readWrite = ["/dev", "/proc", ...writableRoots(policy).filter((root) => existsSync(root))];
	const runtime = \`/run/user/\${process.getuid()}\`;
	if (policy.mode === "workspace-write" && existsSync(runtime)) readWrite.push(runtime);`, OPTIONAL],
  // Commands find the xdg-open in this folder first. It opens things outside the sandbox, as macOS's open does.
  ['...runnerArgv,\n\t\t\t\t"--",\n\t\t\t\t...argv',
    `...runnerArgv,
				"--",
				...((opener) => selected.runner === "landlock" && existsSync(opener) ? ["/bin/sh", "-c", 'PATH="$0:$PATH" exec "$@"', opener] : [])(join(fileURLToPath(import.meta.url).split("/app.asar/")[0], "linux-port", "packaging", "sandbox-bin")),
				...argv`, OPTIONAL],
];

// Every run-as-Node launch that stays outside the sandbox passes this flag.
const NO_DEBUG_SIGNAL = '--disable-sigusr1';
APP_PATCHES['lib/main.js'].push(['"--expose-internals",\n\t\t\t...this.inspectPort', `"--expose-internals",\n\t\t\t"${NO_DEBUG_SIGNAL}",\n\t\t\t...this.inspectPort`]);
APP_PATCHES['dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'].push(['args: ["--expose-internals", process.argv[5]],', `args: ["--expose-internals", "${NO_DEBUG_SIGNAL}", process.argv[5]],`]);
APP_PATCHES['dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'].push(['args: ["--expose-internals", join(supportDir,', `args: ["--expose-internals", "${NO_DEBUG_SIGNAL}", join(supportDir,`]);
APP_PATCHES['dsh/node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/index.js'] = [
  ['process.execPath,\n\t\t\t\t\t...runtime.worker.endsWith(".ts")', `process.execPath,\n\t\t\t\t\t"${NO_DEBUG_SIGNAL}",\n\t\t\t\t\t...runtime.worker.endsWith(".ts")`],
];

/** Patches relative to resources/runtime. */
const RUNTIME_PATCHES = {
  'cli/bin/dsh': [
    ['"$resources/../MacOS/DeepSeek Harness"', '"$resources/../deepseek-harness"'],
    ['"$resources/../deepseek-harness" --expose-internals', `"$resources/../deepseek-harness" ${NO_DEBUG_SIGNAL} --expose-internals`],
  ],
  'cli/command-manager.js': [
    ['} else throw new CommandInstallationError("EUNSUPPORTED", "Command installation is supported on macOS and Windows.");',
      `} else if (process.platform === "linux") {
		const installRoot = join(resources, "..", "..", "..");
		const options = {
			destination: join(process.env.HOME ?? "", ".local", "bin", "dsh"),
			launcher: join(installRoot, "current", "resources", "runtime", "cli", "bin", "dsh")
		};
		const state = operation === "inspect" ? await inspectFileCommand(options) : operation === "install" ? await installFileCommand(options, fingerprint) : await removeFileCommand(options, fingerprint);
		process.stdout.write(JSON.stringify({
			ok: true,
			state
		}) + "\\n");
	} else throw new CommandInstallationError("EUNSUPPORTED", "Command installation is not supported on this platform.");`, OPTIONAL],
  ],
};

// Linux desktops can put the window buttons on the left, where upstream's title bar has its
// own items. This inset is the width of the buttons there, and 0 when they are on the right.
const LEADING_INSET = 'env(titlebar-area-x, 0px)';
APP_PATCHES['lib/preload-app.cjs'].push(
  [/(:host \{ position: fixed; top: 0; left: )var\(--dsh-windows-menu-start, 48px\);/u,
    `$1calc(var(--dsh-windows-menu-start, 48px) + ${LEADING_INSET});`, OPTIONAL],
);
APP_PATCHES['dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js'] = [
  [/(\[data-windows-titlebar\] \.[\w-]+_toggle\{[^{}]*position:fixed;left:)12px\}/u,
    `$1calc(12px + ${LEADING_INSET})}`, OPTIONAL],
  [/(\[data-windows-titlebar\] \.[\w-]+_collapsed \.[\w-]+_newSession\{[^{}]*position:fixed;left:)48px\}/u,
    `$1calc(48px + ${LEADING_INSET})}`, OPTIONAL],
];

/** A bundler can rewrap the same code, so text that moved only in its spacing still counts. */
function spacingFree(text) {
  return new RegExp(text.trim().split(/\s+/u).map((part) => part.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')).join('\\s*'), 'gu');
}

/** @returns The patched text, or why the patch does not apply. */
function applyOne(text, find, replace) {
  const place = (at, length, value) => text.slice(0, at) + value + text.slice(at + length);
  if (typeof find === 'string') {
    const first = text.indexOf(find);
    if (first >= 0) return text.indexOf(find, first + 1) >= 0 ? { problem: 'ambiguous' } : { text: place(first, find.length, replace) };
    const matches = [...text.matchAll(spacingFree(find))];
    if (matches.length !== 1) return { problem: matches.length === 0 ? 'not found' : 'ambiguous' };
    return { text: place(matches[0].index, matches[0][0].length, replace) };
  }
  const count = [...text.matchAll(new RegExp(find.source, `${find.flags.replace('g', '')}g`))].length;
  if (count !== 1) return { problem: count === 0 ? 'not found' : 'ambiguous' };
  return { text: text.replace(find, replace) };
}

function applyTo(root, table, skipped, allPatches) {
  for (const [file, patches] of Object.entries(table)) {
    const path = join(root, file);
    let text = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    for (const [find, replace, kind] of patches) {
      const result = text === undefined ? { problem: 'the file is gone' } : applyOne(text, find, replace);
      if (result.problem === undefined) {
        text = result.text;
        continue;
      }
      const message = `Patch for ${file} no longer applies (${result.problem}): ${(find.source ?? find).slice(0, 90)}`;
      if (kind !== OPTIONAL || allPatches) throw new Error(message);
      console.error(`Going on without an optional patch. ${message}`);
      skipped.push(message);
    }
    if (text !== undefined) writeFileSync(path, text);
  }
}

export function patchApp(appRoot, portInfo, allPatches = false) {
  applyTo(appRoot, APP_PATCHES, portInfo.skippedPatches, allPatches);
  const manifestPath = join(appRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // macOS reads these names from Info.plist. On Linux they decide the app name,
  // the profile folder (~/.config/DeepSeek Harness) and the window's desktop entry.
  manifest.productName = 'DeepSeek Harness';
  manifest.desktopName = 'deepseek-harness.desktop';
  manifest.dshLinuxPort = portInfo;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

export function patchRuntime(runtimeRoot, portInfo, allPatches = false) {
  applyTo(runtimeRoot, RUNTIME_PATCHES, portInfo.skippedPatches, allPatches);
}
