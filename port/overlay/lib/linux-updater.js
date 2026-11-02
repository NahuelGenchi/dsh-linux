// Linux update path for the app's existing update UI. DeepSeek publishes no Linux feed,
// so this follows the macOS feed, verifies the release, ports it with the same engine
// that built this install, and switches to it when the user confirms the restart.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { BrowserWindow, app, dialog, net } from "electron";
import { gt, valid } from "semver";
import yaml from "js-yaml";

const DOWNLOAD_SHARE = 70;
const REQUIRED_FREE_BYTES = 4 * 1024 ** 3;
const MAX_RELEASE_BYTES = 2 * 1024 ** 3;
// Same setting and default as upstream's own update downloads.
const IDLE_LIMIT_MS = Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS) || 6e4;
const ENGINE_FIX_LIMIT_MS = 12e4;

// The engine starts every new build once before it may become current (startTest in port.mjs).
// Everything runs as usual, in a throwaway home, except that no window reaches the screen.
if (process.env.DSH_LINUX_START_TEST) {
	BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = () => {};
	// Electron would put up its error box, and the box would wait for someone to answer it.
	process.on("uncaughtException", (error) => {
		console.error(error.message);
		app.exit(1);
	});
	app.on("web-contents-created", (_event, contents) => {
		contents.once("did-finish-load", () => {
			if (!contents.getURL().startsWith("dsh-app://")) return;
			writeFileSync(process.env.DSH_LINUX_START_TEST, contents.getURL());
			app.exit(0);
		});
	});
}

/** The managed install root (<root>/versions/<version>/deepseek-harness), or undefined for a loose copy. */
function installRoot() {
	const versions = dirname(dirname(process.execPath));
	if (basename(versions) !== "versions") return void 0;
	const root = dirname(versions);
	return existsSync(join(root, "current")) ? root : void 0;
}

function engineNumber(directory) {
	try {
		return JSON.parse(readFileSync(join(directory, "pins.json"), "utf8")).engine;
	} catch {
		return -1;
	}
}

/** This version's own engine, or a signed fix that arrived after it (see engine-fix.mjs). */
function newestEngine(root) {
	const fixes = join(root, "engines");
	const engines = [join(process.resourcesPath, "linux-port"), ...existsSync(fixes) ? readdirSync(fixes).filter((name) => /^\d+$/u.test(name)).map((name) => join(fixes, name)) : []];
	return engines.reduce((newest, engine) => engineNumber(engine) > engineNumber(newest) ? engine : newest);
}

