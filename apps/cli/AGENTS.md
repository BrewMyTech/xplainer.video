# AGENTS.md — `@xplainer/cli`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

**The local runtime.** The `xplainer` binary, the Hono application it serves — `GET /healthz`, the
Streamable HTTP MCP endpoint at `/mcp`, and the `/api/*` REST and SSE surface a GUI client reads
(`src/api/`) — the **eight tools** behind that endpoint
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
| `worker-identity.ts` | The identity triple (pid, start token, machine boot id), the probe each platform needs for it — `/proc/<pid>/stat` on Linux, `ps -o lstart=` on macOS, one CIM query on Windows — and the four verdicts over it |
| `lock.ts` | `owner.lock`: `O_EXCL` create, staleness by the tuple, takeover confirmed by read-back |
| `job-store.ts` | One JSON file per job, the bounded log tail, corrupt quarantine, newer-format detection |
| `reconciler.ts` | Boot reconciliation: terminal records, worker teardown, `workers_uncertain`, output quarantine |
| `process-group.ts` | `SIGTERM` then `SIGKILL` to a worker's whole process group, and the Windows Job Object that stands in for one |
| `runner.ts` | `enqueue` / `get` / `tail` / `cancel` / `drain` over a serial queue of child-process workers |
| `daemon-state.ts` | `daemon.json` and `runtime.json`, the breaker over each run's own recorded outcome, and the installer's own fields |
| `start.ts` | The ordering: ownership → reconciliation → the runner, handed to `commands/serve.ts` to bind |
| `workers.ts` | The registry `start.ts` registers: one `WorkerSpec` per job kind, and the last gate before Chrome |
| `token.ts` | The bearer token file: `XPLAINER_TOKEN_FILE` or the default, `O_EXCL` mint, `0600`, whose token it is, R-SEC-8's rotation and the ring the guard asks |
| `windows-acl.ts` | The `icacls` entry a Windows file gets at creation, and the query `daemon status` re-verifies it with |
| `pipe-acl.ts` | The security descriptor the Windows named pipe gets after its bind, granting the creating account and nobody else |
| `guard.ts` | The four layers every TCP request passes: `Host`, `Origin`, the token, the redacted log |
| `ipc.ts` | The socket path and `--socket`, its `0700` directory, the stale socket a `SIGKILL` left, the Windows pipe |
| `binding.ts` | Which addresses `--bind` may take, and the port precedence — two pure functions, no I/O |
| `tls.ts` | R-SEC-9's other three preconditions: the operator's certificate pair, the `--allow-host` allowlist, and a token this daemon did not mint |
| `ready.ts` | The one JSON line on stdout, and the wait a parent does instead of sleeping |
| `shutdown.ts` | `SIGTERM`/`SIGINT` → drain → close the listeners → remove `runtime.json` → exit `0` |
| `exit-codes.ts` | The start-up codes, quoting the table in `docs/ARCHITECTURE.md` §6 |
| `testing/` | The fake worker, the child entries the tests spawn, the spawn harness, the source hook, `identity-cost.ts` (what one identity probe costs on the machine it runs on — a measurement, never a gate), and `platform.ts`: the facts a suite has to read differently on Windows |

The state directory — `${XDG_STATE_HOME:-~/.local/state}/xplainer/` on Linux,
`~/Library/Application Support/video.xplainer/` on macOS, `%LOCALAPPDATA%\xplainer\state\` on
Windows, or `XPLAINER_STATE_DIR` — holds:

```
owner.lock          the ownership artefact: pid, start token, boot id, nonce (0600)
token               DURABLE. 32 random bytes, base64url, 0600 — or wherever XPLAINER_TOKEN_FILE says
token.previous      DURABLE while a rotation's grace window is open: the retired value and the
                    instant it stops being accepted, at the same 0600 and behind the same Windows
                    entry. Written by `xplainer token rotate`, ignored once expired, removed by the
                    next start, by the next rotation and by `daemon uninstall`
toolchain.json      DURABLE. what `setup` acquired: the Chrome and speech versions, resolved paths,
                    sha256 and provider, and the workspace payload's platform and version. A
                    checked contract (`packages/protocol/schemas/toolchain.json`), because `setup`
                    writes it and the install preflight and `daemon update` both read it
daemon.json         DURABLE. serve writes port, contract_version, token_file, token_origin,
                    socket_path, directory_flush, recentStarts[], stalled; `token rotate` writes
                    token_rotation (two timestamps and a path, never a value); install writes
                    supervisor_kind,
                    supervisor_artefact, runtime_dir, launch_spec, program_source,
                    linger_enabled_by_us, launchd_enable_record_created, log_sink,
                    installed_version
runtime.json        EPHEMERAL. this run's pid, run id, boot id, bound port, addresses, socket
ipc/xplainer.sock   EPHEMERAL. the IPC listener, in a 0700 directory; unlinked on clean shutdown.
                    `serve --socket` moves it, and the 0700 rule follows the path
jobs/job-000001.json   one record per job, temp-then-rename, with a bounded log tail
jobs/corrupt/          records that could not be parsed, moved aside rather than deleted
mcp/session-XXXXXX/    one `xplainer mcp` stdio session's private job store, removed when it ends
runtime/<version>-<digest>/   one staged payload-1 artefact per content, materialised by
                    temp dir → rename so a half-copied runtime is never visible under its own name
bin/xplainer[.cmd]  the generated two-line launcher: the one path a consumer may hold across an
                    update, rewritten by the update transaction as another temp → rename
