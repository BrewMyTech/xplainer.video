# @xplainer/protocol

## 0.0.2

### Patch Changes

- f28ea89: Publish each tool's real input schema in `tools/list`, instead of an open object.

  Every tool was registered with one `z.looseObject({})`, so a client was told the arguments of all
  eight were `{"type":"object","properties":{}}`. An agent was therefore never told that `narration`
  is an object, that `files` is an array, or that `slug` is required — and one that guessed a JSON
  string for `narration` was rejected by the backend with an error naming neither the argument nor its
  shape. Reported from a real session where the operator abandoned the tool and drove the daemon from
  a hand-written script instead.

  The reason the schemas were withheld was real: they are written with cross-file `$ref`s
  (`../slug.json`, `../narration.json`) that a client holding a single schema cannot resolve.
  `@xplainer/protocol` now generates `TOOL_INPUT_SCHEMAS`, the same documents with those references
  inlined and their `$defs` hoisted, and `@xplainer/mcp-server` publishes those.

  Two behaviour changes follow, both of them the contract finally being enforced rather than new
  rules: arguments are now **validated** at the tool boundary instead of reaching the backend
  unchecked, and `additionalProperties: false` now refuses an undeclared key rather than forwarding
  it. `not` is dropped during bundling, which is the position `explainer_put_source.input.json`
  already documents — the runtime gate for engine-owned paths is `assertAgentOwnedPaths()`, which is
  unchanged and still runs on every call.

## 0.0.1

### Patch Changes

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

- 7c81808: `schemas/captions.json` now documents the spacing rule the code actually implements.

  The `text` description still said that the first word of a segment always carries a leading space.
  That stopped being true when the punctuation-first case was fixed: a punctuation-only token that
  _opens_ a segment cannot be folded into the previous word — the fold would stretch that caption's
  `endMs` across the whole inter-segment gap — so it is emitted as its own caption, keeping its own
  span, and it is emitted **bare**, because a leading space there renders `"Alpha , beta"`. The
  description now states both halves of the exception. The schema shape is unchanged, so the
  regenerated TypeScript and Python bindings differ only in their doc comments.

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

- 574480c: Stop citing documents an installer cannot open, and fix the plugin manifests' licence.

  Ten JSON Schema `description` strings and four declaration comments cited
  `max/server/explainer_mcp.py` by file and line — the reference implementation
  this contract was ported from, which lives in a repository nobody who installs
  these packages can read. Codegen carried those strings into the generated
  TypeScript, the generated pydantic models and the emitted `.d.ts`, so they were
  shipping. The substance of each description is unchanged; only the citation is,
  and it now says "the reference implementation" rather than pointing at a path
  that resolves for one person. ADR 0022 booked this as editorial work at the
  source, and this is it.

  Separately, `packages/skill`'s three plugin and marketplace manifests still
  declared `"license": "UNLICENSED"`, contradicting the package they ship inside
  and telling a prospective installer — on the marketplace listing, before they
  install — that they have no right to run the plugin. They now declare
  `Apache-2.0`, which is what the package has been licensed under since ADR 0022.

- c572ac0: Add a machine-readable `error_code` to `explainer_job`'s output.

  `error` is prose, so an agent deciding whether to retry has to parse it. The new
  `job-error-code.json` enum — `daemon_restarted`, `daemon_shutdown`,
  `toolchain_missing`, `render_failed`, `tts_failed`, `cancelled`, `internal` —
  says which class of failure produced that prose, and each member's description
  says whether retrying is worth anything. `error_code` is required and nullable,
  sitting immediately after `error` in both `properties` and `required`; it lands
  now because `@xplainer/protocol` is published for the first time in phase 1, and
  after that a required field is a breaking change to every consumer.
