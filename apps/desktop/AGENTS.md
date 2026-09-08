# AGENTS.md — `@xplainer/desktop`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

An **optional Electron client** for the `xplainer` daemon, and nothing more
([ADR 0016](../../docs/adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md),
[ADR 0004](../../docs/adr/0004-electron-over-tauri.md)). The runtime lives in `apps/cli`; this app
supervises and displays, and either attaches to a daemon URL — including one on a remote Linux VM —
or runs CLI commands through the **runtime payload it ships**.

It is **discovery-first**: `src/main/discovery.ts` asks the CLI's own `status --json` where the
daemon is, gets one of seven outcomes back, and starts a daemon of its own only for the one that
means there is nothing to talk to. Everything the window then shows goes through
`src/main/bridge.ts`, which holds the bearer token so the renderer never has to.

The window is four screens — **library, player, progress and settings** — and the two things it can
ask the CLI to *do* are both shell-outs: `src/main/controls.ts` runs `connect claude|codex` for the
one-click "Add to an agent" control and `daemon install` for "Start xplainer at login". Neither
writes an agent configuration, a `plist`, a unit or a scheduled task; the CLI owns all four.

`private: true`. It is packaged, never published.

## Public surface

None. Nothing imports this package. The internal seams that matter are
`src/main/daemon.ts` (`resolveDaemonUrl()`), `src/main/paths.ts` (`packagedPayloadRoot()`,
`packagedInterpreter()`), `src/main/spawn.ts` (`resolvePayloadCommand()`, `runPayload()`,
`startProgram()`), `src/main/discovery.ts` (`resolveCliProgram()`, `discover()`, `spawnDaemon()`),
`src/main/controls.ts` (`connectAgent()`, `startAtLogin()`), `src/main/bridge.ts` (`DaemonBridge`),
`src/main/window.ts` (`buildWindowOptions()`) and `src/shared/` (`ipc.ts`, `daemon-api.ts`,
`version-argument.ts`). It emits no declarations and has no API report.

The renderer keeps its decisions out of its components in the same way: `src/renderer/src/library.ts`
reads the `/api/videos` document, `src/renderer/src/progress.ts` reduces a job's events, and
`src/renderer/src/screens/` holds the four screens, each a function of the props it is given.
`src/renderer/src/theme.ts` is the one place a colour is chosen.

`src/main/index.ts` is the **edge**: it registers the IPC channels, the media protocol and the
window, and holds no decision of its own. `src/main/testing/live-daemon.ts` is the fixture the
suites arrange real daemons with and `src/main/testing/recording-cli.ts` is the one they arrange a
recording `xplainer` with; `tsconfig` type-checks both and nothing bundles them.

## Commands

```bash
pnpm --filter @xplainer/desktop dev       # electron-vite dev; window title is "Xplainer"
pnpm --filter @xplainer/desktop test
pnpm --filter @xplainer/desktop package   # writes an installer under release/
```

Then the root procedure: `pnpm verify`.

**Packing an app that can actually run.** `package` does *not* build the runtime payload, and
electron-builder only **warns** when an `extraResources` source is missing — it packs an app with no
payload and exits 0 (measured, electron-builder 26.15.3). The full sequence is:

```bash
node apps/cli/dist/bin.js runtime build --out .artefacts/xplainer-runtime   # ~147 MB, once
pnpm --filter @xplainer/desktop exec electron-builder --dir --publish never
pnpm --filter @xplainer/desktop check:packaged   # dependency shape, payload, arch, call path
pnpm --filter @xplainer/desktop check:launch     # launches the packaged app; opens a window
```

`check:packaged` needs no display and is what `.github/workflows/desktop.yml` runs after packing, on
every runner that workflow packed on. Which runners those are is the matrix's decision and not this
step's: a push to `main` packs on `ubuntu-latest` alone, a `v*` tag and a `workflow_dispatch` start
from all three, and a dispatch's per-OS inputs then trim the set. So "all three runners" is a
statement about a tag or a dispatch with every box ticked, and about nothing else.