```

**The two files have opposite lifetimes and that is the whole point** (ADR 0020 §Port and
discovery): `daemon.json` must survive a reboot, `runtime.json` is written at bind and is never
trusted without a liveness check. `recentStarts[]` and `stalled` are in the **durable** one —
ADR 0020 first put them in `runtime.json`, and its own dated note records why that was wrong, since
on Linux `runtime.json` lives in systemd's `RuntimeDirectory=` and is deleted on every clean stop.
`socket_path` is durable for the same reason and `runtime.json`'s `socket` is not a duplicate of it:
one is the path a consumer needs while the daemon is **down**, the other is what this run bound.

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
| `workers/speech.ts` | Where the speech comes from: `XPLAINER_TTS_FIXTURE`, else a server somebody named, else the in-process ONNX engine, else the tts-client's own default |

### `src/speech/` — speech in this process, with no server and no Python

The third implementation of the `SpeechSynthesiser` port `resolveSpeech()` returns, beside the HTTP
`KokoroClient` and the fixture reader (`.omc/plans/ralplan-speech-onnx.md`). Kokoro-82M runs inside
the narration worker on an ONNX Runtime `setup` acquired, with `@xplainer/render-core`'s G2P in
front of it, so a machine narrates with **no Docker, no `--tts-url` and no Python** — and word
timings come from the model's own per-token duration predictor rather than from an alignment
estimate.

| Module | What it owns |
|---|---|
| `synthesiser.ts` | The port implementation: text → phonemes → tokens → audio and word spans |
| `timing.ts` | D6 — the duration→seconds conversion, derived per run, and the refusals over it |
| `tokens.ts` | IPA → token ids with the character offset each came from |
| `voice.ts` | The voice pack, and which of its 510 style rows speaks a given sentence |
| `runtime.ts` | The ONNX Runtime as an acquired path (D7), and the four members used of it |
| `locate.ts` | Where the three artefacts are, as a seam `setup`'s `toolchain.json` reader fills |
| `errors.ts` | `OnnxSpeechError`: a refusal rather than audio nobody can tell is wrong |

**It may never move into `@xplainer/tts-client`.** `@xplainer/render-core` depends on that package
for the wire types, so a synthesiser there that imported `phonemise()` would close a cycle. This app
is downstream of both, which is why the one implementation needing them together lives here.

**The duration→seconds conversion is derived per run and may never be written down.** The published
figure for this model is `duration / 80`; the spike measured a divisor of ≈40, and the ratio then
moves by 79% across the speaking-rate range the port accepts — 583 samples per unit at speed 0.8,
1042 at speed 4. So `timing.ts` computes `waveform.length / Σ durations` from the run that produced
the audio, which makes the timings agree with the audio whatever the unit means. A constant here
would be a silent, systematic drift in every caption and every scene boundary.

**The style vector is row `tokenCount - 1` of the voice pack, never the first 256 floats.** A pack
is 510 rows of 256 float32 and the row carries the prosody of an utterance of that length. Against
the reference implementation speaking the same phoneme string, row 0 — what the S0b prototype used —
is 17.1% off on length and 30.6% off at worst, speaking a 112-token sentence in 4.83 s where the
reference takes 6.95 s. Fluent, self-consistent and wrong; `voice.ts` carries the table.

**A clip is returned untrimmed, and that is a known divergence from the server route rather than an
oversight.** Kokoro-FastAPI trims; this does not, so the same sentence comes back **8–13% longer** —
≈0.32–0.49 s of near-silence before the first phoneme and ≈0.19 s after the last. Do not add a trim
here: the head is a noise floor below −66 dBFS rather than digital silence, the first phoneme's onset
begins *before* the boundary the duration predictor implies, and a threshold set slightly wrong clips
the start of the first word — unrecoverable, where untidy padding is not. Pacing is
`render-core`'s `LEAD_IN_MS` / `GAP_MS` / `TAIL_MS`, which apply to every engine.
**The padding does not shift the word timings**, which is what makes leaving it in safe: they are
absolute offsets into the clip as delivered, and the first word's `start_time` lands 13–41 ms
(mean 29 ms) after the audible onset — under a frame and a half at 30 fps, and the predictor's own
alignment rather than an arithmetic error. `synthesiser.ts`'s docblock carries the measurements.

**Every path arrives as an argument.** The model, the voice pack and the runtime location are
options; this directory discovers nothing, reads no marker and resolves no default path. Acquisition
is `src/setup/`'s and route selection is `workers/speech.ts`'s.

### `src/api/` — the client surface a GUI talks to, and what it may never become

[ADR 0016](../../docs/adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md) promises
"REST + SSE at `/api/*` for GUI clients" beside `/mcp`, and this directory is it. Every route is a
**relay to the same `RenderBackend`** `/mcp` dispatches through — there is no second implementation
of a tool here — plus one filesystem seam for the artefacts the tool contract deliberately does not
describe. `apps/desktop` depends on this package and imports the shapes and the path builders from
`src/index.ts`, so the daemon and the window cannot disagree about a URL.

| Method | Path | Answers |
|---|---|---|
| `GET` | `/api/videos` | `{ videos: ApiVideo[] }` — the library, each entry with its artefacts |
| `GET` | `/api/videos/:slug` | one `ApiVideo`; `404 NO_SUCH_VIDEO`, `400 INVALID_SLUG` |
| `GET`/`HEAD` | `/api/videos/:slug/artefacts/:name` | the bytes, `Accept-Ranges: bytes`, `206` for a `Range`, `416` outside it, `Cache-Control: no-store` |
| `POST` | `/api/videos/:slug/narrate` | `202` + `ApiJobQueued` — body is the tool's input minus the slug |
| `POST` | `/api/videos/:slug/still` | `202` + `ApiJobQueued` — `{ frame, scale }` optional |
| `POST` | `/api/videos/:slug/render` | `202` + `ApiJobQueued` — no arguments |
| `GET` | `/api/jobs/:id` | `ExplainerJobOutput`, **unchanged** — what `explainer_job` answers |
| `GET` | `/api/jobs/:id/events` | `text/event-stream`: `job` frames carrying that same document, one `end` frame, then closed |
| `POST` | `/api/daemon/drain` | T13's control route, in `server.ts`, over the socket **only** |

`ApiVideo` carries `slug`, `has_narration`, `rendered`, `seconds`, `size_mb` and `artefacts`; the
two numbers are `null` rather than absent, so a client never has to tell "this video has no
narration" from "this daemon is too old to say". It does **not** carry `ExplainerListOutput`'s
`mp4`: that is a path on the machine that answered, and a player needs a URL. An `ApiArtefact` is
one of five kinds — `video`, `still`, `narration`, `captions`, `timings` — with the `url` that
serves it. Every refusal is `{ error: { code, message } }`, `code` being the backend's own refusal
code (`NO_SUCH_VIDEO`, `NARRATION_MISSING`, `WORKSPACE_NOT_INSTALLED`, …) or one of this surface's
**seven** (`INVALID_JOB_ID`, `NO_SUCH_JOB`, `NO_SUCH_ARTEFACT`, `INVALID_BODY`, `SHUTTING_DOWN`,
`RANGE_NOT_SATISFIABLE`, `BACKEND_FAILED`). `BACKEND_FAILED` is the last of them and the one a
client cannot branch on usefully: it is what a backend rejection that named nothing becomes.

| Module | What it owns |
|---|---|
| `api/routes.ts` | The assembly and `ApiSeam`; the surface exists only when `createServer()` is given one |
| `api/paths.ts` | Every path, built once and exported, so the desktop and the router agree |
| `api/videos.ts` | `VideoLibrary` and the workspace implementation of it, the slug check, the two library routes |
| `api/media.ts` | `Range` (RFC 9110 §14) and the artefact bytes |
| `api/jobs.ts` | One job read, and the three enqueueing `POST`s |
| `api/events.ts` | The SSE stream: poll, write on change, keep-alive comment, `end`, close |
| `api/errors.ts` | Rejection → status, and the three error names it matches by |

**Three rules, and they are the reason to read the directory before changing it.**

- **The guard is never per route.** These routes are registered *after* the `*` middleware
  `createServer()` mounts, so the bearer token, the `Host` allowlist and the `Origin` check cover
  them by construction on TCP, and the IPC listener passes none. A route that authenticated itself
  would be a route that can forget to (ADR 0020 §R-SEC-2), and `api/routes.test.ts` asserts a `401`
  for **every** path in the table above.
- **No CORS middleware, ever, for any value** (R-SEC-7). See the invariant below.
- **`src/daemon/` is not imported from here.** `errors.ts` matches `JobNotFoundError` and
  `NotAcceptingJobsError` by `name` rather than by `instanceof`, because `server.ts` is the
  application `services/media-service` binds and a value import would put the job store, the
  process-group keeper and the identity probe into its module graph. `api/errors.test.ts`
  constructs the real classes and pins the names.

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
`<state>/bin/xplainer mcp --attach` where an install wrote that launcher, else `xplainer mcp
--attach` if the binary is on `PATH`, else `npx -y @xplainer/cli mcp --attach` — into the agent's own
configuration, and nothing else goes in it: no URL, no port and no token, because the transport is
the daemon's unix socket and filesystem permissions are its authentication
([ADR 0020](../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not TCP).
The launcher comes first because a runtime-directory install puts nothing on `PATH`, so without it
an installed machine wrote the `npx` form and pointed an agent at a package this phase does not
publish. **`--spawn` writes the other entry** — `mcp` without `--attach`, the tools inside the
agent's session — and it is the one form that bypasses the daemon check, because it is what ADR 0020
prints when there is no daemon and no supervisor to arrange one.

| Module | What it owns |
|---|---|
| `entry.ts` | The command line itself: the stable launcher, the real `PATH` lookup, and `npx` — in that order |
| `spawn.ts` | `--spawn`'s entry: `mcp` without `--attach`, and the staged runtime as one more fallback |
| `preflight.ts` | The check before any write: `daemon.json`'s recorded port, or a refusal and exit `3` |
| `claude.ts` | `claude mcp add` when that CLI is on `PATH` — remove-then-add over a name it already holds — else `~/.claude.json`'s `mcpServers` |
| `codex.ts` | `codex mcp add` when that CLI is on `PATH`, else the `[mcp_servers.xplainer]` table in `~/.codex/config.toml`, edited in place |
| `vendor-cli.ts` | The one spawn of somebody else's CLI: resolved path, closed stdin, both streams captured |
| `toml-tables.ts` | Where that table starts and ends, and the declarations it refuses to duplicate |
| `atomic-write.ts` | temp → `rename` over somebody else's file, keeping the mode that file had |
| `refusal.ts` | `ConnectRefusal`: one sentence and one exit code from the documented table |

### `src/install/` — where the program comes from, and the one name that survives an update

`src/runtime/` builds a relocatable payload; this directory is what happens to one afterwards. The
phase-2 default install has nothing published to fetch, so the program is a **payload-1 artefact
staged under the state directory**, and because that directory is named `<version>-<digest>` no
consumer may hold its path — which is what the launcher is for.

| Module | What it owns |
|---|---|
| `program.ts` | The four ordered sources — `explicit`, `sea-binary`, `package-manager`, `runtime-dir` — and the interpreter and entry each one resolves to |
| `stage.ts` | `<state>/runtime/<version>-<digest>/`: the content-addressed name, the sibling temp dir, the one `rename`, and what is staged already |
| `launcher.ts` | `<state>/bin/xplainer[.cmd]`: the generated two-line script, and its rewrite as one more small-file temp → rename |
| `preflight.ts` | Every question an install asks before it writes: the setup marker, the supervisor, the program, the port, lingering, the disable record, the token file |
| `supervisors/` | The three artefact renderers — the systemd unit, the LaunchAgent plist, the Task Scheduler document — behind one `SupervisorAdapter`, plus `identity.ts`: the three-row consistency check |
| `testing/` | A real, small payload-1 artefact whose entry is a miniature daemon, so a launch can be proved by launching |

Two of the four sources **refuse** this phase, by name: `sea-binary` is phase 4 and
`package-manager` is what a publish adds. They are branches rather than absences because falling
through to the default would record `runtime-dir` in the one field whose job is to say where the
program came from. The launcher is the path `connect` writes, the desktop shells out to and
`attach.ts` names in its skew message; nothing else is allowed to hold a version-scoped directory —
with one stated exception, `connect --spawn` on a machine where the install was *refused* and so
wrote no launcher.

**The preflight is read-only, and that is the property to preserve when adding to it.** ADR 0020's
rule for every degraded path is "probe before writing; on refusal, write nothing, exit with the
documented code, and print the one command that fixes it", and `preflight.ts` is the probing half in
full: it reads `test -e /var/lib/systemd/linger/$USER` and **never** attempts
`loginctl enable-linger`, because creating that marker is a write inside the phase that must not
make one. The three commands it runs — `systemctl --user is-system-running`,
`launchctl print-disabled gui/<uid>`, `schtasks /Query` — are queries, and a command that cannot
start is an answer rather than an error. systemd is detected by `/run/systemd/system`, which is what
`sd_booted(3)` checks, and never by `command -v systemctl`, which reports a supervisor on exactly
the Debian container that has none. Its refusals carry codes from the table and invent none: `3` for
the setup marker and for a program that will not execute, `6` for no user manager and for a Task
Scheduler that refuses a query, `7` for a held port. The two `5`s — lingering denied, no batch-logon
right — are the writing phase's, because neither can be established without attempting it.

**`supervisors/identity.ts` compares three rows, and the third one is advertised rather than
read.** *Desired* is `daemon.json`'s launch spec, *loaded* is what the supervisor is actually
holding, and *responding* is the `run_id` and `runtime_digest` the answering daemon puts in
`/healthz`. Two rows cannot see the failure the check exists for: an artefact rewritten and never
reloaded leaves the old definition running while every file this project owns says otherwise, and
reading our own file back reports success. Measured on systemd 252 — `systemctl show` keeps
answering from the manager's cached unit until `daemon-reload`, which is what makes row 2 worth
asking for and why it is asked of the **manager** and not of the file. Row 3 is a snapshot
`daemon/start.ts` freezes after ownership and before the binds, over the effective argv, the
resolved settings, the working directory and the payload's content hash, and **never** from
`daemon.json` — a digest read out of the record would agree with the record, which on macOS (where
there is no row 2 at all) would leave nothing to detect a failed switch with. `daemon status` names
which detector fired. Nothing here writes; `pnpm e2e:identity` is the real-supervisor proof.

**The three renderers are pure, and every setting they emit travels in the argv.** Each takes a
`LaunchSpec` and answers with a path, a mode, the name its own supervisor addresses the daemon by,
and the exact bytes — nothing under `supervisors/` writes a file, which is what makes all three
platforms verifiable on one machine. `Environment=` and `EnvironmentVariables` are kept for the
state directory and the token file so a reader of a unit or a plist still sees them, but they are
never the only emission: `<Exec>` has no environment map and **`--socket` has no variable at all**,
so `ExecStart=`, `ProgramArguments` and `<Arguments>` carry `LaunchSpec.argv` verbatim and the
renderers refuse a contract whose argv lost a flag its `settings` still name. The values are fixed
by measurement rather than preference — `Type=exec` with no `NotifyAccess=` (ADR 0025's 2026-09-08
note), `KillMode=mixed` with `TimeoutStopSec=45s`, and `ExitTimeOut=45` as its macOS counterpart
(ADR 0024's) — and the golden tests assert the whole file, not a key at a time.

### `src/setup/` — what the toolchain is allowed to be, and how it arrives

[ADR 0005](../../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md) books "a CDN
and a version/checksum manifest" as infrastructure and requires that "the download path has to
verify the checksum before extracting". This directory is that manifest, that download, and the
archive reader between them.

| Module | What it owns |
|---|---|
| `manifest.ts` | The manifest's address, its shape, and the mirror of the pinned Remotion line's own Chrome URL selector |
| `source.ts` | Which of the three manifest sources answered — `--manifest`, the published address, this checkout's committed copy |
| `download.ts` | `HEAD`, `Range` resume, streaming SHA-256, the named refusals, the archive-format seam, the staging-then-`rename` commit, and `acquireFile` for an artefact that is not an archive |
| `archive.ts` | The zip reader: central directory, stored and deflate, per-entry CRC-32, modes, symlinks, and every unsafe entry refused |
| `tar.ts` | The gzipped-tarball reader: streamed, ustar only, header checksums, and a **selector** so a package carrying five platforms lands one |
| `acquired.ts` | The record a committed acquisition carries inside itself, and the check a warm cache passes |
| `providers/chrome.ts` | The headless shell the pinned selector names, admitted on the manifest's **expected** digest |
| `providers/speech.ts` | The four speech routes, their precedence, and the refusal that names all four |
| `providers/speech-docker.ts` | The pinned Kokoro image, pulled by digest and never started; the receipt the marker records |
| `providers/speech-onnx.ts` | The in-process route: the Kokoro model, one voice and this platform's ONNX Runtime, each pinned by digest and each from its own upstream home |
| `providers/speech-bundle.ts` | The manifest's own archive for this platform, verified by `sha256` |
| `providers/workspace.ts` | Payload 2's two routes, and D8's install invocation with `path.delimiter` |
| `toolchain.ts` | `toolchain.json` — the writer, the validating reader, and the gate the daemon applies |
| `toolchain.manifest.json` | The reviewed document itself — per-platform expected digests, captured at manifest-build time |
| `testing/` | The loopback artefact server with one route per failure, the writers for archives no archiver produces, the four ONNX artefacts served from loopback, and a real marker for the suites downstream |

**`setup` acquires the components you name, and the rule is a union.** Positive flags restrict the
run to themselves; `--skip-*` flags trim the default; both together give the union. So
`setup --workspace` is the workspace and nothing else — the form the D8 proof runs under a scrubbed
`PATH`, which must not drag a browser download or a Docker pull in behind it — while
`setup --skip-speech` is the browser and the workspace, which is the only form Windows has this
phase. A partial run **exits `0`** and names what is still to acquire: `toolchain.json` records all
three components or it is not a valid document, so an incomplete run merges into what the last one
recorded and writes nothing until the set is complete.

**`<runtime>/bin` goes on the install subprocess's `PATH` and on nothing else (D8), composed with
`path.delimiter`.** npm runs lifecycle scripts through `sh -c` and third-party scripts call bare
`node` — `esbuild`'s `postinstall`, reached through the Remotion tree's 268 packages — so an install
from a payload under a scrubbed `PATH` exits `127` and leaves no workspace at all. This does **not**
reopen D1: D1 refused `PATH` injection for *render workers* because it leaks an interpreter onto the
`PATH` of everything they spawn, Chrome and ffmpeg included, and the installer spawns neither.
`npm ci`, never `npm install`, and never `--ignore-scripts` — which also exits `0` today and makes
the workspace's completeness depend on no package in that tree ever needing its install script.

**The daemon never starts a speech container.** `setup` pulls the pinned image, the user or the
supervisor runs it, and the daemon reports its absence with the command that starts it
(`speechContainerCommand()`). What `toolchain.json` records for that route is a **receipt** — a
pulled image is not a path, and the marker's `path` is checked for existence by the install
preflight — so `setup` re-asks `docker image inspect` on every run rather than trusting the file it
wrote.

**The gate is the one that owns a provider's lifetime, and it is not the daemon.** `setup` pulls;
`scripts/e2e/toolchain.mjs` then needs something to narrate *against* for its one live step, and its
precedence is written down rather than improvised: `XPLAINER_TTS_URL` if an operator or a workflow
`services:` block already provides one, else a container the gate starts **from the digest in the
receipt `setup` wrote** on a port the OS chose and stops in a `finally`, else the narration leg is
skipped with its reason printed. Owning a container for the length of one gate run is not the daemon
owning one. On Windows the third branch is the only one there is (§2.5, P2-4), and the render half
still runs — from `XPLAINER_TTS_FIXTURE`, after the browser-and-workspace-only
`setup --skip-speech --workspace` — so the skip is a skip and never a pass.

**`setup/testing/rollback-render.ts` is T16's sixth assertion, and it lives here because only this
batch has a browser.** B5's boundary suite and its failure proof end every rollback with *readiness*
— the installed workspace satisfies the pins of the runtime that came back — and a daemon that
answers `/healthz` and cannot render is the failure class the precondition exists for. So this entry
reruns every case that ends in a rollback (the five durable boundaries and the replacement that never
becomes ready), against a payload the shipped assembler produced, the workspace `setup` materialised
and the browser it acquired, and asserts a **PNG** out of the daemon each recovery put back. It is
`pnpm e2e:toolchain`'s last phase and is spawned by it; it is never part of `pnpm verify`.

**The manifest is fetched from `cdn.<zone_name>` and never from `r2.dev`.** `infra/terraform`
provisions exactly one hostname — `main.tf`'s `local.cdn_hostname`, a **proxied** CNAME onto the
bucket — and its own comment gives the reason: the bucket's `r2.dev` URL "is explicitly not cached
by Cloudflare, so serving a ~110 MB CLI binary or a several-hundred-megabyte voice pack from it
would pay origin egress on every single download". `toolchainManifestUrl()` refuses an `r2.dev`
zone rather than trusting nobody will type one, and a **speech** entry served from any other host
is refused when the manifest is parsed. Chrome's host is not checked that way, deliberately: its
URL is chosen by the selector, not by the document.

**Nothing is published to that hostname in this phase, and the refusal says so.** `terraform`
creates the bucket and the record; connecting the bucket to the custom domain and adding its Cache
Rule are manual steps it deliberately does not manage, neither is scheduled here, and no command in
this repository uploads a manifest — so the published address answers nothing usable, deliberately.
`deliveryPosition()` is the paragraph `ManifestUnreachable` carries, and it is now **one message for
every platform**: three of the four speech routes read no manifest at all (`--tts-url`, the `docker`
image pinned by digest, and the in-process `onnx` route), only `bundle` does, and what genuinely is
waiting on the address is the **browser's** expected digest. It used to carry a second, harder
paragraph for Windows — no working speech route at all, phase 4 as the milestone — and the `onnx`
route is what removed it: `win32-x64` and `win32-arm64` are both in `onnxruntime-node`'s published
set, so the asymmetry P2-4 recorded has gone rather than merely become unreachable, and a sentence
saying Windows has no speech would now be the most confidently wrong line in the product.
`infra/README.md` §*The delivery position, phase 2* is where the infrastructure half is recorded.
**`.github/workflows/e2e-toolchain.yml`'s `windows-delivery-position` job still greps the retired
sentence** and has to be updated with whatever replaces it; it is `workflow_dispatch` only, so
nothing in `pnpm verify` or in CI sees it first.

**The expected digest is selected by the resolved URL, never by `<os>-<arch>`.**
`@remotion/renderer`'s `getChromeDownloadUrl` branches on Amazon Linux 2023, on `chromeMode` and on
whether the host's glibc is at least 2.35, so one platform resolves to several different artefacts
— and ADR 0020's "Alpine is blocked on rendering, not on init" is what a key ignoring the C library
buys you. `manifest.ts` therefore **mirrors** that function, `manifest.test.ts` drives the real one
over all 80 branch combinations and compares — putting the two predicates it stands in for **back**
after each row, because the last case in that file asks this machine's own question of the
unpatched module and a leaked stand-in made it disagree with the mirror on every glibc-2.35-or-newer
linux-x64 host — and `selectChromeArtefact()` looks the URL up. Two
consequences worth keeping: the manifest **cannot redirect a download**, because the URL fetched is
the selector's rather than the document's; and a configuration with no recorded entry is a refusal
naming the URL, never a download of unreviewed bytes.

**Digests are expected, never recorded.** Nothing here writes a manifest, and no path takes a digest
from the bytes that arrived — `sha256` is a required input to the download. A digest recorded on
first acquisition cannot reject an incorrect-but-intact archive; it only detects later drift.

**Verify, then extract, then commit — in that order.** The archive is checked against its expected
digest, unpacked into a staging directory **beside** the destination, and committed with one
`rename`, the same argument `install/stage.ts` makes for a payload. A digest checked after unpacking
would already have written a hundred megabytes of somebody else's archive where a render will look.

**Every failure is named, and the names are the ones ADR 0005 asks for**: `short-body` (resumable,
the partial is kept), `checksum-mismatch` (the partial is deleted, so a wrong body is never resumed
onto), `resume-not-honoured` (a `206` for a range nobody asked for — appending it would produce a
right-length, wrong-content file), and `proxy-interception` (a `407`, an HTML filter page quoted
back, or a TLS handshake that never reached the origin). That last one **is** the acceptance
condition: "a download that fails behind a corporate proxy must say so, not produce a render that
fails later with a missing-binary error."

**It speaks `node:http`, and that is a measurement rather than a preference.** On Node 24 a `407`
never reaches a `fetch` caller — undici turns it into a network error whose `cause` is an empty
`Error` with no `code` — so the proxy branch would be unreachable code. The artefact URLs also
redirect (the arm64 Linux build's CDN answers `307`), and the redirect policy is a pure function so
the https-downgrade refusal is asserted rather than assumed.

**Both archive readers are written here rather than depended on.** A new *runtime* dependency of
this package is a change to payload 1, to the publish contract and to every installer, which is a
large blast radius for two fully specified formats. The zip reader reads the central directory,
never the local headers, and it refuses an entry that climbs out of the destination before anything
is written. The tar reader **streams** — `gunzipSync` on `onnxruntime-node`'s tarball would hold
111 MB compressed and 296 MB decompressed in two live Buffers — refuses every member type but a file
and a directory (a pinned archive cannot contain one this build has not seen), checks each header's
own checksum because that is the one way a streaming parser can go wrong, and shares `safeJoin` with
the zip reader because that rule is the same rule. What a tar cannot promise is what a central
directory buys: with no index, a member is judged before **that member** is opened rather than before
the first one, and the staging-then-`rename` commit is what still makes a refusal commit nothing.

**The ONNX runtime is acquired, not depended on, and the reason is measured** (D7,
`providers/speech-onnx.ts`'s docblock carries the whole argument). `onnxruntime-node` declares no
`optionalDependencies` and carries **five** platforms in one package — 296,273,872 bytes unpacked —
so depending on it would put every one of them into payload 1's closure; and its `postinstall`
fetches a **191,730,792-byte** CUDA package from `api.nuget.org` on `linux/x64`, which `AC-1d`
forbids outright. Microsoft's per-platform release archives are not an alternative: they carry the C
library and **no `onnxruntime_binding.node`** (listed, 2026-09-10). So `setup` fetches the npm
tarball, keeps this platform's `bin/napi-v6` subtree plus Microsoft's own `dist/` loader, and puts
`onnxruntime-common` where that loader's own `require` resolves it. `@xplainer/cli`'s npm tarball is
unchanged either way — `files` is `dist/**` and a dependency is never inside a tarball.

**A warm cache is re-verified, never trusted, and that is a fix rather than a feature.**
`acquired.ts` is the record every committed acquisition carries inside the tree it commits, written
by `acquireArtefact`'s `stage` hook *before* the `rename` so it is present exactly when the tree is.
Until 2026-09-10 `providers/speech-bundle.ts` skipped the download **and the verification** whenever
its destination existed and then recorded the digest it had merely been told, for a tree nothing had
checked — and its destination was named after the *version*, so a re-published artefact was served
from that cold cache for ever. Cache identity now binds the digest (it is in the directory name) and
a populated destination is judged against the digest its own record says it was admitted on.

## Public surface

From `src/index.ts`: `createServer`, `startServer`, `DEFAULT_PORT`, `DEFAULT_HOSTNAME` and their
option types — including `GuardFactory`, the middleware-over-the-bound-port seam a second binding
uses, and `RunningServer.socket`, the IPC endpoint a `startServer({ ipc })` bound; the `/api/*`
surface `apps/desktop` consumes — `ApiSeam`, `createWorkspaceLibrary` and `VideoLibrary`,
`ApiVideo`, `ApiArtefact`, `ArtefactKind`, `ArtefactFile`, `ApiJobQueued`, `ApiErrorBody`,
`ApiErrorCode`, `ApiRefusal`, `JobStreamEnd`, the event names `JOB_EVENT` and `END_EVENT`, the
timings `DEFAULT_JOB_POLL_INTERVAL_MS`, `DEFAULT_HEARTBEAT_MS` and `RECONNECT_DELAY_MS`, and the
path builders `API_PREFIX`, `videosPath`, `videoPath`, `artefactPath`, `enqueuePath`, `jobPath`
and `jobEventsPath`; `createLocalBackend`, `LocalBackendError` and `LocalBackendCode`;
`resolveWorkspaceRoot`,
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
node apps/cli/dist/bin.js status --json | jq .   # the same facts, with a stable condition code
kill %1 && wait %1                               # drains, removes runtime.json, exits 0

# The three settings as a supervisor delivers them: flags, above the variables, all read back into
# daemon.json. `--socket` names a directory this daemon makes 0700 on every start.
SETTINGS=$(mktemp -d)
node apps/cli/dist/bin.js serve --port 0 \
  --state-dir "$SETTINGS" --token-file "$SETTINGS/token" --socket "$SETTINGS/run/x.sock"

# R-SEC-8's rotation, against the daemon started above and without stopping it: the new value and
# the retired one both open it until the window closes. No value is printed — the token stays in
# the file R-SEC-6 puts it in — so the way to see it is to read that file.
node apps/cli/dist/bin.js token rotate --grace 600
curl -sf -H "Authorization: Bearer $(cat "$XPLAINER_STATE_DIR/token")" localhost:8787/healthz
node apps/cli/dist/bin.js token rotate --grace 0   # the answer to a leak: no window, no grace file

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

# The entry for a machine with no service manager: `mcp` without --attach, and no daemon check.
# It is what the install preflight's two exit-6 messages lead with, so it must work with no
# daemon.json, no launch record and nothing staged.
HOME=$FAKE_HOME XPLAINER_STATE_DIR=$(mktemp -d) node apps/cli/dist/bin.js connect claude --spawn

# The update transaction under injected failure: the boundary suite — a real updater killed at
# every durable transition, twice-asserted per boundary — and then a real payload assembled,
# installed under this machine's own supervisor and rolled back. Not part of `pnpm verify`; on
# macOS it registers a throwaway label and boots it out, and on Linux it installs the real unit in
# this account's own config directory because that is the only place systemd looks.
pnpm e2e:update

# Desired, loaded and responding, compared. The suite runs all three platforms with the supervisor
# and `/healthz` as seams — and a real `serve` for row 3 — and the proof then drives four drift
# scenarios against this machine's own service manager, where the loaded row really does go stale.
# Not part of `pnpm verify`, for the same reason `e2e:update` is not.
pnpm e2e:identity

# `setup` on a machine that behaves as though it has no Node, and then a picture. The artefact is
# moved out of the checkout, `setup --workspace` proves D8 under `env -i PATH=/usr/bin:/bin`, the
# marker is written over the offline copy route, `/healthz` is shown degrading, and then
# narrate → still → render out of the **materialised** workspace with the MP4 read back by
# `ffprobe` — followed by T16's rollback cases, rerun until each recovered daemon produces a PNG.
# Not part of `pnpm verify` and it must not become part of it: ~147 MB of payload, a ~234 MB
# workspace install, a ~100 MB browser, a render, and two more payloads staged six times over.
pnpm e2e:toolchain
XPLAINER_TTS_URL=http://127.0.0.1:8880 pnpm e2e:toolchain   # reuse a server you already run

# The `[runner]` halves. The artefact gate — narration, then payload 2 and its D1/D2/D3
# assertions — on ubuntu, macos and windows; the two platform spikes on the machines a
# developer has none of, including the Task Scheduler half that runs nowhere else; and the update
# transaction against real service managers; and the loaded-configuration row read from a real Task
# Scheduler, which has never been asked anywhere. Every workflow is registered from the default branch,
# so a new one has to reach `main` before the line resolves at all; `--ref` then chooses whose code
# runs.
gh workflow run e2e-runtime.yml --ref "$(git branch --show-current)"
gh workflow run phase2-proofs.yml --ref "$(git branch --show-current)"
gh workflow run daemon-update.yml --ref "$(git branch --show-current)"
gh workflow run daemon-identity.yml --ref "$(git branch --show-current)"
```

Then the root procedure: `pnpm verify`.

## Invariants

- **Never add `serve --detach`.** [ADR 0020](../../docs/adr/0020-always-running-local-daemon.md)
  rejects self-daemonisation outright: the supervisor owns the process lifetime, and a foreground
  command that forks is invisible to it. The rule belongs in `src/commands/serve.ts`'s docblock and
  stays there.
- **Never add CORS middleware, for any value** (R-SEC-7). Not `*`, not an allowlist, not "only for
  the dev server", and least of all on the artefact route, which is the one that serves bytes a
  page would want to read cross-origin. The desktop's renderer never talks to this daemon directly
  — the main process holds the bearer token and proxies — so no browser origin needs allowing, and
  one that was allowed would let any page a user visits read and drive this machine's daemon with
  the browser's own credentials attached. `api/routes.test.ts` asserts that no answer, allowed or
  refused, on either listener, carries an `access-control-*` header.
- **The command surface is asserted with `toEqual`, never widened to `toContain`** (`AC-14b`). The
  listing is exactly `serve`, `status`, `mcp`, `setup`, `connect`, `daemon`, `runtime`, `token`, and
  it only holds because commander's implicit `help [command]` is disabled. A `toContain` would let a stray command
  ship unnoticed. Top-level `status` and the group's `daemon status` are different commands and
  neither is an alias of the other: the first asks "is this machine's daemon up, and where", the
  second adds the installed supervisor — whether it is switched off, what it loaded, and whether
  the daemon is boot-persistent — which is why it has a condition set of its own. `connect` and
  `daemon` are **groups**, and each has its own `toEqual` listing — `claude`, `codex` and the nine
  lifecycle verbs, `update` and `recover` among them — for the same reason and with the same
  implicit `help [command]` disabled. So do `runtime` (`build`, `verify`) and `token`, whose one
  verb is `rotate`: ADR 0020 §Security R-SEC-8 names that and nothing else, and a second verb under
  that group would be a second way to touch the credential.
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
  somewhere fresh. Reading the token is a `ps` spawn at about 4.5 ms on macOS, so it is read **once
  per acquisition and once per worker at reconciliation**, and memoised for this process.
- **All three platforms produce all three members of the tuple, and Windows only since 2026-09-09.**
  Before that the start-token probe was `ps` on everything that is not Linux — and Windows has no
  `ps` — while the boot id answered `null` outside Linux and macOS, so `selfIdentity()` there was
  `(pid, null, null)`: every live pid was `uncertain`, reconciliation could never take a positive
  kill decision, and `startIsProvablyGone` was `false` for any recorded pid the machine had since
  reused. It surfaced as a T14 flake — run `34319237168` green, run `34333162332` red, same code,
  according to whether five recorded pids had been handed out again. Windows now reads
  `Win32_Process.CreationDate` and `Win32_OperatingSystem.LastBootUpTime` in **one**
  `powershell.exe`, each as an exact `ToFileTimeUtc()` integer rather than a formatted date, and
  `selfIdentity()` takes both halves out of that single spawn. Never `wmic`: it is removed from
  current Windows images, so a probe built on it would answer `null` — "uncertain" — on exactly the
  machines this is for. That spawn costs **about 330 ms warm and 2.9 s cold** against the macOS
  `ps`'s 4.5 ms (`windows-latest`, runs `34338721332` and `34339968171`, 2026-09-09), which is why
  `selfIdentity()` takes both halves out of one invocation and `classifyWorker` reaches the probe
  only for a recorded pid that is still alive. A `powershell.exe` that only prints one line costs
  173 ms of that, so no cheaper query reaches the larger half and none is worth looking for.
  `daemon-windows.yml`'s `identity` job is where all of it is measured — by
  `daemon/testing/identity-cost.ts` — and where the four suites that are about the tuple run on the
  platform whose answer they never had. ADR 0024's note of 2026-09-09 carries the whole reading.
- **Every worker runs in its own process group** (`detached: true`), and teardown signals the group
  (`process.kill(-pgid, …)`), because a render's expensive half is the browser and the encoder it
  started, not the pid the daemon holds. **Windows has no process group, so the worker goes in a
  Job Object with kill-on-close** — Node has no API for one and this package ships no native addon,
  so `process-group.ts` starts a `powershell.exe` keeper that creates the job, assigns the worker
  and any descendant it already had, and holds the handle for the life of the worker. Killing the
  keeper closes the job and takes the tree with it. `taskkill /T` is the fallback where no keeper
  could start, and it is weaker on purpose rather than by oversight: it walks the parent chain at
  kill time, so a grandchild whose parent has already gone is out of its reach.
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
  of the state directory, which has no mode, no directory and nothing to unlink — and a **security
  descriptor of its own**, because a digest is not an access check. `net.Server.listen({ path })`
  takes no descriptor (`readableAll`/`writableAll` only *widen* one) and this package ships no
  native addon, so the pipe is born with the default Microsoft documents as granting "read access
  to members of the Everyone group and the anonymous account" and `daemon/pipe-acl.ts` replaces it
  immediately after the bind: one protected entry, `FullControl` — which is what leaves libuv the
  `FILE_CREATE_PIPE_INSTANCE` it needs for the next accepted connection — for this token's own
  `User` SID. The descriptor belongs to the *pipe* rather than to one instance, which is what makes
  narrowing it once enough. Reported, never fatal, exactly as the token's entry is.
  **The rights the narrower *opens* with are not the rights it grants**, and getting that wrong is
  silent: `NamedPipeClientStream` derives the pipe direction from `desiredAccessRights` and throws
  `ArgumentOutOfRangeException` for a value carrying neither `ReadData` nor `WriteData`, so the
  first release's `ChangePermissions,ReadPermissions` opener could never open the pipe and every
  Windows start reported `failed` on a mechanism nobody was reading. The opener asks `ReadData`
  (the direction, never used), `ChangePermissions` (`WRITE_DAC`) and `ReadPermissions`
  (`READ_CONTROL`); the whole emitted script is a committed fixture, because it runs on a platform
  this suite cannot execute.
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
  **`5` and `6` are `daemon install`'s**, and `7` is still only named: `5` is a denied
  `loginctl enable-linger` and a Windows principal without the "Log on as a batch job" right — both
  established by *attempting* them, which is why they belong to the writing phase and not to the
  read-only preflight — and `6` is no user service manager, which on Linux leads with
  `sudo loginctl enable-linger` when lingering is the reason there is none. `7` and `10` are the
  pair to keep straight: **`7` is
  install-time preflight** ("the port I am about to record is held", nothing registered, nothing
  recorded) and **`10` is `serve`-time ownership** ("the state directory or the recorded port is
  taken" by a process running now). Same symptom, two lifecycles, two remediations, and
  `daemon/exit-codes.test.ts` asserts that §6's rows still say which is which.
- **No `testing/` directory ever ships.** `tsconfig.build.json` excludes `src/**/testing/**`, so
  `daemon/testing/`'s fake worker, spawned child entries and TypeScript source hook, and
  `install/testing/`'s fixture payload, are type-checked and linted but never compiled into `dist/`
  and never reach a tarball. Test scaffolding that a consumer could import is test scaffolding that
  becomes a supported surface.
- **The guard is unconditional, and it is mounted before any route.**
  `createServer()` takes it as a *parameter*, so the TCP listener carries it, the IPC listener
  carries none — filesystem permissions are that transport's authentication — and
  `services/media-service` carries its own at phase 3. Three rules inside it are not negotiable
  (ADR 0020 §Security): the `Host` allowlist is **exact string equality** against
  `{127.0.0.1, localhost, [::1]}:PORT` **plus one entry per `--allow-host`**, and never a parser,
  because `http://2130706433:8787` reaches loopback too; the operator's hostnames are **added** and
  nothing is removed, because a validation that weakens when the bind widens is exactly
  CVE-2026-65105; and `/healthz` needs the token like everything else. There is no branch on the
  bind address in `guard.ts` at all, which is what makes that a property rather than a promise. `Authorization` is redacted at the logger (`redactAuthorization`), request bodies
  are never logged at all, and every rejection *is* logged with its reason and the offending value.
  The allowlist is built **after** bind, from the port the OS gave us, which is why `startServer()`
  takes a `GuardFactory` and `--port 0` keeps working.
- **Three settings, and each flag is above its variable.** `serve` takes `--state-dir`,
  `--token-file` and `--socket`, spelled exactly as `src/runtime/launch-spec.ts`'s `SETTING_FLAGS`
  emits them — a spelling that changed on one side only is a daemon that refuses the argv its own
  installer wrote, which is why `serve.test.ts` compares the two rather than trusting them to stay
  in step. The flags exist because **Task Scheduler's `<Exec>` action has no per-action environment
  map**: a daemon told where its state lives only through `XPLAINER_STATE_DIR` would silently take
  the platform default on Windows while `daemon.json` recorded something else. `--token-file` names
  a **path and never a value**, so R-SEC-6 holds on the argv route exactly as it did on the
  environment one; `--socket` has **no variable at all**, which is why all three travel in argv on
  every platform rather than only where they must. All three are written into `daemon.json` at
  readiness, so `status --json` reports what the process used and not what somebody intended, and
  `serve` logs which of flag, variable and default decided each one. The `0700` rule follows
  `--socket`: the directory narrowed is the one the socket is actually in, so point the flag at a
  directory dedicated to the socket — `%t/xplainer`, not `$HOME`.
- **`daemon status` may query a supervisor, and may never parse `launchctl print`.** The narrow
  rule, and it is narrow deliberately: the blanket ban made one of ADR 0020's **own** required
  sentences unobservable, because "you or a policy switched this off in Login Items & Extensions"
  appears in no HTTP response and in no file this project owns. Three documented machine-readable
  queries are allowed and no others — `launchctl print-disabled gui/$UID`,
  `systemctl --user is-enabled xplainer.service` and `(Get-ScheduledTask …).State` for the
  switched-off fact, and `systemctl --user show -p ExecStart -p Environment -p WorkingDirectory
  --value` / `Get-ScheduledTask` for the loaded configuration, which **macOS does not have** (§1.3b
  D7: the responding identity in `/healthz` is the detector there instead). `launchctl print` is
  the one surface its own manual disowns — "This output is NOT API in any sense at all" — and
  nothing in this package calls it. Everything else comes from `/healthz` and our own state files.
- **The four sentences ADR 0020 requires `daemon status` to say are values, not prose.**
  `install/lifecycle.ts` builds them and tags each with its state, and `lifecycle.test.ts` compares
  them with the four quoted strings read **out of the ADR file itself**. Two of them name a
  platform's own surface — Login Items & Extensions is macOS's word for a launchd disable record,
  lingering is systemd's — so the ADR's exact sentence is what that platform produces and the other
  two make the same claim about the surface their user actually has. Reword one and the suite fails.
- **`status --json` answers with a condition code from a closed set**, never with prose: `ready`,
  `stalled`, `unauthorized`, `token_absent`, `unhealthy`, `unreachable`, `absent`
  (`STATUS_CONDITIONS`). `daemon status --json` answers from a superset — the same members plus
  `disabled` (a supervisor query saw the service switched off) and `degraded` (it answered `200`
  and the recorded toolchain is not on this machine) — classified in the same order, so a consumer
  that handles one handles the other by adding two cases. It is what `apps/desktop`'s discovery shells out to instead of
  reimplementing state-directory resolution, so a new member is added here and to that mapping
  together. Two things are deliberately **not** conditions: contract compatibility, which is a
  relation between a daemon and *the shim asking* and so is reported as the daemon's
  `contract_version` for the caller's own `isContractCompatible()`; and "switched off in Login
  Items", which is supervisor state that HTTP and our own files cannot see and that `daemon status`
  reaches with the documented supervisor queries. The document is one object on one line and carries
  no secret. The two refusals that happen before a report exists — a state file that cannot be read
  (`11`) and a `--url` that is not an endpoint (`1`) — write a sentence to stderr and nothing to
  stdout, so a caller tells them apart by exit code rather than by parsing an error object.
- **A non-loopback bind costs all five of R-SEC-9's preconditions, and four of them are refused
  before the state directory is taken.** An explicit `--bind`, `--i-understand-remote-exposure`,
  `--tls-cert` **and** `--tls-key`, at least one `--allow-host`, and a bearer token this daemon did
  not mint — which `daemon.json`'s `token_origin` is what makes decidable, because 32 random bytes
  an operator wrote and 32 the mint generated are the same value. **That record answers for the
  file `token_file` names and for no other**: a token at a path this state directory never wrote is
  the operator's however often this daemon has minted one of its own, and a start that inherited the
  recorded answer refused an operator's `--token-file` for ever in a sentence claiming this daemon
  had minted a file it had never seen. **Because the record answers for a file, the two fields are
  one write**: `serve` writes `token_origin` and `token_file` in the same `updateDaemonState` call,
  at the moment the token is read or minted, and `markReady` writes neither. Writing them apart was
  a hole rather than an untidiness — `token_origin` at the mint and `token_file` only at readiness
  meant every ordinary failed start (a held port, an unloadable certificate pair, a socket path the
  platform refuses) left `minted` on disk with no path beside it, and the next start read "the
  record names no file of mine" and answered `operator` for the token this daemon had just minted,
  meeting the fifth precondition by bookkeeping. `0.0.0.0`, `::`, `[::]` and `*`
  are refused outright, acknowledgement or not. Everything argv decides is decided before ownership,
  and the token's provenance **before the mint** — the three answers are `absent`, `minted` and
  `operator`, and a check asked after `loadOrMintToken` created the credential it then refused — so
  every refusal leaves the machine as it found it, with no token file and no `token_origin` it
  wrote, and the message names **every** missing precondition at once rather than one per run.
  `daemon/tls.ts` never generates a certificate: the operator supplies the pair, and TLS on a
  *loopback* bind is refused because `status`, `daemon restart` and the desktop all reach a local
  daemon over `http`.
- **The bearer token travels as a path, never as a value** (R-SEC-6): `XPLAINER_TOKEN_FILE` names a
  file, `/proc/<pid>/cmdline` is world-readable and `systemctl --user show` prints `Environment=`.
  `daemon/token.ts` is the only reader of that file; the guard is handed a string. And it is not a
  sandbox: same-uid code reads a `0600` file trivially. It buys the browser boundary and the other
  local user on a shared box, and nothing else — a token documented as more than that is worse than
  no token. **On Windows the mode buys neither**, because Node documents that only the write
  permission is settable there and that the owner/group/other distinction is not implemented, so
  the mint runs R-SEC-5's own remedy on the file it has just created —
  `icacls <path> /inheritance:r /grant:r "<user>:(R,W)"`, in `daemon/windows-acl.ts` — and `serve`
  names in one line which of the two protections this platform got. **That command is the first of
  up to three, because it removes only what was *inherited*.** `/inheritance:r` takes the inherited
  ACEs off and `/grant:r` replaces the named account's explicit ones; a third principal's explicit
  entry survives both, and `icacls` has no option meaning "and nobody else". Under `%LOCALAPPDATA%`
  there is never such an entry, which is why the ADR spells the requirement as one command — but a
  path whose parent carries no inheritable ACE gets its DACL from the creating token's *default*
  one, and those entries are explicit. A scratch directory under GitHub's `windows-latest` runner
  temp is exactly that (`NT AUTHORITY\SYSTEM:(F) BUILTIN\Administrators:(F)` on a file this process
  had just created, 2026-09-09), so the entry is read back and whatever is not this account is
  removed. A failure to apply any of it is
  **reported, never fatal**: a daemon that refused to start over a missing `icacls` would trade a
  weaker file for no service at all. R-SEC-5's other half is `daemon status`: it re-reads the entry
  with a plain `icacls <path>` **query** and prints `WARNING —` when a second principal is on the
  file or an `(I)` flag says inheritance has been restored, naming both what it found and the
  command that narrows it again.
- **Nothing this project parses may arrive through PowerShell's output formatter.** Every value a
  `powershell.exe -Command` script emits is formatted on its way to stdout, and with stdout
  redirected — which it always is here — that formatter **wraps at 80 columns**. Two answers this
  package reads back are longer than that and were being read as truncated ones: the
  loaded-configuration row (`Execute=`, `Arguments=` and `WorkingDirectory=` are absolute paths, so
  a *correct* Task Scheduler install reported `command` and `cwd` as drifted) and `pipe-acl.ts`'s
  success line (prefix, digest-length pipe name and a SID, read back as half a SID). Both now write
  with `[Console]::Out.WriteLine`, which is the one way past the formatter, and both have a unit
  pinning that. Measured on `windows-latest`, 2026-09-09. Composing `Key=value` lines by hand is
  necessary and is not sufficient — `Format-List` is only the most obvious way to be wrapped.
- **A `<Repetition>` belongs to a trigger that has fired, and `<RestartOnFailure>` is not a retry
  policy for an action that exits non-zero.** Both measured on `windows-latest`, 2026-09-09 (run
  `34317779107`, job `102357526877`), three tasks side by side for eleven minutes. The document
  `supervisors/schtasks.ts` renders therefore carries the indefinite `PT5M` repetition on **two**
  triggers: a `<RegistrationTrigger>`, because registering the task is itself a trigger event and so
  the five-minute re-check exists from the moment `install` finishes, and the `<LogonTrigger>` for
  the next boot. With the logon trigger alone the re-check did not exist at all between an install
  and the next logon — `Start-ScheduledTask`, which is what `install` and `daemon start` call, is an
  **on-demand** run that starts no trigger, and a logon trigger does not fire in a session the user
  logged into before running `install`. `MultipleInstancesPolicy: IgnoreNew` is what makes the
  trigger and the explicit start unable to produce two daemons, and that was measured too: a
  registration trigger plus an immediate `Start-ScheduledTask` over a four-minute action recorded
  one start. `<RestartOnFailure>` stays because a task failing to *launch* is a real and different
  failure, but nothing here may count on it: a daemon that exits `10` is re-run by the repetition
  and by nothing else, which is why T14's Windows arm waits about twenty minutes for five failed
  starts. [ADR 0020](../../docs/adr/0020-always-running-local-daemon.md)'s note of 2026-09-09 is the
  record.
- **Address a scheduled task by folder *and* leaf, from one place.** `\xplainer\<user>-daemon` is a
  path; `Register-ScheduledTask -TaskName` takes one because it is creating the name, and every
  other cmdlet in the `ScheduledTasks` module is a CDXML wrapper over a CIM query whose `TaskName`
  is the **leaf** and whose `TaskPath` is the folder. Two of them are measured *refusing* a full
  path on `windows-latest`, 2026-09-09, and both refuse quietly: `Get-ScheduledTask` writes a
  non-terminating `ObjectNotFound` and exits `0` (T17 then read a correct install's loaded row back
  as an empty command and reported drift on it), and `Unregister-ScheduledTask` reports success
  having removed no task (T16's uninstall left the task it said it had deregistered). Two others —
  `Start-ScheduledTask` and `Get-ScheduledTaskInfo` — are measured *accepting* one in the same batch
  of runs (34310353206 and 34313848702). So the rule is not "a path never matches": it is that
  **which** cmdlet tolerates one is undocumented and silent when it does not, so all of them are
  addressed the documented way from `install/register.ts`'s `scheduledTaskSelector()` — the verbs in
  `install/lifecycle.ts` and the proof helpers in `install/testing/` included. The one composed
  command that does not come through it is the update's re-registration in `update/switch.ts`, and
  that is correct: a `Register-` is creating the name and takes the whole path. The two queries also
  carry `-ErrorAction Stop`, so a task that is not there is an honest "the query did not answer" — a
  non-zero status and nothing on stdout — rather than a row of empty strings.
- **A Windows deregistration is two commands, because unregistering does not stop.**
  `systemctl --user disable --now` and `launchctl bootout` both stop the process as they take the
  job away; `Unregister-ScheduledTask` removes the registration and leaves a running instance
  running. `install/register.ts`'s `deregisterCommands` therefore emits `Stop-ScheduledTask` first
  and tolerates its failure, or an uninstall leaves a daemon holding the state directory every file
  naming it has just stopped naming — which is what an `EPERM` on removing that directory was
  (`windows-latest`, 2026-09-09).
- **The guard is handed a function, so a rotation reaches a daemon that is already running.**
  ADR 0020 §Security R-SEC-8's `xplainer token rotate` writes a new value and keeps the old one in
  `<token>.previous` for a grace window — five minutes by default, a day at most, `0` for a leak —
  and `daemon/token.ts`'s ring re-reads both files whenever either changes, so **both** values open
  the daemon until the window closes and neither a restart nor a control route is involved. Two
  consequences to keep straight. The daemon **follows its own token file**, so a test that
  simulates an intruder by overwriting it is simulating the wrong thing: what "something is on our
  port that is not our daemon" looks like is a *second* state directory recording that port. And
  `daemon uninstall` still **deletes** rather than rotates — and deletes the grace file too, because
  a rotation leaves two working credentials and taking one of them leaves behind exactly the live
  token P2-9 forbids. No value is ever printed by the command or written to `daemon.json`; what the
  record carries is two instants and a path.
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
exits `NOT_IMPLEMENTED_EXIT_CODE`. Update the `toEqual` surface assertion in the same commit. A
**group** carries its own `configureOutput()` and `exitOverride()` on the group *and* on every verb:
commander's `addCommand()` copies neither, so a group that configures only itself leaves its verbs
writing to the process streams and calling the real `process.exit`.

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
