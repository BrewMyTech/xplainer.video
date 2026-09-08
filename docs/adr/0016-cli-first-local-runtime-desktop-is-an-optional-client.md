# 0016. CLI-first local runtime; the desktop app is an optional client

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview round 11 (post-consensus amendment) — "we also need cli with the
  desktop app or could be complementary, like cli exposes an api and desktop client is
  optional. this will allow us to install on linux vms easily"

## Context and Problem Statement

Up to round 10 the local runtime **was** the Electron application: it hosted the local MCP
server, owned the render pipeline, spawned the TTS sidecar, and the GUI was the only way to
run any of it.

Round 11 broke that on a concrete use the user actually named: **installing the local stack
on a headless Linux VM.** An Electron app cannot be installed there in any useful sense —
there is no display, and the whole runtime is trapped inside a desktop shell that cannot
start.

Two further facts, already true before round 11, pointed the same way. The vision video for
this product describes a `brew install`-style daemon, not a GUI. And the hosted
`services/media-service` needs the same render pipeline the local runtime has — but it
cannot import an Electron main process, so the pre-amendment design implied **two
implementations of one tool contract**.

## Decision Drivers

- **Linux VM installability.** This is the driver the user gave, and it is the one that
  decides: the local stack has to run with no desktop environment present.
- One implementation of the tool contract across local and hosted, because spec
  §Constraints/Contract promises identical names and schemas and a second implementation is
  how that promise breaks.
- Distribution that suits a headless machine: `npx xplainer` and a standalone binary, not a
  `.dmg`.
- The GUI remains a real product for desktop users; this must not become "the CLI, and also
  there used to be an app".

## Considered Options

1. **Electron hosts the local server** (the pre-amendment design).
2. **CLI-first:** `apps/cli` ships the `xplainer` binary and owns the runtime; the desktop
   app becomes an optional client that bundles and spawns it, or attaches to an
   already-running daemon.
3. **CLI only, no desktop app.**

## Decision Outcome

Chosen: **option 2 — CLI-first.**

`apps/cli` (tier `open-later`) ships the `xplainer` binary with four commands: `serve` (a
localhost Streamable HTTP MCP endpoint at `/mcp`, REST + SSE at `/api/*` for GUI clients,
`GET /healthz`, and the job runner), `mcp` (stdio MCP for agents that prefer that
transport), `setup` (downloads Chrome Headless Shell and the TTS sidecar — ADR 0005), and
`connect claude|codex` (writes agent configuration). All render and TTS logic lives here.

`apps/desktop` becomes an **optional client**: it declares `@xplainer/cli` as a production
dependency and, from roadmap phase 2, either spawns `xplainer serve` as an
`ELECTRON_RUN_AS_NODE` child or attaches to a daemon URL — including one on a remote Linux
VM. Its only round-11 code in this phase is the seam: a pure `resolveDaemonUrl()` that
returns a configured remote URL if there is one and `http://127.0.0.1:8787` otherwise.

Option 1 was rejected on all three of the drivers above: it cannot be installed headless, it
contradicts the product's own daemon model, and it forces the hosted media service to
reimplement the tool contract.

Option 3 was rejected because the GUI is a genuine product decision (ADR 0004), not
scaffolding — it just is not the *runtime*.

Distribution is npm (`npx xplainer`), standalone per-OS binaries via Node's
single-executable packaging (recipe documented in `apps/cli/packaging/README.md`, built
outside CI in this phase), and the same code inside the hosted media-service image.
`@xplainer/cli` is consequently the **one application in the workspace that is published**,
which is why it is deliberately absent from the Changesets ignore list while every other app
and service is on it.

**In this phase the CLI is a scaffold** (spec §Non-Goals): `serve` answers `/healthz` and a
placeholder `/mcp` whose `tools/list` equals the protocol manifest by construction, and
`mcp`, `setup` and `connect` are registered commands that print `not implemented in this
phase` to stderr and exit 2. A registered command with a defined exit code is behaviour, and
it is tested as behaviour.

## Consequences

