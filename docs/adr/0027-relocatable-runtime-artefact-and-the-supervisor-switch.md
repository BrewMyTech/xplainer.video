# 0027. The runtime is a relocatable artefact; the installer resolves it locally and the switch rewrites the supervisor artefact

- Status: accepted
- Date: 2026-09-08
- Deciders: @rishavanand
- Settled by: `.omc/plans/ralplan-phase-2.md` — the RALPLAN-DR plan for roadmap phase 2, §6. The
  plan went through **five** review rounds with a Critic and an Architect; §8–§12 of it carry every
  disposition. Round 5 ended with two choices that needed a decision rather than an edit, both
  reviewers recommending the same option in each, and the owner then put both to the external
  Architect (Codex), which **endorsed both** and named one change as the condition of approving
  execution. §Two decisions the owner confirmed records them, the endorsement, and the change.
- Builds on: **[ADR 0020](0020-always-running-local-daemon.md)**, which made the local runtime an
  installed, supervised, per-user daemon and pinned "a copy of the interpreter and the CLI under the
  state directory" as an accepted cost; **[ADR 0025](0025-daemon-updates-and-readiness.md)**, whose
  update sequence and readiness announcement this record's transaction executes;
  **[ADR 0024](0024-durable-jobs-and-boot-reconciliation.md)**, whose drain the switch calls and
  whose durable state directory holds the breaker's history;
  **[ADR 0016](0016-cli-first-local-runtime-desktop-is-an-optional-client.md)**, whose optional
  client this record gives a program to run; and
  **[ADR 0005](0005-download-on-first-run-chrome-headless-shell-and-tts.md)**, whose visible
  first-run acquisition step now materialises a third artefact.
- Amended by dated note, never rewritten: ADR 0025, ADR 0024, ADR 0020, ADR 0013, ADR 0016 and
  ADR 0005 each carry a note of 2026-09-08 pointing here. No accepted body was changed.
- **Every number below is a measurement.** The plan's §7 records each one with the command that
  produced it, and the two platform spikes — `apps/cli/spikes/p2-s4-readiness.mjs` and
  `apps/cli/spikes/p2-s5-drain.mjs` — exit `0` only when their expectations hold. Where a
  measurement comes from a GitHub runner it is named with its run, and §Runner evidence as of
  2026-09-08 says plainly which legs are proven and which are blocked.

## Context and Problem Statement

