# 0004. Electron over Tauri for the desktop client

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview round 5 ("do what's standard for such application"), narrowed by
  round 11 (ADR 0016)

## Context and Problem Statement

The product ships an optional desktop application: a library view, a player, job progress,
settings, and a one-click "Add to Claude Code / Codex" button. Round 11 changed what that
application *is* — the local runtime moved into the `xplainer` CLI daemon and the desktop
app became a client of it (ADR 0016) — but it did not remove the app, and the shell still
has to be built on something.

The choice is between Electron and Tauri. `max/desktop/README.md` already argued this once
for the reference implementation and reached Electron; the question here is whether that
argument still holds when the desktop app no longer supervises a Python server.

## Decision Drivers

- The renderer path needs Node and Chrome Headless Shell either way, so "Tauri is smaller"
  does not remove a runtime, it only moves it.
- The desktop app spawns and supervises a long-running child process (`xplainer serve` as
  an `ELECTRON_RUN_AS_NODE` child) and streams its logs — a Node job, native to Electron's
  main process.
- Three-OS packaging, unsigned now and signed later, plus auto-update: AC-4 needs
  installers on ubuntu, macOS and Windows runners green on the first commit.
- Precedent: `max/desktop` is an Electron app the team has already built and shipped.
- Adding a Rust toolchain to a repository that already carries Node *and* Python is a real
  cost against AC-1's "no manual steps beyond Node LTS + uv".

## Considered Options

1. **Electron + electron-vite (React renderer) + electron-builder + electron-updater.**
2. **Tauri**, with a Node or Bun sidecar for everything Rust cannot do.
3. **No desktop app at all** — CLI plus a browser UI served by the daemon.

## Decision Outcome

Chosen: **option 1, Electron**, with `electron-vite` for the dev/build pipeline,
`electron-builder` for packaging and `electron-updater` for later auto-update.

Tauri was rejected on the sidecar. The moment the desktop app has to ship and spawn a Node
process — which it does, because `@xplainer/cli` *is* the local runtime — Tauri's central
advantage (no bundled Chromium, no bundled Node) is gone, and what remains is a Rust
toolchain in the bootstrap path plus a less-trodden three-OS signing and update story. The
`max` precedent points the same way for the same reason: that app is a process supervisor
first and a window second.

Option 3 was rejected as a product decision rather than a technical one: a browser tab
cannot be a tray icon, cannot own file associations, and cannot be installed by a
non-technical user from a `.dmg`. It stays available in effect — the daemon's REST/SSE API
is what a browser UI would use — but it is not the shipped shell.

Scope in this phase is a placeholder window only (spec §Non-Goals): title `Xplainer`, the
app version, context isolation on, node integration off. `apps/desktop/src/main/window.ts`
is a pure `buildWindowOptions()` function so `window.test.ts` can assert the title and the
security flags with no Electron runtime.

## Consequences

### The two `.npmrc` settings, and why one does not imply the other

electron-builder resolves and packs the production dependency tree by **walking real
directories**. pnpm's default symlinked store is a known failure mode for it, on every
operating system, and the failure is sometimes a broken build and sometimes a silently
incomplete app bundle. Two settings are required, and they cover **different halves of the
dependency graph**:

- **`node-linker=hoisted`** flattens **external** packages into a real directory tree that
  electron-builder can traverse. This is the setting people know about.
- **`inject-workspace-packages=true`** is the one that is easy to miss. pnpm keeps
  **workspace** dependencies as symlinks *whatever the linker setting says* — hoisting
  simply does not apply to them. Since `apps/desktop` takes `@xplainer/cli` as a
  **production** dependency (ADR 0016, AC-14e), without injection electron-builder is
  handed a symlink to exactly the one package the app needs, and it will not follow it.
  Injection makes pnpm hard-copy the workspace package into
  `apps/desktop/node_modules/@xplainer/cli` instead.

Neither implies the other. Both are set. The check is concrete rather than trusting:
`test ! -L apps/desktop/node_modules/@xplainer/cli && test -d
apps/desktop/node_modules/@xplainer/cli` — a real directory, not a link. Nothing else in
the verification list would have caught a symlink here, and the symptom would have been a
desktop installer that builds green and launches broken.

Two supporting settings fall out of injection and are set alongside it:
`dedupe-injected-deps=false`, because pnpm otherwise collapses an injected copy back to a
plain symlink when the copy would be identical to the source, undoing the injection; and
`sync-injected-deps-after-scripts[]=build`, because an injected copy is taken at install
time, so a rebuilt `apps/cli` would not otherwise reach `apps/desktop` until the next
`pnpm install`.

**Operational note:** pnpm 11 no longer reads pnpm-specific settings from `.npmrc`. All of
the above are mirrored in `pnpm-workspace.yaml` (`nodeLinker`, `injectWorkspacePackages`,
`engineStrict`), which is the copy pnpm 11 actually obeys. `.npmrc` is kept because npm,
npx and older pnpm still read it, and because these settings are part of the recorded
decision. **Change both together.**

### The cost

The repository gives up **pnpm's strict dependency isolation workspace-wide**. Under a
hoisted tree an undeclared import resolves anyway, which is a correctness cost everywhere
and specifically weakens the tier check: `check-tiers.mjs` inspects declared dependency
edges, so an undeclared `open-later → hosted` import is invisible to it and the Biome
specifier ban is the only thing left. That limit is recorded in ADR 0003 and in the plan's
principle P4. This is the price of keeping AC-6b (a local installer) and AC-4 (three green
runners) working, and it is revisited if electron-builder ever gains symlink support.

### Packaging constraints

- Targets are restricted to those with no native prerequisites on stock GitHub runners:
  linux `AppImage` + `deb` x64, win `nsis` x64, mac `dmg` + `zip` (arm64 and x64). If
  AppImage proves unreliable on the runner, drop to `deb` only and amend this ADR.
- `publish: null` and `CSC_IDENTITY_AUTO_DISCOVERY=false` so macOS never attempts signing;
  this phase produces unsigned artifacts by design (spec §Non-Goals).
- The artifact upload uses `if-no-files-found: error`, so a silent no-op cannot read green.
- Chrome Headless Shell and the TTS sidecar are **not** bundled in the installer; they are
  downloaded on first run (ADR 0005).
- Spawning the bundled CLI from a packaged build hits the `asar` archive boundary; that is
  a phase-2 problem with a known fix, recorded in ADR 0016's consequences.

`apps/desktop/README.md` carries the retargeted Electron-over-Tauri rationale from
`max/desktop/README.md` plus the round-11 restatement.
