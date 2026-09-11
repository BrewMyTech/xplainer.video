# @xplainer/cli

## 0.0.3

### Patch Changes

- 7e68dee: **`xplainer connect claude|codex` writes the skill, not just the MCP entry.**

  `connect` exists to make an agent able to do this, and for a release it delivered the transport and
  not the method: one stdio entry, eight tools, and none of the instructions an agent reads before it
  composes a scene. The visible symptom is a video that looks improvised, because it was — an agent
  with the tools alone has nothing telling it that every scene length comes from measured word
  timestamps rather than a guess, which is the one mechanic in `SKILL.md` that is not negotiable.

  Both clients read `<home>/skills/<name>/SKILL.md`, verified against real installations of each, so
  one writer serves both and the only difference is which home. The file comes out of the
  `@xplainer/skill` this package now depends on — data only, no code, no dependencies of its own,
  11 KB over 12 files — rather than a copy inside `apps/cli`, because there is one reviewed `SKILL.md`
  and `packages/skill/src/build.test.ts` already compares it byte-for-byte against both plugin
  bundles. A second copy here would be the first to go stale.

  **Re-running `connect` is the update path**, which is what the write being idempotent is for: after
  `npm i -g xplainer@latest`, one `xplainer connect claude` refreshes the entry and the skill together
  and says which of them changed — `wrote` or `already current` — rather than claiming a write it did
  not make.

  This is a new runtime dependency of `@xplainer/cli`, so it is a change to payload 1's closure, to
  the publish contract and to every installer. It is 11 KB of data and no code, which is the only
  reason that is acceptable.

- c95126e: **`xplainer update` reconciles this machine after an upgrade.**

  Upgrading the package is one command; making the machine match it is two more that nobody remembers
  — `setup` may need to acquire something the new version wants, and `connect` has to be re-run or the
  agent keeps yesterday's MCP entry and yesterday's `SKILL.md`. `xplainer update` does both, reports
  each as reconciled or unchanged, and skips an agent that was never configured rather than creating
  one. `--check` reports the version comparison and changes nothing.

  **It does not replace the package, and that is a decision.** Spawning a package manager from here
  rewrites the files the process is executing: survivable on macOS and Linux, where the running inode
  outlives the unlink, and a failure on Windows, where the package is locked while it runs. The manager
  is also only knowable for a global npm install — pnpm, bun and yarn globals differ, and `npx -y
xplainer` has nothing installed to update. So it reads the registry, says which version is newer, and
  prints the upgrade command for the one install it can identify. Where it cannot, it says so instead
  of guessing.

  The reconcile steps are **spawned rather than imported**: `commands/setup.ts` and
  `commands/connect.ts` are about 700 lines of orchestration between them, and calling into their
  internals would mean either refactoring both or keeping a subset here that drifts the first time
  either changes. A child process running this same binary cannot drift.

  **The version comparison is numeric, because the first version of it was not.** It asked
  `latest !== CLI_VERSION` and called any difference "newer on npm", so a build at `0.0.3` was told
  `0.0.2` was available — an offer to downgrade, printed as an upgrade, found by running the command
  rather than by reading it. It now answers behind, same, ahead or unknown, compares parts as numbers
  so `0.0.10` beats `0.0.9`, and declines to guess at anything carrying a pre-release tag: the only
  decision this command makes is whether to offer an upgrade, and offering the wrong direction is worse
  than declining.

## 0.0.2

### Patch Changes

- 458aa0b: **`xplainer daemon install` takes no arguments on a machine that installed from npm.**

  `install/program.ts` has always known four program sources, and `package-manager` was a refusal
  because nothing was published. `xplainer` and `@xplainer/cli` have been on npm since `0.0.1`, so the
  refusal was the only thing left making a user assemble a ~165 MB payload by hand before they could
  install the daemon — friction sitting in front of the mode that
  [ADR 0029](../docs/adr/0029-the-agent-path-may-be-http-when-the-token-never-enters-the-config.md)
  measured as the _cheaper_ one.

  `commands/daemon.ts` now builds a payload out of the installed package and hands it to the installer
  as an ordinary `payloadDir`. `--runtime` still wins when it is given, and a checkout or a CI runner
  still takes `runtime-dir`, because neither has a `node_modules/@xplainer/cli` above it.

  **It assembles rather than pointing at the install directly, and that is the point.** A supervisor
  artefact needs an absolute interpreter path that stays valid, and
  `~/.nvm/versions/node/<v>/bin/node` does not: the next `nvm install` leaves a supervisor entry
  naming a file that is gone. The payload carries its own copy of `process.execPath`, so the daemon
  survives the interpreter it was installed with disappearing.

  **Where the building happens is load-bearing, and it took two defects to get right.** The obvious
  home was `install/program.ts`, the module that decides where a program comes from — and putting it
  there made that module write ~165 MB, while its own contract says "Nothing here writes, so a refusal
  leaves a machine exactly as it was". Two callers paid for the broken promise. `connect/spawn.ts`
  resolves a program only in order to write one line into an agent's configuration, and began
  assembling a payload to do it — on exactly the machine that command exists for. And the branch of
  the installer the payload arrived through pushes no rollback undo, so a failed install kept the
  bytes while reporting that everything it wrote had been undone.

  So the write lives in `install/materialise.ts`, under a verb that says so; the caller discards it in
  a `finally`; the payload is built outside the state directory, where nothing can mistake it for a
  staged runtime; and `install/program.ts` no longer imports the assembler at all — a property held by
  a test that walks its transitive import closure and asserts neither writing module is in it, rather
  than by a comment or by a grep over one file, both of which were tried and both of which a review
  bypassed with one import.

  **A payload that has to be built is built after the preflight, and that took a thunk.** `--runtime`
  names a directory that already exists, so resolving it early costs nothing; assembling ~146 MB
  early costs 1.3 s and 146 MB ahead of an install that may be about to refuse for want of a setup
  marker, twice over when two installers race. `payloadDir` therefore takes `string | (() => string)`
  and phase 3 is what calls it — below the read-only phase 1, inside the operation lock.

  Two adjacent things this reached:
  - `install/install.ts` takes the `program_source` as an input rather than re-deriving it from the
    directory it produced, because both sources end in an identical content-addressed slot and a
    resolver looking at the result would answer `runtime-dir` for either. That record is the only
    place saying whether the bytes came from a registry or from somebody's working copy.
  - `daemon update` now admits `package-manager` beside `runtime-dir`. Its guard was written as
    "not `runtime-dir`" while the fourth value was unreachable, so making it reachable would otherwise
    have closed updates for every npm-installed machine — on the route this change exists to enable.

  **A payload that will not build is a refusal that rolls back.** Building at phase 3 put the build
  _after_ the phase that enables lingering, so a machine that could not assemble — out of disk, a
  partial npm tree — was told the install had refused while the linger marker it had just created
  stayed enabled, and with it nothing recorded that would let `uninstall` remove it later. The build
  happens inside the same `try` as the staging now, so every failure from there reports what it undid:
  exit `3`, the assembler's own sentence, and `rolled back: disabled lingering for <user>`.

  **Held at `patch` deliberately.** This adds a capability and on a `0.0.x` line a `minor` marker
  produces `0.1.0`, which is a release decision rather than a changelog one. Nothing here is breaking:
  every existing invocation resolves exactly as it did.

- 78a4358: **A payload's symlinks stay relative, so the payload can still be moved.**

  `runtime/assemble.ts` copies with `cpSync`, and Node **resolves** a symlink's target against the
  source location unless `verbatimSymlinks` is set. Neither of the two copies set it, so a relative
  link inside a copied package tree — `../dist/bin.js` — arrived in the payload as an absolute path
  back into the tree it was built from. Measured on Node 24:

  ```
  source link target : ../lib/node_modules/real/cli.js
  copied link target : /private/tmp/.../sym-src/lib/node_modules/real/cli.js
  ```

  **Relocatability is the one thing payload 1 exists for**, so this defeated the whole artefact where
  it applied. It is the same failure as the one the argument-free install exists to avoid, arriving by
  a different route: a `PATH` copy dies on the next `nvm install`, and so does an absolute link into
  the directory that `nvm install` replaces.

  **It was silent in both directions, which is why it survived.** `scanTree` records whatever the copy
  produced, so `runtime verify` compared each link against the rewritten target and answered
  `ok: true` — a payload that could not move, verifying clean. And `bin/npm` is correct however the
  option is set, because the assembler creates that one with `symlinkSync` rather than by copying, so
  the one link a reader would spot-check by hand was the one that could not be wrong.

  **Nothing was broken yet, and the trigger would not have been a code change.** A real payload
  assembled from this checkout carries one link and no absolute targets: the dependency closure's
  1805 relative symlinks all sit at the `node_modules/<name>` boundary, which the external copy's
  filter excludes at any depth and which the checkout route resolves through `realpathSync` before
  copying. It would have started the day some package in the closure shipped a symlink inside its own
  `files` allowlist — a lockfile change rather than a diff anybody would review for this.

  The `npm` copy has always had it; the external-install copy inherited it. Both now pass
  `verbatimSymlinks: true`, and `install/materialise.test.ts` asserts a package's relative link is
  recorded relative **and** resolves to a file inside the payload from where the payload now is.

## 0.0.1

### Patch Changes

- 4b534da: **A stale half-record made `serve` call an operator's own token file "the one this daemon minted for
  itself" — at any path, for as long as the record stood.**

  The correction of 2026-09-08 that split `token_origin` from the directory it lives in stopped short
  of one branch. `resolveTokenOrigin` answered the half-record case — `token_origin: "minted"` with no
  `token_file` beside it, which a start that minted and then failed used to leave — **before** it
  compared the resolved path with anything. So a `serve --bind <LAN address> --token-file
/etc/xplainer/operator.token` against such a state directory was refused with:

  > the bearer token in `/etc/xplainer/operator.token` is the one this daemon minted for itself

  which is false, and whose remediation — "write a token of your own to a file and pass it with
  `--token-file`" — is exactly what the operator had just done. It was fail-closed and one loopback
  start cleared it, so nothing was exposed; what it cost was a true sentence.

  The ordering is now the other way round. A half-record is inherited **only** at the path a mint of
  that state directory would have written — `defaultTokenPath(stateDir)`, newly exported for the
  comparison — because that is the only file such a start can have created. A token at any other path
  is the operator's, which is what R-SEC-9's fifth precondition is asking about.

  `daemon/token.ts`'s `TokenOriginRequest` and `TokenPresenceRequest` therefore carry `defaultPath`,
  and `commands/serve.ts` supplies it at both call sites. `token.test.ts` covers both halves against
  real files: the half-record at the state directory's own `token` is still `minted`, and the same
  record against a file outside it is `operator`. Before the fix both answered `minted`.

- b3e1be8: **The published packages described a repository that no longer exists and a service that was never
  here.** This is the editorial pass ADR 0022 booked and ADR 0023 made necessary, done before the
  first publish rather than after it.

  `apps/api`, `apps/web` and `services/media-service` moved to a private repository on 2026-09-06.
  What stayed behind was a tree full of sentences citing them as siblings — and those sentences ship.
  `apps/cli`'s npm `description` named "the HTTP/MCP server core shared with the hosted
  media-service", which is the one line a human reads before installing a daemon; twenty-three
  docblocks across `apps/cli/src/` and `packages/mcp-server/src/` cited a `services/media-service`
  path that no reader of this repository can open, and every one of them travels inside
  `dist/**/*.d.ts` and the committed API reports.

  The reasoning in those comments was never wrong and is untouched: a seam is a parameter _because_ a
  second binder supplies its own guard, state directory or socket. Only the naming changed — the
  second binder is now **the hosted media service**, located once per file as _relocated to a private
  repository, ADR 0023_. Where a comment quotes ADR 0020 or `apps/cli/AGENTS.md`, the quotation still
  says what the record said and the surrounding sentence carries the correction, because a quote that
  has been tidied is no longer evidence.

  `LICENSE` — which ships inside all six tarballs — stopped listing three directories that are not
  here and now states the decision it used to leave open: `apps/desktop`, `packages/config` and
  `services/tts-sidecar` stay proprietary and stay `UNLICENSED`. Making the repository public made
  them readable, not usable.

  `@xplainer/skill` changes most. `SKILL.md`'s "Two backends, one tool set" sold a hosted service to
  an agent that cannot reach one, which is the same failure as publishing a dead URL: it is now "One
  tool set, and it runs on this machine", and an agent told no server is registered is told to stop
  rather than to reach for a route that does not exist. The three plugin and marketplace manifests
  drop the same framing and gain the Remotion disclosure ADR 0022 requires on a pre-install surface —
  completing the five surfaces that record named, none of which existed when it was written.

  Two schema `description` strings did move, and they are the reason this pass was not editorial
  after all. `captions.json` and `narration.json` cited `max/.explainers/scripts/narrate.py` by file
  and line — a path into the private reference implementation this product was derived from — and
  `@xplainer/protocol` ships `schemas`, `python/**/*.py` and `dist/**/*.d.ts`, so one citation was
  live on three surfaces at once. Twelve descriptions named that implementation, an earlier hand pass
  scrubbed ten, and these two outlived it. Both keep their claim and lose the coordinate: caption
  timing is still "measured rather than inferred", narration defaults still "mirror the reference
  implementation". `check-publish-contract` now carries a `no-private-reference-path` rule beside the
  one that matches the hosted repository's name, with its own negative test, because a class scrubbed
  by hand comes back and a class matched by a gate does not.

  What did NOT move is the local/hosted wording itself. The tool contract describes both backends
  deliberately, that wording is the published contract rather than a stale path, and narrowing it
  would be a contract change wearing an editorial hat.