ADR 0020 decided that the local runtime is an installed, supervised, per-user daemon, and left one
sentence to carry the whole of distribution: the installer pins "a copy of the interpreter and the
CLI under the state directory". ADR 0025 then built an update sequence on top of that copy without
saying what the copy *is*, and ADR 0016 promised a desktop client that "either spawns `xplainer
serve` … or attaches to a daemon URL" without saying what it spawns on a machine that has no Node.

Phase 2's first round of planning took the daemon installer first and the artefact second. Four
measurements refuted that order, and they are recorded in `apps/cli/packaging/README.md` with their
dates:

1. The prescribed CommonJS bundle **does not build** (2026-09-07).
2. With the one top-level `await` removed it builds, and four modules lose `import.meta.url` at
   **six** call sites — two of which resolve *directories* of data files that are then enumerated
   with `readFileSync`, which no bundler can inline (2026-09-07).
3. The bundle that does build **throws at load, on every command** (2026-09-07).
4. A `dist`-only relocated payload **dies at load**, because `protocol` reads `schemas/` and
   `render-core` reads `template/` and `dist/scaffold/templates/*.txt` at run time (2026-09-07).

Only the fifth arrangement worked: a payload built from each package's own `files` allowlist,
relocated, run through its own interpreter (2026-09-07). So the question this record answers is the
one every other phase-2 deliverable depends on and that no earlier record asked: **what exactly is
the thing a supervisor starts, where does it come from on a machine with no Node and no published
package, and what happens to it when it is replaced?**

Two further facts made the question sharper. Both reviewers ran the render path and found it exits
**127** — `env: node: No such file or directory` — because the daemon spawns Remotion's `.bin`
shim, whose first line is `#!/usr/bin/env node`, on the machine whose whole premise is that it has
no `node`. And the owner's constraint for this phase is that **nothing is published to a registry**,
so `npx -y @xplainer/cli` is not an acquisition route and the fallback ADR 0005 implies — "the
workspace's own package manager" — does not exist on the target machine either.

## Decision Drivers

- **No administrator privileges on the supported path.** ADR 0020's design is a user-scope
  supervisor and never root; a distribution mechanism that needs `sudo` would undo it.
- **Boot persistence on a headless Linux VM**, where there is no installer and no desktop session.
- **An interrupted update must leave a recoverable daemon**, which is ADR 0025's requirement and
  cannot be met by a mechanism whose failure modes are unenumerated.
- **A machine with no Node**, which is what makes an interpreter part of the artefact rather than a
  prerequisite of it.
- **Nothing is published this phase.** A dated constraint from the owner, not a permanent property —
  see §Consequences.

## Considered Options

1. **Daemon-install-first** (the first round's order): build the supervisor installer, the update
   transaction and the Electron client, and treat the payload as an implementation detail of each.
2. **Binaries-first**: produce single-executable applications and distribute those.
3. **Desktop-first**: build the client, and let it carry the daemon.
4. **A thin attach-only client**, with no bundled daemon at all.
5. **Distribution-first, over one relocatable artefact** — build and prove the payload, then make
   the installer, the update transaction and the desktop client consumers of it.
6. **Distribution-first, with the Remotion tree carried inside that one artefact.**

## Decision Outcome

Chosen: **option 5 — distribution-first, over two payloads with two lifetimes.**

Option 1 is rejected on measurements 1–4 above: it would have built three distribution mechanisms
around a payload that does not run. Option 2 is refuted by the same measurements, since the binary
is a bundle of the artefact it depends on; single-executable packaging is deferred to phase 4 on
that evidence. Option 3 defers both platform spikes behind user-interface work and delays the
phase's only human-gated criterion. Option 4 fails the roadmap's own P2-1 as worded and strands the
user whose machine has no supported supervisor. Option 6 was measured at about **120 MB** for the
Remotion tree and is rejected because an update would re-ship a tree that did not change, and it
still leaves the browser unacquired.

### The two payloads, and why their lifetimes differ

**Payload 1 — the runtime.** One relocatable directory produced by `xplainer runtime build`, laid
out so that nothing inside it names its own location:

```
<runtime>/
  bin/node[.exe]                        a copy of process.execPath
  bin/npm[.cmd] + lib/node_modules/npm  the package manager setup needs
  lib/node_modules/@xplainer/cli/       package.json + dist/
  lib/node_modules/@xplainer/{mcp-server,protocol,render-core,tts-client}/
  lib/node_modules/<externals>/         the transitive closure of the five runtime dependencies
  runtime.manifest.json                 every path, its sha256, the versions, the launch contract
```

Measured by spike P2-S4 while assembling one into a scratch directory: **5,791 files, 146.7 MB, 102
packages**. It is **per-version**, and an update replaces it.

**Payload 2 — the workspace.** The pinned Remotion tree a render needs, about **120 MB**, assembled
by the same `runtime build` command on the platform it targets — because
`@remotion/compositor-<platform>` is platform-specific. It belongs to the **workspace**, is shared
by every video, is materialised once by `xplainer setup --workspace`, and **an update does not
replace it**.

The split is the decision, not an implementation detail. One payload changes with the application
and the other changes with the render toolchain, and merging them means every daemon update
re-ships 120 MB that did not change.

### What defines the payload, and the six sites that force it

**The payload is defined by each package's own `files` allowlist — the publish contract — and not
by `dist/`.** That single rule is what measurement 4 above would have prevented: `protocol` ships
`schemas`, `render-core` ships `template` and `dist/scaffold/templates/*.txt`, and all three are
read at run time.

The rule is forced by six `import.meta.url` call sites in four modules, which are what let a
*relocated* directory find its own data:

| Module | Target it resolves |
| --- | --- |
| `apps/cli/dist/version.js` | `../package.json` |
| `render-core/dist/scaffold/index.js` | `./templates/` — six `.txt` files |
| `render-core/dist/workspace.js` | `../template/` — four workspace files |
| `apps/cli/dist/daemon/workers.js` (×3) | `../workers/narrate.js`, `../workers/narrate.ts`, `./testing/ts-source-hook.ts` |

Two of the six are the decisive ones: they resolve **directories** that are then listed and read.
`import.meta.url` is intact in a relocatable directory and empty in a bundle, which is why the
artefact is a directory and why the single-executable recipe is deferred rather than adopted.

**They are recorded here and in `apps/cli/packaging/README.md`, and deliberately not asserted.**
The packaging spike (`P2-S6`) asserts what must keep holding — every path the built payload resolves
at run time exists inside it, none falls outside a `files` allowlist, no `.ts` source is among them,
and it answers `--version` with no `node` on `PATH` — so a refactor that moves one of the six cannot
fail the gate by tidying.

### The launch contract, and per-platform settings emission

One typed record every consumer takes, so that no consumer composes an argument vector of its own:

```ts
type LaunchSpec = {
  executable: string;            // <runtime>/bin/node, or the packaged Electron binary
  argv: readonly string[];       // [<runtime>/lib/.../cli/dist/bin.js, "serve", "--port", "8787"]
  settings: Readonly<{ stateDir: string; tokenFile: string; socket: string }>;
  cwd: string;
};
```

**`settings` is not an environment map, and that distinction is load-bearing.** An earlier round
carried `env: Record<string, string>` and claimed a shared record made a dropped setting a type
error. It does not: a shared record makes the *record* complete and says nothing about *emission*.
Task Scheduler's `<Exec>` action carries `Command`, `Arguments` and `WorkingDirectory` and has **no
per-action environment map**, while `state-dir.ts` and `token.ts` read `XPLAINER_STATE_DIR` and
`XPLAINER_TOKEN_FILE` from the environment only — so on Windows an installed daemon would have
silently fallen back to the platform defaults while `daemon.json` recorded something else.

**The rule as built is one rule, and it is simpler than the per-platform table an earlier round
wrote.** All three settings are emitted as **argv on every platform**, because no `XPLAINER_SOCKET`
variable exists to carry the third; `Environment=` and `EnvironmentVariables` keep the state
directory and the token file beside them where the platform has them. `serve` therefore gained
`--state-dir` and `--token-file` beside `--socket`, and a golden test per platform **fails when any
one setting is dropped**. Putting a path in `<Arguments>` makes it visible to
`Get-ScheduledTaskInfo`, which is the same cost ADR 0020's R-SEC-6 already weighs for
`/proc/<pid>/cmdline`; it is a *path* and never the token value, so R-SEC-6's rule is unbroken.

### The stable launcher

`install` also writes **`<state>/bin/xplainer[.cmd]`**, a generated two-line launcher that execs the
current runtime's `bin/node` and `dist/bin.js`. Every consumer that needs a name surviving an update
takes that path — `connect`'s written entry, the desktop's shell-outs and `attach.ts`'s skew
remediation — because a runtime directory is named `<version>-<digest>` and the next update points
that name at a directory that no longer exists.

Both lines are load-bearing. On POSIX the second is `exec "<interpreter>" "<entry>" "$@"`, and
`exec` is what makes the launcher cost nothing: measured, a shell that `exec`s keeps the **same
pid**, so signals, process groups and a supervisor's accounting all reach the daemon exactly as they
would without it. On Windows the file is `xplainer.cmd`; `cmd.exe` has no `exec`, so the launcher is
a parent there and its exit status is the child's. The launcher is written with its mode set on the
temporary file, so the rename publishes something already runnable rather than a `0600` file that a
consumer could catch mid-chmod.

**A claim an earlier round made here is withdrawn on measurement.** A launcher was said to add a
second process with an identity of its own; the `exec` measurement above shows it costs no identity
at all. The preference for rewriting rather than indirecting stands on the one reason that survives
— see §The switch.

### Where the installed program comes from

One resolver, `apps/cli/src/install/program.ts`, recording its answer in `daemon.json` as
`program_source`:

| `program_source` | Source | Needs a publish? | Chosen when |
|---|---|---|---|
| `runtime-dir` **(the phase-2 default)** | A payload-1 artefact staged at `<state>/runtime/<version>-<digest>/` | **No** — assembled from the local checkout's build output | Always, unless overridden |
| `explicit` | `install --program <absolute path>`, verbatim after a preflight | **No** | `--program` given |
| `sea-binary` | A single executable staged by `install --from-binary <path>` | **No** | Accepted and **refused** this phase: nothing stages a SEA yet |
| `package-manager` | A global install, pinned by copy exactly as `runtime-dir` does | Yes | **Not implemented this phase** |

**What one value changes when a publish happens.** `package-manager` gains a body whose only job is
to locate the installed package and hand its directory to the *same* assembler. The assembler, the
launch contract, the renderers, the update transaction and the consistency check are unchanged,
because none of them knows where the payload came from. That is the point of routing every path
through one resolver: the no-publish constraint costs one unimplemented branch, not a design.

### The switch rewrites the supervisor artefact

**Decision: an update rewrites the supervisor artefact**, and every other thing that must change with
it — the stable launcher, the mirrored task XML — is the same operation on a different small file:
`temp → rename` in the target's own directory, one transition inside the update transaction,
followed by the platform's reload command. One mechanism everywhere.

The alternative was a stable indirection — a symlink or junction the supervisor names, flipped to
point at the new runtime. It was rejected on argument in an earlier round, the Critic asked for a
measurement, and here it is: `rename(2)` through `fs.renameSync` **does** replace a symlink
atomically on POSIX, and the obvious shell idiom for the same flip — `ln -sfn new tmp && mv -f tmp
current` — **silently writes into the old runtime directory** when `current` points at a directory,
leaving the link untouched.

**That experiment is recorded for exactly what it showed and for nothing else.** It shows the
indirection *is* reachable on POSIX, through one call, and that the obvious way to write it is
wrong. It is not evidence about Windows, and it is not evidence about a launcher that reads a
version record.

**So the rejection rests on two reasons, both true and both checkable.** One: a single mechanism
for four artefacts is fewer failure modes than two mechanisms for four. Two: the rewrite is the
operation three of those four already need, so choosing it adds nothing that was not already
there. An earlier round also rejected the indirection on an unmeasured
assertion about Windows atomicity; that half of the argument is **withdrawn rather than defended**,
and Windows moved to a runner in the same round. What replaces it is a measurement:
`.github/workflows/daemon-windows.yml` runs a probe that writes a target, writes a temporary file
beside it and calls `fs.renameSync` over the existing target, and on `windows-latest` on 2026-09-08
it **replaced the file** and the probe printed its `check:` line. The launcher rewrite depends on
that behaviour, which is why it is measured on the platform rather than assumed from POSIX.

**Reading configuration back is not a parse ban.** `daemon status` is never built from a parsed
supervisor, and the update's consistency check reads the **loaded** configuration to catch a failed
switch. The narrow rule that reconciles those: `launchctl print` is the surface its own manual
disowns — "This output is NOT API in any sense at all" — and nothing depends on it, while
`systemctl --user show -p ExecStart --value` and `Get-ScheduledTask` are documented
machine-readable queries and are used.

### D1 — Remotion is resolved and spawned through the runtime's own interpreter

`node_modules/@remotion/cli/remotion-cli.js` begins `#!/usr/bin/env node`, and the daemon spawned
the `.bin/remotion` shim directly. Measured under `PATH=/usr/bin:/bin`: exit **127**, `env: node: No
such file or directory`. This is not a harness artefact — the rendered unit and plist set no `PATH`,
a systemd user unit's default is `/usr/local/bin:/usr/bin:/bin`, and the premise of the design is a
machine with no Node. So `--version`, `serve`, `/healthz` and `explainer_create` all passed while
**every render exited 127**.

*Chosen:* resolve `@remotion/cli`'s `bin` entry to its real file and spawn
`<runtime>/bin/node <entry>`, which is the pattern the narration worker already used
(`command: process.execPath`). Resolution goes through the package's own `bin` field rather than
through the `.bin` shim, so the Windows `.cmd` case needs no special path.

*Rejected:* prepending `<runtime>/bin` to the render worker's `PATH`. It is one line smaller and it
**leaks an interpreter onto the `PATH` of everything the worker spawns, Chrome and ffmpeg included**.

### D2 and D11 — payload 2 is resolved from the template's pins, against a committed lockfile

An earlier round said payload 2 was "copied from the hoisted tree". The hoisted tree is not the
template's tree:

| Package | Template pin | Hoisted |
|---|---|---|
| `react`, `react-dom` | 19.2.3 | **19.2.8** |
| `tailwindcss` | 4.0.0 | **4.2.0** |
| `zod` | undeclared | **4.5.4**, where Remotion requires 4.3.6 |

Remotion polices the last one itself: `remotion versions` prints "Version mismatch … zod: installed
4.5.4, required 4.3.6" and **exits 1**. So the copied payload was one Remotion's own guard rejects.
(`remotion --version` is not a subcommand and exits `1` on any tree, which is what made an earlier
assertion fail on correct work; the subcommand is `versions`.)

*Chosen:* payload 2 is produced by a **real install** of `template/package.json` into a staging
directory, and `workspace.manifest.json` records every resolved version. **`zod` joins the
template's pins at 4.3.6**, because a dependency Remotion requires and the template does not declare
is a version nobody controls. `runtime verify --workspace` compares the manifest against the
template's pins, so a skew is a named failure rather than an exit 1 inside a render.

**The lockfile is `packages/render-core/template/package-lock.json`, npm's format, and both ends run
`npm ci`** — never `npm install`. `ci` requires the lockfile to be in sync and removes
`node_modules` first, which is what reproducibility means here, while `install` may rewrite the
lockfile on a user's machine and silently defeat it. Build time uses the repository's npm; setup
time uses payload 1's. Three interactions, each checked rather than assumed:

- **The pnpm workspace does not contain it.** `pnpm-workspace.yaml` globs `apps/*`, `packages/*` and
  `services/*`; `packages/render-core/template` is one level deeper and is not a member — verified
  with `pnpm ls -r --depth -1`. A foreign-format lockfile there is inert to
  `pnpm install --frozen-lockfile`.
- **It ships, deliberately.** `render-core`'s `files` allowlist already contains `template`, so the
  lockfile is published inside `@xplainer/render-core` — correct, because it is **data the user's
  `setup` reads**, exactly like `template/package.json` beside it.
- **`check:publish-contract` gains one `MUST_SHIP_FILES` row, not an exemption.** The two lists mean
  opposite things — *must be present in the tarball* versus *permitted to break a rule* — and the
  lockfile's whole argument is that it must be present.

### D3 and D8 — npm rides inside payload 1, and the install subprocess gets a scoped `PATH`

The installer omits payload 2 by design, nothing is published, and the documented fallback ran "the
workspace's own package manager" — which payload 1 did not contain, on a machine whose premise is
that it has no Node. A desktop user could install, spawn, narrate and never render.

*Chosen:* the assembler copies `<node root>/lib/node_modules/npm` and its `bin` shim into payload 1,
measured at **17 MB** against the runtime's 146.7 MB. `setup --workspace` then has two real routes —
copy a staged payload 2 where one exists, else resolve the template's pins with the shipped npm —
and both end at the same verified manifest.

*Rejected:* shipping payload 2 inside the installer (about 265 MB, against ADR 0005's "installers
stay small enough to be worth signing"); publishing it (nothing is published this phase); and
recording desktop rendering as pending, which would hollow out three roadmap criteria together.

**This makes first-run rendering need a network**, which is exactly ADR 0005's contract for the
other two artefacts, and it is stated rather than discovered.

Both reviewers then ran that route, and it exits **127** one layer down:

```
npm error path .../node_modules/esbuild
npm error command sh -c node install.js
npm error sh: node: command not found
```

npm runs lifecycle scripts through `sh -c`, and third-party scripts call bare `node` — `esbuild`'s
`postinstall` here, reached through the Remotion tree's 268 packages. `npm ci` aborts, so
`setup --workspace` left **no workspace at all**, on exactly the machine the shipped npm exists for.

*Chosen:* the install subprocess is spawned with `PATH=<runtime>/bin<delimiter><inherited PATH>` and
nothing else changed — `path.delimiter`, because Windows uses `;`. Measured: `npm ci` then exits
`0`, and the resulting tree passes `remotion versions` under a **scrubbed** `PATH` afterwards.

**Why this does not reopen D1.** D1 rejected `PATH` injection for the **render workers** on one
stated ground: it leaks an interpreter onto the `PATH` of everything the worker spawns, Chrome and
ffmpeg included. The install subprocess spawns neither. It spawns npm, which spawns `sh -c` package
scripts, and every one of those *wants* the interpreter it is being given — that is the failure being
fixed. The scope is one process tree, for the duration of one install, in the one place where a
missing `node` is the bug rather than a leak. Render workers keep D1's rule unchanged.

*Rejected:* `npm ci --ignore-scripts`, which also exits `0` here. It makes the workspace's
completeness depend on no package in a 268-package tree needing its install script — true of
`esbuild` today because its platform binary arrives as an optional dependency rather than as a
script product, and an assumption that would fail silently and much later.

### D4, D9 and decision A — the update refuses rather than pairs

Payload 2 survives updates by design, and the first compatibility check written for it was a
render-time refusal inside the worker factory — so an update could report success, keep `/healthz`
green, and leave the next render broken.

*First form (D4):* a **pre-drain** check comparing the incoming runtime's `template/package.json`
**pins** against the installed runtime's pins and against the recorded workspace — pins, not the
template's version string, which is `1.0.0` and need not change when a pin does. On mismatch, exit
with nothing written and nothing drained. It also allowed a paired path: proceed when a matching
payload 2 is staged beside the new runtime.

*The paired path is dropped (D9).* It made the workspace part of an update without making it part of
the transaction: the transaction retains and journals only the previous **runtime**, so if B fails
readiness, payload 1 rolls back to A and B's workspace stays. A then cannot render — while
`/healthz` is green and every rollback assertion passes.

**Decision as built: refusal only, this phase.** `daemon update` compares the incoming runtime's
template pins against the recorded workspace **and** against the installed runtime's, and on
mismatch exits **`PRECONDITION_UNMET_EXIT_CODE` (`3`)** — the constant `exit-codes.ts` already
exports, not a new one — having written nothing, staged nothing and drained nothing, with the daemon
still serving. **The precondition is three-way**, and that is the change the external Architect made
the condition of its endorsement: a check that compared only *B against the workspace* **passes in
the case that matters**, because a user who has already run `setup --workspace` has a workspace
matching B, while the rollback target **A** is exactly what that workspace no longer satisfies.

**The refusal names a reinstall, not an ordered pair.** An earlier wording told the user to run
`xplainer setup --workspace` and then `xplainer daemon install`. Both reviewers found that pair
**cannot execute**: `xplainer` there is the stable launcher, which execs the **installed** runtime A,
and every runtime carries its own `template/`, so `setup --workspace` re-resolves **A's** pins and
the update refuses again. So the message says plainly that a pin-changing upgrade is a reinstall this
phase, and names the program to run it from — the **new** runtime's own — because the installed
launcher is precisely the thing that cannot do it.

*Rejected:* staging and switching payload 2 inside the transaction with a retained previous copy. It
is the right long-term shape and it doubles the transaction's state — a second retained tree, a
second switch, a second rollback and a second recovery boundary — for a case this phase meets with a
refusal. **It is the successor's work, deferred and named here rather than omitted.**

*Also rejected:* adding `setup --workspace --from <runtime dir>` so the ordered pair executes. It
makes the pair work and leaves the rollback hole open — a pin-changing rollback would still land on a
daemon that cannot render — so it would buy a working command sequence and a weakened assertion.

**The invariant the rest of the design rests on:** within the supported class the installed workspace
must satisfy **both** A and B, which is what makes the "the rolled-back daemon must render"
assertion satisfiable rather than merely desirable. Recovery from an interrupted update is
**commanded, not automatic**, because a daemon that exited `0` gave the portable "do not restart"
signal on all three supervisors.

### D10 — the desktop resolves its program in two stages

Every shell-out was routed through the stable launcher, which `install` writes. So "start xplainer at
login" shelled out to `daemon install` through a file that `daemon install` creates: unreachable on a
clean machine, and **permanently** unreachable for the user ADR 0020 cares most about — the one with
no supported supervisor, who never installs.

*Chosen:* the packaged app carries payload 1 as `extraResources`, and payload 1 carries its own
interpreter, so pre-install commands — `status --json`, `setup`, `daemon install`, `connect` — are
spawned as

```
<resources>/xplainer-runtime/bin/node <resources>/xplainer-runtime/lib/node_modules/@xplainer/cli/dist/bin.js <argv…>
```

and the app switches to `<state>/bin/xplainer` **only after `install` has written it**, which
`status --json` reports: the state directory arrives in the report, and the launcher is looked for in
the `bin/` beside it. `daemon install` is the only thing that writes that file, so its presence at
the reported path is the report's own account of an install having happened.

**`ELECTRON_RUN_AS_NODE` is not used.** ADR 0016 anticipated it; it existed so the app would not need
Node on the user's machine, and payload 1 now supplies one. The consequence worth having is that the
pre-install and post-install paths run the *same* interpreter and the same entry, so the app is not
exercising a second code path in the case that is hardest to test.

### `token_origin`

ADR 0020's R-SEC-9 requires "a non-default token" for a non-loopback bind, and **the value cannot
answer that**: the mint is 32 random bytes and so is a good operator token. So the answer is
*provenance*, recorded in `daemon.json` as `token_origin` so the next start inherits it:

1. **This start minted the file** → `minted`, unconditionally.
2. **`daemon.json` records this same path** → the recorded origin, or `minted` where none was
   recorded. An unrecorded origin at a recorded path is a state directory a release older than this
   field served, and every such release minted its own token into the path it recorded. Reading it as
   the operator's would let an upgrade turn the daemon's own default into a credential R-SEC-9
   accepts.
3. **Any other path** → `operator`. This is the correction of 2026-09-08 and it is what makes the
   record a fact about a **file** rather than about a directory: a record saying "the token in
   `<state>/token` is mine" says nothing about the token in `/etc/xplainer/token` that `--token-file`
   just named. Inheriting it there refused the operator's own token for ever, and the refusal said
   the daemon had minted a file it never wrote, which is the worse half.

Every uncertainty **about the recorded file** falls towards `minted`, because `minted` is the answer
that refuses the remote bind. A file at a path this state directory has never recorded is not an
uncertainty: nothing here ever wrote it. `inspectTokenPresence` gives the third answer — `absent` —
*before* the mint, so a remote bind that would be refused is never the reason a token file exists.

This is a **new decision taken by this record**, not a correction of ADR 0020: that record stated the
requirement and left the discriminator unspecified.

### The per-user Windows task name

The task is registered as **`\xplainer\<user>-daemon`**, taking its last segment from the qualified
`DOMAIN\user` account the daemon runs as, and refusing an account whose user part is blank or carries
any of `\ / : * ? " < > |`. A single fixed name would have meant that two users on one machine could
not both register one, which is the same per-user premise ADR 0020's whole design rests on. This
**supersedes the fixed name earlier planning used**, and ADR 0020's dated note of 2026-09-08 records
the supersession rather than being rewritten.

### D6 — the breaker records outcomes, and what it does with a start that recorded none

ADR 0020 words the breaker as "if the last five runs all failed within 30 seconds of starting". The
first implementation inferred both halves: a run failed if its entry had no `ready_at`, and it failed
*fast* if the **next** run started within 30 s of it. **The second inference measured the
supervisor's retry cadence rather than the run's own life**, so a supervisor that spaces its retries
wider than the window could never trip the breaker at all — launchd's `ThrottleInterval` is 30 s,
which sits exactly on the boundary, and Task Scheduler's `<RestartOnFailure>` has a one-minute schema
minimum, which is outside it.

**Decision: each run records its own end.** `recentStarts[]` is durable, in `daemon.json` rather than
the ephemeral file, and carries per run:

- `ready_at` — stamped the moment the listeners are bound. A run that has one did not fail to start,
  however it ended afterwards.
- `outcome` and `ended_at` — written from the run's own orderly end. `failed` is a run that ended
  without ever announcing itself; `stopped` is one that had announced itself first.
- **neither** — the run was `SIGKILL`ed, panicked, or the machine lost power, so it wrote no epitaph.

**The unknown-outcome policy is the half a test cannot be written without.** Such a start counts as a
failure **only when its process is provably gone and the next recorded start began within 30,000 ms
of its own `started_at`**, because the next start is the only sound upper bound on when it died, and
it **resets the streak otherwise**. Each start persists an identity tuple — pid, start time, boot id
— beside its record, which is what lets a later start establish "provably gone" without a file a
pre-readiness death never wrote; the ephemeral `runtime.json` cannot corroborate it, because it is
written only from the readiness path and this rule is only ever about pre-readiness deaths. It is not
the inference that was removed: that one inferred an end where one could have been recorded, and this
one bounds an end that provably was not.

**Every interval is validated before it is used.** `started_at` is wall clock, so a backward NTP
correction, a VM resume or an operator can invert or shrink a real interval. **A negative or
non-finite interval is timing-uncertain and resets the streak** rather than counting it. The
residual is stated rather than papered over: **a backward adjustment that leaves a finite interval
between zero and 30 seconds is indistinguishable from a genuine fast failure and may over-count.** A
monotonic clock would close it and is not this phase's; the spurious latch it could produce is
cleared by `xplainer daemon restart`.

The boundary is inclusive and measured: **30,000 ms is fast and 30,001 ms is not**, which is why
launchd's 30-second `ThrottleInterval` sits exactly on it. Five consecutive such starts latch, and
the daemon then exits `0` — the portable "do not restart" signal on all three supervisors.

### D5 and D7 — two smaller decisions this record carries

**D5 — the P2-S5 spike carries its own stub listener.** The spike asked for the drain through a route
built two batches later, and only Linux has a signal fallback while Windows is in the table precisely
because it has none. So the harness binds its own socket — a named pipe on Windows — with a fixture
route that runs a fake drain. What the spike measures is **supervisor** behaviour, and none of that
needs the production route. The fixture is spike-only and never ships.

**D7 — on macOS the responding identity is the drift detector, and that is a stated limitation.** The
update's consistency check reads the **loaded** configuration back on Linux and Windows through
documented queries. macOS has no such query: `launchctl print` exposes `program` and `arguments` and
also interleaves duplicate keys and `state = active` lines *inside* the `arguments` block, which is
the unstable structure its manual's "Do NOT rely on the structure … for ANY reason" is warning about.
So the row is **unavailable on macOS**, and `/healthz` advertising `run_id` and `runtime_digest` is
what closes it: the responding identity is asserted by the process that is answering rather than read
out of a state file, so a plist rewritten and not reloaded is still caught. What is lost on macOS is
only the ability to name the failure as a *configuration* mismatch rather than an *identity* one.
That is a limitation of the platform's own interfaces, recorded as a consequence rather than a defect
to fix later.

### Two decisions the owner confirmed, and the external Architect endorsed

After five review rounds two choices remained that needed a decision rather than an edit. Both
reviewers recommended the same option in each; the owner put both to the external Architect (Codex),
which **endorsed both** and named one change as the condition of approving execution.

**Decision A — workspace-changing (template-pin-changing) updates are unsupported this phase.** The
refusal, its exit code and its message are §D4, D9 and decision A above. *Endorsed with a change:*
"endorse refusing pin-changing updates, but make the update enforce compatibility with **both**
runtimes explicitly" — the three-way precondition recorded there, which is what stops the check
passing in the one case that matters.

**Decision B — macOS x64 desktop artefacts are dropped this phase.** `electron-builder.yml` built
`dmg` and `zip` for arm64 **and** x64; `xplainer runtime build` copies `process.execPath`, the build
host's own interpreter; and `macos-latest` is arm64. The x64 artefacts would therefore have shipped an
**arm64** `node` inside payload 1 and failed to spawn on an Intel Mac — and no criterion catches it,
because one asks only that installers build green and the other runs the payload on the runner that
built it. *Chosen:* the mac target becomes **arm64 only**, and the runtime manifest records the
**interpreter's architecture** beside the platform it already records, so a payload/host mismatch is a
named `runtime verify` failure rather than a spawn error on a user's machine. Two corrections came
with the endorsement and are applied: the architecture check runs **from an already-compatible
process before the candidate interpreter is spawned**, because an incompatible interpreter cannot
execute its own verifier, and the check is an assertion rather than a comment.

*Rejected:* shipping the x64 artefacts as they are. An installer that builds green and cannot start
its daemon is the failure class this plan exists to prevent, and dropping a target is honest where
shipping a broken one is not.

**Both are reversible, and what each costs a user is in §Consequences rather than in a footnote.**

## Consequences

- **About 265 MB for a full install before the browser** — roughly 146.7 MB per installed runtime,
  plus a retained previous copy during an update, plus about 120 MB once for the workspace, which an
  update does not replace. The desktop installer ships payload 1 only, so it stays the size ADR 0005
  wanted.
- **`daemon.json` grows nine fields `serve` must preserve and not own**, and the split between its
  two writers is by field: `serve` owns what a *run* establishes, `daemon install` owns what an
  *installation* establishes, and every write is a read-modify-write that preserves keys it does not
  name.
- **`serve` grows three options** — `--state-dir`, `--token-file`, `--socket` — because Task
  Scheduler has no environment map.
- **Two new top-level commands, `runtime` and `token`**, which changes the asserted command surface.
- **Payload verification has two modes, and that is a consequence of the two lifetimes.** Payload 1
  is verified **exhaustively**: a file the manifest does not describe is an integrity failure.
  Payload 2 is a *live* directory — a render writes caches, `setup` leaves configuration — so it is
  verified in **described** mode: every manifest entry must match, and an undescribed file is
  permitted **unless it shadows a described one**, a package copy nested under a described top-level
  package. Verifying the workspace exhaustively refused every real workspace, which is how the
  distinction was found.
- **What decision A costs a user, stated and not softened.** Every update that changes a template
  dependency pin returns exit `3`, an unchanged daemon, and instructions naming the new runtime's own
  `setup` and `install`. How often depends on how often pins change, and nothing here sets a cadence
  for that. The reinstall interrupts service and carries **no workspace rollback guarantee** — if it
  goes wrong, the workspace is not restored. Same-pin updates keep the full transaction, the recovery
  command and the render-after-rollback requirement.
- **What decision B costs a user, in the Architect's own terms.** Every Intel Mac user who wants a
  phase-2 desktop installation has **no supported installer for the whole phase**. That is
  unavailable platform support, not an occasional failure; Apple Silicon users are unaffected. It is
  a **prioritisation choice rather than a technical limit** — GitHub supplies Intel runners, and a
  native x64 build on one would copy its own `process.execPath` exactly as the arm64 build does. The
  phase declines the extra build and verification scope and says so here.
- **On macOS, configuration drift is detected as an identity mismatch and cannot be named as a
  configuration one** (D7 above). Stated limitation, not a defect.
- **`apps/cli/packaging/README.md` is corrected and relabelled**: it is the record of five packaging
  measurements and the recipe that is deferred, not an instruction to build a binary today.
- **One behaviour is accepted rather than engineered around.** If the updater dies between the drain
  and the restart, on Linux and macOS **nothing is running until a named recovery command is run**,
  because the daemon exited `0` and that is the portable "do not restart" signal. Windows' `PT5M`
  repetition restores automatically only at boundaries where the old runtime is still the registered
  one.

### Dated context: nothing is published to a registry, as of 2026-09-08

**This is a dated constraint of the owner's, and it is not a decision this record takes.** As of
2026-09-08 nothing is published to npm and nothing is published to the R2 bucket, so:

- `npx -y @xplainer/cli mcp` — the command both plugin bundles declare — **does not work**, and
  ADR 0013 already bars submission until `xplainer mcp` is real. It is real; the *package* is not.
  ADR 0013 carries a dated note recording that the bar is now on the publish.
- `connect`'s `npx` fallback is **not dead code** — it is the path a runtime-directory install would
  otherwise take, because a runtime directory under the state directory is not on `PATH`. `connect`
  writes the stable launcher's path instead, and never `npx` and never a version-scoped directory.
- The skew remediation names the launcher and the local update command rather than
  `npm i -g @xplainer/cli@<version>`, which no machine in this phase can run.
- The toolchain manifest is **not a trust anchor**: it records the expected Chrome digest captured at
  manifest-build time, and the speech `bundle` route has nothing published to fetch.

**When the publish happens, one resolver branch acquires a body and these four sentences change.**
Nothing above them does. That is the whole reason the constraint is recorded here as context with a
date rather than as a decision: a reader in six months must be able to tell which parts of this
record were chosen and which were merely true at the time.

### Runner evidence as of 2026-09-08

Recorded honestly, because a record that implied the whole matrix was green would be the thing this
phase's principles exist to prevent.

**Proven on GitHub runners.** The two platform spikes exit `0` on `ubuntu-latest`, and P2-S5 also on
`windows-latest` (run 34166469014). The runtime gate — assemble the payload, run it through its own
interpreter with no `node` on `PATH` — is green on **ubuntu, macOS and Windows** (run 34166471340).
The lifecycle, restart, breaker, update and identity proofs are green against **real systemd** on
ubuntu and **real launchd** on macOS, including a supervisor restart during a job, the
`ThrottleInterval` and `RestartSec` latches, the update transaction and the identity check. On
Windows, four legs are green: process-group containment, the `fs.renameSync`-over-an-existing-file
probe the launcher rewrite depends on, the `Get-ScheduledTask` query, and `setup`'s
delivery-position message. The toolchain gate passed on macOS and Windows.

**Not proven, and why.** The remaining Windows legs were still red at the last dispatch: the
install-as-standard-user registration, the four-sentence lifecycle assertion, the drain-route and
`serve` suites (POSIX assumptions about modes, unix sockets and `SIGKILL` semantics), the Task
Scheduler adapter proofs for restart, breaker and identity, the update failure injection, and the
desktop main-process unit tests. The ubuntu toolchain gate passed its first six phases and failed the
rollback rerun on a fixture defect that has since been fixed locally and **not re-dispatched**. The
remote-exposure workflow has never run at all. Every artifact-upload step fails on an org-wide
artifact-storage quota, so the criterion that asks for *produced installers* is **pending** wherever
the build is green and the upload is red — a green build with a red upload has not produced an
installer.

**And the reason none of that moved today: GitHub Actions is billing-blocked for the organisation.**
Every job dispatched since `d376533` refuses to start with "The job was not started because recent
account payments have failed or your spending limit needs to be increased", and the seven workflows
dispatched at 12:07–12:08 UTC on 2026-09-08 each failed in 6–15 seconds without running a step. That
is the owner's to fix, and until it is fixed the legs above stay honestly unmet. The queue to
dispatch afterwards is the six daemon workflows, the toolchain and remote gates, and the desktop and
CI workflows on push.

**One criterion is not machine-checkable here at all.** A reboot with nobody logged in, a real macOS
login and a real Windows logon are transcripts from a human, and the phase is not complete without
the Linux one.

## What this record does not decide

- **Single-executable binaries.** Deferred to phase 4 on the five measurements in
  `apps/cli/packaging/README.md`, which is where the recipe and its one unresolved gap live.
- **The paired stage-and-switch of payload 2** inside the update transaction. Named above as the
  successor's work, with the reason it is not this phase's.
- **Per-architecture payload builds** for the desktop installers, which is what reverses decision B.
- **Publishing toolchain artefacts and the Cache Rule** behind a connected custom domain, phase 4;
  until then the speech `bundle` route has nothing to fetch and Windows has no speech route.
- **Job-record retention.** Open, and ADR 0024's territory rather than this record's.
- **`--system` and `--at-boot` escapes**, which stay documented refusals.

## Follow-ups

1. The publish, which turns one resolver branch into a default and changes the four dated sentences
   above.
2. SEA binaries with notarisation, phase 4.
3. Publishing toolchain artefacts and the Cache Rule, phase 4 — the condition that closes the Windows
   speech route.
4. Per-architecture payload builds wired to electron-builder's per-arch `extraResources`, which is
   what an Intel Mac installer needs.
5. A monotonic clock for the breaker's interval, which closes the one residual D6 states.