`check:launch` copies the packaged application **out of the checkout**, empties `PATH`, launches it
and asserts the `payload_probe` line names an interpreter inside the copy — the local and human half
of the proof. On Linux run it under `xvfb-run -a`.

## Invariants

- **No render or TTS code here, ever.** `AC-14f` greps `apps/desktop` for `@remotion/`, `remotion`,
  `kokoro`, `captioned_speech` and `tts` and requires no hits — including in `package.json`. It runs
  as its own CI step, on a pristine checkout before the toolchain is installed. If you need one of
  those, the work belongs in `apps/cli` or `packages/render-core`.
- **`resolveDaemonUrl()` stays a pure function.** No filesystem, no process, no network: the caller
  reads `daemon.json` and passes `{ port }`. Its precedence is
  **configured remote URL → recorded port → `DEFAULT_DAEMON_PORT`**, and the comment tying the
  fallback to `DEFAULT_PORT` in `apps/cli/src/server.ts` is about the fallback only.
- **`@xplainer/cli` is an *injected* production dependency.** `pnpm-workspace.yaml` sets
  `injectWorkspacePackages: true` and `dedupeInjectedDeps: false` so electron-builder packs a real
  directory rather than a symlink it will not follow. Because
  `syncInjectedDepsAfterScripts: [build]` re-syncs the injected copy right after `@xplainer/cli`'s
  build script, **`pnpm --filter @xplainer/cli build` is enough** to get a rebuilt CLI into this
  app; a full `pnpm install` is needed only for a change that does not run that build. **The copy
  lands in the workspace root's `node_modules`, not in `apps/desktop/node_modules`** — `nodeLinker:
  hoisted` hoists an injected package like any other, so `apps/desktop/node_modules/@xplainer` does
  not exist at all (measured, pnpm 11.25.0). `scripts/check-packaged-payload.mjs` therefore asserts
  the shape at the directory *Node resolves*, walking up from `apps/desktop` the way electron-builder
  does.
- **The app spawns the payload, never anything inside `app.asar`, and never
  `ELECTRON_RUN_AS_NODE`.** Decision D10: `status --json`, `setup`, `daemon install` and `connect`
  run as `<resources>/xplainer-runtime/bin/node[.exe]
  <resources>/xplainer-runtime/lib/node_modules/@xplainer/cli/dist/bin.js …`, resolved from
  Electron's own `process.resourcesPath`. Routing them through the stable launcher instead would
  make the app depend on a file `daemon install` creates — unreachable on a clean machine, and
  permanently unreachable for the user with no supported supervisor. Nothing may be spawned from
  inside the archive: Electron patches `fs` so a child can *read* it, but no path inside it can be
  executed (ADR 0004, ADR 0005). Anything that must be spawned belongs in the payload, or in
  `asarUnpack`.
- **Discovery shells out; it never reimplements.** `discovery.ts` runs
  `xplainer daemon status --json` for this machine's daemon and `xplainer status --url … --json`
  for one somebody else runs, and maps the CLI's **closed set of condition codes** — never prose —
  onto the seven outcomes (`ready`, `degraded`, `incompatible`, `unauthorized`, `occupied`,
  `disabled`, `absent`). Resolving a state directory and resolving a port are the CLI's, and a
  second implementation here would be one that can disagree with the daemon about which machine it
  is describing. `disabled` in particular is only observable through the supervisor queries T12
  whitelists, which is why the local command is the one asked about a local daemon.
- **The state directory arrives in the report, and the launcher is looked for beside it.** D10's
  second stage — `<state>/bin/xplainer[.cmd]` — is reached only through
  `DaemonReport.stateDir`; nothing here derives, defaults or guesses that path.
- **On Windows that launcher is a `.cmd`, and Node will not spawn one without an interpreter.**
  Since the fix for CVE-2024-27980, `spawn` of a `.cmd` or `.bat` with `shell: false` fails with
  `EINVAL` before the file is read, so every control and every discovery that resolved the launcher
  answered `command-failed` on `windows-latest` — the app worked with nothing installed and stopped
  the moment an install had happened (measured 2026-09-08). `spawnPlan()` in `src/main/spawn.ts` is
  the one place that is handled: `%ComSpec% /d /s /c "…"` with **every token quoted here**, because
  `shell: true` joins the arguments with spaces and quotes none of them, and a token `cmd.exe` would
  re-parse or expand — a quote, a percent sign, a line break — is refused by name rather than run as
  a different path than the one this app resolved. It is the identity on every other platform, and
  `shell: false` stays what `startProgram()` passes.
- **Both one-click controls are shell-outs, and they take D10's two stages with everything else.**
  "Add to Claude Code / Codex" runs `connect claude|codex`; "Start xplainer at login" runs
  `daemon install`. Before an install they run through the packaged payload's own interpreter, and
  `daemon install` is given `--runtime <resources>/xplainer-runtime` there, because nothing is
  staged under `<state>/runtime/` on a clean machine and an install with nothing to install is the
  situation the control exists for. Once the launcher exists the argument is dropped and the
  launcher is what runs. `src/main/controls.test.ts` asserts both stages of both controls against a
  recording program on a temporary path.
- **The window offers `still` and `render`, and never `narrate`.** `explainer_narrate` takes a
  narration document whose segment ids are the scene ids of the video's own composition, and
  composing one is the agent's work. `EnqueueVerb` in `src/shared/daemon-api.ts` is that closed set.
- **`xplainer-media:` is on the renderer's `img-src` and `media-src`.** The page's
  Content-Security-Policy is `default-src 'self'`, so without those two the `<video>` element and
  the stills are blocked with nothing in the window to say why. The daemon's own origin is
  deliberately not there: a page that could reach it would need the bearer token, and R-SEC-7
  forbids the CORS that would take. *Enforcement: `src/renderer/csp.test.ts`, which reads the
  `<meta>` out of `index.html` and pins each directive's source list. It exists because this
  sentence and `index.html`'s own comment were both false until 2026-09-08 — `connect-src` ended
  `http://localhost:*`, which is every loopback port the daemon can bind — and two documents
  describing a third file is the arrangement that drifts.*
