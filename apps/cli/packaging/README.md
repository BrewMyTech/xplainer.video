# Packaging `xplainer` as a standalone binary

**Nothing in this directory runs in CI, in this phase or by accident.** There is no
workflow, no Turbo task and no `package.json` script that invokes any of it. The recipe is
written down because the decision to use Node's single-executable applications (SEA) rather
than `pkg` or a rewrite is part of the CLI-first runtime decision (ADR 0016), and a decision
nobody can reproduce is not recorded.

This file is the **record** half of spike P2-S6. The **live** half is
`apps/cli/spikes/p2-s6-packaging.mjs`, which assembles a relocated payload and asserts what has
to keep holding:

```sh
pnpm --filter @xplainer/cli build      # the spike measures the built payload, not the sources
node apps/cli/spikes/p2-s6-packaging.mjs
```

Everything under [What was measured, and when](#what-was-measured-and-when) is **recorded and not
asserted**, deliberately. Those measurements are today's *defects*, and an assertion over a defect
breaks when the defect is fixed: a future esbuild that supports top-level `await` in CommonJS, a
Node that accepts an ESM SEA main, or a refactor that moves one of the six `import.meta.url` lines
would each fail a gate by improving the code. So they are written down with their dates and their
verbatim output, once, and the spike asserts the properties that survive all three.

---

## What was measured, and when

All five measurements were made on 2026-09-07, on macOS 26.5 (`darwin/arm64`), Node v24.20.0,
esbuild 0.28.2, against `apps/cli/dist` built from the same checkout. Every command was run in a
scratch directory; no repository file was modified by any of them.

### 1. The prescribed CommonJS bundle does not build — 2026-09-07

Step 0 below is the first thing this recipe asks for, and it fails:

```
$ ./node_modules/.bin/esbuild --bundle --platform=node --format=cjs --target=node24 \
    apps/cli/dist/bin.js --outfile=<scratch>/a.cjs

✘ [ERROR] Top-level await is currently not supported with the "cjs" output format

    apps/cli/dist/bin.js:2:74:
      2 │ ...ateProgram}from"./program.js";await createProgram().parseAsync(p...
        ╵                                  ~~~~~

4 warnings and 1 error
EXIT=1
```

`apps/cli/src/bin.ts` ends with a bare `await createProgram().parseAsync(process.argv)` and the
package is `"type": "module"`. **No file is written.** Everything from `sea-config.json` onwards is
therefore unreachable as the recipe stands.

### 2. With the top-level `await` removed, four modules lose `import.meta.url` at six sites — 2026-09-07

Rewriting the one `await` into `.then(() => {})` produces a **1,773,281 byte** bundle with four
warnings and no error. esbuild replaces `import.meta` with an empty object per module, and the four
placeholders it emits stand at six call sites:

| Placeholder | Module | Target it was resolving |
| --- | --- | --- |
| `import_meta` | `apps/cli/dist/version.js` | `../package.json` |
| `import_meta2` | `render-core/dist/scaffold/index.js` | `./templates/` — six `.txt` files |
| `import_meta3` | `render-core/dist/workspace.js` | `../template/` — four workspace files |
| `import_meta4` ×3 | `apps/cli/dist/daemon/workers.js` | `../workers/narrate.js`, `../workers/narrate.ts`, `./testing/ts-source-hook.ts` |

The verbatim use sites in the bundle:

```
new URL("../package.json", import_meta.url)
fileURLToPath(new URL("./templates/", import_meta2.url))
fileURLToPath(new URL("../template/", import_meta3.url))
fileURLToPath(new URL("../workers/narrate.js", import_meta4.url))
fileURLToPath(new URL("../workers/narrate.ts", import_meta4.url))
fileURLToPath(new URL("./testing/ts-source-hook.ts", import_meta4.url))
```

**Only four of the six are warned about.** esbuild suppresses warnings for files under
`node_modules`, and the two `render-core` sites reach the bundler through the workspace link, so
they are emptied in silence. They are also the decisive two: both resolve **directories of data
files** that are then listed and read with `readFileSync`, and no bundler can inline a directory
into the code that enumerates it.

### 3. The bundle that does build throws at load, on every command — 2026-09-07

`import.meta` is an empty object, so `import.meta.url` is `undefined`, and `version.ts` computes
`CLI_VERSION` at module scope:

```
$ node a.cjs --version
TypeError: Invalid URL
    at new URL (node:internal/url:840:25)
    at readPackageVersion (<scratch>/a.cjs:43931:23)
    at Object.<anonymous> (<scratch>/a.cjs:43935:19)
    at Module._compile (node:internal/modules/cjs/loader:1929:14)
EXIT=1

$ node a.cjs --help                                → same TypeError, EXIT=1
$ echo '{"version":"9.9.9"}' > ../package.json      # a manifest one directory above
$ node nested/a.cjs --version                       → same TypeError, EXIT=1
```

This is the measurement that corrects this file's own closing claim; see
[One gap this recipe does not paper over](#one-gap-this-recipe-does-not-paper-over).

### 4. A `dist`-only relocated payload dies at load — 2026-09-07

A payload assembled from `package.json` + `dist/` for each workspace package, with the external
dependency closure beside it, run from `/tmp` under `env -i`:

```
$ env -i <rt>/bin/node <rt>/lib/node_modules/@xplainer/cli/dist/bin.js --version

Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '<rt>/lib/node_modules/@xplainer/protocol/schemas/manifest.json'
  imported from '<rt>/lib/node_modules/@xplainer/mcp-server/dist/server.js'
    at finalizeResolution (node:internal/modules/esm/resolve:272:11)
EXIT=1
```

`packages/mcp-server/src/server.ts` imports the tool manifest with
`with { type: "json" }`, and `@xplainer/protocol`'s `files` allowlist ships it under `"schemas"` —
a row a `dist`-only payload drops. **The allowlist, not `dist/`, is the definition of the payload.**
Reproducing it is one edit to the spike: dropping the `"schemas"` row from the allowlist it copies
produces the error above verbatim and fails five of its expectations — the probe, and both
`--version` runs (done 2026-09-07; the spike ships without the sabotage, which is why it is a
measurement here and not a test there).

### 5. The payload built from the `files` allowlists works — 2026-09-07

The same assembly, with each workspace package copied by its own `files` allowlist:

```
$ command -v node                                       # under env -i: not resolvable, exit 1
$ env -i <rt>/bin/node <rt>/lib/node_modules/@xplainer/cli/dist/bin.js --version
0.0.0
EXIT=0
$ env -i … --help
serve, status, mcp, setup, connect, daemon
```

**132.8 MB, 3853 files:** the interpreter, five workspace packages and 96 external package copies —
92 distinct dependencies, four of them installed twice because two `content-type` majors are in the
closure and a flat directory cannot hold both. The narration worker runs from inside it, spawned by
the payload's own resolution, with nothing on `PATH`:

```
bin/node lib/node_modules/@xplainer/cli/dist/workers/narrate.js <workspace> 1
[xplainer] narrating spike: 2 segment(s) from an estimated dry run — no speech server was contacted
[xplainer] mode dry_run: 2 segment(s), 311 frames at 30 fps (10.37 s)
```

---

## What the spike asserts, and what it deliberately does not

`apps/cli/spikes/p2-s6-packaging.mjs` records every run-time resolution the payload makes — 1,665 of
them across two processes on 2026-09-07, the whole module graph plus every data file, captured
through Node's own `node:fs` without naming a single source location — and asserts five things:

1. every file the payload **read** exists inside the artefact, and nothing it owns is looked for and
   missing;
2. nothing resolved falls outside some package's `files` allowlist (`package.json` excepted: npm
   ships it whatever `files` says, and `version.ts` reads it at startup);
3. no `.ts` source is resolved out of a package's build output, and none is among the arguments the
   payload spawns;
4. nothing is resolved from the checkout the artefact was built in;
5. the artefact answers `--version` with no `node` on `PATH` and with no environment at all.

It does **not** assert the six `import.meta.url` sites. They are how *today's* payload reaches its
data; the assertion is that the data is reachable, whatever the sites become. A refactor that moves
one of them cannot fail this gate by tidying, and a bundler that stops emptying them cannot fail it
by improving.

Rule 3 names `dist/` rather than every `.ts` on purpose. `render-core`'s
`template/remotion.config.ts` is shipped deliberately and copied into a user's Remotion workspace,
where that workspace's own toolchain compiles it; the spike reports it as data. A `.ts` inside
`dist/` is the other thing entirely — it is `daemon/workers.ts`'s Vitest fallback, and a published
payload cannot run it: Node refuses to strip types under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, measured 2026-09-07 by deleting the compiled worker
from the artefact and shipping the sources instead).

