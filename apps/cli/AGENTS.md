# AGENTS.md — `@xplainer/cli`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

**The local runtime.** The `xplainer` binary, the Hono application it serves — `GET /healthz` and
the Streamable HTTP MCP endpoint at `/mcp` — the **eight tools** behind that endpoint
(`src/backend.ts`, over a shared Remotion workspace on this machine), and the **durable job daemon**
under `src/daemon/`:
exclusive ownership of the state directory, one JSON file per job, boot reconciliation, and a runner
that executes each job's worker as a child process in its own process group. `serve` is also
**hardened**: a bearer token minted `0600` in a `0700` directory, a guard in front of every TCP
route (`Host` allowlist, `Origin` validation, the token on `/healthz` too), a `SIGTERM` drain that
ends in exit `0`, and one JSON line on stdout announcing readiness. It binds **two** listeners over
that one application — the TCP port, and a unix socket (a named pipe on Windows) inside a `0700`
directory where filesystem permissions are the authentication — and `xplainer mcp` is the stdio
entry an agent is configured with, either running the tools in its own process or proxying them to
that socket with `--attach` (`src/mcp/`), while `xplainer connect claude|codex` is what writes that
entry into an agent's own configuration (`src/connect/`). All render
and TTS logic lives here, not in `apps/desktop`
([ADR 0016](../../docs/adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md)), and from
phase 2 `serve` becomes an installed, supervised, per-user daemon
([ADR 0020](../../docs/adr/0020-always-running-local-daemon.md)).

It is the **one application in the workspace that is published**, which is why it is deliberately
absent from the Changesets ignore list.

### `src/daemon/` — the store, and the two state files

Each module is small and named for the one thing it owns, and each has a colocated test:

| Module | What it owns |
|---|---|
| `state-dir.ts` | Where the state directory is per platform, `XPLAINER_STATE_DIR`, and the names inside it |
| `durable-write.ts` | temp → `fsync` → `rename` → `fsync` the directory; the flush that reports instead of throwing |
| `worker-identity.ts` | The identity triple (pid, start token, machine boot id) and the four verdicts over it |
| `lock.ts` | `owner.lock`: `O_EXCL` create, staleness by the tuple, takeover confirmed by read-back |
| `job-store.ts` | One JSON file per job, the bounded log tail, corrupt quarantine, newer-format detection |
| `reconciler.ts` | Boot reconciliation: terminal records, worker teardown, `workers_uncertain`, output quarantine |
| `process-group.ts` | `SIGTERM` then `SIGKILL` to a worker's whole process group |
| `runner.ts` | `enqueue` / `get` / `tail` / `cancel` / `drain` over a serial queue of child-process workers |
| `daemon-state.ts` | `daemon.json` and `runtime.json`, and the circuit breaker's `recentStarts[]`/`stalled` |
| `start.ts` | The ordering: ownership → reconciliation → the runner, handed to `commands/serve.ts` to bind |
| `workers.ts` | The registry `start.ts` registers: one `WorkerSpec` per job kind, and the last gate before Chrome |
| `token.ts` | The bearer token file: `XPLAINER_TOKEN_FILE` or the default, `O_EXCL` mint, `0600` |
| `guard.ts` | The four layers every TCP request passes: `Host`, `Origin`, the token, the redacted log |
| `ipc.ts` | The socket path, its `0700` directory, the stale socket a `SIGKILL` left, the Windows pipe |
| `binding.ts` | Which addresses `--bind` may take, and the port precedence — two pure functions, no I/O |
| `ready.ts` | The one JSON line on stdout, and the wait a parent does instead of sleeping |
| `shutdown.ts` | `SIGTERM`/`SIGINT` → drain → close the listeners → remove `runtime.json` → exit `0` |
| `exit-codes.ts` | The start-up codes, quoting the table in `docs/ARCHITECTURE.md` §6 |
| `testing/` | The fake worker, the child entries the tests spawn, the spawn harness and the source hook |

