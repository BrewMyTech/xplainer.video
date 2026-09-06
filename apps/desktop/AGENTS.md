# AGENTS.md — `@xplainer/desktop`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

An **optional Electron client** for the `xplainer` daemon, and nothing more
([ADR 0016](../../docs/adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md),
[ADR 0004](../../docs/adr/0004-electron-over-tauri.md)). The runtime lives in `apps/cli`. From
roadmap phase 2 this app either spawns `xplainer serve` as an `ELECTRON_RUN_AS_NODE` child or
attaches to a daemon URL — including one on a remote Linux VM. In this phase its only real code is
the seam: `resolveDaemonUrl()`.

`private: true`. It is packaged, never published.

## Public surface

None. Nothing imports this package. The internal seams that matter are
`src/main/daemon.ts` (`resolveDaemonUrl()`), `src/main/window.ts` (`buildWindowOptions()`) and
`src/shared/version-argument.ts`. It emits no declarations and has no API report.

## Commands

```bash
pnpm --filter @xplainer/desktop dev       # electron-vite dev; window title is "Xplainer"
pnpm --filter @xplainer/desktop test
pnpm --filter @xplainer/desktop package   # writes an installer under release/
```

Then the root procedure: `pnpm verify`.

## Invariants

- **No render or TTS code here, ever.** `AC-14f` greps `apps/desktop` for `@remotion/`, `remotion`,
  `kokoro`, `captioned_speech` and `tts` and requires no hits — including in `package.json`. If you
  need one of those, the work belongs in `apps/cli` or `packages/render-core`.
- **`resolveDaemonUrl()` stays a pure function.** No filesystem, no process, no network: the caller
  reads `daemon.json` and passes `{ port }`. Its precedence is
  **configured remote URL → recorded port → `DEFAULT_DAEMON_PORT`**, and the comment tying the
  fallback to `DEFAULT_PORT` in `apps/cli/src/server.ts` is about the fallback only.
- **`@xplainer/cli` is an *injected* production dependency.** `pnpm-workspace.yaml` sets
  `injectWorkspacePackages: true` and `dedupeInjectedDeps: false` so electron-builder packs a real
  directory rather than a symlink it will not follow. Because
  `syncInjectedDepsAfterScripts: [build]` re-syncs the injected copy right after `@xplainer/cli`'s
  build script, **`pnpm --filter @xplainer/cli build` is enough** to get a rebuilt CLI into this
  app; a full `pnpm install` is needed only for a change that does not run that build.
- **React component files under `src/renderer/` are PascalCase by override.** The workspace rule is
  kebab-case; `biome.json` scopes the exception to that directory alone. Do not widen it.
- **`electron.vite.config.ts` is the one file allowed a default export**, by its own scoped Biome
  override, because Vite requires it.
- **`isolatedDeclarations` is deliberately *not* enabled here.** This app emits no declarations, and
  the config file's required default export would fail the flag for no benefit.

## How to add

**A main-process capability:** put the decision in a pure function under `src/main/` and test it
directly; keep the Electron call at the edge, where it cannot be unit-tested anyway.

**A renderer screen:** add it under `src/renderer/src/` — PascalCase for components — and share
anything the main process also needs through `src/shared/`.

**A dependency:** check it is not render or TTS related before you add it. `AC-14f` reads
`package.json` too.

Finish with `pnpm verify`.