---

## The recipe

**It does not run as written** — measurement 1 stops it at step 0 — and it is kept because it is the
record of how the SEA decision was reached, and of what a later phase would have to fix first.
Producing, signing and shipping real binaries is roadmap phase 2 work; this file is the same kind of
deliberately-manual artefact as `services/tts-sidecar/packaging/`, and spec §Non-Goals scopes both
out of the scaffold.

The intended output is one file per OS and architecture that runs `xplainer` on a machine with no
Node.js installed. It is the Node binary with a blob of your application appended to it, so it is
large (roughly 110 MB before compression) and it is not cross-compilable: **each target must be
built on that target's OS and CPU**, or built against a Node binary downloaded for that platform.

Toolchain, pinned to what this repository already uses:

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | 24.20.0 (`.node-version`) | The binary you copy *is* the runtime users get. |
| esbuild | 0.28.2 | Bundles the workspace graph into the one file SEA accepts. |
| postject | 1.0.0-alpha.6 | Injects the blob. Still the tool the Node docs name. |

### Step 0 — build, then bundle (all platforms)

SEA loads exactly one script and, as of Node 24, that script must be CommonJS. `dist/bin.js`
is neither: it is ESM and it imports `@xplainer/mcp-server`, `@xplainer/protocol`, `hono`,
`@hono/node-server`, `@modelcontextprotocol/sdk` and `commander` from the workspace. So the
build output has to be bundled and down-levelled first.