The state directory — `${XDG_STATE_HOME:-~/.local/state}/xplainer/` on Linux,
`~/Library/Application Support/video.xplainer/` on macOS, `%LOCALAPPDATA%\xplainer\state\` on
Windows, or `XPLAINER_STATE_DIR` — holds:

```
owner.lock          the ownership artefact: pid, start token, boot id, nonce (0600)
token               DURABLE. 32 random bytes, base64url, 0600 — or wherever XPLAINER_TOKEN_FILE says
daemon.json         DURABLE. port, contract version, token_file, directory_flush, recentStarts[], stalled
runtime.json        EPHEMERAL. this run's pid, run id, boot id, bound port, addresses, socket
ipc/xplainer.sock   EPHEMERAL. the IPC listener, in a 0700 directory; unlinked on clean shutdown
jobs/job-000001.json   one record per job, temp-then-rename, with a bounded log tail
jobs/corrupt/          records that could not be parsed, moved aside rather than deleted
mcp/session-XXXXXX/    one `xplainer mcp` stdio session's private job store, removed when it ends
```

**The two files have opposite lifetimes and that is the whole point** (ADR 0020 §Port and
discovery): `daemon.json` must survive a reboot, `runtime.json` is written at bind and is never
trusted without a liveness check. `recentStarts[]` and `stalled` are in the **durable** one —
ADR 0020 first put them in `runtime.json`, and its own dated note records why that was wrong, since
on Linux `runtime.json` lives in systemd's `RuntimeDirectory=` and is deleted on every clean stop.

### `src/backend.ts` and `src/workers/` — the eight tools, and what carries them out

`createLocalBackend({ runner, root })` is the local implementation of `RenderBackend`
([ADR 0016](../../docs/adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md)). Four
tools are filesystem work that finishes in milliseconds — `explainer_create`,
`explainer_put_source`, `explainer_put_media`, `explainer_list` — three enqueue against the daemon's
runner because they take tens of seconds
([ADR 0008](../../docs/adr/0008-async-job-model-poll-and-progress-no-agent-webhooks.md)), and
`explainer_job` **is** `runner.get()`, relayed.

| Module | What it owns |
|---|---|
| `backend.ts` | The eight tools, their refusals, and the schema patterns re-checked at the disk boundary |
| `workspace-root.ts` | `XPLAINER_VIDEOS_DIR`, else `<state dir>/workspace` — one pure function, two callers |
| `job-request.ts` | The per-job request document under `<workspace>/requests/`: the tool call's arguments, where the worker can read them |
| `daemon/video-lock.ts` | `<workspace>/locks/<slug>.lock`: one writer per video, across processes — the shared workspace's own exclusion |
| `daemon/workers.ts` | kind → `WorkerSpec`: the narration worker, and the pinned Remotion CLI with render-core's argv |
| `workers/narrate.ts` | The spawned narration worker: the request and the spec back off disk, then render-core's narration port |
| `workers/speech.ts` | Where the speech comes from: `XPLAINER_TTS_FIXTURE`, else `XPLAINER_TTS_URL`, else the tts-client's own resolution |

### `src/mcp/` — the two things `xplainer mcp` can be

`xplainer connect` writes an agent a **command**, never a URL and never a token
([ADR 0020](../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not TCP),
and this directory is what that command runs.

| Module | What it owns |
|---|---|
| `stdio-server.ts` | `xplainer mcp`: the eight tools in this process, over a session-private job store |
| `attach.ts` | `xplainer mcp --attach`: the `/healthz` skew gate, then one pumped MCP session |
| `socket-fetch.ts` | `fetch` over a unix socket, which Node's own has no supported way to do |

`xplainer mcp` is the **plugin-bundle** path — `npx -y @xplainer/cli mcp`, on a machine with nothing
installed — and `--attach` is what a machine with a daemon gets. They share the *workspace* and
deliberately not the *job store*, and because they share the workspace they take a per-video write
lock in it: see the two invariants below.

The workspace itself belongs to `@xplainer/render-core` — the layout, the template, the scaffold,
the argv builders and the preflight all live there, and nothing about a video's shape is decided
here:

```
<XPLAINER_VIDEOS_DIR, or <state dir>/workspace>/
  package.json remotion.config.ts tailwind.css tsconfig.json   copied from render-core/template/
  node_modules/         NOT installed by any tool call — see the invariant below
  videos/<slug>/        the engine-owned shell and the agent's Scenes.tsx
  public/<slug>/        timings.json, captions.json, narration.wav, narration.json, media/
  out/<slug>/           explainer.mp4 and frame-<n>.png
  requests/job-000001.json   what the job was asked to do
  locks/<slug>.lock     held while a job is writing that video, by whichever process is writing it