- **`a11y/useMediaCaption` is off for `src/renderer/src/screens/Player.tsx` alone**, by a scoped
  `biome.json` override. The captions are composited into the frames by the render, so there is no
  sidecar track to point at, and `captions.json` is word-level `Caption[]` rather than a cue list —
  the composition decides the pagination. Do not widen the override, and do not add a `<track>` with
  no source to satisfy the rule.
- **The renderer never holds the token.** `bridge.ts` is the only place that reads the token file
  and the only place that sets `Authorization`. The preload exposes verbs — a document, a stream, a
  media URL — and no way to set a header or name an origin. A token in the page would need a
  browser origin allowed on the daemon, and R-SEC-7 forbids CORS middleware there for any value,
  ever. A `401` re-reads the token file once and retries only when the value has changed, which is
  how `token rotate` propagates without a restart.
- **The bridge judges the resolved URL, never the string the renderer sent.** `open()` builds the
  URL first and checks *that* — the origin against the daemon's, the pathname against `/healthz` and
  `${API_PREFIX}/` — and hands the same object to the send. A `startsWith` over the raw path is a
  check about a different request than the one that goes out: `new URL()` collapses `..`, `.` and
  their percent-encoded spellings (`%2e%2e` is a double-dot segment by the URL standard), so
  `/api/../mcp` and `/api/%2e%2e/mcp` pass the prefix and dial `/mcp` with the bearer attached.
  `mediaPath()` in `src/shared/daemon-api.ts` already had the rule; the bridge now keeps it too.
- **The bridge's transport is unpooled `node:http`, not `fetch`.** Node's `undici` calls
  `setTypeOfService()` on a resumed **pooled** socket and `node:net` throws the failed `setsockopt`
  from inside the socket's own handler, past every `try`/`catch` — the CLI moved its pollers off
  `fetch` for exactly that. Every request here gets its own connection.