```sh
pnpm --filter @xplainer/cli build
mkdir -p apps/cli/packaging/out
pnpm dlx esbuild@0.28.2 apps/cli/dist/bin.js \
  --bundle \
  --platform=node \
  --target=node24 \
  --format=cjs \
  --outfile=apps/cli/packaging/out/xplainer.cjs
```

**This is the command that exits 1** (measurement 1). Two things would have to land before the rest
of this file is reachable: the top-level `await` in `src/bin.ts` has to go, and all six
`import.meta.url` sites need a bundler-safe answer (measurement 2) — which for the two that resolve
*directories* means SEA assets or a second file beside the binary, not a `--define`.

`out/` is already in the root `.gitignore`, so nothing a release run produces can be
committed by accident.

Then write the SEA configuration — it belongs to a release run, not to version control:

```sh
cat > apps/cli/packaging/out/sea-config.json <<'JSON'
{
  "main": "xplainer.cjs",
  "output": "xplainer.blob",
  "disableExperimentalSEAWarning": true
}
JSON
cd apps/cli/packaging/out && node --experimental-sea-config sea-config.json
```

That writes `xplainer.blob`. Every platform below starts from it. The sentinel fuse string
is the same on all platforms and is chosen by Node, not by us:

```
NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

### macOS (arm64 and x64)

macOS refuses to run a binary whose signature no longer matches its contents, so the existing
signature is removed before injection and an ad-hoc one is applied after. Skipping either
step gives a binary that is killed on launch with `SIGKILL` and no useful message. Run this
on an Apple-silicon Mac for `arm64` and on an Intel Mac (or under Rosetta with an x64 Node)
for `x64`; there is no cross-compile.

```sh
cp "$(command -v node)" xplainer
codesign --remove-signature xplainer
pnpm dlx postject@1.0.0-alpha.6 xplainer NODE_SEA_BLOB xplainer.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA
codesign --sign - xplainer
./xplainer --version
```

`--macho-segment-name NODE_SEA` is required on macOS and rejected everywhere else. The
`codesign --sign -` is ad-hoc: it satisfies the loader, it is not notarisation, and it will
still show Gatekeeper warnings on another machine. Signing and notarisation are phase-2 work
and deliberately out of scope here (spec §Non-Goals).

### Linux (x64)

No signature to strip and none to reapply:

```sh
cp "$(command -v node)" xplainer
pnpm dlx postject@1.0.0-alpha.6 xplainer NODE_SEA_BLOB xplainer.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
chmod +x xplainer
./xplainer --version
```

Build on the oldest glibc you intend to support — the copied Node binary carries that
constraint with it. `node:24-bookworm-slim`, the base image `services/media-service` already
uses, is a reasonable floor.

### Windows (x64)

PowerShell, and no signing in this phase — the installers this repository produces are
unsigned by design (spec §Non-Goals, AC-4):

```powershell
Copy-Item (Get-Command node).Source -Destination xplainer.exe
pnpm dlx postject@1.0.0-alpha.6 xplainer.exe NODE_SEA_BLOB xplainer.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
.\xplainer.exe --version
```

If the executable is later Authenticode-signed, the signature must be removed with
`signtool remove /s xplainer.exe` before injection and reapplied afterwards, for the same
reason macOS needs it.

---

## One gap this recipe does not paper over

`src/version.ts` reads `apps/cli/package.json` relative to its own module URL, which is a
real file both in the source tree and in `dist/`, and which AC-14a depends on. Inside a
single executable there is no such file.

Two fixes were written down here, and both are still phase-2 decisions with consequences rather
than one-liners to bury in a build script:

- **Bake it in.** Add a build-time constant (esbuild `--define`) that `version.ts` prefers
  when set, falling back to the file read. Cheap, but it puts a bundler-specific branch in
  product code that only the packaging path exercises.
- **Ship it as a SEA asset.** Declare `"assets": { "package.json": "../package.json" }` in
  `sea-config.json` and read it through `node:sea`'s `getAsset()`. Truer to the mechanism,
  and it drags an experimental Node API into a module every other surface imports.

**An earlier version of this file closed that list by saying a binary from this recipe "answers
`serve`, `--help` and the three deferred commands correctly, and answers `--version` only when a
`package.json` sits one directory above it". That is false, in three separate ways, and each one is
measured above.**

1. **No binary comes out of this recipe at all.** The bundle step exits 1 before anything is
   written (measurement 1), so there is nothing to run.
2. **The bundle that does build answers nothing.** With the `await` removed, `import.meta.url` is
   `undefined` rather than wrong, `new URL("../package.json", undefined)` throws `TypeError: Invalid
   URL`, and `CLI_VERSION` is computed at *module scope* — so the throw happens while the bundle is
   still loading, before any command runs. `--version`, `--help` and every other command exit 1
   identically (measurement 3).
3. **A `package.json` one directory above does not help.** There is no lookup to redirect; the URL
   constructor rejects an `undefined` base (measurement 3, third run).

And even with `version.ts` fixed by either bullet above, `scaffold/index.ts` and `workspace.ts`
would still resolve **directories** through emptied `import.meta.url` (measurement 2), so
`explainer_create` and `setup --workspace` would fail next. A single-file binary needs an answer for
data directories, not just for one manifest.

## Checking the result

There is no binary to check. The relocated-directory payload — the artefact phase 2 actually ships,
per the plan's §2.1 — is checked by the spike, which is the mechanised form of exactly these three
commands (AC-14a, AC-14b, AC-14c):

```sh
node apps/cli/spikes/p2-s6-packaging.mjs
```

against a payload it assembles itself, with no `node` on `PATH` and no environment at all. If a real
SEA binary is ever produced, the same three commands are what it has to answer:

```sh
./xplainer --version            # the version in apps/cli/package.json
./xplainer --help               # serve, status, mcp, setup, connect, daemon
./xplainer serve --port 8787 &  # then: curl -sf localhost:8787/healthz
```

## When this becomes automatic

Phase 2 of `docs/ROADMAP.md` owns the artefact that actually ships, and on the evidence above it is
the relocatable directory rather than a single executable: it needs no bundler, no `import.meta`
rewrite and no SEA asset API, and it is measured working today. Should a single-file binary be
wanted later, it is a matrix over `macos-14` (arm64), `macos-13` (x64), `ubuntu-latest` (x64) and
`windows-latest` (x64) running the steps above and uploading the artefact unsigned, exactly as
`.github/workflows/desktop.yml` already does for the Electron installers — and the two blockers in
measurements 1 and 2 have to be cleared first.