```

### `src/connect/` — the entry an agent is given, and who writes it

`xplainer connect claude` and `xplainer connect codex` write **one stdio entry** —
`xplainer mcp --attach`, or `npx -y @xplainer/cli mcp --attach` on a machine where the binary is not
on `PATH` — into the agent's own configuration, and nothing else goes in it: no URL, no port and no
token, because the transport is the daemon's unix socket and filesystem permissions are its
authentication ([ADR 0020](../../docs/adr/0020-always-running-local-daemon.md) §The agent path is
IPC, not TCP).

| Module | What it owns |
|---|---|
| `entry.ts` | The command line itself: the real `PATH` lookup, and the two forms it chooses between |
| `preflight.ts` | The check before any write: `daemon.json`'s recorded port, or a refusal and exit `3` |
| `claude.ts` | `claude mcp add` when that CLI is on `PATH` — remove-then-add over a name it already holds — else `~/.claude.json`'s `mcpServers` |
| `codex.ts` | `codex mcp add` when that CLI is on `PATH`, else the `[mcp_servers.xplainer]` table in `~/.codex/config.toml`, edited in place |
| `vendor-cli.ts` | The one spawn of somebody else's CLI: resolved path, closed stdin, both streams captured |
| `toml-tables.ts` | Where that table starts and ends, and the declarations it refuses to duplicate |
| `atomic-write.ts` | temp → `rename` over somebody else's file, keeping the mode that file had |
| `refusal.ts` | `ConnectRefusal`: one sentence and one exit code from the documented table |

## Public surface

From `src/index.ts`: `createServer`, `startServer`, `DEFAULT_PORT`, `DEFAULT_HOSTNAME` and their
option types — including `GuardFactory`, the middleware-over-the-bound-port seam a second binding
uses, and `RunningServer.socket`, the IPC endpoint a `startServer({ ipc })` bound;
`createLocalBackend`, `LocalBackendError` and `LocalBackendCode`; `resolveWorkspaceRoot`,
`VIDEOS_DIR_ENV` and `WORKSPACE_DIR_NAME`; `CLI_VERSION`; `NOT_IMPLEMENTED_EXIT_CODE` and the
not-implemented helpers. `bin/` ships `dist/bin.js` as `xplainer`. Published, emits declarations,
carries `api/cli.api.md`.

**`src/daemon/` is internal and deliberately not exported.** It is the local runtime's own
machinery, and ADR 0020's last accepted cost is that "the supervisor modules are local-runtime
concerns and must not leak into `packages/mcp-server`". `services/media-service` imports
`createServer()` and nothing below it; the backend and the `SIGTERM` drain reach the runner through
`startDaemon()`, inside this package. `createLocalBackend()` **takes** a `JobRunner` rather than
reaching for one, which is what keeps that boundary a compile-time fact rather than a convention.

## Commands

```bash
pnpm --filter @xplainer/cli test
pnpm turbo build --filter @xplainer/cli          # where TS9010 appears

# The render test bundles a composition and drives Chrome; it takes ~10 s once Remotion has its
# headless shell, and skips only on this:
XPLAINER_SKIP_RENDER_TEST=1 pnpm --filter @xplainer/cli test

# A throwaway state directory, so a hand-run daemon cannot take the real one — and every TCP
# request needs the bearer token the first start mints there (ADR 0020 §Security R-SEC-4).
# Read the ready line rather than sleeping (ADR 0025 §Part three): `head -n 1` blocks until the
# daemon has taken ownership, reconciled and bound both listeners, which is also when the token
# file and `daemon.json`'s port exist. Without it the next two lines race the start-up.
export XPLAINER_STATE_DIR=$(mktemp -d)
mkfifo "$XPLAINER_STATE_DIR/stdout"
node apps/cli/dist/bin.js serve --port 8787 > "$XPLAINER_STATE_DIR/stdout" &
head -n 1 "$XPLAINER_STATE_DIR/stdout"           # {"event":"ready","port":…,"socket":…,…}
curl -sf -H "Authorization: Bearer $(cat "$XPLAINER_STATE_DIR/token")" localhost:8787/healthz
node apps/cli/dist/bin.js status                 # the two state files, confirmed by a real probe
kill %1 && wait %1                               # drains, removes runtime.json, exits 0

node apps/cli/spikes/p1-s1-ownership.mjs         # the ownership check ADR 0024's note quotes