- **One server core, three surfaces.** `apps/cli/src/server.ts` exports the
  `createServer(backend)` that `services/media-service` imports, and both build on
  `createMcpServer()` from `@xplainer/mcp-server`, which iterates `TOOL_NAMES`. The hosted
  image and the local daemon are one code path rather than two that drift. The Python
  surface cannot share the code, so it is pinned by assertion against the same manifest
  instead (ADR 0007).
- **Electron spawning the bundled CLI does not resolve under `asar`, and phase 2 must know
  that in advance.** The bundled `@xplainer/cli` lives inside the packaged `app.asar`
  archive — a virtual filesystem Electron's own APIs understand and a **spawned child
  process does not**, so the child is handed a path it cannot open. `node-linker=hoisted`
  changes where the package sits, not whether the archive is traversable. The fix at phase 2
  is to add `@xplainer/cli` to electron-builder's `asarUnpack` so it is extracted to
  `app.asar.unpacked`, and to resolve the child path through that directory. Recorded here
  so phase 2 does not rediscover it the hard way.
- **The desktop app takes a production dependency on a workspace package**, which is what
  makes `inject-workspace-packages=true` load-bearing rather than optional (ADR 0004).
  A consequence to know before it surprises someone: an injected workspace package is
  **copied at install time**, so a rebuilt `apps/cli` does not reach `apps/desktop` until
  the injected copies are re-synced. Harmless in this phase, where the desktop app only
  declares the dependency and never executes it; a real development-loop concern at phase 2.
- **At roadmap phase 5, `services/media-service` is `hosted` and depends on `apps/cli`,
  which is `open-later`.** That direction is legal under the tier rule (ADR 0003) — hosted
  may import open-later — but once the open-later tier is extracted and published
  separately, that dependency stops being a workspace sibling and becomes an **externally
  published package**. The extraction checklist must therefore treat `@xplainer/cli` as a
  **publish-then-consume boundary, not a file move**: the CLI is published first, and the
  hosted service then consumes it from the registry at a pinned version. This is the one
  cross-tier edge in the repository that changes shape at extraction, and it is recorded
  here and in `docs/ROADMAP.md` phase 5 rather than being found during it.
- **The daemon has no authentication and binds localhost.** Non-localhost access needs a
  bearer token, deferred to roadmap phase 2; until then, exposing the daemon on a network is
  outside the supported configuration.
- **`apps/desktop` must contain no render or TTS code**, and that is asserted by grep rather
  than by reading: no `@remotion/*`, no `remotion`, no `kokoro`, no `captioned_speech`, no
  `tts` anywhere in the app's sources or manifest.
- **Twelve workspace members instead of eleven**, which changes every task-coverage count
  the CI check asserts.

## Note, 2026-09-05: sequencing is decided in ADR 0019, not here

This record decided **which process owns the local runtime** — `xplainer serve`, not an
Electron main process — on installability and contract-unity drivers. It does not decide
**when that runtime ships relative to the hosted tier**, and nothing above mentions audience,
buyer, demand or phase ordering.

That question was put by an external architecture review on 2026-09-05, which recommended
reversing the roadmap's ordering. It is answered in
[ADR 0019](0019-sequencing-local-cli-before-hosted.md): the local CLI tier ships first, the
hosted tier follows at roadmap phase 3. ADR 0019 builds on this record — it depends on the
"one server core, three surfaces" property above, because that is what makes the phase-1 work
transferable to `services/media-service` rather than throwaway — and it records the rejected
hosted-first case at full strength, including the parts of it that survive the decision.

Note also that the review explicitly endorsed keeping this record: "Keep ADR 0016. Moving
rendering into Electron would not solve onboarding or authoring." Its recommendation was
about phase order, not about the runtime boundary.

## Note, 2026-09-06: how the runtime is supervised is decided in ADR 0020, not here

This record decided **which process owns the local runtime**. It does not decide **how that
process is started, kept running, or stopped** — nothing above mentions boot, login,
supervision, restart-on-crash or installation of a service, and `xplainer serve` is a
foreground command throughout.