- 9912ac1: Four defects from B7 and B8's verification, each with the measurement that found it.

  **`daemon.json`'s `token_origin` answers for the file `token_file` names, and for no other.** The
  record was being read as an answer about the _state directory_, so once a directory had minted a
  token of its own, an operator's `--token-file /elsewhere/token` inherited `minted` and a non-loopback
  bind was refused for ever — in a sentence saying "the bearer token in /elsewhere/token is the one
  this daemon minted for itself", about a file this daemon had never written. A recorded origin now
  governs only when the recorded path is the path this start resolved; anything else is the operator's.

  **And R-SEC-9's fifth precondition is asked before the mint rather than after it.** A remote bind on
  a machine with no token file used to reach `loadOrMintToken`, create the token `0600`, stamp
  `token_origin: minted` into `daemon.json`, and then refuse itself over the credential it had just
  written — a refusal that left the machine changed, on the one path ADR 0020 says must leave it
  exactly as it was found. The check is now three-way — `absent`, `minted`, `operator` — and runs
  first: an absent token is refused in its own words, nothing is minted, and nothing is recorded.
  Measured against the shipped binary, before and after, on a real non-loopback bind with a real
  certificate.

  **The Windows named pipe's narrowing could never run.** `NamedPipeClientStream` derives the pipe
  direction from `desiredAccessRights` and throws `ArgumentOutOfRangeException` for a value carrying
  neither `ReadData` nor `WriteData`, so the opener's `ChangePermissions,ReadPermissions` threw at
  construction: every Windows start reported `failed` from a mechanism whose failures are reported and
  not fatal, and the pipe kept the default descriptor Microsoft documents as granting "read access to
  members of the Everyone group and the anonymous account". The opener now asks `ReadData` as well —
  the connection still never reads a byte — while the entry it _grants_ is unchanged. The whole
  emitted script is a committed fixture, because it runs on a platform the suite cannot execute, and
  the window between `CreateNamedPipeW` and the narrowing is written down: one promise resolution and
  one `powershell.exe` start, with nothing of the daemon's in between.

  **And the toolchain manifest's mirror was never wrong — its own suite was.** `manifest.test.ts`
  drives the real `getChromeDownloadUrl` over all 80 branches by replacing the two predicates it reads
  the host through, and never put them back, so the case that asks _this machine's_ question compared
  the mirror against a selector still answering "no remotion.media binaries". On macOS and Windows that
  is the same URL either way; on linux-x64 with glibc ≥ 2.35 it is not, which is what failed on the
  ubuntu runner. The stand-ins are now restored after every row, and the host case asserts it is
  looking at the shipped module before it compares. Measured on Debian bookworm x64 (glibc 2.36): the
  mirror and the unpatched selector both answer
  `https://remotion.media/chromium-headless-shell-linux-x64-149.0.7790.0.zip?clear`, which is the URL
  the manifest records for `linux-x64-glibc235` — re-verified by streaming it: 96,395,776 bytes,
  sha256 `f11d8e76f043a8a70c7ebdae2834f94370ad329ed997ddcdfd5dbcd803f53f76`, exactly as recorded.

- 1608d75: **A short `healthTimeoutMs` was also the budget the rollback got for putting the previous runtime
  back — so the smaller a caller made it, the likelier `daemon update` was to leave the machine with
  no daemon at all.**

  `updateDaemon` and `recoverUpdate` took one readiness budget, and it is a budget for the runtime
  being _installed_: "how long am I prepared to wait to find out this is not going to work". A caller
  is entitled to make it small. The rollback's own wait — on the retained previous runtime, the one
  thing in the transaction already known to work — was reading the same number, so a two-second budget
  for the replacement was a two-second budget for the comeback. When that expired the transaction
  refused with `4` and the sentence "The previous runtime … was put back and it did not answer
  either", leaving a journal, a stopped daemon and a `xplainer daemon recover` for the user to run by
  hand — over a daemon that was seconds from answering.

  They are two questions now, and they are resolved separately. `UpdateRequest` gains
  **`rollbackHealthTimeoutMs`**, which defaults to `healthTimeoutMs` or `REPLACEMENT_READY_TIMEOUT_MS`,
  **whichever is larger** — so shortening the wait for the incoming runtime no longer shortens the wait
  for the one being put back, and a caller who asked for longer still gets longer. Nothing else about
  the transaction changes: the forward wait, the refusal codes, the journal and every boundary are as
  they were. The new field exists for one kind of caller, and both of them are in this repository's own
  suite: a case that has made **both** runtimes unstartable on purpose, where waiting the ordinary
  minute for a start that cannot happen measures nothing.

  Found as a flake rather than reasoned. T33's rollback rerun passes `healthTimeoutMs: 1_500` so that a
  _deliberately_ doomed replacement fails fast, and on `windows-latest` that 1.5 s became the whole
  budget for a real `xplainer serve` to start: run `34319281465` shows the `started` case failing with
  "A is answering /healthz as release 0.0.0" over a daemon whose log had reached its second line. The
  same case failed once before (run `34308497439`) with no explanation. All six rollback cases pass in
  run `34320488979`.

  Two things were added so the next one says more. `transaction.test.ts` pins the separation directly —
  both runtimes refused, the two budgets given deliberately different values, and the refusal must name
  the rollback's own — and `setup/testing/rollback-render.ts` now prints the refusal's own sentence
  beside the daemon log tail, because "the rollback gave up on its comeback" and "the rollback
  succeeded and the daemon stopped afterwards" are different bugs that produced the same failed
  assertion.

- d01d6db: `serve` takes its three settings as flags, records them, and `status --json` reports them.

  **`serve` gains `--state-dir`, `--token-file` and `--socket`, each above its environment variable.**
  Task Scheduler's `<Exec>` action carries a command, a working directory and arguments and has **no
  per-action environment map**, so a daemon that could only be told where its state lives through
  `XPLAINER_STATE_DIR` would, once installed on Windows, silently take the platform default while
  `daemon.json` recorded something else. The spellings are the launch contract's `SETTING_FLAGS`, and
  a test compares the two rather than trusting them to stay in step: an argv the installer writes and
  the daemon refuses is the failure this is guarding.

  `--token-file` names a **path and never a token value**, so R-SEC-6 — "the unit carries a token
  _path_, never a token value" — holds on the argv route exactly as it did on the environment one.
  `--socket` has **no variable at all**, because `daemon/ipc.ts` reads none; that absence is why all
  three settings travel in argv on every platform rather than only where they must, and it is what
  makes a rendered `RuntimeDirectory=xplainer` a directory the daemon actually binds in rather than an
  empty one beside it. The `0700` chmod-on-every-start rule follows the flag: the directory narrowed
  is the one the socket is really in, which is also the cost of the flag — point it at a directory
  dedicated to the socket.

  **All three are read back into `daemon.json`**, so what is recorded is what the process used rather
  than what somebody intended, and `serve` says on stderr which of flag, variable and default decided
  each one.

  **`daemon.json` gains the fields the installer and the desktop read**: `socket_path`,
  `supervisor_kind`, `supervisor_artefact`, `runtime_dir`, `launch_spec`, `program_source`,
  `linger_enabled_by_us`, `log_sink` and `installed_version`. They are typed and parsed rather than
  merely preserved, because `status` reports them, the consistency check compares them and `uninstall`
  acts on `linger_enabled_by_us` — a field that is only preserved is a field nobody can read without a
  cast at every call site. A value outside a closed set, and a half-written `launch_spec`, read back
  as `null` rather than as something a later branch would trust. The file now has **two writers split
  by field**: `serve` owns what a run establishes, `daemon install` owns what an installation does,
  and each preserves the other's keys.

  **`xplainer status --json`** writes one object on one line with a **stable condition code** from a
  closed set — `ready`, `stalled`, `unauthorized`, `token_absent`, `unhealthy`, `unreachable`,
  `absent` — rather than prose a consumer would have to parse. `unauthorized` and `token_absent` are
  the same `401` and completely different problems; `absent` and `unreachable` are the same silence
  and the difference between an install and an investigation. Contract compatibility is deliberately
  **not** a condition: it is a relation between a daemon and the shim asking, so the daemon's
  `contract_version` is reported for the caller's own `isContractCompatible()`. The document carries
  the token's path and never its value, and the two refusals that happen before a report can exist — a
  state file that cannot be read (`11`) and a `--url` that is not an endpoint (`1`) — write a sentence
  to stderr and nothing to stdout.

  No exit code changed: `status` still exits `0` when the daemon answers and `4` when it does not.

- 26aade2: `xplainer connect claude` and `xplainer connect codex` write a working stdio configuration.

  `connect` stops being a stub and becomes a group of two verbs. Both write the **same** entry —
  `xplainer mcp --attach` when the binary is on `PATH`, and `npx -y @xplainer/cli mcp --attach` when
  it is not — into the agent's own configuration file, and there is nowhere in that entry for a URL, a
  port or a token to go: the transport is the daemon's unix socket, and filesystem permissions are its
  authentication.

  **`connect claude`** hands the entry to Claude Code's own writer when that CLI is installed —
  `claude mcp add --transport stdio --scope user xplainer -- xplainer mcp --attach`, with `--scope`
  passed through — because a command that reimplements another program's file layout is a command
  that is one release behind for ever. Where the CLI is absent it writes the documented user-scope
  location itself, `~/.claude.json`'s `mcpServers`, merging into a file that holds Claude Code's whole
  per-user state and refusing outright to rewrite one it cannot parse. `local` and `project` name
  files that belong to a _directory_; without the vendor CLI those are refused rather than guessed at
  (ADR 0020 §Security R-SEC-8).

  **`connect codex`** writes `[mcp_servers.xplainer]` into `~/.codex/config.toml`, or the path given
  by `--config`. The file is **edited, not reserialised**: the table's own lines are located and
  replaced, so comments, table order and every other server survive, and running the command twice
  leaves exactly one entry — updated in place, not appended beside itself. A configuration that
  already declares that name another way — a dotted key, an inline parent, an array of tables — is
  refused, because appending beside it would be a duplicate key and a `config.toml` with a duplicate
  key does not load at all.

  **Both refuse before they write.** `connect` reads `daemon.json` rather than assuming port 8787,
  and a state directory where no daemon has ever bound gets exit **`3`**, nothing written, and the
  one command that fixes it: run `xplainer serve`. `--force` overrides. The port is never _in_ the
  entry — it is the evidence that there is a daemon to attach to, and it is printed so a user with
  two daemons can see which one they just connected to.

  Exit code `3` — "precondition unmet, with nothing written" — moves from planned to built in the
  table in `docs/ARCHITECTURE.md` §6; `1` covers a `--scope` this command cannot write, `11` a
  `daemon.json` that cannot be read, and `70` a `claude mcp add` that failed for its own reasons.

- acdd06a: `setup` says why the manifest address is empty, and what still works on this machine.

  Nothing is published to `https://cdn.xplainer.video/toolchain/v1/manifest.json` in this phase and no
  command in this repository publishes to it: `infra/terraform` creates the R2 bucket and the proxied
  `cdn.<zone_name>` record, connecting the bucket to that custom domain and adding its Cache Rule are
  manual steps that module deliberately does not manage, neither is scheduled here, and the upload is
  the release owner's step in the phase-4 work that builds the per-platform speech bundles. So the
  published address answers nothing usable — by design, not by accident.

  A refusal that reported only a DNS or HTTP error would send every reader looking for a broken CDN.
  `ManifestUnreachable` now carries `deliveryPosition()`: the state of the delivery, and then the
  routes that still work on the machine reading the message.

  **It is per platform, because the position is.** On macOS and Linux it names the two speech routes
  that do work and that never read this manifest — `--tts-url <url>` for a Kokoro-FastAPI server you
  already run, and the `docker` route's image pinned by digest — and it says that a browser
  acquisition needs a reviewed manifest named with `--manifest`, since only the expected digest comes
  from the document. On Windows it says instead that there is **no working speech route at all**:
  nothing is published for `bundle` to fetch, the `docker` route needs a linux/amd64 container engine
  a Windows host need not have and `windows-latest` does not have, and `--tts-url` records a server
  somebody else already runs rather than acquiring one. It names phase 4 — a native speech bundle per
  platform, published with the manifest behind the connected custom domain — as the milestone that
  closes it, rather than offering a route that will fail.

  That asymmetry is roadmap **P2-4**'s, which this change moves to its real status: met on macOS and
  Linux, **pending on Windows**. `docs/ROADMAP.md` and `infra/README.md` record the same position, and
  `infra/terraform/**` is unchanged — there was nothing to change in it.

- af31c2f: The circuit breaker counts each run's own life, and a Windows worker takes its whole tree with it.

  **The breaker could not latch under two of the three supervisors, and now it can.** ADR 0020 words
  it as "if the last five runs all failed within 30 seconds of starting", and `isStalled()` inferred
  the second half of that from the **next** run's start time. That measures the supervisor's retry
  cadence rather than the daemon's own life: launchd's `ThrottleInterval` is 30 s, which sits exactly
  on the boundary, and Task Scheduler's `<RestartOnFailure>` has a one-minute schema minimum, which is
  outside it — so a daemon crash-looping on a held port was restarted for ever on macOS and Windows.
  Each run now records its **own** end. `recentStarts[]` carries an `outcome` (`failed` for a run that
  ended without ever announcing itself, `stopped` for one that had) and an `ended_at`, both written by
  the run itself as it goes down, and five starts two minutes apart that each die two seconds in now
  trip the breaker. `FAILED_START_WINDOW_MS` and `STALL_AFTER_FAILED_STARTS` keep their values and
  their meaning.

  **A run that wrote no epitaph is governed by a rule that can be evaluated.** A `SIGKILL`, a panic or
  a power cut leaves an entry with no outcome and no end. Such a start counts as a failure **only when
  the next recorded start began within 30 s of its own `started_at`** — the only sound upper bound on
  when it died — and **resets the streak otherwise**, so the breaker under-counts rather than
  inventing a failure. Deciding that needs to know the dead process really is gone, and a
  pre-readiness death writes no `runtime.json` at all, so `newDaemonStart()` now persists the run's
  identity tuple — pid, process start token, machine boot id — beside its start record. A run that
  reached readiness resets the streak outright, however it ended afterwards.

  **Every interval is validated before it is used.** `started_at` is wall clock, so a backward NTP
  correction or a VM resume can invert or shrink a real one; a negative or non-finite difference is
  timing-uncertain and resets the streak rather than counting it. The residual is stated rather than
  papered over: a backward adjustment that leaves a finite interval between zero and 30 seconds is
  indistinguishable from a genuine fast failure and may over-count, and `xplainer daemon restart`
  clears the latch it would produce.

  **On Windows a worker is now put in a Job Object with kill-on-close.** `process.kill(-pid)` is a
  POSIX process-group idiom Node does not implement there, so `process-group.ts` signalled the pid
  alone and left every grandchild — an orphaned `chrome.exe` after every logoff, once a phase targets
  Windows. Node has no Job Object API and this package ships no native addon, so the handle is held by
  a `powershell.exe` keeper started with the worker: it creates the job with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigns the worker and any descendant it already had, and then
  waits for the worker to exit. Killing the keeper closes the job and takes the tree with it; the
  keeper outliving a killed worker closes it a moment later and takes the survivors. A machine with no
  `powershell.exe` falls back to `taskkill /T`, which is weaker and documented as such. Nothing
  changes on macOS or Linux, where a real process group already did this.

