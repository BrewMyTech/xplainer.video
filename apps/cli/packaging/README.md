# Packaging `xplainer` as a standalone binary

**Nothing in this directory runs in CI, in this phase or by accident.** There is no
workflow, no Turbo task and no `package.json` script that invokes any of it. The recipe is
written down because the decision to use Node's single-executable applications (SEA) rather
than `pkg` or a rewrite is part of the CLI-first runtime decision (ADR 0016), and a decision
nobody can reproduce is not recorded. Producing, signing and shipping real binaries is
roadmap phase 2 work; this file is the same kind of deliberately-manual artefact as
`services/tts-sidecar/packaging/`, and spec §Non-Goals scopes both out of the scaffold.

The output is one file per OS and architecture that runs `xplainer` on a machine with no
Node.js installed. It is the Node binary with a blob of your application appended to it, so
it is large (roughly 110 MB before compression) and it is not cross-compilable: **each
target must be built on that target's OS and CPU**, or built against a Node binary
downloaded for that platform.

Toolchain, pinned to what this repository already uses:

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | 24.20.0 (`.node-version`) | The binary you copy *is* the runtime users get. |
| esbuild | 0.28.2 | Bundles the workspace graph into the one file SEA accepts. |
| postject | 1.0.0-alpha.6 | Injects the blob. Still the tool the Node docs name. |

---

## Step 0 — build, then bundle (all platforms)

SEA loads exactly one script and, as of Node 24, that script must be CommonJS. `dist/bin.js`
is neither: it is ESM and it imports `@xplainer/mcp-server`, `@xplainer/protocol`, `hono`,
`@hono/node-server`, `@modelcontextprotocol/sdk` and `commander` from the workspace. So the
build output has to be bundled and down-levelled first. Skipping this step produces a binary
that fails at startup with `ERR_MODULE_NOT_FOUND`, which is the single most common way this
recipe is got wrong.

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

---

## macOS (arm64 and x64)

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

## Linux (x64)

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

## Windows (x64)

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
single executable there is no such file: Node reports the SEA main script's location as
`process.execPath`, so the lookup lands on `<directory containing the binary>/../package.json`
and `xplainer --version` throws unless a manifest happens to sit there.

This is stated rather than worked around because both fixes are phase-2 decisions with
consequences, not one-liners to bury in a build script:

- **Bake it in.** Add a build-time constant (esbuild `--define`) that `version.ts` prefers
  when set, falling back to the file read. Cheap, but it puts a bundler-specific branch in
  product code that only the packaging path exercises.
- **Ship it as a SEA asset.** Declare `"assets": { "package.json": "../package.json" }` in
  `sea-config.json` and read it through `node:sea`'s `getAsset()`. Truer to the mechanism,
  and it drags an experimental Node API into a module every other surface imports.

Until one of them lands, a binary produced by this recipe answers `serve`, `--help` and the
three deferred commands correctly, and answers `--version` only when a `package.json` sits
one directory above it.

## Checking the result

The same three commands that check the built JavaScript check the binary, which is the point
of writing them down (AC-14a, AC-14b, AC-14c):

```sh
./xplainer --version            # the version in apps/cli/package.json
./xplainer --help               # serve, mcp, setup, connect — and nothing else
./xplainer serve --port 8787 &  # then: curl -sf localhost:8787/healthz
```

## When this becomes automatic

Phase 2 of `docs/ROADMAP.md` owns turning this into a workflow: a matrix over
`macos-14` (arm64), `macos-13` (x64), `ubuntu-latest` (x64) and `windows-latest` (x64), each
running the steps above and uploading the artefact unsigned, exactly as
`.github/workflows/desktop.yml` already does for the Electron installers. Until then the
recipe is run by hand, and this file is the record of how.
