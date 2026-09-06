# @xplainer/desktop

An **optional** desktop client for xplainer.video. Open-later tier.

In this phase it is a placeholder: one window showing the application name and
`app.getVersion()`, and the seam it will later use to find a daemon. Nothing
else. Everything below explains what it is *for*, so the next phase does not
have to re-derive it.

## What this app is (and is not)

The desktop app is a **client of the `xplainer` CLI daemon, not a runtime**.

- `@xplainer/cli` owns the local runtime: the HTTP server, the MCP endpoint, and
  in later phases the render and narration pipelines. It is a **production
  dependency** of this package for exactly that reason.
- Electron supervises and displays. In a later roadmap phase the main process
  either spawns `xplainer serve` as an `ELECTRON_RUN_AS_NODE` child or attaches
  to a daemon that is already running; `src/main/daemon.ts` decides which URL
  applies. **No process is spawned in this phase** — the seam is scaffolded, not
  wired.
- Consequently there is **no rendering and no speech-synthesis code in this
  package, and there must never be any**. The relevant packages are not
  dependencies, are not imported, and are not mentioned; AC-14f asserts that by
  grep rather than by reading.

The reason the split runs this way is Linux VM installability: the runtime has
to be usable with no desktop environment at all, over SSH on a headless box, so
the runtime cannot live inside a GUI application. See **ADR 0016**.

## Why Electron and not Tauri

The rationale is inherited from the `max` desktop shell, which solved the same
problem, and retargeted to this repository.

A desktop shell whose main job is to **supervise a long-running local server
process** and stream its output is a Node job, and Electron's main process does
that natively. Tauri would put a Rust toolchain in front of every contributor
and every CI runner without addressing the supervision problem any better.

Two facts specific to this repository push the same way:

1. The thing being supervised is `@xplainer/cli`, a Node program in this very
   workspace. Electron can execute it directly with `ELECTRON_RUN_AS_NODE`,
   with no second runtime to ship and no IPC protocol to invent.
2. The renderer is not a static export. It talks to a live local daemon over
   HTTP, which is a pattern Electron treats as ordinary and Tauri treats as the
   exception.

Recorded as **ADR 0004**, which links here for the long form.

## Layout

```
src/
├── main/                Electron main process
│   ├── index.ts         app lifecycle; opens the one window
│   ├── window.ts        pure buildWindowOptions() — the window contract
│   └── daemon.ts        pure resolveDaemonUrl() — the client seam (A1)
├── preload/index.ts     context-isolated bridge; exposes the version, nothing else
├── renderer/            React placeholder window
└── shared/              the one value both processes need to agree on
```

`window.ts` and `daemon.ts` are pure and import Electron only as a type, so
`vitest run` asserts the real window contract and the real URL resolution with
no Electron binary and no display.

## Develop

```bash
pnpm --filter @xplainer/desktop dev        # electron-vite dev, opens the window
pnpm --filter @xplainer/desktop build      # electron-vite build -> out/
pnpm --filter @xplainer/desktop test       # vitest run
pnpm --filter @xplainer/desktop package    # electron-builder -> release/
```

## Packaging

`electron-builder.yml` is deliberately narrow.

- **Targets need no native prerequisites.** Linux `AppImage` + `deb` (x64),
  Windows `nsis` (x64), macOS `dmg` + `zip` (arm64 + x64). Targets that need a
  toolchain a stock GitHub-hosted runner lacks — snap, rpm, pacman — are absent,
  so `desktop.yml` can build on all three runners with no setup step.
- **Artifacts are unsigned and unpublished.** `publish: null` in the config and
  `--publish never` in the script keep electron-builder away from a release
  feed; `mac.identity: null` plus `CSC_IDENTITY_AUTO_DISCOVERY=false` in the
  `package` script keep it from adopting a signing certificate that happens to
  be in the developer's keychain. Signing, notarization and auto-update are a
  later roadmap phase. `electron-updater` is declared as a dependency so that
  phase does not have to change the packaged dependency tree, and is
  deliberately not wired to anything today.
- **`npmRebuild: false`.** There are no native modules in the dependency tree,
  so there is nothing to rebuild against the Electron ABI.

One install-time detail matters here: pnpm is configured with
`injectWorkspacePackages` and `dedupeInjectedDeps: false`, so `@xplainer/cli` is
hard-copied into `apps/desktop/node_modules` instead of symlinked. electron-
builder packs real directories and does not follow symlinks, so without that
setting the packaged app would ship a broken dependency. The copy is refreshed
when `@xplainer/cli` builds (`syncInjectedDepsAfterScripts`), and otherwise at
install time.
