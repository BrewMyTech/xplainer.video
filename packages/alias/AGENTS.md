# AGENTS.md — `xplainer` (the unscoped alias)

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

**A name, and a hand-over.** `xplainer` on npm is the unscoped alias for
[`@xplainer/cli`](../../apps/cli/AGENTS.md), so that `npm i -g xplainer` and `npx xplainer` work
without the scope. It carries **one dependency** — `@xplainer/cli` at the same exact version — and
one file: `src/bin.ts` locates that package's own `bin` and imports it.

**It is a forwarder rather than a second copy of the CLI, and that is the point.** The rejected
alternative was to publish `apps/cli`'s `dist/` under a second name, which would mean two tarballs
of the same program that can drift by a release, two sets of `files` rules and two things to get a
publish right for. A forwarder has nothing to keep in sync: the version pin is the whole
relationship, and there is no second copy of anything.

### How the hand-over works, and why it is an import

`src/bin.ts` resolves `@xplainer/cli`, reads `bin["xplainer"]` out of **that package's own
manifest**, and `await import`s the file it names. Two decisions are load-bearing and both are
argued at the site:

- **The target comes from the dependency's manifest, never from a derived path.** The published
  `exports` map of `@xplainer/cli@0.0.1` carries `"."` and nothing else, so `@xplainer/cli/bin` is
  not resolvable and cannot be made resolvable after the fact — 0.0.1 is on the registry and
  immutable. `"."` *is* resolvable; `src/forward.ts` resolves it, walks up to the manifest that
  names the package, and reads the same field npm reads when it links the command. Guessing
  `dist/bin.js` from the entry point would encode a layout this package does not own.
- **An import, not a spawn.** This is the process a user's shell waits on and the process an
  agent's stdio MCP session runs through. Running the CLI in *this* process makes the exit code,
  the signal handlers and all three file descriptors the real thing by construction; a `spawnSync`
  would have to re-implement each of them, and would put a second process in the middle of a
  JSON-RPC stream. `src/bin.ts`'s docblock carries the full argument.

`process.argv[1]` is rewritten to the file being imported, which is the one thing an import does
not get for free — see the invariant below.

## Public surface

**None, deliberately.** The manifest declares `bin` and no `exports`, so nothing here is
importable and there is no API to report (`scripts/api-report.mjs` lists it in
`UNREPORTED_MEMBERS` for that reason). The published surface is one command, `xplainer`, and it is
whatever `@xplainer/cli` says it is.

`src/forward.ts` exports `resolveCliBin`, `AliasRefusal`, `CLI_PACKAGE`, `BIN_NAME` and
`REFUSAL_EXIT_CODE` to `src/bin.ts` and to its own test. That is internal by construction: with no
`exports` map, a consumer cannot reach it.

## Commands

```bash
pnpm --filter xplainer test
pnpm turbo build --filter xplainer

# The hand-over, by hand. Both work, and the source is what the tests spawn.
node packages/alias/src/bin.ts --version      # 0.0.1, from @xplainer/cli
node packages/alias/dist/bin.js --help        # the real command surface, named `xplainer`

# What a user gets, without publishing: pack, then install the tarball somewhere else.
# `pnpm pack` in place refuses under this workspace's `nodeLinker: hoisted` — see the root
# AGENTS.md §Publishing a release — so the tarball for a proof comes from the same isolated
# install a release is published from.
```

Then the root procedure: `pnpm verify`.

## Invariants

- **One dependency, pinned to one exact version.** `@xplainer/cli` is spelled
  `workspace:<the CLI's exact version>`, which pnpm rewrites to that version in the published
  manifest. A range would let a published `xplainer` install a CLI it was never tested against, and
  the alias has no behaviour of its own to absorb the difference. `changeset version` moves both
  together, so the pin is not maintained by hand — but write the changeset so it covers both
  packages, or the CHANGELOGs disagree about the same release. **Do not write the version into a
  sentence or a test.** This paragraph said `workspace:0.0.1` until the `0.0.2` release made it
  false, and `src/bin.test.ts` held the same literal and turned the gate red on the first correct
  release: the suite now reads the version out of this package's manifest, which asserts the
  property that actually matters — that the forwarder announces the version of the CLI it resolved.
