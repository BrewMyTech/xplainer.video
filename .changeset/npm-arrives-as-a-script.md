---
"@xplainer/cli": patch
---

**`xplainer setup` had never once worked on Windows without a staged runtime payload, and the exit
code it failed with is the tell.**

The workspace provider has two routes to `node_modules`, and the `resolve` one — the route a machine
with no staged payload 2 takes — spawned npm's own launcher: `npm` on POSIX, `npm.cmd` on Windows.
On Windows that cannot work at all. Since the CVE-2024-27980 fix (Node ≥18.20.2/20.12.2/21.7.3, so
every version this build supports) libuv's `uv_spawn` refuses a `.bat`/`.cmd` application outright
unless `UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS` is set, and Node sets that flag only for
`shell: true` or `windowsVerbatimArguments: true`. The refusal happens in libuv rather than in JS,
which is why it arrived as a bare errno and why `spawnSync` came back carrying **neither a `status`
nor a `signal`** — no process was created:

```
xplainer setup: workspace: npm.cmd ci --no-audit --no-fund (cwd …\workspace)
xplainer setup: `npm ci` in …\workspace exited without running:
spawnSync npm.cmd EINVAL
```

`WorkspaceRefusal("install-failed")` then mapped that to exit **70**, the "unexpected throw" bucket,
which is the honest reading of what had happened: nobody expected this branch to be able to fail.

**npm is now spawned as a *script* under an explicit *interpreter*, on both routes and on all three
platforms.** The payload route always did this — `<runtime>/bin/node[.exe]` plus
`lib/node_modules/npm/bin/npm-cli.js`, no launcher and no shell — which is precisely why that route
works on Windows and this one did not, and the fix is to make the second route the same shape as the
first. `process.execPath` is the interpreter, because it is the host's own node and it is already
running; and npm's CLI is *located* rather than guessed, by `locateNpmCli()`: beside the interpreter
first — the route supplies that interpreter now, so the npm which shipped beside it is the pair that
was tested together, and it is the answer that does not depend on the `PATH` this route is proved
under a scrubbed copy of (D8) — then beside any `npm` on `PATH`, following a POSIX `npm` symlink onto
the script itself and rejecting a launcher whose real path is not one. Where nothing answers it
**refuses by name**, `no-package-manager` at exit `3`, a precondition this command cannot meet
rather than an internal error.

`shell: true` was rejected outright and not merely passed over. It hands the whole argv to `cmd.exe`
to re-parse, which is the quoting hazard the CVE fix exists for, and a workspace path containing a
space — `C:\Users\RUNNER~1\…` is short, a real user's is not — is exactly where that bites.

A second instance of the same defect went with it: `npm_version` in `workspace.manifest.json` was
read by `spawnSync(install.command, ["--version"])`, which on Windows was one more `npm.cmd` and one
more `EINVAL`, recorded as `"unknown"`. Both routes now read npm's version off the `package.json`
two directories above the CLI script they are about to run, with no spawn at all.

**Why nothing caught it.** `e2e-toolchain.yml`'s Windows leg is green and its D8 phase does run
`setup --workspace`, but out of a relocated payload 1, so `hostRuntimeDir()` answers and the
interpreter-plus-script form is what ran; its later phase sets `XPLAINER_WORKSPACE_PAYLOAD` and takes
the `copy` route, which spawns nothing. The same workflow's `windows-delivery-position` job does run
the CLI out of a checkout, but it refuses at the **browser** — `setup` acquires browser, then speech,
then workspace — and never reaches the provider. And the unit test asserted the launcher rather than
questioning it. `pnpm e2e:speech` is the first thing in this repository to drive the resolve route on
Windows, and it is what found this.

The suite can now say what Windows would be handed without being Windows. `InstallHost` takes the
platform, the interpreter and the `PATH` as arguments — the seam `install/supervisors/`'s three
renderers already take, and the honest one here, because this package mocks nothing — so the `win32`
argv is asserted on every platform: an interpreter and a script, and not one word ending in `.cmd`.