That question was put by the owner on 2026-09-06, after the scaffold landed: the local runtime
should be always running, like the Docker daemon. It is answered in
[ADR 0020](0020-always-running-local-daemon.md): one supervised process per user, per machine,
started by the operating system's own user-scope supervisor — `systemd --user` with lingering
on Linux, a LaunchAgent on macOS, a Scheduled Task on Windows — and never by root. ADR 0020
builds on this record: the no-desktop-session driver above is what rules out a login-item or
tray-owned daemon, and "the user's own uid" is what rules out a system service.

**One consequence above is amended by ADR 0020, and it is amended rather than clarified.**
This record states:

> **The daemon has no authentication and binds localhost.** Non-localhost access needs a
> bearer token, deferred to roadmap phase 2.

That sentence was written for a daemon a human starts, uses and Ctrl-Cs. A daemon that is
always listening on loopback is reachable by any web page the user visits, through DNS
rebinding, so ADR 0020 makes loopback binding, `Host` and `Origin` validation and a local
bearer token **requirements of the local daemon**, not deferred work — and narrows the ADR 0019
Dissolved-table row that rests on "the user's own agent, running under the user's own uid" to
the IPC and stdio transports. The clause about **non-localhost** exposure being outside the
supported configuration is unchanged and is reinforced there.

Nothing else in this record is rewritten: the CLI still owns the runtime, the desktop app is
still an optional client, and `createServer()` is still the one server core behind three
surfaces.

## Note, 2026-09-08: what the optional client spawns, and the third answer discovery can give

Added as a dated note rather than a rewrite. This record decided that `apps/cli` owns the runtime and
that `apps/desktop` is an optional client. Both still stand, and
[ADR 0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md) fills in the two things
this record left as sentences rather than mechanisms.

**What the client spawns is the packaged runtime artefact, and `ELECTRON_RUN_AS_NODE` is not used.**
This record says the app "either spawns `xplainer serve` as an `ELECTRON_RUN_AS_NODE` child or
attaches to a daemon URL", and its Consequences record the `asar` trap — a spawned child cannot open a
path inside `app.asar` — with `asarUnpack` named as the phase-2 fix. What shipped is neither. The
packaged application carries **payload 1**, the relocatable runtime artefact, as `extraResources`, and
that payload carries **its own interpreter**; so the app spawns
`<resources>/xplainer-runtime/bin/node` with the payload's own `bin.js`, and the reason
`ELECTRON_RUN_AS_NODE` existed — so the app would not need Node on the user's machine — is answered by
the payload instead. The `asar` finding above was correct and is why the payload sits outside the
archive rather than inside it.

**Program resolution has two stages, and that is a correction of an order this record could not have
seen.** Routing every shell-out through the stable launcher at `<state>/bin/xplainer` — the one name
that survives a daemon update — makes the app depend on a file that `daemon install` creates. That is
unreachable on a clean machine, and **permanently** unreachable for the user with no supported
supervisor, who never installs and whose product is the spawned daemon. So the app asks through the
packaged payload **before** an install and through the launcher **after** one, and it learns which of
the two it is in from `status --json` rather than by guessing: the state directory arrives in the
report, and the launcher is looked for in the `bin/` beside it.

**There is a third answer, and `status --json` is what makes it sayable.** This record offers two:
spawn, or attach. As built there are seven discovery outcomes and **three branches** — attach to what
answered, spawn when nothing did, or **do neither and name the condition**. Two conditions land in the
third branch and neither is repairable by a `serve` of this app's own: a **latched circuit breaker**,
where a daemon started now exits `0` without binding, so spawning produces no daemon and no error a
window could show; and a daemon that is **installed and stopped**, which is its supervisor's to start
and where a duplicate over the same state directory is the exit `10` the design exists to avoid. Both
are observable only through the CLI's own report — a user switching the service off in Login Items &
Extensions changes supervisor state and touches no file of ours — which is why the app shells out to
`xplainer daemon status --json` instead of reimplementing state-directory and port resolution. A
second implementation of either would be a second implementation that can disagree with the daemon
about which machine it is describing.

Nothing else is rewritten. The CLI still owns the runtime, the desktop app is still an optional
client that holds no token of its own, and `createServer()` is still the one server core behind three
surfaces.