- **Nothing is ever written to stdout.** Not a banner, not a warning, not a refusal.
  `xplainer mcp` is configured into an agent as a stdio MCP server, so this command's stdout *is* a
  JSON-RPC stream — `apps/cli/AGENTS.md`: "a shim's stdout is the JSON-RPC stream… one stray line
  on stdout is a parse error inside the agent, with no message anyone will see". Refusals go to
  stderr. Two tests hold the line: one asserts the first line of a raw `mcp` session's stdout
  parses as JSON-RPC, the other drives a real MCP client through the forwarder.
- **`process.argv[1]` is rewritten to the CLI's own entry before the import.**
  `apps/cli/src/daemon/start.ts` reads `process.argv[1]` as the entry file when it freezes the
  daemon's *responding* identity, and `install/supervisors/identity.ts` compares that against the
  launch spec the supervisor holds. Left pointing at this file, a `serve` reached through the alias
  would report identity drift against a correct install. The rewrite makes the argv exactly what
  npm's own shim for `@xplainer/cli` would have produced.
- **This alias is not an install path.** `xplainer daemon install` registers a program from one of
  four sources (`explicit`, `sea-binary`, `package-manager`, `runtime-dir`) and a supervisor is
  given the launcher or the staged payload — never this command. Nothing here may grow a flag, a
  marker or a state file; a forwarder that knows what a daemon is has become a second
  implementation of one.
- **No refusal invents an exit code.** A refusal here exits `70`, "anything else" in the exit-code
  table (`docs/ARCHITECTURE.md` §6). Every other row belongs to something the CLI decided, and a
  refusal here means the CLI never ran, so borrowing one of its codes would say something specific
  and false.
- **There is no `tsconfig.build.json` here, and the name is the reason.** This package emits no
  declarations — it has no module surface to declare — and `check-docs-contract.mjs` derives the
  **Declarations** column of `docs/ARCHITECTURE.md` §3 from the *presence of that filename*. A
  build config named `tsconfig.build.json` would make that column say `yes` about a package that
  emits none, and the **API report** column is derived from it in turn. So the emit config is
  `tsconfig.emit.json`, and the two columns stay true.
- **The two extra compiler options are what let the tests run the source.**
  `allowImportingTsExtensions` and `rewriteRelativeImportExtensions` are set here and nowhere else
  in the workspace: `src/bin.ts` says `./forward.ts` in source, so `node src/bin.ts` runs under
  Node's own type stripping with no loader, and `tsc` rewrites the specifier to `./forward.js` on
  the way into `dist/`. `turbo.json` gives `test` no dependency on this package's own build, so a
  suite that spawned `dist/` would be a green test over code that is not the code —
  `apps/cli/src/daemon/testing/ts-source-hook.ts` solves the same problem with a resolve hook, and
  two files need no hook.
- **The tarball is `dist/**/*.js`, `LICENSE` and `NOTICE`, and no `.d.ts`.** There is nothing for a
  consumer's `tsc` to read, because there is nothing to import.

## How to add

**Nothing, if it can be avoided.** The value of this package is that it has no behaviour: every
feature belongs in `@xplainer/cli`, where it is tested against the daemon, the tools and the three
platforms. A change here is either the version pin moving or a fix to the hand-over itself.

**A refusal:** add it to `src/forward.ts` as an `AliasRefusal` whose message names the fix, add the
case to `src/forward.test.ts` with a hand-written host, and keep the exit code at `70`.

**A version bump:** it moves with `@xplainer/cli`. Update the `dependencies` pin and write one
changeset covering both packages, so the CHANGELOG of each says the same thing.

Finish with `pnpm verify`.