function feedBase() {
	const override = process.env.DSH_LINUX_UPDATE_FEED;
	if (override) return override.endsWith("/") ? override : `${override}/`;
	const config = yaml.load(readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8"));
	if (typeof config?.url !== "string") throw new Error("desktop update: app-update.yml has no feed URL");
	return config.url;
}

class LinuxAutoUpdater extends EventEmitter {
	autoDownload = false;
	autoInstallOnAppQuit = false;
	allowPrerelease = true;
	allowDowngrade = false;
	channel = "nightly";
	httpExecutor;
	release;
	preparedVersion;
	forcedUpdate;
	keepingVersion = false;
	offeringToKeep = false;

	/** A forced update reads the same on Linux until it has really failed here and the user has chosen to carry on. */
	watchForcedUpdate(policy, changed) {
		const state = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(policy), "state")?.get;
		if (state === void 0) return;
		const view = (current) => this.keepingVersion && current.blocking ? { ...current, blocking: false } : current;
		const publish = policy.publish;
		Object.defineProperty(policy, "state", { get: () => view(state.call(policy)) });
		policy.publish = (current) => publish(view(current));
		this.forcedUpdate = { active: () => state.call(policy).blocking, changed };
	}

	/** Lasts until the app quits, so the next start asks DeepSeek and tries again, by then perhaps with an engine fix. */
	offerToKeepVersion() {
		if (this.forcedUpdate === void 0 || this.keepingVersion || this.offeringToKeep || !this.forcedUpdate.active()) return;
		this.offeringToKeep = true;
		const chinese = app.getLocale().startsWith("zh");
		const options = {
			type: "warning",
			title: "DeepSeek Harness",
			message: chinese ? "暂时无法在 Linux 上更新到所需版本" : "The required update isn't available for Linux yet",
			detail: chinese ? "DeepSeek 要求使用新版本，但无法准备它的 Linux 版本。在修复发布前你可以继续使用当前版本，不过 DeepSeek 可能已不再支持它，部分功能可能无法使用。下次启动时应用会再次尝试更新。" : "DeepSeek requires a newer version, but its Linux build could not be prepared. You can keep using this version until a fix arrives, though DeepSeek may no longer support it and some things may stop working. The app tries again the next time it starts.",
			buttons: chinese ? ["继续使用当前版本", "返回"] : ["Keep Using This Version", "Go Back"],
			defaultId: 0,
			cancelId: 1
		};
		const parent = BrowserWindow.getFocusedWindow();
		(parent === null ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options)).then(({ response }) => {
			if (response !== 0) return;
			this.keepingVersion = true;
			this.forcedUpdate.changed();
		}).catch((error) => {
			console.error(error);
		}).finally(() => {
			this.offeringToKeep = false;
		});
	}

	async checkForUpdates() {
		try {
			const result = await this.readFeed();
			if (!result.isUpdateAvailable) this.offerToKeepVersion();
			return result;
		} catch (error) {
			this.offerToKeepVersion();
			throw error;
		}
	}

	async downloadUpdate() {
		try {
			return await this.prepareRelease();
		} catch (error) {
			this.offerToKeepVersion();
			throw error;
		}
	}

	async readFeed() {
		const feed = new URL(`${this.channel}-mac.yml`, feedBase());
		const response = await net.fetch(feed.href, { cache: "no-store", signal: AbortSignal.timeout(IDLE_LIMIT_MS) });
		if (!response.ok) throw new Error(`desktop update: the update feed answered HTTP ${response.status}`);
		const info = yaml.load(await response.text());
		if (typeof info?.version !== "string" || valid(info.version) !== info.version) throw new Error("desktop update: feed version is invalid");
		const file = info.files?.find((entry) => typeof entry.url === "string" && entry.url.endsWith(".zip"));
		if (file === void 0 || typeof file.sha512 !== "string") throw new Error("desktop update: the feed lists no verifiable release");
		const url = new URL(file.url, feed);
		if (url.host !== feed.host || (url.protocol !== "https:" && !process.env.DSH_LINUX_UPDATE_FEED)) throw new Error("desktop update: the feed points to an unexpected host");
		this.release = { version: info.version, url: url.href, sha512: file.sha512, size: Number(file.size) || 0 };
		return { updateInfo: info, isUpdateAvailable: gt(info.version, app.getVersion()) };
	}

	async prepareRelease() {
		const release = this.release;
		if (release === void 0) throw new Error("desktop update: no checked update is available");
		if (!gt(release.version, app.getVersion())) throw new Error("desktop update: refusing to go back to an older version");
		const root = installRoot();
		if (root === void 0) throw new Error("This copy of DeepSeek Harness is not installed. Run install.sh from the Linux package to enable updates.");
		const staging = join(root, "staging");
		mkdirSync(staging, { recursive: true, mode: 0o700 });
		const free = statfsSync(staging);
		if (free.bavail * free.bsize < REQUIRED_FREE_BYTES) throw new Error("Updating DeepSeek Harness needs 4 GB of free disk space.");
		for (const name of readdirSync(staging)) {
			if (name.startsWith(".port-")) rmSync(join(staging, name), { recursive: true, force: true });
		}
		const archive = join(staging, `${release.version}.zip`);
		await this.fetchRelease(release, archive);
		await this.fetchEngineFix(root);
		await this.port(release.version, archive, root);
		rmSync(archive, { force: true });
		this.preparedVersion = release.version;
		this.emit("update-downloaded", { version: release.version });
		return [archive];
	}

	progress(percent) {
		this.emit("download-progress", { percent: Math.min(99, percent) });
	}

	async fetchRelease(release, archive) {
		if (existsSync(archive) && sha512(archive) === release.sha512) return;
		const partial = `${archive}.partial`;
		const stalled = new AbortController();
		let idle;
		const watch = () => {
			clearTimeout(idle);
			idle = setTimeout(() => stalled.abort(new Error("desktop update: the download stopped receiving data")), IDLE_LIMIT_MS);
		};
		watch();
		const hash = createHash("sha512");
		const progress = this.progress.bind(this);
		try {
			const response = await net.fetch(release.url, { cache: "no-store", signal: stalled.signal });
			if (!response.ok || response.body === null) throw new Error(`desktop update: the download answered HTTP ${response.status}`);
			const total = Number(response.headers.get("content-length")) || release.size;
			let received = 0;
			rmSync(partial, { force: true });
			await pipeline(response.body, async function* (source) {
				for await (const chunk of source) {
					watch();
					hash.update(chunk);
					received += chunk.length;
					if (received > MAX_RELEASE_BYTES || (release.size > 0 && received > release.size)) throw new Error("desktop update: the download is larger than the feed announced");
					if (total > 0) progress(received / total * DOWNLOAD_SHARE);
					yield chunk;
				}
			}, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal: stalled.signal });
			if (hash.digest("base64") !== release.sha512) throw new Error("desktop update: the downloaded release failed verification");
			renameSync(partial, archive);
		} catch (error) {
			rmSync(partial, { force: true });
			throw stalled.signal.aborted ? stalled.signal.reason : error;
		} finally {
			clearTimeout(idle);
		}
	}

	/** Never in the way: whatever happens here, the update carries on with the engine it has. */
	fetchEngineFix(root) {
		return new Promise((resolve) => {
			const logs = join(root, "logs");
			mkdirSync(logs, { recursive: true, mode: 0o700 });
			const output = createWriteStream(join(logs, "engine-fix.log"), { mode: 0o600 });
			output.on("error", () => {});
			// This version's own copy, so a fix that turns out broken can still be replaced by a later one.
			const child = spawn(process.execPath, ["--disable-sigusr1", join(process.resourcesPath, "linux-port", "engine-fix.mjs"), "--root", root], {
				env: { ...engineEnvironment(), ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1", NODE_USE_ENV_PROXY: "1" },
				stdio: ["ignore", "pipe", "pipe"]
			});
			const stop = () => child.kill();
			const limit = setTimeout(stop, ENGINE_FIX_LIMIT_MS);
			app.once("will-quit", stop);
			child.stdout.pipe(output, { end: false });
			child.stderr.pipe(output, { end: false });
			const finish = () => {
				clearTimeout(limit);
				app.off("will-quit", stop);
				output.end();
				resolve();
			};
			child.on("error", finish);
			child.on("close", finish);
		});
	}

	port(version, archive, root) {
		return new Promise((resolve, reject) => {
			const logs = join(root, "logs");
			mkdirSync(logs, { recursive: true, mode: 0o700 });
			const log = join(logs, `update-${version}.log`);
			rmSync(log, { force: true });
			const output = createWriteStream(log, { mode: 0o600 });
			// On a full disk the log fails too, and the engine's own error must still reach the user.
			output.on("error", () => {});
			const target = join(root, "versions", version);
			const child = spawn(process.execPath, [
				"--disable-sigusr1",
				join(newestEngine(root), "port.mjs"),
				"--zip", archive,
				"--out", target,
				"--reuse", dirname(process.resourcesPath),
				"--cache", join(root, "cache"),
				"--work-dir", join(root, "staging"),
				"--expect-version", version,
				"--progress-json"
			], {
				env: { ...engineEnvironment(), ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1", NODE_USE_ENV_PROXY: "1" },
				stdio: ["ignore", "pipe", "pipe"]
			});
			// The engine keeps working in the background unless it is told the app has gone.
			const stop = () => child.kill();
			app.once("will-quit", stop);
			let tail = "";
			child.stderr.on("data", (chunk) => {
				output.write(chunk);
				tail = `${tail}${chunk}`.slice(-600);
			});
			let pending = "";
			child.stdout.on("data", (chunk) => {
				output.write(chunk);
				pending += chunk;
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					try {
						const event = JSON.parse(line);
						if (typeof event.percent === "number") this.progress(DOWNLOAD_SHARE + event.percent / 100 * (100 - DOWNLOAD_SHARE));
					} catch {}
				}
			});
			child.on("error", reject);
			child.on("close", (code) => {
				app.off("will-quit", stop);
				output.end();
				if (code === 0 && existsSync(join(target, "deepseek-harness"))) resolve();
				else reject(new Error(`DeepSeek Harness could not prepare the Linux build of ${version}, so the current version stays installed. Details: ${log}. ${tail.trim().split("\n").pop() ?? ""}`));
			});
		});
	}

	quitAndInstall() {
		const version = this.preparedVersion;
		const root = installRoot();
		if (version === void 0 || root === void 0) throw new Error("desktop update: no prepared version");
		const running = basename(dirname(process.execPath));
		setLink(root, "previous", join("versions", running));
		setLink(root, "current", join("versions", version));
		const integrate = join(root, "versions", version, "resources", "linux-port", "packaging", "integrate.sh");
		spawnSync("/bin/sh", [integrate, root], { stdio: "ignore", timeout: 3e4 });
		for (const name of readdirSync(join(root, "versions"))) {
			if (name !== version && name !== running) rmSync(join(root, "versions", name), { recursive: true, force: true });
		}
		rmSync(join(root, "staging"), { recursive: true, force: true });
		// The new version carries the newest engine itself.
		rmSync(join(root, "engines"), { recursive: true, force: true });
		app.relaunch({ execPath: join(root, "deepseek-harness"), args: ["--updated"] });
		app.quit();
	}
}

/** The engine runs downloaded tools, so it gets no credentials and no switches that change how Node loads or trusts code. */
function engineEnvironment() {
	return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(name) && !["NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(name)));
}

function setLink(root, name, target) {
	const temporary = join(root, `.${name}.${process.pid}`);
	rmSync(temporary, { force: true });
	symlinkSync(target, temporary);
	renameSync(temporary, join(root, name));
}

function sha512(path) {
	const hash = createHash("sha512");
	const fd = openSync(path, "r");
	const buffer = Buffer.alloc(1 << 20);
	try {
		let read;
		while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
	} finally {
		closeSync(fd);
	}
	return hash.digest("base64");
}

export const linuxAutoUpdater = new LinuxAutoUpdater();