- 2de797b: A non-loopback `serve` now costs all five of R-SEC-9's preconditions, and the guard never weakens.

  **`serve` gains `--tls-cert`, `--tls-key` and a repeatable `--allow-host`.** ADR 0020 §Security
  R-SEC-9 does not make remote exposure a flag; it makes it a list, and the list is `all` rather than
  `any`. A bind that is not loopback now requires an explicit `--bind`, the existing
  `--i-understand-remote-exposure`, a PEM certificate and its key, at least one operator hostname, and
  a bearer token this daemon did not mint. `0.0.0.0`, `::`, `[::]` and `*` are still refused outright,
  acknowledgement or not: a wildcard bind is not a decision about which interface to expose, it is the
  absence of one.

  Four of the five are decided **before the state directory is taken** and the fifth before anything
  is bound, so a refusal leaves the machine exactly as it found it — `serve` exits `1` naming
  **every** missing precondition in one sentence, rather than one flag per run.

  **`daemon.json` gains `token_origin`.** "A non-default token" cannot be decided from the value —
  32 random bytes an operator wrote and 32 random bytes the daemon minted are the same thing — so
  provenance is recorded at the moment it is known and inherited by every later start. A token file
  `serve` created is `minted` and is refused for a remote bind; one it found and cannot attribute to a
  mint of its own is the `operator`'s. Every uncertainty falls towards `minted`, which is the answer
  that refuses.

  **The `Host`/`Origin` allowlist is loopback _plus_ the operator's hosts, and it is unconditional.**
  That is CVE-2026-65105 written down as a rule: Ollama's `Host` validation was conditional on a
  loopback bind, so widening the bind silently disabled the whole defence. Here widening adds
  authority and removes none — `Host: evil.com` is `403` on a daemon bound to a LAN address exactly as
  it is on one bound to `127.0.0.1`, `127.0.0.1` stays on the list, and `/healthz` still asks for the
  token. There is no branch on the bind address anywhere in the guard.

  **TLS on a _loopback_ bind is refused**, which R-SEC-9 does not say and the rest of the machine
  does: `xplainer status`, `xplainer daemon restart` and the desktop all reach a loopback daemon over
  `http`, and a listener that quietly stopped answering them would be a working machine turned broken
  with no message. `startServer()` takes an optional `tls` pair — the PEM text, never a path, because
  it does no I/O — and reports an `https:` origin when it has one.

  Nothing here generates a certificate. The operator brings the pair, `serve` checks that the two
  files are a certificate and a private key **and that the key is that certificate's**, and refuses by
  name rather than failing inside a handshake on somebody else's machine.

- 1a95fee: The eight tools do real work: `createLocalBackend()` replaces the phase-0 stub.

  `explainer_create` scaffolds a video into the shared Remotion workspace and never overwrites the
  agent's `Scenes.tsx`; `explainer_put_source` writes the agent's files and refuses the five
  engine-owned ones **at the disk boundary**, case-folded, all-or-nothing — that is ADR 0018's layer 3,
  and it exists because layer 2 sits on the MCP registration and this backend is also reachable
  without it; `explainer_put_media` decodes base64 strictly, because `Buffer.from` drops anything
  outside the alphabet in silence and would otherwise write a truncated asset that only fails inside a
  render minutes later; `explainer_list` reports what is actually on disk. `explainer_narrate`,
  `explainer_still` and `explainer_render` enqueue against the daemon's job runner and answer with a
  `job_id`, and `explainer_job` **is** that runner's own answer, relayed. The "not implemented in this
  phase" wording is gone from all eight; it now describes deferred _commands_ and nothing else.

  Two workers carry the queued work, registered in `daemon/start.ts`. Narration is a child process
  running `@xplainer/render-core`'s narration port against `@xplainer/tts-client`: `XPLAINER_TTS_URL`
  names the Kokoro server, and `XPLAINER_TTS_FIXTURE` points at recorded WAVs and word spans instead,
  so a machine with no container still produces _measured_ timings rather than estimates. Stills and
  renders are the pinned Remotion CLI, spawned with the argv render-core's builders produce — never
  `npx`, which would resolve whatever version the registry serves at call time.

  The workspace lives at `XPLAINER_VIDEOS_DIR`, or `<state dir>/workspace`, and **nothing installs
  it**: a tool call copies four template files and creates three directories, and a workspace with no
  Remotion in it is refused by name with the one command that fixes it, rather than failing later
  inside `spawn`. Before a render, the worker restores any engine-owned file that drifted — the hole
  `write_source_to` leaves open, since no MCP guard can see a direct write — and runs the preflight, so
  a video with no narration or no captions costs a second instead of the minutes a doomed render would
  have taken.

  A tool call's arguments reach its worker through one small document per job under
  `<workspace>/requests/`, because a job record deliberately carries no command line (ADR 0008).

  `apps/cli/src/workers/render.test.ts` renders a real video end to end — create, narrate, still,
  render — and reads the MP4 back with `ffprobe` and `ffmpeg`: 1920×1080, 30 fps, h264, an AAC track,
  a duration within 100 ms of `timings.json`'s own total, a frame count equal to its
  `durationInFrames`, and a picture that changes on each segment boundary frame and is steady either
  side of it. `XPLAINER_SKIP_RENDER_TEST=1` is the only way to skip it, and CI does not set it.

- f0af433: Narrate in this process: a third `SpeechSynthesiser` behind `resolveSpeech()`, running Kokoro-82M
  on an ONNX Runtime under `apps/cli/src/speech/`. With it a machine needs **no Docker, no
  `--tts-url` and no Python** to produce narration, and no GPL component is fetched, shipped or
  linked. `--tts-url` and the Docker route keep working unchanged.

  The route is chosen the way the other two are — by what the machine has, never by a flag a tool
  call carries. The precedence is `XPLAINER_TTS_FIXTURE`, then a server somebody named
  (`XPLAINER_TTS_URL` or `KOKORO_URL`), then the in-process engine, then the tts-client's own default.
  A server that was _named_ wins over the local engine because naming one was an intention; the
  `localhost:8880` default is a guess, and loses to it.

  Word timings come from the model's own per-token duration predictor rather than from an alignment
  estimate, which is why this model was chosen. **The duration-to-seconds conversion is derived from
  the run that produced the audio** — `waveform.length / Σ durations` — and never written down: the
  published figure for this model is off by a factor of two, and the true ratio moves by 79% across
  the speaking-rate range the port accepts (583 samples per unit at speed 0.8, 1042 at speed 4). A
  constant would be a silent, systematic drift in every caption and every scene boundary, so
  `timing.ts` refuses rather than emitting timings that disagree with the audio it returned.

  Two consequences worth knowing before this is switched on:
  - **A clip is returned untrimmed.** Kokoro-FastAPI trims its output; this does not, because the
    head is a noise floor below −66 dBFS rather than digital silence, the first phoneme's onset
    begins _before_ the boundary the duration predictor implies, and a trim threshold set slightly
    wrong clips the start of the first word. The same sentence therefore comes back 8–13% longer than
    from a server — ≈0.32–0.49 s of near-silence before the first phoneme, ≈0.19 s after the last.
    The speech is the same length; the padding is not, and pacing belongs to
    `@xplainer/render-core`'s `LEAD_IN_MS` / `GAP_MS` / `TAIL_MS`, which apply to every engine.
    **The padding does not shift the timings**, which is what makes leaving it in safe: they are
    absolute offsets into the clip as delivered, and the first word's `start_time` lands 13–41 ms
    (mean 29 ms) after the audible onset — under a frame and a half at 30 fps, and the predictor's
    own alignment rather than an arithmetic error. Nothing downstream needs to know.
  - **A voice this machine has no pack for is refused, not substituted**, and a server-side blend
    such as `af_bella(2)+af_sky(1)` has no meaning on this route at all.

  Nothing is added to this package's public surface: `src/speech/` is internal, like `src/daemon/`.
  The ONNX Runtime is an acquired toolchain component rather than an npm dependency — one
  `onnxruntime-node` package carries all five platforms' binaries at 296 MB — so the published
  tarball and payload 1 are unchanged.

  **The product selects this route itself, and `onnx` now sits above `docker` in `setup`.** Both are
  part of switching it on rather than refinements of it. `resolveSpeech()` reads
  `<state>/toolchain.json`, so a daemon on a machine that has run `setup` finds the engine `setup`
  acquired: before this it defaulted to reading `XPLAINER_ONNX_MODEL`, `XPLAINER_ONNX_VOICE` and
  `XPLAINER_ONNX_RUNTIME`, so the engine spoke only for a caller who exported three variables. Those
  three still work, above the marker, as the way to point it at a model no `setup` acquired.

  `setup`'s acquisition order is now `--tts-url`, `onnx`, `docker`, `bundle`. Below `docker`, every
  machine with a container engine recorded `docker` and never took the in-process route — which is the
  machine class this work exists for, since the point is that a voiceover needs no Docker. Three
  things come with the swap:
  - **`xplainer setup --speech <onnx|docker>`** pins a route and does not walk the precedence. A route
    somebody named is an instruction, so a named route that is unavailable is a refusal naming why
    rather than a fall-through to something else. `--tts-url` still wins outright.
  - **A machine that already records a working `docker` route keeps it.** `setup` is re-runnable by
    design, and a re-run is the worst moment to move narration onto a different engine: the container
    is running, it is what every previous narration was spoken by, and switching would fetch ~204 MB
    to replace something that works. So a recorded `docker` component whose image Docker can still
    address takes the route again, and `setup` prints that it did and names `--speech onnx`. A machine
    that has _lost_ its engine falls through and gets the in-process route.
  - **`setup` prints which route it took and why the others were not**, and distinguishes the two
    reasons: a route above the one taken was probed and reported itself unavailable, a route below it
    was never asked at all.

- 1a95fee: Harden `xplainer serve`: a bearer token, a loopback guard, a `SIGTERM` drain, a ready line, and
  `xplainer status`.

  Every TCP route now needs a bearer token — `/healthz` included, deliberately: an unauthenticated
  `{status, version}` tells any web page which xplainer to attack, and a `401` against _our own_ token
  is what lets `status` say "something is on our port that is not our daemon". The token is 32 random
  bytes minted `O_EXCL` at `0600` inside the `0700` state directory on first start, or read from
  wherever `XPLAINER_TOKEN_FILE` points; the environment carries the **path** and never the value,
  because `/proc/<pid>/cmdline` is world-readable. A token file that exists and cannot be used ends
  the process with exit `12` rather than serving unauthenticated. It is not a sandbox: same-uid code
  reads a `0600` file trivially, and what it buys is the browser boundary and the other local user on
  a shared machine.

  In front of the token sit a `Host` allowlist and `Origin` validation (ADR 0020 §Security R-SEC-2 and
  R-SEC-3), built from the port the OS actually gave us so `--port 0` keeps working, and mounted
  before any route so a new route is covered by construction. The allowlist is exact string equality
  against `{127.0.0.1, localhost, [::1]}:PORT` and never a parser, because `http://2130706433:8787`
  reaches loopback too. A deliberately widened bind _adds_ its authority and removes nothing — a
  validation that weakens when the bind widens is exactly CVE-2026-65105 — and `--bind` refuses a
  non-loopback address without `--i-understand-remote-exposure`, refusing `0.0.0.0` and `::` even
  with it. `Authorization` is redacted at the logger; rejections are logged with their reason and the
  offending value.

  `SIGTERM` and `SIGINT` now run ADR 0024's drain: stop accepting, give the running job 20 s, tear
  down its whole process group, mark anything still `running` or `queued` as
  `error`/`daemon_shutdown`, close the listeners, remove `runtime.json`, exit `0` — the portable "do
  not restart" signal on all three supervisors, inside P1-7's 25-second budget. `runtime.json` gained
  the bound addresses and the socket path (`null` until the IPC listener lands) and is removed on a
  clean stop, which is what makes its presence meaningful; `daemon.json` gained the token file's path.

  A `serve` whose port is already in use now exits **`10`** rather than `70`, because a supervisor
  told `70` restarts a daemon whose port is held by something else, for ever; the message names the
  port and what to do about it.

  After ownership, reconciliation and the bind, `serve` writes exactly one line of JSON to stdout —
  `{"event":"ready","port":…,"socket":…,"contract_version":…,"pid":…}` — and everything else it says
  goes to stderr, so a parent that spawned it can wait for readiness instead of sleeping. The new
  `xplainer status` reads both state files, says where each fact came from, and reports liveness with
  a real authenticated `GET /healthz`: exit `0` healthy, `4` bound-but-not-ours or not answering,
  `11` for a state file it cannot read.

- 1637cac: **`xplainer setup` had never once worked on Windows without a staged runtime payload, and the exit
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

  **npm is now spawned as a _script_ under an explicit _interpreter_, on both routes and on all three
  platforms.** The payload route always did this — `<runtime>/bin/node[.exe]` plus
  `lib/node_modules/npm/bin/npm-cli.js`, no launcher and no shell — which is precisely why that route
  works on Windows and this one did not, and the fix is to make the second route the same shape as the
  first. `process.execPath` is the interpreter, because it is the host's own node and it is already
  running; and npm's CLI is _located_ rather than guessed, by `locateNpmCli()`: beside the interpreter
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

- 574480c: Give every published package a `README.md`, a `homepage`, a `repository` and an `author`.

  None of the six had a README, so each one's npm page would have rendered blank —
  including `@xplainer/cli`, which is the page a human reads before deciding to
  install a background daemon on their machine. Each README is derived from the
  member's own `AGENTS.md`, states what the package is and links to the repository
  docs rather than restating their invariants; `@xplainer/cli` and
  `@xplainer/render-core` also carry the Remotion disclosure ADR 0022 requires on
  a surface a user reads _before_ installing — Remotion is declared, never bundled,
  and a company above three people needs its own licence.

  `repository.directory` names the member inside the monorepo, so "view source"
  lands on the package a reader is looking at instead of on the repository root.

- acaa26e: Give `xplainer serve` a durable job store, exclusive ownership and boot reconciliation.

  `serve` now does three things in a fixed order before it binds — acquire exclusive ownership of the
  state directory, reconcile the jobs a previous run left behind, and build the job runner — which is
  the invariant ADR 0024 §Exclusive ownership makes: reconciliation rewrites other processes' records,
  so a second `serve` has to be turned away _first_. It exits `10` having written nothing, and the
  test hashes every file in the state directory either side of the refusal to prove it.

  The store is one JSON file per job under `jobs/`, written temp-then-`rename` with the file and then
  the containing directory flushed, so `enqueue()` returns a `job_id` only once no crash can lose the
  record. At boot, every job still `queued` or `running` whose daemon is gone becomes `error` with
  `error_code: "daemon_restarted"`, a `finished_at` and a bounded log tail — never a `404`, and never
  a `running` that never advances. Orphaned workers are killed only on a positive match of the
  identity triple (pid, process start time, machine boot id); one that cannot be identified is left
  alone, the record carries `workers_uncertain: true`, and the job's output directory is quarantined
  so a retry writes somewhere fresh. A record written by a _newer_ daemon is reported but never
  rewritten, and an unparseable one is moved to `jobs/corrupt/` rather than stopping the boot.

  Jobs run one at a time as child processes in their own process group, with stdout and stderr
  captured into the record's bounded tail and the record made durable on every state transition;
  cancelling or draining tears down the whole group, not just the leader. `recentStarts[]` and the
  `stalled` flag now live in the durable `daemon.json` rather than in the ephemeral `runtime.json`,
  which systemd deletes on every clean stop.

  The eight tools still answer "not implemented in this phase": the runner exists and is exercised by
  its own tests, and the render backend that enqueues against it is the next step.

