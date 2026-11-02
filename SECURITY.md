# Security

## Reporting a problem

Please don't open a public issue. Use GitHub's [private reporting](https://github.com/NahuelGenchi/dsh-linux/security/advisories/new) instead, so a fix can land before the details are public. Problems that affect DeepSeek Harness on every system belong with [DeepSeek](https://github.com/deepseek-ai/deepseek-harness).

## What protects you

| If someone controls... | What stops them |
|---|---|
| The download host or the update feed | Every update must carry DeepSeek's real Apple signature, checked against a pinned Apple root certificate, DeepSeek's team ID and the signed list of every file. The version in the feed must match the signed release and be newer than what you run. |
| A look-alike npm package | Only packages the signed release declares can be picked, and each is verified by npm's SHA-512. The engine unpacks them and never runs their install scripts. |
| A download of Electron, Node or Python | Hashes are pinned in [`port/pins.json`](port/pins.json) for each reviewed version. Electron's hash from GitHub must also match the one in its npm package, and a redirect to plain HTTP stops the download. |
| A crafted archive | The extractors refuse paths outside their folder, links that lead out of the tree, zip bombs and loose file modes. |
| The engine fix channel | A fix must be signed by the key pinned in the app, carry a higher number than the engine it replaces and match its hash. You can [turn it off](README.md#updates). |
| Another account on your machine | Scripts set their own file modes, and logs and staging folders are private to you. The AppArmor rule names this one install. |
| A web page with a `dsh://` link | The app only focuses its window, and ignores anything the link tries to pass along. |
| A bad command from the agent | Writes outside the workspace are blocked, and debug entry points are closed. With `bubblewrap` installed, local services are hidden too. |

## What it can't protect you from

**Root, or malware already running as you.** Those are outside what any of this can stop.

**A stolen signing key.** If DeepSeek's Apple key or this project's engine key were stolen, the signatures would still check out. Apple's revocation list isn't checked, because that needs Apple's servers.

**Running without `bubblewrap`.** Landlock has no rule for sockets, so commands in the agent's sandbox can still reach local services. Installing `bubblewrap` closes this.

**The AppArmor rule's path.** In-app updates need the install folder to be writable by you, so your other programs could claim the rule. That weakens Ubuntu's user namespace restriction for your account only.

**Reads and network inside the sandbox.** Commands can read your files and reach the network. That is DeepSeek's stated design, and the port keeps it.

**An old version kept on offer.** A feed can keep offering an old release. The app refuses a downgrade, but it can't tell that a newer one exists.

## Your data

This project has no servers and never sees your account. Your sign-in and API keys stay in `~/.dsh`, and the update engine runs with credentials removed from its environment. The only request the port itself adds is the engine fix check, which sends nothing but your IP address to GitHub. The package carries no user name, home folder or key, and each release is scanned for them before upload.