# What `connect` would write, into a throwaway HOME rather than your own agent configuration.
# Relocate HOME only: `XPLAINER_STATE_DIR` is still exported from the block above, and the
# `daemon.json` the killed daemon left there is what records the port `connect` refuses to write
# without (exit 3, nothing written). Relocating HOME on its own would move the state directory too,
# and every line here would exit 3.
# With `codex` on PATH this delegates to `codex mcp add`, which writes the same file under that
# HOME; `--config` is how you exercise this package's own writer instead.
FAKE_HOME=$(mktemp -d)
HOME=$FAKE_HOME node apps/cli/dist/bin.js connect codex
cat "$FAKE_HOME/.codex/config.toml"
HOME=$FAKE_HOME node apps/cli/dist/bin.js connect codex --config "$FAKE_HOME/direct.toml"

# The `[runner]` half of the artefact gate: `pnpm e2e:runtime` on ubuntu, macos and windows.
gh workflow run e2e-runtime.yml --ref "$(git branch --show-current)"
```

Then the root procedure: `pnpm verify`.

## Invariants

- **Never add `serve --detach`.** [ADR 0020](../../docs/adr/0020-always-running-local-daemon.md)
  rejects self-daemonisation outright: the supervisor owns the process lifetime, and a foreground
  command that forks is invisible to it. The rule belongs in `src/commands/serve.ts`'s docblock and
  stays there.
- **The command surface is asserted with `toEqual`, never widened to `toContain`** (`AC-14b`). The
  listing is exactly `serve`, `status`, `mcp`, `setup`, `connect`, `daemon`, and it only holds
  because commander's implicit `help [command]` is disabled. A `toContain` would let a stray command
  ship unnoticed. Top-level `status` and the group's `daemon status` are different commands and
  neither is an alias of the other: the first asks "is this machine's daemon up, and where", the
  second reports on the installed supervisor artefact and is still a phase-2 stub. `connect` and
  `daemon` are **groups**, and each has its own `toEqual` listing — `claude`, `codex` and the seven
  lifecycle verbs — for the same reason and with the same implicit `help [command]` disabled.
- **Ownership, then reconciliation, then bind.** That order is an invariant, not an implementation
  note ([ADR 0024](../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Exclusive
  ownership). Reconciliation *rewrites other processes' records*, so a second `serve` has to be
  turned away before it touches anything: it exits `10` **having written nothing**, which
  `daemon/start.test.ts` proves by hashing every file in the state directory either side of the
  refusal. Never move a write above `acquireOwnership()`.
- **A `job_id` is returned only after its record is durable.** `enqueue()` writes
  temp → `fsync` → `rename` → `fsync` the directory *before* it resolves, because "an agent must
  never hold an identifier for a job that no restart can find". Durable writes happen on state
  transitions and on a log-flush timer — **never per output line**: a durable record costs about
  7 ms on macOS (ADR 0024's note of 2026-09-06 §Storage shape).
- **A recorded pid is never an identity.** Only a positive tuple match licenses a kill. A live pid
  whose token cannot be read is `uncertain`: it is left alone, the record carries
  `workers_uncertain: true`, and the job's output directory is quarantined so a retry writes
  somewhere fresh. Reading the token is a `ps` spawn at about 4.5 ms, so it is read **once per
  acquisition and once per worker at reconciliation**, and memoised for this process.
- **Every worker runs in its own process group** (`detached: true`), and teardown signals the group
  (`process.kill(-pgid, …)`), because a render's expensive half is the browser and the encoder it
  started, not the pid the daemon holds.
- **Nothing installs the workspace's `node_modules`.** `materialiseWorkspace()` copies four files
  and creates three directories; it never runs a package manager, because installing hundreds of
  megabytes is a visible step a user takes and never something a tool call does behind an agent's
  back ([ADR 0005](../../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)).
  `explainer_still` and `explainer_render` therefore refuse a workspace with no Remotion in it, by
  name and with the command that fixes it — `remotionBinary()` answering `null` is a refusal, never
  a guessed path that fails later inside `spawn`.
- **A tool's arguments reach its worker on disk, not in the record.** ADR 0008 dropped the
  reference implementation's `command` field, so a job record carries no arguments; `job-request.ts`
  writes one document per job under `<workspace>/requests/` and `daemon/workers.ts` reads it back.
  The write happens after `enqueue()` resolves and before the runner's `setImmediate` can start the
  worker — that ordering is the event loop's, not luck, and a missing document is still a named
  failure rather than an assumption.
- **A render is gated twice, and restored once.** The backend refuses a video with no
  `timings.json` at the call, so an agent hears about it immediately; the worker factory then runs
  `scaffoldVideo()` — restoring an engine-owned file an agent wrote through `write_source_to`, which
  is the hole ADR 0007 accepted and ADR 0018 layer 4 closes — and `assertRenderable()` before a
  single Chrome process starts.
- **Two listeners, one application, and only one of them carries the guard.** `startServer({ ipc })`
  binds the TCP port with `serve()` and the socket with `createAdaptorServer({ fetch })` over the
  *same* `Hono` object — ADR 0020's "One `createServer()`, one tool registration, two listeners".
  A request is exempt from the guard because the **socket's own adaptor** put its `Request` in a
  `WeakSet` on the way in, never because of anything the request says: no header, path or body can
  make a TCP request look like an IPC one, and there is no "local mode" flag to get wrong. Keep it
  that way — the moment the exemption is inferred from a header or from `remoteAddress`, the
  loopback guard has a bypass in it.
- **The socket lives in a `0700` directory and is unlinked on a clean stop.** `daemon/ipc.ts` makes
  the directory and clears whatever the last run left at the path, and it is only allowed to do that
  because `serve` calls it **after** `acquireOwnership()`: a socket file present while this process
  holds `owner.lock` belongs to a run that is gone. `0700` is **`chmod`ed on every start, not just
  passed to `mkdir`**: a mode given to `mkdir` applies to a directory it creates and is ignored for
  one that already exists, so an `ipc/` an older release or a stray `umask` left at `0755` would
  keep those bits for ever and every local account could walk in to the socket that is authenticated
  by nothing else. The state directory *above* it is left exactly as found — ADR 0020 and
  `state-dir.ts` own that one, and `ipc/` is the last directory on the path to the socket, so
  narrowing it is sufficient. Windows gets a named pipe named after a digest
  of the state directory, which has no mode, no directory and nothing to unlink — ADR 0020 §Security
  R-SEC-5 already records that gap as the installer's to close in phase 2.
- **`xplainer mcp` does not share the daemon's job store, and `--attach` is how you get it.** A job
  store is single-writer — `job_id`s are allocated from what is on disk — so an in-process `mcp`
  takes a session directory under `<state dir>/mcp/` and removes it when the session ends. It does
  **not** take `owner.lock`, deliberately: an `mcp` that refused to start because a daemon was
  running would defeat the `npx -y @xplainer/cli mcp` bundle path it exists for. The consequence is
  documented rather than discovered: a `job_id` from one connection means nothing on another.
- **One writer per video, across processes, and it is a lock in the *workspace*.** Owning the state
  directory says nothing about the workspace once `xplainer mcp` holds the same worker registry over
  the same root without that lock, so a daemon and two stdio sessions could each drive Remotion at
  one `out/<slug>/explainer.mp4`. `daemon/workers.ts` therefore takes
  `<workspace>/locks/<slug>.lock` (`daemon/video-lock.ts`) as the **last** thing a factory does —
  after every refusal, so a refused job leaves no lock — and `daemon/runner.ts` gives it back in
  `finish()`, which is the one place every terminal outcome passes through. A second process asking
  for a video that is held fails **that job** with a message saying to retry; different videos never
  contend. Decided in [ADR 0024](../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Note,
  2026-09-07. Anything new that writes into `videos/`, `public/` or `out/` from a *job* belongs
  behind the same lock; do not reach for `owner.lock` instead, which is a different question.
- **A shim's stdout is the JSON-RPC stream.** Both `mcp` paths write every human-readable line to
  stderr and never call `io.writeOut`; one stray line on stdout is a parse error inside the agent,
  with no message anyone will see. Same rule as the ready line, pointed the other way.
- **`connect` writes a command, never a credential, and proves there is a daemon first.** The entry
  is `connect/entry.ts`'s and neither writer composes its own: `xplainer mcp --attach`, or
  `npx -y @xplainer/cli mcp --attach` where the binary is not on `PATH`. No URL, no port and no
  token go into an agent's file
  ([ADR 0020](../../docs/adr/0020-always-running-local-daemon.md) §Security R-SEC-8), and the
  *reason* the port is read at all is the refusal: ADR 0020 §Ordering says `connect` "refuses to
  write an agent configuration pointing at a daemon that has never answered (`--force`
  overrides)", and `daemon.json`'s recorded port is that proof. Exit `3`, having written nothing.
- **The vendor's own writer is preferred on both verbs, and the direct writer is the fallback.**
  `claude mcp add` and `codex mcp add` both exist — the latter is
  `codex mcp add <NAME> -- <COMMAND>…`, checked against codex-cli 0.153.4 — and each is delegated
  to when that binary is on `PATH`, because a command that reimplements another program's file
  layout is a command that is one release behind for ever. `connect/vendor-cli.ts` is the one place
  either is spawned. Two cases still reach the direct writers: the machine with no such CLI
  installed, and `codex --config <path>`, which names a file `codex mcp add` has no flag to be
  aimed at (`-c key=value` overrides *values*). Delegating costs something and the cost is
  recorded rather than assumed: `codex mcp add` rewrites the `mcp_servers` subtree, so a comment
  attached to or inside an `[mcp_servers.*]` table does not survive it (0.153.4, measured), while
  comments elsewhere in `config.toml` do. `--config` is the way to a byte-preserving write.
- **Somebody else's configuration is edited, never reserialised.** `~/.claude.json` is Claude
  Code's whole per-user state and `~/.codex/config.toml` carries the user's comments and table
  order; a parse-and-write round trip through a JSON or TOML serialiser returns a file that means
  the same and looks nothing like theirs. So where this package writes, it writes narrowly: the
  Claude fallback sets one key of `mcpServers` and keeps every other key in that file, and the
  Codex fallback replaces exactly the lines of `[mcp_servers.xplainer]` and no others. Every write
  goes through `connect/atomic-write.ts`, temp-then-`rename`, keeping the mode the file already
  had. A declaration this line-oriented edit cannot safely replace — a dotted key, an inline
  parent, an array of tables — is **refused**, because appending beside it is a duplicate key and a
  `config.toml` with a duplicate key does not load at all.
- **Both verbs are re-runnable, and only one of them gets that for free.** Running `connect` again
  is the most ordinary thing a user does — after an upgrade, or after moving off `npx` — and it has
  to end in one entry saying what this version writes. `codex mcp add` updates the table it finds
  and exits `0` every time. `claude mcp add` does not: over a name its scope already holds it
  writes `already exists` and exits `1`, and `claude mcp` has no update verb (2.1.263 lists
  eleven verbs; `add-json`, the only other writer, refuses an existing name the same way). So that one refusal — matched on
  `already exists`, over a CLI that has *already said* the name is taken — is answered with
  `claude mcp remove <name> --scope <scope>` and a second add. Nothing is ever removed on any other
  failure, and because the pair is not atomic, a re-add that fails says the old entry is gone
  rather than claiming nothing was written.
- **The skew check happens before a session exists, and compares the contract.** `mcp --attach`
  reads `contract_version` from `GET /healthz` over the socket and applies
  `isContractCompatible()` from `@xplainer/protocol` — never `serverInfo.version`, which is the
  release, and never the `initialize` result, because "a check that requires the session it is
  gating is not a gate" ([ADR 0025](../../docs/adr/0025-daemon-updates-and-readiness.md) §Note,
  2026-09-06). An incompatible pair exits `8` naming both versions and a command that **exists
  today**; the release version in the same body is what makes that command
  `npm i -g @xplainer/cli@<the daemon's release>` rather than a phase-2 verb.