- 93c5812: `xplainer runtime build` and `runtime verify`: the two payloads this phase ships, and the manifest
  that describes them.

  **Payload 1 — the runtime.** `xplainer runtime build --out <dir>` assembles a relocatable
  directory: a copy of `process.execPath`, each workspace package's own `files` allowlist, the
  transitive closure of the five runtime dependencies, and **npm** — 17 MB, laid out the way a Node
  distribution lays it out, so the copy inside the payload can read the payload. `runtime.manifest.json`
  records every path with its `sha256`, every package with its version, the platform, the
  interpreter's **architecture**, and the launch contract, all payload-relative: nothing inside the
  artefact is an absolute path, because a payload is moved for a living.

  npm is there for one reason and it is never imported. On a machine with no Node, `setup --workspace`
  has to resolve the render workspace's pins with _something_, and until now the documented fallback
  named a package manager the payload did not contain.

  **Payload 2 — the render workspace.** `xplainer runtime build --workspace --out <dir>` performs a
  **real `npm ci`** of `@xplainer/render-core`'s `template/package.json` against the lockfile now
  committed beside it, and writes `workspace.manifest.json` recording every **resolved** version.
  It does not copy this repository's hoisted tree, which is a different tree: measured, that yields
  react 19.2.8 against the template's 19.2.3, tailwind 4.2.0 against 4.0.0 and zod 4.5.4 where
  Remotion requires 4.3.6 — and `remotion versions` exits `1` on the last of those, reporting
  `zod: installed 4.5.4, required 4.3.6`. So the copied tree was one Remotion's own guard rejects.

  `packages/render-core/template/package-lock.json` is new and ships inside `@xplainer/render-core`
  (its `files` allowlist already contained `template`), and `zod` joins the template's pins at
  **4.3.6** so nothing Remotion requires is left undeclared. Both ends run `npm ci`, never
  `npm install`: `ci` requires the lockfile to be in sync and removes `node_modules` first, while
  `install` may rewrite the lockfile on a user's machine and silently defeat the determinism the
  lockfile was committed for.

  `--from-runtime <dir>` runs that install from a payload's own interpreter and bundled npm, with
  `<runtime>/bin` prepended to **the install subprocess's** `PATH` and nothing else changed. That
  scope is the whole decision: npm runs lifecycle scripts through `sh -c` and third-party scripts call
  bare `node` — `esbuild`'s `postinstall` is `node install.js` — so the same install under a scrubbed
  `PATH` exits `127` with `sh: node: command not found` and leaves no workspace at all. Render workers
  keep the opposite rule and are still spawned as `<runtime>/bin/node <entry>`, so no interpreter
  leaks onto Chrome's or ffmpeg's `PATH`.

  **`runtime verify <dir>`** re-hashes a payload against its own manifest and reports the **first**
  mismatch by name — a changed file, a truncated one, a missing one, a repointed symlink, or a file
  the manifest never described. It refuses a payload built for another platform or another
  architecture **before** it hashes anything: `@remotion/compositor-<platform>` is a platform-specific
  optional dependency and the interpreter is a native binary, so a payload that matches every hash in
  its own manifest can still be one this host cannot run. `runtime verify --workspace <dir>` adds the
  comparison that moves a render-time failure to build time: the manifest's resolved versions against
  the template's declared pins, package by package.

  The assembler refuses rather than guesses. It will not copy an interpreter from a host that is not
  plain Node — inside a packaged Electron application `process.execPath` is the Electron binary, and
  inside a single-executable build it is the sealed executable — it will not merge into a directory
  that already holds something, and it will not copy a workspace package that declares no `files`
  allowlist, because the payload is defined by what each package publishes.

  `scripts/check-publish-contract.mjs` gains one `MUST_SHIP_FILES` row for the lockfile, beside the
  four `template/*` rows already there. Not an exemption: an exemption permits a file to break a rule,
  and the lockfile's whole argument is that it must be **present**.

  **The launch contract, and how Remotion is started.** `runtime/launch-spec.ts` exports `LaunchSpec`
  — executable, argv, settings, cwd — and the one builder that produces it, so the supervisor
  renderers, the desktop's spawn and the update transaction all render the same record and none of
  them composes an argument of its own. `settings` is deliberately not an environment map: Task
  Scheduler's `<Exec>` action has no per-action environment, and the state directory and the token
  file are read from the environment only, so an environment-shaped contract would leave an installed
  Windows daemon silently on the platform defaults while `daemon.json` recorded something else. Every
  setting is emitted as **argv** on every platform — there is no `XPLAINER_SOCKET` variable for an
  environment emission to use — and `emitSettings(spec, platform)` says what each artefact carries
  beside it: `Environment=` lines for systemd, an `EnvironmentVariables` dictionary for launchd,
  `<Arguments>` entries for Task Scheduler. A dropped setting is a failing golden test rather than a
  silent fallback.

  `resolveNodeEntry(packageDir, binName)` reads a package's **own `bin` field** to the real entry file
  and answers `{ executable, argv }`, and the two Remotion workers now use it. They previously spawned
  `node_modules/.bin/remotion`, a symlink to a file beginning `#!/usr/bin/env node`: the kernel hands
  that to `/usr/bin/env`, which searches the **child's** `PATH`, and on a machine with no Node —
  the machine this runtime exists for — `serve`, `/healthz` and `explainer_create` all succeed while
  every render exits `127`. Measured here: the shim exits `127` under `PATH=/usr/bin:/bin`, and the
  resolved entry run as `<interpreter> <entry>` under the same scrubbed `PATH` reaches Remotion's own
  code. Going through `bin` rather than through the shim is also why the Windows `.cmd` case needs no
  branch — there is no shim to wrap on any platform — and `PATH` is still never injected through
  `WorkerSpec.env`, which would leak an interpreter onto the `PATH` of everything a worker starts,
  Chrome and ffmpeg included.

- 574480c: Advertise the contract version, and make the `error_code` enum open.

  Spike P1-S3 settled the four questions ADR 0025 §Part two left proposed, and
  this is the code half of that answer.

  `MCP_CONTRACT_VERSION` moves to `@xplainer/protocol`, generated from
  `schemas/manifest.json`'s `version` and exported from the entry point.
  `@xplainer/mcp-server` re-exports it, so no caller changes; the value now comes
  from the package that owns the contract, which is what lets
  `xplainer mcp --attach` read a daemon's version without depending on the MCP
  server it may be about to refuse. `@xplainer/protocol` also gains
  `isContractCompatible(daemon, shim)` — **major-compatible**, symmetric, and
  fail-closed on a version it cannot parse.

  `xplainer serve` now answers `GET /healthz` with `contract_version` beside the
  existing `version`. The two are different numbers on purpose: `version` is the
  release, and it is what the MCP handshake reports in `serverInfo.version`, which
  is why the handshake could never have carried this.

  The `error_code` enum is now **open**: adding a member is a minor contract
  change, and both generated bindings decode a member they do not know as
  `internal` rather than rejecting the record. `schemas/manifest.json` gains an
  `open_enums` table, and codegen emits a decoder per language from it — an
  `enum._missing_` hook on the Python `StrEnum`, which pydantic otherwise rejects
  unknown members against, and a `toJobErrorCode()` function beside a frozen
  `JOB_ERROR_CODE_VALUES` tuple in TypeScript, where the erased union gave a
  consumer nothing to call. A non-string `error_code` is still rejected: tolerance
  is for a newer contract, not for a malformed record.

- 1571cce: `daemon update` and `daemon recover`: the update is a transaction, and one command finishes it.

  **ADR 0025's six update steps become a recoverable transaction**, because an ordered call sequence
  has no answer to "the updater died". `xplainer daemon update --from <runtime dir>` stages the
  incoming payload beside the running one, drains the daemon over ADR 0024's own
  `POST /api/daemon/drain`, rewrites the supervisor artefact and the stable launcher, reloads or
  re-registers with the supervisor, starts the replacement and waits for it to answer an
  **authenticated** `GET /healthz` from a run that is not the one that was drained and that reports
  the release it was launched from. If it does not, the replacement is **stopped before anything else
  is started** — or the rollback would contend for ADR 0024's exclusive ownership and lose — the
  retained previous runtime is put back, and the command exits `4` with the old version running.

  **An operation lock, and it is not `owner.lock`.** `<state>/update.lock` keeps two updaters, or an
  updater and an installer, from interleaving; `owner.lock` belongs to the daemon this transaction
  drains on purpose. A live holder is refused with exit `10` — ADR 0020's code, reused per ADR 0024
  §Exclusive ownership rather than a new one — and a lock whose holder is provably gone is taken over
  by the same tuple check and settle-then-read-back that `daemon/lock.ts` uses, because otherwise a
  dead updater's lock would block the recovery for ever.

  **A durable journal, and a recovery that is commanded rather than automatic.**
  `<state>/update.json` names the last completed transition and the retained previous runtime, written
  temp → `fsync` → `rename` at every boundary. `daemon status` **reports** an interrupted transaction
  and names the command; `xplainer daemon recover` — also `daemon update --recover`, and the first
  thing `daemon restart` does — completes it or rolls it back. `status` never repairs. The cost is
  stated rather than hidden: on Linux and macOS, an updater that dies between the drain and the
  restart leaves nothing running until that command is run, because the daemon exited `0` and `0` is
  the portable "do not restart" signal for both `Restart=on-failure` and
  `KeepAlive{SuccessfulExit:false}`. Every step between two boundaries is idempotent, so a recovery
  **repeats** the interrupted step rather than repairing it. A journal written by a newer release is
  preserved and named, never acted on: a newer `format_version` is a rollback signal and not
  corruption.

  **The source of the new runtime is explicit**: `--from <dir>`, or `--build` to assemble one from
  this program's own checkout. Never whatever is on `PATH` — a package manager replaces the _global_
  CLI and leaves the pinned copy the supervisor executes exactly where it was, which is the fact this
  command exists for.

  **A workspace-changing update is refused, and that is this phase's supported class.** Before
  anything is staged or drained, `update` requires the installed and incoming runtimes to pin
  **identical** `template/package.json` versions — pins, never the template package's own version
  string — **and** the installed workspace to verify against both. Otherwise it exits `3` having
  written nothing and drained nothing, and names the reinstall path — `setup --workspace` then
  `daemon install` — spelled with the **new runtime's own interpreter and entry**, because the
  installed launcher execs the old runtime and would re-resolve the old pins. Both clauses are load
  bearing: a workspace that satisfies only the incoming runtime passes for a user who has already run
  `setup --workspace`, and the rollback target is exactly the runtime it no longer satisfies. Staging
  a matching workspace beside the new runtime does not make the update proceed; keeping one payload
  transactional is what makes the rollback mean something.

  `daemon --help` now lists nine verbs. `daemon status --json` gains an additive `update` field
  carrying the journal's state; every existing field, the condition set and the exit codes are
  unchanged.

- acdd06a: The toolchain manifest, and a downloader that resumes, verifies and commits whole.

  [ADR 0005](docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md) books "a CDN and a
  version/checksum manifest" as infrastructure rather than an afterthought, and requires that "the
  download path has to verify the checksum before extracting". `apps/cli/src/setup/` is that manifest,
  that download, and the archive reader between them. Nothing calls it yet — `xplainer setup` is still
  a stub, and the three providers that use this are the next story — but the document and the
  transport are settled here.

  **The manifest is fetched from the one hostname Terraform provisions.**
  `https://cdn.<zone_name>/toolchain/v1/manifest.json`, where `infra/terraform/main.tf` declares
  `cdn_hostname = "cdn.${var.zone_name}"` as a **proxied** CNAME onto the R2 bucket. The bucket's own
  `r2.dev` URL is refused by name, on that file's own argument: it "is explicitly not cached by
  Cloudflare, so serving a ~110 MB CLI binary or a several-hundred-megabyte voice pack from it would
  pay origin egress on every single download". A speech bundle recorded against any other host is
  refused when the manifest is parsed.

  **The expected Chrome digest is selected by the exact URL the pinned Remotion line resolves, not by
  an `<os>-<arch>` key.** `@remotion/renderer`'s own `getChromeDownloadUrl` branches on Amazon Linux
  2023, on `chromeMode` and on whether the host's glibc is at least 2.35 — so `linux-x64` alone
  resolves to three different artefacts, and a key that ignores the C library selects one that
  installs and cannot run, which is what ADR 0020's "Alpine is blocked on rendering, not on init"
  costs. `manifest.ts` mirrors that selector branch for branch, its suite drives the **real** function
  over all 80 combinations and compares, and the manifest is then searched for the entry carrying that
  URL. Two properties fall out: the manifest cannot redirect a download, because the URL fetched is
  the selector's rather than the document's, and a configuration with no recorded entry is a refusal
  naming the URL rather than a download of unreviewed bytes.

  **Digests are expected, never recorded.** `sha256` is a required input to the download, captured
  when the manifest was built and reviewed like any other pinned input; nothing in this code writes a
  manifest or takes a digest from the bytes that arrived. A digest recorded on first acquisition
  cannot reject an incorrect-but-intact archive — it only detects later drift.

  **The committed manifest carries eight platform entries with real digests, and says so where it
  carries none.** The ninth configuration — arm64 Linux below glibc 2.35 and not Amazon Linux —
  resolves to a Playwright build whose CDN answers `400 GatewayExceptionResponse` through its own
  redirect (measured 2026-09-08), so it is recorded as unavailable with that measurement and the
  remedy, rather than left as a hole. The four speech platforms are recorded the same way, because
  nothing is published to the CDN in this phase and the two routes that do exist are the pinned Docker
  image and `--tts-url`.

  **Every failure has a name.** `short-body` keeps the partial, so the next run resumes it;
  `checksum-mismatch` deletes it, so a wrong body is never resumed onto; `resume-not-honoured` refuses
  a `206` that answers a different range than the one asked for, because appending it produces a file
  of the right length and the wrong contents; and `proxy-interception` names a `407`, an HTML filter
  page — quoted back — or a TLS handshake that never reached the origin. That last one is ADR 0005's
  own acceptance condition: "a download that fails behind a corporate proxy must say so, not produce a
  render that fails later with a missing-binary error."

  **It speaks `node:http` rather than `fetch`, on a measurement.** On Node 24 a `407` never reaches a
  `fetch` caller at all — undici turns it into a network error whose `cause` is an empty `Error` with
  no `code` — so the branch naming the likeliest corporate-proxy response would have been dead code.
  The artefact URLs also redirect, and a redirect that leaves `https` is refused rather than followed.

  **The commit is a `rename` of a staging directory beside the destination**, so a half-unpacked
  toolchain is never visible under the name a later `setup`, an install preflight or a render will
  look for — the argument `install/stage.ts` makes for a payload, applied to an archive.

  The zip reader is written here rather than taken as a dependency: a new runtime dependency of this
  package is a change to payload 1, to the publish contract and to every installer. It reads the
  central directory, checks each member's CRC-32, preserves modes and symlinks the way Remotion's own
  extractor does, and refuses every entry that would write outside the directory it is unpacked into.

