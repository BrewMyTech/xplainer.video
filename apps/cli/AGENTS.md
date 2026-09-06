# AGENTS.md — `@xplainer/cli`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

**The local runtime.** The `xplainer` binary, and the Hono application it serves: `GET /healthz`,
the Streamable HTTP MCP endpoint at `/mcp`, and — from roadmap phase 1 — the job runner. All render
and TTS logic lives here, not in `apps/desktop`
([ADR 0016](../../docs/adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md)), and from
phase 2 `serve` becomes an installed, supervised, per-user daemon
([ADR 0020](../../docs/adr/0020-always-running-local-daemon.md)).

It is the **one application in the workspace that is published**, which is why it is deliberately
absent from the Changesets ignore list.

## Public surface

From `src/index.ts`: `createServer`, `startServer`, `DEFAULT_PORT`, `DEFAULT_HOSTNAME` and their
option types; `createStubBackend`; `CLI_VERSION`; `NOT_IMPLEMENTED_EXIT_CODE` and the
not-implemented helpers. `bin/` ships `dist/bin.js` as `xplainer`. Published, emits declarations,
carries `api/cli.api.md`.

## Commands

```bash
pnpm --filter @xplainer/cli test
pnpm turbo build --filter @xplainer/cli          # where TS9010 appears
node apps/cli/dist/bin.js serve --port 8787      # then: curl -sf localhost:8787/healthz
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
- **Exit codes are a documented table**, in
  [`docs/ARCHITECTURE.md` §6](../../docs/ARCHITECTURE.md#6-the-runtime) and in the ADR that owns
  each one. A new code is added to the table and to ADR 0020's successor — never invented at the
  call site. `NOT_IMPLEMENTED_EXIT_CODE = 2` keeps its meaning and its export site, and **`8` is
  reserved for contract skew** ([ADR 0025](../../docs/adr/0025-daemon-updates-and-readiness.md)).
- **`serverInfo.version` is the release version, not the contract version.** `src/server.ts` passes
  `CLI_VERSION` into `createMcpServer`, so do not read the handshake as a contract advertisement;
  an explicit one is spike **P1-S3**.
- **Nothing downloads at install.** No `postinstall` fetches a browser, a model or a binary
  (`AC-1d`); `xplainer setup` does that, deliberately and visibly
  ([ADR 0005](../../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)).
- **`isolatedDeclarations` is on `tsconfig.build.json`**, so `TS9010` surfaces under
  `pnpm turbo build` — not under `typecheck`, and not in your editor.

## How to add

**A command:** add the module under `src/commands/` (one concept per file, kebab-case), register it
in `src/program.ts`, and — until it does something — register it as a stub that names itself and
exits `NOT_IMPLEMENTED_EXIT_CODE`. Update the `toEqual` surface assertion in the same commit.

**A route:** add it in `src/server.ts` and test it against a started server, not against the app
object alone.

**An export:** add it to `src/index.ts` explicitly, run `pnpm api:report`, commit the `.api.md`.

Finish with `pnpm verify`.
