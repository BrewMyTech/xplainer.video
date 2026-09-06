# AGENTS.md — `@xplainer/cli`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

**The local runtime.** The `xplainer` binary, the Hono application it serves — `GET /healthz` and
the Streamable HTTP MCP endpoint at `/mcp` — and the **durable job daemon** under `src/daemon/`:
exclusive ownership of the state directory, one JSON file per job, boot reconciliation, and a runner
that executes each job's worker as a child process in its own process group. All render
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
| `exit-codes.ts` | The three start-up codes, quoting the table in `docs/ARCHITECTURE.md` §6 |
| `testing/` | The fake worker, the child entries the tests spawn, and the source hook that runs them |

The state directory — `${XDG_STATE_HOME:-~/.local/state}/xplainer/` on Linux,
`~/Library/Application Support/video.xplainer/` on macOS, `%LOCALAPPDATA%\xplainer\state\` on
Windows, or `XPLAINER_STATE_DIR` — holds:

```
owner.lock          the ownership artefact: pid, start token, boot id, nonce (0600)
daemon.json         DURABLE. port, contract version, directory_flush, recentStarts[], stalled
runtime.json        EPHEMERAL. this run's pid, run id, boot id, bound port
jobs/job-000001.json   one record per job, temp-then-rename, with a bounded log tail
jobs/corrupt/          records that could not be parsed, moved aside rather than deleted
```

**The two files have opposite lifetimes and that is the whole point** (ADR 0020 §Port and
discovery): `daemon.json` must survive a reboot, `runtime.json` is written at bind and is never
trusted without a liveness check. `recentStarts[]` and `stalled` are in the **durable** one —
ADR 0020 first put them in `runtime.json`, and its own dated note records why that was wrong, since
on Linux `runtime.json` lives in systemd's `RuntimeDirectory=` and is deleted on every clean stop.

## Public surface

From `src/index.ts`: `createServer`, `startServer`, `DEFAULT_PORT`, `DEFAULT_HOSTNAME` and their
option types; `createStubBackend`; `CLI_VERSION`; `NOT_IMPLEMENTED_EXIT_CODE` and the
not-implemented helpers. `bin/` ships `dist/bin.js` as `xplainer`. Published, emits declarations,
carries `api/cli.api.md`.

**`src/daemon/` is internal and deliberately not exported.** It is the local runtime's own
machinery, and ADR 0020's last accepted cost is that "the supervisor modules are local-runtime
concerns and must not leak into `packages/mcp-server`". `services/media-service` imports
`createServer()` and nothing below it; the render backend and the `SIGTERM` drain reach the runner
through `startDaemon()`, inside this package.

## Commands

```bash
pnpm --filter @xplainer/cli test
pnpm turbo build --filter @xplainer/cli          # where TS9010 appears
node apps/cli/dist/bin.js serve --port 8787      # then: curl -sf localhost:8787/healthz

# Serve against a throwaway state directory, so a hand-run daemon cannot take the real one:
XPLAINER_STATE_DIR=$(mktemp -d) node apps/cli/dist/bin.js serve --port 0

node apps/cli/spikes/p1-s1-ownership.mjs         # the ownership check ADR 0024's note quotes
```

Then the root procedure: `pnpm verify`.

## Invariants

- **Never add `serve --detach`.** [ADR 0020](../../docs/adr/0020-always-running-local-daemon.md)
  rejects self-daemonisation outright: the supervisor owns the process lifetime, and a foreground
  command that forks is invisible to it. The rule belongs in `src/commands/serve.ts`'s docblock and
  stays there.
- **The command surface is asserted with `toEqual`, never widened to `toContain`** (`AC-14b`). The
  listing is exactly `serve`, `mcp`, `setup`, `connect`, `daemon`, and it only holds because
  commander's implicit `help [command]` is disabled. A `toContain` would let a stray command ship
  unnoticed.
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
- **Exit codes are a documented table**, in
  [`docs/ARCHITECTURE.md` §6](../../docs/ARCHITECTURE.md#6-the-runtime) and in the ADR that owns
  each one. A new code is added to the table and to ADR 0020's successor — never invented at the
  call site; `daemon/exit-codes.ts` is the only place `serve` reads them from.
  `NOT_IMPLEMENTED_EXIT_CODE = 2` keeps its meaning and its export site, and **`8` is
  reserved for contract skew** ([ADR 0025](../../docs/adr/0025-daemon-updates-and-readiness.md)).
  What `serve` uses today: **`10`** another process owns the state directory (nothing written),
  **`11`** `daemon.json` exists and cannot be read, **`0`** the circuit breaker is latched — which
  is the portable "do not restart" signal on all three supervisors — and **`70`** anything else.
  **`12`** (token file missing) arrives with the bearer token.
- **`src/daemon/testing/` never ships.** `tsconfig.build.json` excludes it, so the fake worker, the
  spawned child entries and the TypeScript source hook are type-checked and linted but never
  compiled into `dist/` and never reach a tarball. Test scaffolding that a consumer could import is
  test scaffolding that becomes a supported surface.
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
object alone.

**A daemon module:** add it under `src/daemon/` as one named concept per file with a colocated
`*.test.ts`, and give it the state directory as an argument rather than reading the environment —
`state-dir.ts` is the only module that knows where state lives. If the behaviour is only true of a
real process — a `SIGKILL`, a second `serve`, an orphaned worker — add the case to
`daemon/start.test.ts` and spawn a child through `testing/ts-source-hook.ts`; do not spawn `dist/`,
because `turbo.json` gives `test` no dependency on this package's own build.

**A worker for a job kind:** register a `WorkerFactory` in the `WorkerRegistry` passed to
`startDaemon()`. A kind with no worker is not a crash and not a silent success: the job reaches
`error` with `error_code: "internal"` and a sentence naming the kind, because an agent holding a
`job_id` must always be able to poll it to a conclusion.

**An export:** add it to `src/index.ts` explicitly, run `pnpm api:report`, commit the `.api.md`.

Finish with `pnpm verify`.