- **One daemon over one state directory, always.** A daemon this app spawned is supervised by
  nothing else: it is stopped before an installed one starts (the spawn-to-install handoff,
  `handOffToInstall` in `src/main/discovery.ts`, which the install channel is wired through) and
  before this process exits (`before-quit`). A `serve` that finds the state directory owned exits
  `10` having written nothing, and that is **reattachment** — ask again — not a failure to retry.
  The handoff is not only about that exit: a spawned daemon binds `serve`'s default port, which is
  the `8787` `daemon install` records and probes, so an install run beside it refuses with exit `7`
  over a port conflict this app is itself the whole of.
- **`absent` is not by itself permission to spawn.** Two conditions land on that outcome that a
  `serve` of this app's own cannot repair, and `mayStartDaemon()` is what consults them: `stalled`
  is a latched breaker, where a `serve` exits `0` without binding and the window would wait for a
  daemon that never arrives; `unreachable` on a machine that registered one is an installed daemon
  that is stopped, which is its supervisor's to start. Both already have a remedy sentence of their
  own, and the sentence and the decision are the same decision.
- **The architecture is compared before the interpreter is spawned.** `runtime build` copies the
  build host's `process.execPath`, so a payload runs only on the architecture it was built on. The
  Electron main process — already running on this machine's architecture — reads
  `runtime.manifest.json` and refuses by name; a mismatched interpreter could not have performed
  that check on itself, because it cannot start. `src/main/spawn.ts` owns the comparison.
- **The macOS target is arm64 only** (plan §1.3d decision B). `macos-latest` is arm64 and
  `runtime build` copies its own interpreter, so an x64 dmg built there would carry an arm64
  interpreter. Adding the x64 targets back means building the payload on an x64 runner and wiring
  per-architecture `extraResources`.
- **React component files under `src/renderer/` are PascalCase by override.** The workspace rule is
  kebab-case; `biome.json` scopes the exception to that directory alone. Do not widen it.
- **`electron.vite.config.ts` is the one file allowed a default export**, by its own scoped Biome
  override, because Vite requires it.
- **`isolatedDeclarations` is deliberately *not* enabled here.** This app emits no declarations, and
  the config file's required default export would fail the flag for no benefit.

## How to add

**A main-process capability:** put the decision in a pure function under `src/main/` and test it
directly; keep the Electron call at the edge, where it cannot be unit-tested anyway.

**A CLI command the app has to run:** add its argv beside `DAEMON_STATUS_ARGV` in `discovery.ts`
and run it with `runCli(resolveCliProgram({ resourcesPath, stateDir }), argv)`, so it takes D10's
two stages with everything else. Do not reach for a `PATH` lookup, a bare `xplainer`, or the copy of
the CLI inside the archive.

**A daemon route the window needs:** do not spell the path here. Follow it from what the daemon
answered — an artefact's `url`, a queued job's `events` — and add a channel in `src/shared/ipc.ts`
if the renderer has to ask for it. `/api/videos` is the one path this app names, in
`src/shared/daemon-api.ts`, and `bridge.test.ts` compares it against `@xplainer/cli`'s own builder.

**A test that needs a daemon:** arrange it with `src/main/testing/live-daemon.ts` — a real payload,
a real `serve`, and the CLI's own fixture writers for anything `setup` would have produced. No
mocking: the suites drive this machine into the state they are about.

**A renderer screen:** add it under `src/renderer/src/screens/` — PascalCase for components — put
the decision it shows in a plain module beside `library.ts` and `progress.ts`, and share anything
the main process also needs through `src/shared/`. A screen is asserted by rendering it with
`react-dom/server` over a document a real daemon answered (`src/renderer/src/screens.test.tsx`); it
needs no DOM implementation and none is installed.

**A dependency:** check it is not render or TTS related before you add it. `AC-14f` reads
`package.json` too.

Finish with `pnpm verify`.
