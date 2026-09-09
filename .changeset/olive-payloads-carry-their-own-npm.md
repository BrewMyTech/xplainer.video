---
"@xplainer/cli": minor
"@xplainer/render-core": minor
---

`xplainer runtime build` and `runtime verify`: the two payloads this phase ships, and the manifest
that describes them.

**Payload 1 — the runtime.** `xplainer runtime build --out <dir>` assembles a relocatable
directory: a copy of `process.execPath`, each workspace package's own `files` allowlist, the
transitive closure of the five runtime dependencies, and **npm** — 17 MB, laid out the way a Node
distribution lays it out, so the copy inside the payload can read the payload. `runtime.manifest.json`
records every path with its `sha256`, every package with its version, the platform, the
interpreter's **architecture**, and the launch contract, all payload-relative: nothing inside the
artefact is an absolute path, because a payload is moved for a living.

npm is there for one reason and it is never imported. On a machine with no Node, `setup --workspace`
has to resolve the render workspace's pins with *something*, and until now the documented fallback
named a package manager the payload did not contain.

**Payload 2 — the render workspace.** `xplainer runtime build --workspace --out <dir>` performs a
**real `npm ci`** of `@xplainer/render-core`'s `template/package.json` against the lockfile now
committed beside it, and writes `workspace.manifest.json` recording every **resolved** version.
It does not copy this repository's hoisted tree, which is a different tree: measured, that yields
react 19.2.8 against the template's 19.2.3, tailwind 4.2.0 against 4.0.0 and zod 4.5.4 where
Remotion requires 4.3.6 — and `remotion versions` exits `1` on the last of those, reporting
`zod: installed 4.5.4, required 4.3.6`. So the copied tree was one Remotion's own guard rejects.

`packages/render-core/template/package-lock.json` is new and ships inside `@xplainer/render-core`
(its `files` allowlist already contained `template`), and `zod` joins the template's pins at
**4.3.6** so nothing Remotion requires is left undeclared. Both ends run `npm ci`, never
`npm install`: `ci` requires the lockfile to be in sync and removes `node_modules` first, while
`install` may rewrite the lockfile on a user's machine and silently defeat the determinism the
lockfile was committed for.

`--from-runtime <dir>` runs that install from a payload's own interpreter and bundled npm, with
`<runtime>/bin` prepended to **the install subprocess's** `PATH` and nothing else changed. That
scope is the whole decision: npm runs lifecycle scripts through `sh -c` and third-party scripts call
bare `node` — `esbuild`'s `postinstall` is `node install.js` — so the same install under a scrubbed
`PATH` exits `127` with `sh: node: command not found` and leaves no workspace at all. Render workers
keep the opposite rule and are still spawned as `<runtime>/bin/node <entry>`, so no interpreter
leaks onto Chrome's or ffmpeg's `PATH`.

**`runtime verify <dir>`** re-hashes a payload against its own manifest and reports the **first**
mismatch by name — a changed file, a truncated one, a missing one, a repointed symlink, or a file
the manifest never described. It refuses a payload built for another platform or another
architecture **before** it hashes anything: `@remotion/compositor-<platform>` is a platform-specific
optional dependency and the interpreter is a native binary, so a payload that matches every hash in
its own manifest can still be one this host cannot run. `runtime verify --workspace <dir>` adds the
comparison that moves a render-time failure to build time: the manifest's resolved versions against
the template's declared pins, package by package.

The assembler refuses rather than guesses. It will not copy an interpreter from a host that is not
plain Node — inside a packaged Electron application `process.execPath` is the Electron binary, and
inside a single-executable build it is the sealed executable — it will not merge into a directory
that already holds something, and it will not copy a workspace package that declares no `files`
allowlist, because the payload is defined by what each package publishes.

`scripts/check-publish-contract.mjs` gains one `MUST_SHIP_FILES` row for the lockfile, beside the
four `template/*` rows already there. Not an exemption: an exemption permits a file to break a rule,
and the lockfile's whole argument is that it must be **present**.

**The launch contract, and how Remotion is started.** `runtime/launch-spec.ts` exports `LaunchSpec`
— executable, argv, settings, cwd — and the one builder that produces it, so the supervisor
renderers, the desktop's spawn and the update transaction all render the same record and none of
them composes an argument of its own. `settings` is deliberately not an environment map: Task
Scheduler's `<Exec>` action has no per-action environment, and the state directory and the token
file are read from the environment only, so an environment-shaped contract would leave an installed
Windows daemon silently on the platform defaults while `daemon.json` recorded something else. Every
setting is emitted as **argv** on every platform — there is no `XPLAINER_SOCKET` variable for an
environment emission to use — and `emitSettings(spec, platform)` says what each artefact carries
beside it: `Environment=` lines for systemd, an `EnvironmentVariables` dictionary for launchd,
`<Arguments>` entries for Task Scheduler. A dropped setting is a failing golden test rather than a
silent fallback.

`resolveNodeEntry(packageDir, binName)` reads a package's **own `bin` field** to the real entry file
and answers `{ executable, argv }`, and the two Remotion workers now use it. They previously spawned
`node_modules/.bin/remotion`, a symlink to a file beginning `#!/usr/bin/env node`: the kernel hands
that to `/usr/bin/env`, which searches the **child's** `PATH`, and on a machine with no Node —
the machine this runtime exists for — `serve`, `/healthz` and `explainer_create` all succeed while
every render exits `127`. Measured here: the shim exits `127` under `PATH=/usr/bin:/bin`, and the
resolved entry run as `<interpreter> <entry>` under the same scrubbed `PATH` reaches Remotion's own
code. Going through `bin` rather than through the shim is also why the Windows `.cmd` case needs no
branch — there is no shim to wrap on any platform — and `PATH` is still never injected through
`WorkerSpec.env`, which would leak an interpreter onto the `PATH` of everything a worker starts,
Chrome and ffmpeg included.