- **Exit codes are a documented table**, in
  [`docs/ARCHITECTURE.md` §6](../../docs/ARCHITECTURE.md#6-the-runtime) and in the ADR that owns
  each one. A new code is added to the table and to ADR 0020's successor — never invented at the
  call site; `daemon/exit-codes.ts` is the only place `serve` and `status` read them from.
  `NOT_IMPLEMENTED_EXIT_CODE = 2` keeps its meaning and its export site.
  What is used today: **`0`** a clean drain *or* a latched circuit breaker — the portable "do not
  restart" signal on all three supervisors — **`1`** a usage error such as a refused `--bind`, a
  `--url` that is not an endpoint or a `--scope` this command cannot write (`USAGE_EXIT_CODE`,
  which is also commander's own code for a rejected argument, so the two halves of the parser
  cannot disagree), **`3`** a precondition unmet with nothing written —
  `connect` with no daemon ever bound here, or an agent configuration file that cannot be
  understood — **`4`** installed but not healthy — `status`, and `mcp --attach` when nothing answers on the
  socket — **`8`** contract skew between the shim and the daemon
  ([ADR 0025](../../docs/adr/0025-daemon-updates-and-readiness.md) §Part two), **`10`** another
  process holds this machine's runtime — the state directory is owned, or the port is already
  in use — **`11`** a state file
  exists and cannot be read, **`12`** the token file exists and cannot be used, and **`70`**
  anything else. `EADDRINUSE` is deliberately `10` rather than `70`: a supervisor told `70`
  restarts a daemon whose port is held by something else, for ever.
- **`src/daemon/testing/` never ships.** `tsconfig.build.json` excludes it, so the fake worker, the
  spawned child entries and the TypeScript source hook are type-checked and linted but never
  compiled into `dist/` and never reach a tarball. Test scaffolding that a consumer could import is
  test scaffolding that becomes a supported surface.
- **The guard is unconditional, and it is mounted before any route.**
  `createServer()` takes it as a *parameter*, so the TCP listener carries it, the IPC listener
  carries none — filesystem permissions are that transport's authentication — and
  `services/media-service` carries its own at phase 3. Three rules inside it are not negotiable
  (ADR 0020 §Security): the `Host` allowlist is **exact string equality** against
  `{127.0.0.1, localhost, [::1]}:PORT` and never a parser, because `http://2130706433:8787` reaches
  loopback too; a widened bind **adds** its authority and removes nothing, because a validation that
  weakens when the bind widens is exactly CVE-2026-65105; and `/healthz` needs the token like
  everything else. `Authorization` is redacted at the logger (`redactAuthorization`), request bodies
  are never logged at all, and every rejection *is* logged with its reason and the offending value.
  The allowlist is built **after** bind, from the port the OS gave us, which is why `startServer()`
  takes a `GuardFactory` and `--port 0` keeps working.
- **The bearer token travels as a path, never as a value** (R-SEC-6): `XPLAINER_TOKEN_FILE` names a
  file, `/proc/<pid>/cmdline` is world-readable and `systemctl --user show` prints `Environment=`.
  `daemon/token.ts` is the only reader of that file; the guard is handed a string. And it is not a
  sandbox: same-uid code reads a `0600` file trivially. It buys the browser boundary and the other
  local user on a shared box, and nothing else — a token documented as more than that is worse than
  no token.
- **`SIGTERM` is six steps and ends in exit `0`** ([ADR 0024](../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md)
  §Drain on planned restart): stop accepting, give the running job **20 s**, `SIGTERM` then
  `SIGKILL` its whole process group, mark anything still `running` *or* `queued` as `error` with
  `error_code: "daemon_shutdown"`, remove `runtime.json` and the socket, exit `0`. Twenty seconds
  plus teardown fits inside P1-7's 25-second budget, and the listeners close *after* the drain so a
  client polling `explainer_job` about the job being drained still gets its answer. A second signal
  mid-drain is ignored, not obeyed.
- **The ready line is the whole of stdout.** One JSON object, once, after ownership, reconciliation
  and the binds ([ADR 0025](../../docs/adr/0025-daemon-updates-and-readiness.md) §Part three).
  Everything else `serve` says goes to **stderr**, and the line must never move behind a `--quiet`
  flag or a log-level filter: it is the contract with whatever spawned the daemon. Adding a second
  kind of stdout line means adding an `event` value, never a bare line.
- **`serverInfo.version` is the release version, not the contract version.** `src/server.ts` passes
  `CLI_VERSION` into `createMcpServer`, so do not read the handshake as a contract advertisement.
  The explicit one is **`contract_version` in the `/healthz` body**, from
  `@xplainer/protocol`'s `MCP_CONTRACT_VERSION` — settled by spike P1-S3
  ([ADR 0025](../../docs/adr/0025-daemon-updates-and-readiness.md) §Note, 2026-09-06). The two
  numbers sit side by side in that one body on purpose, and `/healthz` rather than the
  `initialize` result because the shim must decide before it opens a session. Compare it with
  `isContractCompatible()` from the same package; the predicate is major-compatible, and exit
  `8` is what an incompatible pair gets.
- **Nothing downloads at install.** No `postinstall` fetches a browser, a model or a binary
  (`AC-1d`); `xplainer setup` does that, deliberately and visibly
  ([ADR 0005](../../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)).
- **`isolatedDeclarations` is on `tsconfig.build.json`**, so `TS9010` surfaces under
  `pnpm turbo build` — not under `typecheck`, and not in your editor.
- **`spikes/` is measurement, not product.** `spikes/p1-s1-ownership.mjs` settles
  [ADR 0024](../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md)'s four proposed
  mechanisms and is quoted by the dated note at the end of that record. It is plain Node with no
  dependencies, and it is outside the build by construction: both `tsconfig.json` and
  `tsconfig.build.json` `include` only `src`, and `package.json`'s `files` allowlist is `dist/`
  plus `LICENSE` and `NOTICE`, so nothing here compiles and nothing here ships. It **is** linted —
  this package's `lint` is `biome check .` from the package root, which reaches it — and it is a
  check rather than a report: `node spikes/p1-s1-ownership.mjs` exits non-zero if an expectation
  the ADR note quotes stops holding. Add a spike here when a record names one; do not add product
  code here.

## How to add

**A command:** add the module under `src/commands/` (one concept per file, kebab-case), register it
in `src/program.ts`, and — until it does something — register it as a stub that names itself and
exits `NOT_IMPLEMENTED_EXIT_CODE`. Update the `toEqual` surface assertion in the same commit.

**A route:** add it in `src/server.ts` and test it against a started server, not against the app
object alone. Both listeners get it: the guard is mounted before every route, so a route that must
*not* be reachable without the token needs saying so in words, not in a second application.

**Anything under `src/mcp/`:** it is an agent-facing entry, so the first question is which of stdout
and stderr it may write to — the answer is stderr, always. The in-process server takes a session
directory and gives it back; the shim decides *before* it proxies and refuses with a documented exit
code. Neither one may grow a tool list, a schema or a refusal of its own: those live in
`@xplainer/mcp-server` and `src/backend.ts`, and a shim that knows what a tool is has become a
second implementation of the contract.

**A daemon module:** add it under `src/daemon/` as one named concept per file with a colocated
`*.test.ts`, and give it the state directory as an argument rather than reading the environment —
`state-dir.ts` is the only module that knows where state lives. If the behaviour is only true of a
real process — a `SIGKILL`, a second `serve`, a `SIGTERM` drain, an orphaned worker, a ready line
read from a pipe — spawn a child with `testing/spawn-child.ts`, which runs this package's *sources*
through `testing/ts-source-hook.ts`; do not spawn `dist/`, because `turbo.json` gives `test` no
dependency on this package's own build. Start-up ordering cases go in `daemon/start.test.ts`; cases
about the process a supervisor runs — the token, the refusals, the ready line, the drain — go in
`commands/serve.test.ts`. **Never stub what a test is about**: there is no `vi.mock` anywhere in
this package, and a guard, a probe or a drain asserted against a double asserts nothing.

**A worker for a job kind:** add a `WorkerFactory` to `daemon/workers.ts`, which is the registry
`startDaemon()` registers; a caller may still substitute its own, and only the drain tests do. A
kind with no worker is not a crash and not a silent success: the job reaches `error` with
`error_code: "internal"` and a sentence naming the kind, because an agent holding a `job_id` must
always be able to poll it to a conclusion. If the worker needs arguments, add them to `JobRequest`
in `job-request.ts` — the record has nowhere to put them.

**A tool, or a refusal inside one:** it goes in `src/backend.ts`, and the refusal carries a
`LocalBackendCode` and a sentence naming the call that fixes it. Every argument arrives unvalidated
(the published input schema is an open object), so validate at the disk boundary and pin any pattern
you re-state to `packages/protocol/schemas/` from `backend.test.ts` rather than trusting the copy.

**Anything that renders:** assert it against the rendered file. `src/workers/render.test.ts` runs
the whole path — create, narrate, still, render — and reads the MP4 back with `ffprobe` and
`ffmpeg`, because a silent, mistimed or 300-frame placeholder render looks like success from inside
Node. It is skipped only by `XPLAINER_SKIP_RENDER_TEST=1`, which CI does not set. Speech comes from
`XPLAINER_TTS_FIXTURE`, a recorded WAV and its word spans; the narration port itself is never
substituted.

**An agent for `connect` to write:** add a module under `src/connect/` and a verb to the group in
`src/commands/connect.ts`, and update the group's `toEqual` listing in `program.test.ts` in the same
commit. Two rules are not negotiable: the entry comes from `connect/entry.ts` — a verb that composes
its own command line is a second place for a token to appear — and the vendor's own writer is
preferred to a file format reimplemented here, with a direct write only for the scope that vendor
documents. Test it as a real spawned `xplainer connect` with a temporary `HOME` and a temporary
`PATH`, assert against the file on disk, and read that file back with a parser that is **not** the
one that wrote it.

**An export:** add it to `src/index.ts` explicitly, run `pnpm api:report`, commit the `.api.md`.

Finish with `pnpm verify`.