- af31c2f: `POST /api/daemon/drain` over the socket, and `xplainer daemon restart` behind it.

  **The daemon's six-step drain is now reachable as a route, and only over the IPC listener.**
  [ADR 0024](../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Drain on planned restart is
  one sequence — stop accepting, give the running job 20 s, kill its process group, mark `running` and
  `queued` records `daemon_shutdown`, remove `runtime.json` and the socket, exit `0` — and until now
  the only way to ask for it was `SIGTERM`. That is a mechanism Windows does not have: Node maps
  `SIGTERM` there to `TerminateProcess`, so no handler ever runs and there is no such thing as a
  graceful stop through a signal. `POST /api/daemon/drain` is the same sequence asked for over HTTP,
  and it answers `202` with the daemon's own cap and pid before it begins.

  **Over TCP it is `404`, with a valid bearer token, exactly as a route that does not exist answers.**
  The token is what lets an agent render on this machine; it must not also be what stops the machine's
  daemon. How the two listeners are told apart is one new `CreateServerOptions` field —
  `isOverIpc?: (request: Request) => boolean` — which `startServer()` fills in from the `WeakSet` its
  socket adaptor already keeps. Membership is a fact about which listener accepted the connection, so
  no header, path or body can move a request across that line, and nothing reads `remoteAddress`.

  **The acknowledgement is written before the listeners close.** Step 6 removes the socket and exits
  the process, and a client that asked for a drain and got `ECONNRESET` cannot tell a daemon that is
  draining from one that crashed. The route replies first and begins the drain when that response has
  left the socket. Closing the listeners afterwards is now **bounded**: `server.close()` waits for the
  last connection to go idle, which for a long-lived response — an SSE stream, a media body, a poll
  that is still open — is never, so after one second the remaining connections are closed and the
  teardown finishes inside P1-7's 25-second budget rather than hanging with a socket file on disk.

  **`xplainer daemon restart` is the seventh verb, and it is no longer a stub.** It clears the
  application's failure latch **first** — `daemon.json`'s `stalled` record _and_ the start history
  `isStalled()` re-latches from, because clearing one without the other is a restart that latches
  again on the next start — then the supervisor's, which on Linux is `systemctl --user reset-failed`
  and on the other two is nothing, said in words rather than skipped silently. Then it asks the daemon
  to drain over the socket, waits for that process to be gone and `runtime.json` with it, asks the
  adapter to start, and waits for an authenticated `GET /healthz` against the record the new run
  wrote. **An already-stopped daemon is a success**, not a refusal: that is the state people run this
  command in.

  The report says which latch was holding the daemon down, whether the running one was drained or
  stopped another way, and — on the one platform with a documented query for it,
  `systemctl --user show -p Result -p ExecMainStatus` — how that run actually ended. No exit code
  changed: `restart` refuses with `3` when nothing is installed and `4` when the daemon would not stop
  or would not come back.

- dbfe59d: `serve` answers the `/api/*` REST and SSE surface a GUI client reads.

  ADR 0016 promises "REST + SSE at `/api/*` for GUI clients" beside the MCP endpoint, and phase 1
  built only `/healthz`, `/mcp` and — from T13 — the drain control route. The surface a desktop is
  judged against now exists: the library, the artefact bytes, the three long-running tools, one job,
  and the stream that reports it.

  | Method       | Path                                                 | Answers                                                               |
  | ------------ | ---------------------------------------------------- | --------------------------------------------------------------------- |
  | `GET`        | `/api/videos`                                        | `{ videos: ApiVideo[] }` — the library, each entry with its artefacts |
  | `GET`        | `/api/videos/:slug`                                  | one `ApiVideo`                                                        |
  | `GET`/`HEAD` | `/api/videos/:slug/artefacts/:name`                  | the bytes, with `Range`                                               |
  | `POST`       | `/api/videos/:slug/narrate` \| `/still` \| `/render` | `202` and a `job_id`                                                  |
  | `GET`        | `/api/jobs/:id`                                      | `ExplainerJobOutput`, unchanged                                       |
  | `GET`        | `/api/jobs/:id/events`                               | `text/event-stream` of that same document                             |

  **Nothing here is a second implementation of a tool.** Every route relays to the same
  `RenderBackend` `/mcp` dispatches through, so a window and an agent watching one render read one
  description of it: `GET /api/jobs/:id` answers with exactly what `explainer_job` answers with, and
  each SSE frame carries that document. The three `POST`s take the slug from the path and pass the
  rest of the body through untouched, which leaves `backend.ts` the only place a refusal is decided.
  The backend's refusal codes reach the client unchanged inside `{ error: { code, message } }`, with
  the status this surface promised for each: `404` for `NO_SUCH_VIDEO`, `409` for
  `NARRATION_MISSING`, `503` for `WORKSPACE_NOT_INSTALLED` and for a daemon that has stopped
  accepting work mid-drain.

  **What the tool contract deliberately does not carry, this surface does.** `ExplainerListOutput`'s
  `mp4` is a path on the machine that answered — a hosted backend must not expose one and a player
  cannot open one — so `ApiVideo` drops it and carries artefacts instead: the film, the stills, the
  narration audio, the captions and the timings, each with the route that serves its bytes. That
  route implements RFC 9110 §14 for a single byte range, which is the difference between a player and
  a download: `206` with `Content-Range`, `416` outside the file, `Accept-Ranges` on every answer, and
  the body read lazily so a 200 MB render costs one file descriptor rather than 200 MB of heap. An
  artefact is fetched **by name out of an enumeration** and never by a path joined to what a client
  sent, and the slug is checked against `schemas/slug.json`'s pattern before anything touches the
  disk.

  **The stream ends by itself.** A `job` frame is written only when the document changed, a comment
  line keeps a silent render's connection provably alive, and a terminal job gets one last frame, an
  `end` frame and a close — so a window does not have to decide when to stop listening and the daemon
  does not accumulate streams over jobs that finished hours ago. A job this daemon has no record of
  is a `404` before the stream opens, rather than a stream an `EventSource` would reconnect to for
  ever.

  **The guard is the guard that was already there.** The routes are registered after the middleware
  `createServer()` mounts on `*`, so the bearer token, the `Host` allowlist and the `Origin` check
  cover every one of them on TCP, and the IPC listener passes none — filesystem permissions on a
  `0700` directory are that transport's authentication. There is no per-route authentication and
  **no CORS middleware, for any value** (R-SEC-7): the desktop's renderer never talks to this daemon
  directly, so no browser origin needs allowing, and one that was allowed would let any page a user
  visits drive this machine's daemon with the browser's own credentials attached.

  The whole surface is **optional**. `createServer()` mounts it only when it is given an `ApiSeam`,
  so `services/media-service` binds the same application, over the same tool registration, with no
  route that assumes a workspace on local disk.

  New from `src/index.ts`, for `apps/desktop` to import rather than describe a second time:
  `ApiSeam`, `createWorkspaceLibrary`, `VideoLibrary`, `ApiVideo`, `ApiArtefact`, `ArtefactKind`,
  `ArtefactFile`, `ApiJobQueued`, `ApiErrorBody`, `ApiErrorCode`, `ApiRefusal`, `JobStreamEnd`,
  `JOB_EVENT`, `END_EVENT`, `DEFAULT_JOB_POLL_INTERVAL_MS`, `DEFAULT_HEARTBEAT_MS`,
  `RECONNECT_DELAY_MS`, `API_PREFIX`, `videosPath`, `videoPath`, `artefactPath`, `enqueuePath`,
  `jobPath` and `jobEventsPath`.

  The drain now has the case T13 specified and could not exercise: a drain asked for over the socket
  with an **open SSE stream and a media body mid-transfer**, asserting that the acknowledgement is
  complete before the listeners close and that closing them still finishes.

- f73e8cc: `daemon update` stops refusing every workspace `setup` has ever produced.

  `runtime verify` re-hashed both payloads with one rule — "the tree holds the manifest and nothing
  else" — and `daemon update`'s pre-drain check runs that rule over the **live render workspace**. A
  workspace's manifest describes `node_modules/`, `package.json` and `package-lock.json` and
  deliberately nothing else, while `setup` also copies in `remotion.config.ts`, `tailwind.css` and
  `tsconfig.json`, and `videos/`, `out/`, `public/`, `.remotion/` and Remotion's
  `node_modules/.cache/` arrive around them. Every one of those was reported as a file "in the payload
  and not in the manifest", so `xplainer daemon update` exited `3` on every machine that had run
  `xplainer setup` — before anything was staged, and with no way for a user to get past it.

  Verification now takes an explicit mode per payload rather than a single rule:
  - **Payload 1, the runtime, is unchanged and stays exhaustive.** Nothing but `runtime build` and
    `install stage` writes inside a runtime payload, so a file that appeared in one is an integrity
    failure whatever it is called.
  - **Payload 2, the workspace, is checked as _described_.** Every file the manifest names must be
    present with its recorded size and digest — that is what proves the pins the check exists for —
    and a file the manifest does not describe is allowed _unless it shadows a described one_: a
    package copy nested under the described `node_modules/` whose name that tree also carries at the
    top level. Node resolves the nearest `node_modules` first, so such a copy is the version a render
    would load while the manifest still records the pinned one, which is the one way an extra file can
    make the pin comparison a lie. It is reported as a new `shadowed` reason, by the package it
    shadows.

  `daemon status` also stops polling `/healthz` through the platform's `fetch`. Node's bundled undici
  calls `socket.setTypeOfService()` on every request it writes and `node:net` reports a failed
  `setsockopt` by _throwing_ — from inside the socket's own event handler, so `EINVAL` on a pooled
  socket the daemon has torn down between two asks is an uncaught exception that no `try`/`catch`
  around the call can see. The probe now uses the same unpooled `node:http` client the install's
  readiness poll already used, one connection per ask.

- e2c99a5: **A failed start used to leave `daemon.json` claiming an origin for no file, and the next remote
  bind read the daemon's own minted token as the operator's.**

  `token_origin` answers for the file `token_file` names, and the two were being written at different
  moments: the origin the instant the token was read or minted, the path only in `markReady()`, after
  ownership, reconciliation and both binds. So any ordinary start that failed _between_ them — a held
  port, a certificate pair that will not load, a socket path the platform refuses — recorded
  `token_origin: "minted"` with `token_file: null`. On the next start `resolveTokenOrigin` compared
  the resolved path with the recorded one, found the record named no file at all, and answered
  `operator` for the very token this daemon had minted seconds earlier. ADR 0020 §Security R-SEC-9's
  fifth precondition — "a bearer token this daemon did not mint" — was then met by bookkeeping rather
  than by an operator, and the daemon said so: _"with an operator token from `<state>/token`"_, about
  a file nobody but the daemon had ever written.

  The two fields are now one durable write, in `commands/serve.ts`, at the moment the provenance is
  decided; `markReady()` writes neither, and `DaemonBinding` no longer carries `tokenFile`. Recording
  the path before the bind is the point rather than a side effect: the mint is the event whose answer
  the next start inherits, so the run that mints and then fails is exactly the run that has to leave a
  complete record behind.

  Measured against the shipped binary, on macOS, before and after, in a throwaway state directory:
  `serve --port <a port held by another process>` exits `10` having minted the token, and then a
  non-loopback `serve --bind <LAN address>` with TLS and an allowlist **bound the LAN address and
  announced itself ready** — before the fix — and **exits `1` with "the bearer token … is the one this
  daemon minted for itself", having bound nothing** after it. `commands/serve.test.ts` carries the
  same sequence as a spawned-child regression test; without the fix it fails twice, once on the
  incomplete record and once on the bind that should never have happened (exit `70` from the refused
  address instead of the refusal's `1`).

- ce26d75: `xplainer setup` acquires everything the in-process ONNX speech path needs: the Kokoro-82M int8
  graph and one voice pack from the HuggingFace repository they live in, pinned to revision
  `dd4401a9`, and **this platform's ONNX Runtime** from the npm registry. Four artefacts, each pinned
  by digest, each fetched from its own upstream home — this project hosts none of it — and the
  existing verify-then-commit path does all of it: `HEAD`, `Range` resume, streaming SHA-256, the
  named refusals, and a commit that is one `rename`.

  **Why the runtime is acquired rather than depended on, with the numbers.** `onnxruntime-node`
  declares no `optionalDependencies` and carries **five** platforms in one package —
  `darwin/arm64` 88,043,128 bytes, `linux/x64` 45,116,232, `linux/arm64` 24,932,672,
  `win32/x64` 66,310,760, `win32/arm64` 71,871,080, and no `darwin/x64` at all — so depending on it
  would put 296,273,872 bytes of foreign-platform binaries into payload 1's closure and into every
  global install. It also declares a `postinstall` that fetches a **191,730,792-byte** CUDA package
  from `api.nuget.org` on `linux/x64`, which `AC-1d` forbids outright and which cannot be turned off
  from inside this repository. And Microsoft's per-platform release archives are not an alternative:
  they carry the C shared library, the headers and the CMake package, and **no
  `onnxruntime_binding.node`** — the N-API binding exists only inside the npm package, and the two
  halves are different builds of the same version (28,497,752 bytes against 44,726,808 on
  `linux/x64`) so they cannot be mixed. So `setup` fetches the npm tarball, keeps this platform's
  `bin/napi-v6` subtree plus Microsoft's own `dist/` loader verbatim, and puts `onnxruntime-common`
  where that loader's own `require` resolves it. The same bytes cross the wire either way; a third of
  them stay on disk, nothing is fetched from a third feed, and `@xplainer/cli`'s published tarball and
  payload 1 are unchanged.

  Measured end to end on darwin-arm64: 39.7 s to acquire all four, 16 files and 88,062,119 bytes taken
  out of the 296 MB archive, 181,392,041 bytes committed, and the acquired tree loads through
  `createRequire` and answers `waveform[1,33600]` / `durations[1,9]` on the pinned voice. An Intel Mac
  is **refused by name** before anything is fetched, because that binding does not exist.

  `toolchain.json` gains an optional `files` array on `ToolchainComponent`, and `provider: "onnx"`
  uses it. `path` still names one artefact — the model graph, which is what every existing reader
  looks at — and `files` names the rest: the voice, every file in this platform's native subtree, and
  one witness inside each committed tree. ADR 0020 makes `daemon install` "verify the recorded paths
  still exist", and for a component made of several files that check is only meaningful if every path
  is recorded; both readers of the marker now check all of them. The field is **optional**, so
  `format_version` does not move: an older build reads the marker exactly as it did.

  **One voice, deliberately.** Nothing in the eight-tool contract can select a second — a voice no
  caller can name is 0.5 MB of unreachable bytes and a digest somebody has to review — and adding one
  later is two lines and a reviewed digest on a command that is re-runnable by design.

  **The `onnx` route sits below `docker` and above `bundle`**, which was decided against the proofs
  rather than by preference: `scripts/e2e/toolchain.mjs` opens `marker.speech.path` _as the docker
  receipt_ on any machine whose `docker version` answers, so an `onnx`-first order would have that
  gate parse a 92 MB model. Docker keeps every host with an engine; `onnx` closes every host without
  one — which is Windows, and every locked-down laptop and Linux container besides.

  **A pre-existing warm-cache defect is fixed here**, independent of any of the above.
  `providers/speech-bundle.ts` skipped the download **and the verification** whenever its destination
  directory already existed, and then recorded the digest it had merely been told for a tree nothing
  on this machine had ever checked — and because the destination was named after the _version_, a
  re-published artefact at an unchanged version would have been served out of that cold cache for
  ever. Cache identity now binds the digest, and every committed acquisition carries a record inside
  the tree it commits (written before the `rename`, so it is present exactly when the tree is) that a
  later run re-verifies. Nothing records a digest it did not observe.

  Two internal modules make it work and neither adds a dependency: a **streaming gzip-tarball
  reader** with a member selector, because the npm registry serves `.tgz` and this platform's subtree
  is one of five in it, and the record-and-re-verify machinery above. `deliveryPosition()` loses its
  Windows paragraph — the sentence saying Windows has no working speech route is what the `onnx` route
  makes false.

- d01d6db: The install preflight, the entry an installed machine actually gets, and `connect --spawn`.

  **One read-only preflight answers every question before an install writes anything.** ADR 0020's
  rule for the degraded paths is "probe before writing; on refusal, write nothing, exit with the
  documented code, and print the one command that fixes it", and `install/preflight.ts` is the probing
  half in full: the setup marker and whether the files it records still exist, the supervisor **and
  whether this user has a manager to register with**, the resolved program's executability, the port,
  the linger marker, a stale `launchctl` disable record, and the token file. Its refusals carry codes
  from the table and invent none — `3` for a missing marker, a stale one or a program that will not
  execute, `6` for no user manager and for a Task Scheduler that refuses a query, `7` for a held port,
  with the holding pid named in words from `lsof` or `ss` where either answers.

  **Read-only is the property, and lingering is where it is won.** The preflight reads
  `/var/lib/systemd/linger/$USER` and **never** attempts `loginctl enable-linger`: enabling lingering
  _creates_ that marker, which is a write inside the phase whose whole contract is that a refusal
  leaves the machine as it was. The absent marker is a fact the writing phase acts on, which is also
  what makes `daemon.json`'s `linger_enabled_by_us` meaningful — an install can only remove a setting
  it made. Every refusal case is asserted against a hashed snapshot of the state directory _and_ of
  the supervisor's own artefact location, so "writes nothing" is a comparison rather than a claim.

  **systemd is detected by `/run/systemd/system`, never by `command -v systemctl`** — that directory
  is what `sd_booted(3)` checks, and Debian and Ubuntu base images ship the binary without systemd as
  PID 1, so the naive probe reports a supervisor on exactly the container that has none. Presence is
  still not enough: `systemctl --user is-system-running` is what establishes that _this user_ has a
  manager, and "systemd booted this machine" and "you have somewhere to put a unit" are two different
  facts with the same remediation and different sentences.

  **`connect` writes the stable launcher, and `--spawn` exists.** A runtime-directory install puts
  nothing on `PATH`, so `connect` used to fall through to `npx -y @xplainer/cli` — an entry pointing at
  a package this phase does not publish, written on the one machine that already has the code. The
  order is now `<state>/bin/xplainer`, then the binary on `PATH`, then `npx`, and a version-scoped
  runtime directory is never written. `xplainer connect claude|codex --spawn` writes the other entry —
  `xplainer mcp` **without** `--attach`, the eight tools inside the agent's own session — and it
  **bypasses the daemon preflight**, because it is the remediation both exit-`6` messages lead with
  and is offered exactly when there is no daemon to check for. It works with no launch record: the
  launcher when an install wrote one, the staged runtime otherwise, which is the one place a
  version-scoped path is allowed and it is allowed because a refused install has no update to break
  it.

  **`mcp --attach`'s skew message names a command this machine can run.** It printed
  `npm i -g @xplainer/cli@<version>`; nothing is published, so it named a package that does not exist.
  It now names the launcher the daemon's own install wrote — the one name a shim and a daemon share
  across an update — or, where there is none, the command that creates it. A dated note in
  `mcp/attach.ts` records that the npm form returns when the publish happens.

  **`@xplainer/protocol` gains `toolchain.json`.** The setup marker becomes a checked contract with
  generated bindings in both languages — the Chrome and speech versions, resolved paths, `sha256` and
  provider, and the workspace payload's platform and version — because three surfaces read it and none
  of them owns it: `setup` writes it, the install preflight validates it, and `daemon update` compares
  the workspace it records against an incoming runtime's template pins. An unknown newer
  `format_version` is a rollback signal rather than corruption, so a marker a later build wrote is
  read rather than rejected.

- af31c2f: `xplainer daemon install` and `xplainer daemon uninstall` do the thing, on all three platforms, with a rollback that leaves a failed install invisible.

  **`install` is preflight → stage → render → register → verify, and the last step is the one that
  makes it an install.** A supervisor that accepted a unit has said nothing about whether the daemon
  runs, so `install` starts it and polls an **authenticated** `GET /healthz` with a bounded timeout —
  which is the wait ADR 0025's note of 2026-09-08 assigns to the caller when it rejects `Type=notify`
  — and reads the port out of the `runtime.json` the daemon itself wrote rather than out of the
  artefact it was asked for. Every step that changes anything registers its own undo beside it, so a
  failure at step nine removes what steps one to eight wrote: the registration, the record, the
  artefact, the launcher, the staged runtime, the linger marker, and the empty directories the
  install's own `mkdir -p` invented — `~/.config/systemd/user` among them, which is the user's tree
  and not this project's.

  **The orders are the ones the platforms actually require, and each is now checked against the
  argument vectors a supervisor was handed.** On Linux lingering goes **first**, because
  `loginctl enable-linger` is the one step that can be refused outright, and the check that follows is
  `test -e /var/lib/systemd/linger/$USER` rather than `loginctl`'s exit status — `loginctl` is a client
  of `logind` and reports what it was told. On macOS `launchctl enable` precedes `bootstrap`, because
  `man launchctl` says a disabled service "cannot be loaded in the specified domain until it is once
  again enabled" and that state survives reboots; `bootout` comes before both, because `bootstrap`
  does not refresh an already-loaded definition, and `kickstart` comes last. On Windows
  `Register-ScheduledTask -Xml … -Force` is followed by `Start-ScheduledTask`, and a health failure
  there reads `LastTaskResult`, names `SCHED_S_BATCH_LOGON_PROBLEM` (`0x0004131C`) as a **candidate**
  rather than a diagnosis, unregisters, and exits `5`.

  **`uninstall` deletes the token rather than rotating it.** P2-9 asks for no live token afterwards and
  rotation mints a new value and leaves it on disk, so the file goes — wherever `XPLAINER_TOKEN_FILE`
  put it — along with the artefact, `runtime.json`, `owner.lock`, the socket, every staged runtime and
  the launcher. `toolchain.json` and the workspace stay: the marker is `setup`'s and the workspace is
  the user's videos.

  **It never disables lingering, not even lingering this project enabled**, because
  `/var/lib/systemd/linger/$USER` is per user and not per service: anything else the user has since
  arranged to survive logout depends on it. `daemon.json` records that we enabled it and `uninstall`
  reports it with the one line that undoes it. The rollback of a _failed_ install is the single
  exception, and only there because the marker is seconds old.

  **Two exit codes stop being reserved.** `5` — the install needs an administrator — is what a denied
  `enable-linger` and a Windows principal without the "Log on as a batch job" right both take, and `6`
  now leads with `sudo loginctl enable-linger` instead of `connect --spawn` when systemd booted the
  machine and the user manager is absent _because_ lingering is: measured inside the project's own
  systemd container, `systemctl --user is-system-running` answers "Failed to connect to bus" in that
  state, and the old message called a fixable machine an unsupported one.

  **A `launchctl` disable record for our label is cleared; an `enabled` one is named and left.**
  `launchctl` sets a record's value and has no verb that removes it — `enable` and `disable` are the
  only two, and the store is root-owned — so `uninstall` clears the record that would break a later
  install and reports the inert one it cannot remove, rather than "cleaning up" with
  `launchctl disable` and creating exactly the stale disable record the preflight exists to warn about.

  **Fixed on the way past.** `xplainer mcp --attach` reads the daemon's recorded `socket_path` before
  falling back to the path derived from the state directory, so a daemon started with `serve --socket`
  elsewhere — which is what an installed one is — is reached rather than reported unreachable. And the
  install preflight's `launchctl print-disabled` reader matched `=> true`, which no modern macOS
  prints: captured verbatim from macOS on 2026-09-08, the store spells a record `=> disabled` or
  `=> enabled`, so the probe answered "not disabled" for every label on the platform and the one
  condition it exists to catch was unreachable.

  `xplainer daemon start`, `stop`, `status` and `logs` join them, over the same one supervisor seam.

  **`daemon status` is built from `/healthz`, our own state files, and three documented
  machine-readable supervisor queries — and never from `launchctl print`.** The blanket "never parse a
  supervisor" rule made one of ADR 0020's **own** required sentences unobservable: whether the user
  switched the service off appears in no HTTP response and in no file this project owns, because Login
  Items & Extensions changes launchd's disable store and touches nothing of ours. So the rule is
  narrowed to the surface whose own manual disowns it — `launchctl print`, "This output is NOT API in
  any sense at all" — and three queries with stable answers are allowed: `launchctl print-disabled
gui/$UID`, `systemctl --user is-enabled xplainer.service` and `(Get-ScheduledTask …).State` for the
  switched-off fact, and `systemctl --user show -p ExecStart -p Environment -p WorkingDirectory
--value` and `Get-ScheduledTask` for the loaded configuration, which **macOS does not have** and
  which `/healthz`'s responding identity stands in for there.

  **The four sentences ADR 0020 requires are values with a state tag, not prose in a command**, and
  the test compares them with the four quoted strings read out of the ADR file itself. Reword one in
  either place and the suite fails. Two of the four name a platform's own surface — "Login Items &
  Extensions" means nothing on Linux and lingering is a systemd concept — so the ADR's exact sentence
  is what the platform it was written for produces, and the other two make the same claim about the
  surface their user actually has.

  **`daemon status --json` answers from a closed set of conditions**, the same members `xplainer
status` uses plus two that need a supervisor or the setup marker: `disabled`, which no HTTP response
  can see, and `degraded` — the daemon answered `200` and the toolchain `setup` recorded is not on
  this machine. `degraded` exits `0`, because the daemon is running and a script that gates on "is it
  up" should not fail over a missing Chrome; the sentence and `toolchain.missing` are how a reader
  finds out.

  **`start` and `stop` wait for a post-condition rather than for an exit status.** All three
  supervisors return as soon as they have accepted the request, so a start that trusted the status
  would report success for a daemon that never bound. `start` waits for an authenticated `200` through
  the same `awaitHealthy` the install uses — reading the port out of the `runtime.json` this start
  wrote, which is the only correct answer for a daemon installed with `--port 0` — and `stop` waits
  until nothing answers, tolerating the non-zero status all three report for stopping something that
  was not running. `stop` leaves the registration in place: on macOS it sends `SIGTERM` with
  `launchctl kill` rather than booting the job out, because a stop that deregistered would be an
  uninstall with another name.

  **`daemon logs` execs `journalctl --user -u xplainer` on Linux and tails the daemon's own file on
  macOS and Windows**, which is ADR 0020's deliberate asymmetry: journald already does retention, and
  launchd has no log-rotation key at all. Windows now records that file's path — `%LOCALAPPDATA%\
xplainer\logs\daemon.log`, the one ADR 0020's platform table names — instead of `journald`, which
  was never true there: a Scheduled Task's `<Exec>` captures no output at all, so Windows is the
  platform where the daemon writing its own log is the only way there is one. The writer that keeps
  that file under a size bound is not in this release, and `daemon logs` reads whatever is there.

- d01d6db: The program resolver, the runtime stager, the stable launcher, and exit codes `5`, `6` and `7`.

  **One resolver decides where an install's program comes from**, and records its answer in
  `daemon.json` as `program_source`. The four sources are tried in a fixed order and there is no
  registry to add a fifth to: `explicit` (`--program <absolute path>`, taken verbatim after a
  preflight), `sea-binary` (`--from-binary`, accepted as a request and refused as phase-4 work),
  `package-manager` (refused, because nothing is published yet — the branch a publish adds locates the
  global install and hands its directory to the same stager) and `runtime-dir`, the phase-2 default: a
  payload-1 artefact staged under the state directory. The two refusals are branches rather than
  absences on purpose — a resolver that fell through to the default when it was asked for a source it
  cannot serve would write `runtime-dir` into the one field whose whole job is to say where the program
  came from.

  **The stager materialises a payload at `<state>/runtime/<version>-<digest>/` by temp dir → rename.**
  The temporary directory is a _sibling_ of the target, because `rename(2)` is atomic only within one
  filesystem and a state directory relocated onto another volume would otherwise turn the operation
  this rests on into a copy-and-delete that can be interrupted: the invariant is that **a half-copied
  runtime is never visible under its final name**. The name is the content — the version of the package
  the launch contract's entry lies in, plus a SHA-256 over every file hash, every symlink target and
  the host facts the payload was built against — so re-staging the same artefact copies nothing, a
  payload that differs by one byte gets a directory of its own, and an update can stage the new runtime
  beside the running one. The payload is re-hashed against its own manifest _before_ the copy, so a
  tampered artefact is refused while the state directory still holds nothing the call made. The build's
  `created_at` is deliberately not in the digest: two builds of one tree are one runtime.

  **`<state>/bin/xplainer` (`xplainer.cmd` on Windows) is the one name a consumer may hold across an
  update.** It is a generated two-line script: `#!/bin/sh` and `exec "<runtime>/bin/node"
"<runtime>/lib/node_modules/@xplainer/cli/dist/bin.js" "$@"`. `exec` costs nothing — a shell that
  `exec`s keeps the same pid — and the file is rewritten by the same small-file temp → rename as the
  unit, the plist and the task XML, with the mode set on the temporary so the name never appears
  carrying one a consumer cannot run. Without it, `connect` writes a `<version>-<digest>` directory into
  an agent's configuration and the next update points it at a deleted path.

  **Three exit codes gain names and rows.** `5` administrator privileges required, `6` no supported
  supervisor, `7` an install-time port or label conflict. The distinction between `7` and `10` is
  stated in `docs/ARCHITECTURE.md` §6 and asserted by a test, because it is the one a reader gets
  wrong: **`7` is install-time preflight** — the port `install` is about to record is held, nothing is
  registered and nothing is recorded — and **`10` is `serve`-time ownership**, the state directory or
  the recorded port taken by a process running now. Same symptom, two lifecycles, two remediations.

  No command exits `5`, `6` or `7` yet and nothing writes a launcher yet: `xplainer daemon install` is
  still a registered stub, and it is the first caller of all of this.

- 26aade2: `serve` binds a second listener, and `xplainer mcp` is a real command on both sides of it.

  **The IPC listener.** `serve` now binds a unix socket — a named pipe on Windows — inside a `0700`
  directory under the state directory, over the _same_ Hono application and the same tool
  registration as the TCP port: one `createServer()`, two listeners. The socket carries **no guard**,
  because filesystem permissions are that transport's authentication, and the exemption is a fact
  about which listener accepted the connection rather than anything a request can claim — the
  socket's own adaptor records the `Request` it built, and nothing a client sends can put a TCP
  request in that set. The same `GET /healthz` is answered `401` on the port and `200` on the socket,
  which is the pair of tests that makes the claim mean something. The path is the ready line's
  `socket` field and `runtime.json`'s, and a clean shutdown unlinks it. A socket left behind by a
  `SIGKILL` is cleared at the next start — after ownership is acquired, so clearing one can never
  clear a live daemon's.

  **`xplainer mcp`** runs the eight tools over stdio in its own process, over the shared Remotion
  workspace and a job store private to the session. That is the entry the plugin bundles'
  `npx -y @xplainer/cli mcp` points at and the MCP specification's own first-choice mitigation for a
  local server. It deliberately does not take the daemon's job store or its ownership lock — a job
  store is single-writer — so a `job_id` from this connection means nothing on another, and the
  session directory is removed when the client goes away.

  **`xplainer mcp --attach`** proxies that same stdio to a running daemon's socket, so an agent's
  configuration holds a command and neither a URL nor a token. Before it proxies anything it reads
  `contract_version` from `GET /healthz` over the socket and applies `isContractCompatible()`: an
  incompatible pair exits **`8`** naming both contract versions and the command that fixes it —
  `npm i -g @xplainer/cli@<the release the daemon reported>` — while two releases that serve the same
  contract attach normally. A daemon that is not answering on its socket exits `4` and names both
  `xplainer serve` and the `--attach`-less command that needs no daemon.

  Everything is proved against real processes: a spawned `serve`, a spawned shim, and an
  `@modelcontextprotocol/sdk` client over the command line an agent would be given.

- c8bd1d0: **On Windows, a daemon `xplainer daemon install` started and that then died stayed dead until the
  next interactive logon — which on a machine already logged in is the next reboot.**

  ADR 0020 gives the Windows daemon an "indefinite `PT5M` trigger repetition" as its restart policy,
  and the registered task carried one. It was never running. A `<Repetition>` belongs to a **trigger**,
  and the only trigger in the document was a `<LogonTrigger>`: `install` starts the task with
  `Start-ScheduledTask`, which is an _on-demand_ run and starts no trigger, and a logon trigger does
  not fire in a session the user logged into before opening the terminal `install` runs in. So between
  an install and the next logon nothing re-checked that the daemon was alive.

  The document now carries a **`<RegistrationTrigger>`** with the same indefinite `PT5M`
  `<Repetition>` beside the `<LogonTrigger>`, because registering the task is itself the trigger event:
  the run that registration produces is a triggered run, and its repetition then runs the task every
  five minutes for ever. Registration covers this boot and the logon trigger covers the next one.
  `install`'s explicit `Start-ScheduledTask` is unchanged and cannot now produce a second concurrent
  daemon — `MultipleInstancesPolicy: IgnoreNew` was measured doing exactly that job.

  Measured on `windows-latest`, 2026-09-09 (run `34317779107`, job `102357526877`): three throwaway
  tasks side by side, one action exiting `10`, `Get-ScheduledTaskInfo` polled every twenty seconds for
  eleven minutes.

  | document                                                                             | started by              | runs in 11 minutes        |
  | ------------------------------------------------------------------------------------ | ----------------------- | ------------------------- |
  | `<LogonTrigger>` alone, `PT5M` repetition — what shipped                             | `Start-ScheduledTask`   | **1**                     |
  | the same plus a `<RegistrationTrigger>` with that repetition                         | nothing; registering it | **3**, five minutes apart |
  | `<RegistrationTrigger>`, four-minute action, `Start-ScheduledTask` immediately after | both                    | **1** concurrent start    |

  The same run settled a second claim, against itself: **`<RestartOnFailure>` (3 × `PT1M`) does not
  restart an action that exits non-zero.** The task above carried `<Count>3</Count>` and
  `<Interval>PT1M</Interval>`, registered and read back out of `Export-ScheduledTask`, and was started
  by a trigger; its runs are five minutes apart. An exit code of `10` is a _completed_ run recorded as
  `LastTaskResult 10`, and what `<RestartOnFailure>` restarts is a task that failed to **launch**. The
  element stays — that is a real, different failure — but the Windows retry cadence is the `PT5M`
  repetition alone, and T14's circuit breaker now waits about twenty minutes for its five failed starts
  rather than the quarter of an hour the old reading of the schema predicted.

  `supervisors/schtasks.test.ts` pins the second trigger and the two `PT5M` intervals;
  `install/testing/breaker-proof.ts` and `.github/workflows/daemon-breaker.yml` carry the new budget
  with the measurement written at the site; and ADR 0020, `docs/daemon.md` and `docs/ROADMAP.md` carry
  dated notes recording what was measured and which of their sentences it corrects.

- 2de797b: `xplainer token rotate`, the token file's re-verified ACL, and a named pipe only its creator can open.

  **`xplainer token rotate` is ADR 0020 §Security R-SEC-8's rotation, grace window and all.** The
  window is the difference between a rotation and an outage: an agent holds the token in its
  environment — Claude Code's `${VAR}` expansion, Codex's `bearer_token_env_var` — and nothing updates
  that environment at the instant a file changes. So the retired value goes into `<token>.previous`,
  at the same `0600` and behind the same Windows entry as the token itself, with the instant it stops
  being accepted beside it; five minutes by default, a day at most, and `--grace 0` for a leak. No
  value is printed and none reaches `daemon.json`, which records two instants and a path.

  **A daemon that stays installed picks the rotation up on its next request.** The guard is handed a
  _function_ rather than a string, and `daemon/token.ts`'s ring re-reads the token and the grace file
  whenever either changes — so both values open the daemon until the window closes, with no restart,
  no signal and no control route. A read that fails keeps the values already held, because the one
  moment the token file is unreadable is the moment something is renaming over it. `daemon uninstall`
  still **deletes** rather than rotates, and now deletes the grace file too: a rotation leaves two
  working credentials, and taking one of them would leave behind exactly the live token P2-9 forbids.

  **`daemon status` re-verifies the Windows token entry, which is R-SEC-5's other half.** A mode is
  not protection on that platform, so `icacls <path> /inheritance:r /grant:r "<user>:(R,W)"` is — and
  one `icacls /inheritance:e`, a restored backup or an installer that resets a tree undoes it while
  changing nothing else about the file. The entry is now read back with a plain `icacls <path>`
  **query**, and a file carrying a second principal or an `(I)` flag gets a `WARNING —` line naming
  what was found and the command that narrows it again.

  **And the gap the record left open: the named pipe now carries a security descriptor of its own.**
  Microsoft documents what libuv's pipe is born with — "full control to the LocalSystem account,
  administrators, and the creator owner … **read access to members of the Everyone group and the
  anonymous account**" — so on Windows "filesystem permissions are the authentication" was a claim
  about POSIX. `net.Server.listen()` still takes no descriptor and this package still ships no native
  addon, but creation was never the only moment available: the daemon opens a handle to its own pipe
  asking for `ChangePermissions` and nothing that could read or write it, and replaces the DACL with
  one protected `FullControl` entry for its own account's SID — full control because
  `FILE_CREATE_PIPE_INSTANCE` is part of it and libuv creates an instance per accepted connection. The
  descriptor belongs to the pipe rather than to one instance, which is what makes narrowing it once
  enough. Reported and never fatal, exactly as the token's entry is, and `serve`'s line about the IPC
  listener says which of the two protections this platform actually got.

- 7c81808: One writer per video, a shutdown that always finishes, and exit code `1` in the table.
  - **`<workspace>/locks/<slug>.lock`.** `xplainer mcp` runs the real worker registry over the same
    workspace root a daemon resolves and deliberately does not take `owner.lock`, so a daemon and two
    stdio sessions could each drive Remotion at one `out/<slug>/explainer.mp4`. The worker factory now
    takes a per-video write lock — last, after every refusal — and the runner gives it back in
    `finish()`, the one place every terminal outcome passes through. A second process asking for a
    video that is held gets _that job_ failed with a message saying to retry; different videos never
    contend, and a `SIGKILL`ed holder's lock is classified stale and taken over by the same identity
    tuple the ownership lock uses. Decided in ADR 0024 §Note, 2026-09-07.
  - **A drain that throws no longer strands the daemon.** `installShutdownHandlers` guarded only the
    happy path: a record write failing on a full disk left the listeners open, the socket file and
    `runtime.json` on disk, nothing calling `exit`, and a second `SIGTERM` logged as ignored — so the
    process hung until a supervisor killed it. Every step is now guarded and the teardown always
    completes; a failure changes the exit code to `70` instead of `0`, which is exactly the
    distinction a supervisor reads. `StartedDaemon.close()` releases ownership in a `finally`, and the
    `xplainer mcp` session drain is guarded the same way so a failing drain cannot leave the process
    waiting on a promise that will never resolve.
  - **Exit code `1` is a named constant.** `USAGE_EXIT_CODE` in `daemon/exit-codes.ts`, used by
    `serve --bind`, `status --url` and `connect --scope`, with a row in `docs/ARCHITECTURE.md` §6 and
    a test that fails if any command exits with a code the table has no row for.
  - **The ready line's shape is recorded where the record is.** `{event, port, socket,
contract_version, pid}` is what ships; ADR 0025's §Part three sketch and its note of 2026-09-06
    said otherwise, and a new dated note corrects both and carries the reasoning that had been living
    only in a source docblock. No behaviour changed.

- 1ec8b8b: `connect` is re-runnable on both agents, `connect codex` delegates to `codex mcp add`, and the IPC
  directory is narrowed to `0700` on every start.

  **`xplainer connect claude` run a second time used to exit `70`.** `claude mcp add` answers a name
  its scope already holds with `MCP server xplainer already exists in <scope> config` and exit `1`,
  and that came out of `connect` as a hard failure over a perfectly ordinary state — running the
  command again after an upgrade, or after the binary moved off `npx`. `claude mcp` has no update
  verb (none of the verbs 2.1.263 offers replaces an existing entry; `add-json` refuses the same way), so that one refusal is now
  answered with `claude mcp remove <name> --scope <scope>` and a second add, leaving exactly one entry
  saying what this version writes. Nothing is removed on any other failure; and because the pair is
  not atomic, a re-add that fails says the entry that was there is gone rather than claiming nothing
  was written.

  **`xplainer connect codex` now prefers Codex CLI's own writer.** `codex mcp add <NAME> --
<COMMAND>…` does exist (codex-cli 0.153.4) — an earlier note in this repository said it did not —
  and it writes the same `[mcp_servers.xplainer]` table and updates it in place when run twice. It is
  delegated to whenever `codex` is on `PATH`, for the same reason the Claude path prefers
  `claude mcp add`: a command that reimplements another program's file layout is a command that is one
  release behind for ever. One thing that CLI does differently is worth knowing before you run it: it
  rewrites the `mcp_servers` subtree, so a comment attached to or inside an `[mcp_servers.*]` table
  does not survive, while comments elsewhere in `config.toml` do. The direct TOML writer — which moves
  nothing it did not write — is unchanged and is still what runs for `--config <path>`, a file that
  CLI has no flag to be aimed at, and on any machine where `codex` is not installed.

  **The socket's `0700` directory is now `chmod`ed, not just `mkdir`ed.** A mode passed to `mkdir`
  applies to a directory it creates and is ignored for one that already exists, so an `ipc/` left at
  `0755` by an older release or a stray `umask` kept those bits for ever — and filesystem permissions
  are the whole authentication of that transport. The state directory above it is left exactly as
  found: `ipc/` is the last directory on the path to the socket, so narrowing it is sufficient.

- acdd06a: `xplainer setup` acquires the toolchain, and the daemon reads what it wrote.

  `setup` stops being a stub. It acquires three components through three provider modules under
  `apps/cli/src/setup/providers/`, records them in `<state>/toolchain.json` — the checked contract
  `packages/protocol/schemas/toolchain.json` already described and nothing yet produced — and the
  daemon now reads that marker at the two moments the condition can be observed.

  **The browser is admitted on an expected digest, never a recorded one.** The URL fetched is the one
  the pinned Remotion line's own selector resolves for this machine; the manifest is then searched for
  an entry carrying **that exact URL**, and all it contributes is the reviewed `sha256` and the
  C-library constraint. A digest recorded on first acquisition cannot reject an
  incorrect-but-intact archive — it only detects later drift — so where the manifest records no entry
  for this configuration, `setup` says so and downloads nothing.

  **Speech has three routes and the refusal names all three.** `--tts-url` records a server this
  machine does not own; `docker` pulls the Kokoro-FastAPI image `services/tts-sidecar` pins by digest
  and **never starts it** — `setup` pulls, the user or the supervisor runs, and the daemon reports its
  absence with the command that starts it; `bundle` is the manifest's own archive, verified by
  `sha256`. When none is possible the exit is `3` with each route's own reason beside it.

  **The render workspace is the third artefact, with two real routes.** `setup --workspace` either
  copies a staged payload 2 — offline, symlinks kept, the tree replaced whole the way `npm ci` replaces
  one — or resolves `template/package.json` with the npm the runtime payload carries. The install
  subprocess is spawned as `<runtime>/bin/node <runtime>/lib/node_modules/npm/bin/npm-cli.js ci` with
  `<runtime>/bin` prepended to **that child's** `PATH` and nothing else's, composed with
  `path.delimiter` because Windows separates with `;`. Measured: without it, `npm ci` from a payload
  under a scrubbed `PATH` exits `127` on `esbuild`'s `postinstall` and leaves no workspace at all, on
  exactly the machine the bundled npm exists for. It does not reopen the rule against injecting `PATH`
  into render workers: that rule exists because a worker spawns Chrome and ffmpeg, and the installer
  spawns neither.

  `package-lock.json` joins `WORKSPACE_FILES` in `@xplainer/render-core`, because `npm ci` in a
  directory without one exits `EUSAGE` — so the lockfile reaches the workspace with the rest of the
  template rather than being placed by whichever installer runs next. `workspaceNotInstalledMessage()`
  now names `xplainer setup --workspace` instead of `npm install`, which is a command a user cannot
  run on the machine the message is printed for.

  **The wiring is the half that was missing.** The worker factory reads `toolchain.json` before a
  still or a render leaves the queue, so a missing marker, a recorded path that has been cleaned away,
  or a workspace resolved for another platform or another template is a **named refusal on the job
  record** rather than an `ENOENT` inside a worker whose log tail is the only evidence. `/healthz`
  answers `{"status":"degraded","reason":"toolchain_missing"}` for the same machine, as a `200` —
  the daemon is up, answering and holding the queue, and a `503` would make every liveness probe treat
  a working daemon as a failed one. `daemon start` and `daemon restart` accept a `degraded` daemon as
  answering for that reason. The tool call and the worker now ask the same question, so a call that
  succeeded cannot queue a job that fails on the toolchain a moment later.

  `pnpm e2e:toolchain` is the proof, end to end and out of a relocated payload.

- 1571cce: `/healthz` advertises who is answering, and `daemon status` compares three rows rather than two.

  **`GET /healthz` gains `run_id` and `runtime_digest`.** `run_id` is the ownership acquisition's own
  `boot_nonce` — a fresh value per run, the same one `recentStarts[]`, `runtime.json` and every job
  record's owner already carry — so a stale process is distinguishable from a fresh one. Every existing
  field is unchanged, and a server built with no identity (the hosted `services/media-service`) reports
  both as `null` rather than omitting them, so the body's shape does not depend on the caller.

  **`runtime_digest` is an immutable startup snapshot**, taken once, after ownership is acquired and
  before anything binds, over the **effective argv**, the **resolved settings**, the **working
  directory** and the staged payload's **content hash**. It is computed from what the process was
  actually launched with and **never from `daemon.json`** — a value read back out of the record would
  agree with the record by construction, and on macOS that record is the only thing a check could
  otherwise compare against.

  **`daemon status` compares three things, because two cannot see the failure the check exists for.**
  An update rewrites the supervisor artefact and records a new launch spec; if the supervisor never
  reloads the definition, the daemon that is answering is still the old one and every file we own says
  otherwise. So:
  - **desired** — `daemon.json`'s launch spec;
  - **loaded** — what the supervisor is actually holding: `systemctl --user show -p ExecStart
-p Environment -p WorkingDirectory --value` on Linux, all three properties, and `Get-ScheduledTask`
    for the **registered task** on Windows, its working directory included, never the local XML mirror;
  - **responding** — the two fields above, advertised by the process that answered.

  **macOS has no loaded row, and that is a decision rather than an omission.** The only `launchd`
  surface that would answer is `launchctl print`, whose manual says "Do NOT rely on the structure or
  information emitted for ANY reason" — and its output interleaves duplicate keys and `state = active`
  lines inside the `arguments` block. macOS therefore detects a failed switch through the responding
  identity alone, and `daemon status` **names which detector fired**, because "the configuration is
  wrong" and "the identity is wrong" are different sentences and only one of them is available there.

  `daemon status --json` gains an additive `identity` object and two additive `health` fields; the
  condition set, the exit codes and every existing field are unchanged. The Windows loaded-configuration
  query now composes three `Key=value` lines itself instead of going through `Format-List`, which wraps
  a long value across lines — and an installed `Arguments` is two absolute paths and six flags long.

  `pnpm e2e:identity` runs the whole of it: the comparison on all three platforms, a real `xplainer
serve` whose advertised digest is recomputed from its own launch, and the four drift scenarios
  against this machine's real service manager.

- d01d6db: The three supervisor artefact renderers, behind one adapter.

  `src/install/supervisors/` renders the systemd unit, the LaunchAgent plist and the Task Scheduler
  document from a `LaunchSpec` and composes **no argument of its own**. Each renderer answers with the
  file's path, its mode, the name its own supervisor addresses the daemon by, and its exact bytes;
  nothing here writes, which is what makes all three platforms verifiable on one machine — the golden
  tests assert each document whole rather than a key at a time.

  **Every setting travels in the argv, on every platform, and that is one rule rather than two.** Task
  Scheduler's `<Exec>` action has no per-action environment map, so Windows had to use the argument
  vector anyway; the two POSIX platforms do the same because **there is no `XPLAINER_SOCKET`
  variable** for an environment emission to use — `--socket` is a flag and `daemon/ipc.ts` reads no
  variable — so an environment-only emission would leave systemd creating a `RuntimeDirectory=`
  nothing writes into. `Environment=` and `EnvironmentVariables` are kept for the state directory and
  the token file, so a reader of a unit or a plist still sees them where they have always been, and
  every emitted value is a **path and never the token itself**. A renderer refuses a contract whose
  `argv` lost a flag its `settings` still name, because that artefact would satisfy every value it
  records and start a daemon that received none of them.

  The values are the measured ones. `Type=exec` with **no `NotifyAccess=` line at all**, per ADR
  0025's note of 2026-09-08: a unit that let the two be chosen independently is one that can render a
  daemon which never starts. `KillMode=mixed` with `TimeoutStopSec=45s`, per ADR 0024's: under the
  default `KillMode` the drain is not a drain, because Chrome and ffmpeg are signalled at the same
  instant as the daemon, and the stop budget is escalation rather than a drain and so has to exceed
  the 20 s cap. `ExitTimeOut=45` is the macOS counterpart — it is what bounds `launchctl kickstart
-k`, which was measured to send `SIGTERM`, wait for the drain and block until the process is gone.
  `ProcessType=Interactive` because _unspecified_ is the throttled case for a job whose work is Chrome
  and ffmpeg, and `Umask` as the decimal integer `63`.

  `StartLimitIntervalSec` and `StartLimitBurst` are `[Unit]` keys and are asserted in that section:
  systemd 252 answers `Unknown key 'StartLimitIntervalSec' in section [Service], ignoring` to the
  other placement. The Windows task is `\xplainer\<user>-daemon` with its XML mirrored at
  `%LOCALAPPDATA%\xplainer\service\xplainer-daemon.xml` — per user, because two accounts on one
  machine cannot both register a machine-global name — with an explicit `S4U`/`LeastPrivilege`
  principal, an explicit trigger identity, and a `PT5M` repetition with no `<Duration>`, which is what
  makes it indefinite.

- 53214a4: Windows reads the whole identity triple, so reconciliation there can decide instead of only doubt.

  **The decision existed and the platform did not implement it.** ADR 0024 §A recorded PID is not an
  identity makes the identity of a recorded process the triple `(pid, process start time, machine boot
id)`, and only a positive match of it licenses a kill. On Windows the daemon had one member of the
  three: `processStartToken()` spawned `ps -o lstart=` on every platform that is not Linux, and
  Windows has no `ps`; `machineBootId()` answered `null` outside Linux and macOS. So `selfIdentity()`
  was `(pid, null, null)`, every job record and every `owner.lock` written on Windows carried a tuple
  with nothing in it to compare, and the consequences ran through the whole daemon: `classifyWorker()`
  answered `uncertain` for any live pid, so boot reconciliation could never kill an orphaned worker
  and never positively identify a stranger — it quarantined the output directory and set
  `workers_uncertain` in both cases; `classifyHolder()` could never tell a live lock holder from a
  process that had merely inherited its number, so a stale `owner.lock` naming a reused pid blocked
  the daemon until somebody deleted the file; and `startIsProvablyGone()` was `false` for any recorded
  start whose pid Windows had since handed out again, which is one of the two things the circuit
  breaker needs to latch on a run that died before it could record its own end.

  **Both halves now come out of one CIM query.** `Win32_Process.CreationDate` is the start token and
  `Win32_OperatingSystem.LastBootUpTime` the boot id, each rendered by `ToFileTimeUtc()` as an exact
  64-bit count of 100 ns intervals — an integer rather than a formatted date, so no locale, no time
  zone and no output formatter can make two readers of the same process disagree. `selfIdentity()`
  asks one `powershell.exe` for both, because the spawn is what either of them costs. `wmic` is
  deliberately not used: it is deprecated and absent from current Windows images, so a probe built on
  it would answer `null` — "uncertain" — on exactly the machines this is for.

  **A probe that cannot run still answers `null`, and `null` is still `uncertain`.** No
  `powershell.exe`, a WMI service that will not answer, output that arrived mangled: each of those is
  a machine that cannot say, which leaves a live worker alone and quarantines its output rather than
  guessing. Nothing changes on macOS or Linux, and the cost discipline the tuple has always had is
  unchanged — the probe is read once per acquisition and once per worker at reconciliation, never per
  write, and `classifyWorker()` reaches it only for a recorded pid that something is still using.

- d376533: Windows: the Task Scheduler document registers, and the bearer token gets the ACL a mode cannot give
  it.

  **`daemon install` could not register a task on Windows at all, and the reason was one attribute.**
  The document `supervisors/schtasks.ts` renders declared `encoding="UTF-8"`, and
  `Register-ScheduledTask -Xml` is handed a **string** — UTF-16 by construction — so MSXML refused it
  with `(1,40)::ERROR: unable to switch the encoding`, the service reported `SCHED_E_MALFORMEDXML`
  (`0x8004131a`), and the install rolled back everything it had written and exited `5` saying a
  privilege or a policy had refused it. It had not: nothing about the machine was wrong. The
  declaration now says `UTF-16`, which is what `Export-ScheduledTask` emits and what a registration of
  an otherwise identical document had already been measured to accept on `windows-latest`; the bytes
  on disk stay UTF-8 so the mirror under `%LOCALAPPDATA%` is readable text, and the registration
  command names the encoding it decodes with (`Get-Content -Raw -Encoding UTF8`, which also stops
  Windows PowerShell reading a profile path through the active ANSI code page). The same one-line
  defect had been failing `daemon update`'s re-registration and three of this project's four
  Task Scheduler proofs. The refusal that reported it has been corrected too: it asserted "a
  privilege or a policy" for every command a supervisor declines, which was not true of this one and
  sent the reading in the wrong direction. It now says only what a non-zero status establishes — the
  service manager is there, it refused, and the line it printed is the reason.

  **The bearer token is now narrowed to the account that minted it.**
  [ADR 0020](https://github.com/xplainer-hosted/xplainer.video/blob/main/docs/adr/0020-always-running-local-daemon.md)
  §R-SEC-5 records that a mode is not protection on Windows — Node documents that only the write
  permission is settable and that the owner/group/other distinction is not implemented — so
  `open(path, "wx", 0o600)` was leaving a token every account on the machine could read, and names the
  remedy it assigns to phase 2. `serve` now applies it at creation:
  `icacls <path> /inheritance:r /grant:r "<user>:(R,W)"` on the token, and the container-inheriting
  form on the state directory it is minted in. `/inheritance:r` is the half that matters — a file
  under `%LOCALAPPDATA%` inherits its parent's entries, which routinely include `BUILTIN\Users` on a
  machine with a second account, and granting the owner changes nothing while those are still there.
  A failure is **reported and never fatal**: the one line `serve` already printed about the token now
  says which of a mode and an ACL this platform got, and names the `icacls` that did not run, because
  refusing to start over a missing `icacls` would trade a weaker file for no service at all. Nothing
  changes on macOS or Linux, where the mode is the protection.

  **And the install preflight no longer names the current working directory as a place an install
  writes.** `preflightWriteLocations()` reports every path an install could touch, so that a refusal
  can be proved to have written nothing; the Windows entry among them is composed with `win32.join`,
  and taking its directory with the _host's_ `dirname` answered `"."` on macOS and Linux, where that
  string carries no `/` at all. Nothing was ever written there — the list is read, not acted on — but
  a caller checking it was checking the wrong directory, and this project's own refusal test was
  hashing its checkout to do it.

  The named pipe is **not** narrowed the same way and the gap is stated rather than implied:
  `net.Server.listen({ path })` offers no way to pass a security descriptor, and a native addon is
  what this phase's packaging cannot carry. Its name is still derived from the state directory, so two
  accounts and two runs never meet on one endpoint.

- Updated dependencies [b3e1be8]
- Updated dependencies [1ec8b8b]
- Updated dependencies [26aade2]
- Updated dependencies [687279b]
- Updated dependencies [574480c]
- Updated dependencies [574480c]
- Updated dependencies [93c5812]
- Updated dependencies [574480c]
- Updated dependencies [ce26d75]
- Updated dependencies [83db21c]
- Updated dependencies [7c81808]
- Updated dependencies [26aade2]
- Updated dependencies [d01d6db]
- Updated dependencies [574480c]
- Updated dependencies [574480c]
- Updated dependencies [687279b]
- Updated dependencies [1a95fee]
- Updated dependencies [acdd06a]
- Updated dependencies [c572ac0]
- Updated dependencies [1a95fee]
  - @xplainer/mcp-server@0.0.1
  - @xplainer/protocol@0.0.1
  - @xplainer/render-core@0.0.1
  - @xplainer/tts-client@0.0.1
