# @xplainer/desktop

An **optional** desktop client for xplainer.video. Open-later tier.

It opens one window, asks the `xplainer` CLI where this machine's daemon is, and
talks to it over an authenticated connection the **main process** holds. It
reaches the CLI one way only: through the **runtime payload it ships beside the
archive**. Everything below explains what it is *for*, so the next phase does
not have to re-derive it.

The window is four screens — **library**, **player**, **progress** and
**settings** — over that one connection, and the two things it can ask the CLI
to *do* are both shell-outs: `connect claude|codex` for the one-click "Add to an
agent" control, and `daemon install` for "Start xplainer at login". The app
writes no agent configuration, no `plist`, no unit and no scheduled task.

## What this app is (and is not)

The desktop app is a **client of the `xplainer` CLI daemon, not a runtime**.

- `@xplainer/cli` owns the local runtime: the HTTP server, the MCP endpoint, and
  in later phases the render and narration pipelines. It is a **production
  dependency** of this package for exactly that reason.
- Electron supervises and displays. The main process either attaches to a daemon
  that is already running — `src/main/daemon.ts` decides which URL applies — or
  runs a CLI command through the packaged payload: `<resources>/xplainer-runtime/
  bin/node <resources>/…/@xplainer/cli/dist/bin.js <argv…>`, which is decision
  D10 and is what `src/main/spawn.ts` builds. **`ELECTRON_RUN_AS_NODE` is not
  used**: the payload carries its own interpreter, so the app's pre-install and
  post-install paths are the same interpreter running the same entry.
- Consequently there is **no rendering and no speech-synthesis code in this
  package, and there must never be any**. The relevant packages are not
  dependencies, are not imported, and are not mentioned; AC-14f asserts that by
  grep rather than by reading.

## Discovery, and the authenticated bridge

The app **asks before it starts anything**. `src/main/discovery.ts` shells out to
the CLI's own `status --json` — `xplainer daemon status --json` for this
machine's daemon, `xplainer status --url … --json` for one somebody else runs —
and turns the condition code it answers into one of seven outcomes:

| Outcome | What was observed | What the app offers |
|---|---|---|
| `ready` | an authenticated `/healthz` `200` | the library |
| `degraded` | `200` with a reason | the library, and `setup` |
| `incompatible` | a `contract_version` this app cannot speak | update one side |
| `unauthorized` | `401` — something on our port is not our daemon | stop it, or point elsewhere |
| `occupied` | the port is held by a foreign pid (exit `10`'s condition) | stop that process |
| `disabled` | the supervisor says the service is switched off | switch it back on |
| `absent` | nothing answered, and nothing above explained why | start one, or install it |

Only `absent` leads to a daemon of this app's own — and not every `absent` does.
Two conditions land on that outcome whose remedy is a command the user runs
rather than a daemon this app starts: `stalled`, where the breaker is latched and
a `serve` exits `0` without binding, and `unreachable` on a machine that has one
registered, where an installed daemon is stopped and its supervisor owns starting
it. The app consults the condition, not just the outcome.

A daemon this app spawned is stopped before an installed one starts and before
the app exits — one daemon over one state directory, always. A `serve` that finds
the state directory owned exits `10` having written nothing, which the app reads
as *reattach*: ask again. The **Start at login** button runs that handoff in
order — stop the spawned daemon, install, discover again — because a spawned
daemon holds `serve`'s default port, which is the port `daemon install` probes,
and an install beside it refuses with exit `7` over this app's own listener.

Which program those commands run is **decision D10**, and it has two stages: the
packaged payload's own interpreter until `daemon install` has written
`<state>/bin/xplainer`, and the stable launcher afterwards. The state directory
is never derived here — it arrives in the report, and the launcher is looked for
in the `bin/` beside it.

`src/main/bridge.ts` is the other half: it reads the bearer token from the file
the daemon recorded and is the only thing that sets an `Authorization` header.
The renderer is given verbs — a document, a job's event stream, a
`xplainer-media://` URL a `<video>` element can load — and never a credential. A
token in the page would have to be reachable from a browser origin, which would
mean CORS on the daemon, which ADR 0020 §R-SEC-7 forbids for any value. A `401`
re-reads the token file and retries once, so `token rotate` propagates without
anything being restarted.

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
   workspace, spawned as an ordinary child process with no IPC protocol to
   invent. (ADR 0004 reached that conclusion via `ELECTRON_RUN_AS_NODE`; the
   app ships an interpreter of its own now, and the argument is unchanged.)
2. The renderer is not a static export. It talks to a live local daemon over
   HTTP, which is a pattern Electron treats as ordinary and Tauri treats as the
   exception.

Recorded as **ADR 0004**, which links here for the long form.

## Layout

```
src/
├── main/                Electron main process
│   ├── index.ts         the edge: window, IPC channels, media protocol, app exit
│   ├── window.ts        pure buildWindowOptions() — the window contract
│   ├── daemon.ts        pure resolveDaemonUrl() — the client seam (A1)
│   ├── paths.ts         pure packagedPayloadRoot()/packagedInterpreter() — all 3 platforms
│   ├── spawn.ts         reads the payload manifest, refuses by name, spawns the payload
│   ├── discovery.ts     the seven outcomes, D10's two stages, the spawned daemon
│   ├── bridge.ts        the token, the REST/SSE/media proxy, the 401 retry
│   ├── controls.ts      the two one-click shell-outs, at both of D10's stages
│   └── testing/         real payloads and real daemons for the two suites
├── preload/index.ts     context-isolated bridge; verbs only, never a token
├── renderer/src/        the window: four screens and the decisions behind them
│   ├── library.ts       reads /api/videos into rows; no URL is built here
│   ├── progress.ts      reduces a job's events into what a row shows
│   ├── theme.ts         the one place a colour is chosen
│   └── screens/         Library, Player, Progress, Settings
├── shared/              what both processes must agree on: IPC names, API paths, version
└── ../scripts/          the two packaged-build checks (see Packaging)
```

`window.ts`, `daemon.ts` and `paths.ts` are pure and import Electron only as a
type, so `vitest run` asserts the real window contract, the real URL resolution
and all three packaged layouts with no Electron binary and no display.
`spawn.ts`'s tests build real payload directories in a temporary directory and
spawn real children out of them; `discovery.ts`'s and `bridge.ts`'s start a real
`xplainer serve` out of one of those payloads and drive it into each of the seven
states — a stale token, a held port, a supervisor that answers "switched off" —
rather than mocking any of them. `controls.ts`'s tests put a **recording
`xplainer`** at both of D10's two stages and assert which program each control
executed; the screens are rendered with `react-dom/server` over documents a real
daemon answered, which needs no DOM implementation and no display.

## The two one-click controls

Both are shell-outs and both go through the same two-stage resolution every
other command does, which is what makes them work on a machine with nothing
installed:

| Control | Command | Before an install | After one |
|---|---|---|---|
| Add to Claude Code / Codex | `connect claude`, `connect codex` | `<resources>/xplainer-runtime/bin/node <…>/bin.js …` | `<state>/bin/xplainer …` |
| Start xplainer at login | `daemon install` | the same, plus `--runtime <resources>/xplainer-runtime` | `<state>/bin/xplainer daemon install` |

`--runtime` is there because nothing is staged under `<state>/runtime/` on a
clean machine, and the packaged app is already carrying a payload-1 directory.
Once the launcher exists the argument is dropped: by then the state directory
has a staged runtime of its own, and `daemon update` is what changes it.

The window offers `still` and `render` and never `narrate`: narration takes a
document whose segment ids are the scene ids of the video's own composition, and
composing one is the agent's work.

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
  Windows `nsis` (x64), macOS `dmg` + `zip` (**arm64 only**). Targets that need a
  toolchain a stock GitHub-hosted runner lacks — snap, rpm, pacman — are absent,
  so `desktop.yml` can build on all three runners with no setup step.
- **macOS x64 is dropped this phase** (plan §1.3d B). `runtime build` copies the
  build host's own `process.execPath` and `macos-latest` is arm64, so an x64 dmg
  built there would ship an arm64 interpreter and fail to spawn on an Intel Mac.
  The manifest records the interpreter's architecture and the app compares it
  against `process.arch` before spawning, so such a mismatch is named rather
  than silent — but the fix is a payload built on the target architecture.
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
hard-copied instead of symlinked. electron-builder packs real directories and
does not follow symlinks, so without that setting the packaged app would ship a
broken dependency. The copy is refreshed when `@xplainer/cli` builds
(`syncInjectedDepsAfterScripts`), and otherwise at install time. It lands in the
**workspace root's** `node_modules` — `nodeLinker: hoisted` hoists an injected
package like any other, so `apps/desktop/node_modules/@xplainer` does not exist
(measured, pnpm 11.25.0) — and electron-builder finds it by walking up.

### The runtime payload

The packed archive is not what the app runs. `extraResources` ships the
`xplainer runtime build` artefact — an interpreter, npm and the workspace
packages, ~147 MB — to `<resources>/xplainer-runtime/`, and that is what every
CLI command the app runs is spawned from. It has to be outside `app.asar`
because nothing can execute a path that exists only inside an archive (ADR 0004,
ADR 0005), and it has to be a whole payload rather than the packed
`@xplainer/cli` directory because a machine with no Node cannot run the latter.

`extraResources` copies from a directory that must already exist, and
electron-builder only **warns** when it does not — it packs an app with no
payload and exits 0 (measured, electron-builder 26.15.3). So the payload is
built first and the result is checked afterwards:

```bash
node apps/cli/dist/bin.js runtime build --out .artefacts/xplainer-runtime
pnpm --filter @xplainer/desktop exec electron-builder --dir --publish never
pnpm --filter @xplainer/desktop check:packaged   # no display; runs on all three runners
pnpm --filter @xplainer/desktop check:launch     # launches the packaged app; opens a window
```

`check:packaged` asserts the dependency shape, the payload's presence, the
architecture — compared by the checking process, because an interpreter built
for another architecture cannot make that comparison on itself — a full
`runtime verify` re-hash, and the production call path. `check:launch` copies
the packaged application out of the checkout, empties `PATH`, starts it and
asserts the interpreter it spawned is the one inside the copy.
