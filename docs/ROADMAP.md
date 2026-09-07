# Roadmap

Three phases of work remain, after the scaffold and after the split. Each ends with something
that runs, and each is judged by criteria written down **before** it starts.

**Phase numbers are never reused, and the numbering has a gap.** Phase 3 was the hosted
skeleton; it relocated to the private repository `BrewMyTech/xplainer-hosted` with the tier it
built ([ADR 0023](adr/0023-split-the-repository.md)). Its criteria — `P3-4`, `P3-7`, `P3-8` —
are cited by name inside accepted decision records here, so the slot stays and says where the
work went, rather than closing up and turning every one of those citations into a typo. Phase 4
keeps its number for the same reason: `P4-3` and `P4-4` were always local criteria and are
unchanged below; the commercial ones relocated.

Phase 0 — the scaffold — is judged by AC-1..AC-14, which now live in
[`acceptance-criteria.md`](acceptance-criteria.md). It implemented no product features by
design: the deliverable was the layout, the decisions in [`adr/`](adr/), and this roadmap.

---

## Phase 0 — Scaffold, and the split (largely done)

The scaffold landed and was judged against AC-1..AC-14. On 2026-09-06 the repository was
reduced to the local product and the hosted tier was relocated
([ADR 0023](adr/0023-split-the-repository.md)) — deferred pending a written answer from
Remotion AG on whether a rendering service may accept user-authored code, **not cancelled**.

**What remains before this repository is made public.** These are gates, not aspirations, and
the first one is the reason the others matter.

1. **The private repository's name still ships inside published packages.** It appears in the
   `description` strings of twelve JSON Schema files under `packages/protocol/schemas/`, and in
   the TypeScript and pydantic output generated from them. `packages/protocol`'s `files` ships
   `schemas`, `python/**/*.py` and `dist/**/*.d.ts`, so all three surfaces are on the
   distribution path today. A grep for absolute paths does not find this; a grep for the name
   does. Fixing the schema descriptions requires re-running
   `pnpm --filter @xplainer/protocol codegen` in the same commit, or CI's staleness check
   (AC-9c) goes red.
2. **Comment-level references to the relocated packages, in surviving and published code.**
   `apps/cli/package.json`'s `description` names the hosted media-service and **ships to npm**;
   the same class of reference sits in `apps/cli/src/`, `packages/mcp-server/src/` and
   `packages/protocol/tests/`. Editorial, at source — the same call
   [ADR 0022](adr/0022-open-source-the-published-packages.md) already made for the shipped
   `.d.ts` citations. Re-check `dist/**/*.d.ts` after the edit.
3. **The plugin bundles are retargeted, and must not be published yet.** Both `.mcp.json`
   files declared `https://mcp.xplainer.video/mcp` — an endpoint this repository no longer
   describes — and the Codex bundle declared an `oauth_resource` that a loopback daemon cannot
   answer. Both now declare a local stdio server, `npx -y @xplainer/cli mcp`
   ([ADR 0013](adr/0013-plugin-packaging-for-claude-and-codex.md)'s note of 2026-09-06). **That
   command is still a stub that exits 2**, so the bundles are correct and not yet publishable:
   publishing a dead URL and publishing a command that exits 2 are the same failure in different
   clothes, and a marketplace fetch is not retractable. `xplainer mcp` becomes real in phase 1;
   submission is phase 4.
4. **`LICENSE` Part Two still names three directories that no longer exist here**, and still
   covers `apps/desktop`, `packages/config`, `services/tts-sidecar`, `docs/`, `infra/` and
   `scripts/` as proprietary. Making the repository public does not relicense them, and ADR 0023
   is explicit that it did not. Correcting the file, and deciding whether the remainder is
   relicensed, is open work.
5. **The Remotion disclosure is still owed on three surfaces.** ADR 0022 named five: the root
   `README.md`, `apps/cli/README.md`, `packages/render-core/README.md`, the three plugin
   manifest `description` fields, and one line in `SKILL.md`. The root README carries it; the two
   package READMEs do not exist and the manifests do not say it. The manifests also still declare
   `"license": "UNLICENSED"` against packages whose own `package.json` says `Apache-2.0` — a
   defect ADR 0022 identified and that ships inside the published bundles.
6. **`SKILL.md` still sells a hosted backend** — a whole "Two backends, one tool set" section
   and two more sentences. Rewriting it is constrained: `packages/skill/src/build.test.ts`
   asserts a literal sentence is present and that the set of `explainer_*` names mentioned
   **equals** the protocol's `TOOL_NAMES` exactly, so a rewrite keeps all eight names and moves
   the assertion in the same commit.

**Judged by** the surviving phase-5 criteria, which kept their ids — see
[Phase 5](#phase-5--the-split-what-is-discharged-and-what-is-not) at the foot of this file.

---

## Phase 1 — Local walking skeleton

> A sample video renders end-to-end through `xplainer serve`'s local MCP on a Linux VM and on
> macOS, with Kokoro in Docker; `xplainer connect claude` works.

The first phase where a video exists. Everything the scaffold stubbed becomes real, and the
proof is a rendered MP4 produced by an agent, not by a human running commands by hand.

**Work this phase owns, deferred here deliberately from phase 0:**

- **The `narrate.py` port.** `packages/render-core/src/narrate/` — the pacing constants
  (lead-in 400 ms, inter-segment gap 620 ms, tail 800 ms), the word-span algorithm, WAV
  concatenation, and the generation of `timings.json` and `captions.json`. Phase 0
  deliberately did **not** port this: an `estimate()` port is narration logic and the
  scaffold's non-goals forbid it outright. `packages/tts-client` already pins the Kokoro
  request contract it will call ([ADR 0006](adr/0006-kokoro-fastapi-http-contract-as-tts-interface.md)).
- **The real `xplainer serve` job runner** — queueing, execution, progress notifications and
  log capture behind the `explainer_job` contract
  ([ADR 0008](adr/0008-async-job-model-poll-and-progress-no-agent-webhooks.md)). Phase 0 serves
  only `/healthz` and a placeholder `/mcp`.
- **The `mcp` stdio transport** — the registered-but-stubbed `xplainer mcp` command becomes a
  working stdio MCP server, built from the *same* `createMcpServer()` the HTTP surface uses,
  never a second registration
  ([ADR 0016](adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md)). **This is
  now also what unblocks the plugin bundles**, which declare `npx -y @xplainer/cli mcp` and
  cannot be submitted to a marketplace while that command exits 2.
- A real `RenderBackend` implementation behind `packages/mcp-server`'s interface, replacing
  the phase-0 stub whose methods returned "not implemented in this phase".
  - *Landed 2026-09-06 (US-006):* `apps/cli/src/backend.ts` implements all eight tools over the
    shared Remotion workspace — the four filesystem ones answer immediately, the three slow ones
    enqueue against the daemon's job runner, and `explainer_job` relays `runner.get()`. The stub
    and its exit code are gone; `grep -rn 'not implemented in this phase' apps packages` finds
    nothing for these tools.
- **The prerequisites of the supervised daemon
  ([ADR 0020](adr/0020-always-running-local-daemon.md)), which are here and not in phase 2
  because phase 1 would otherwise get each of them wrong.** ADR 0020 makes the local runtime an
  installed, always-running per-user service; the *installer* is phase 2 work, but four pieces
  of it belong to the first phase that has a working runtime:
  - **`serve`'s SIGTERM handler, clean shutdown and child-process teardown.** Stop accepting,
    let in-flight jobs reach a checkpoint, close the server, kill Chrome and ffmpeg children,
    remove the runtime state file. Without it, P1-1's render on a Linux VM is what gets
    orphaned on every logout, and an interrupted job stays stuck in `running`, which P1-5
    forbids. `serve` stays a **foreground** process — that is what all three supervisors
    execute, and `serve --detach` is ruled out by ADR 0020.
  - **The loopback guard and the local token**: `Host` allowlist, `Origin` validation, bearer
    token on every TCP route including `/healthz`, and the three negative tests beside the
    positive ones already in `apps/cli/src/server.test.ts`. P1-4's `connect` has to write
    *something*; writing an unauthenticated URL now and retrofitting a token at phase 2 means
    rewriting agent configurations already shipped to users. The daemon is also in violation
    of the MCP transport spec's Origin MUST today.
  - **The IPC listener and `xplainer mcp --attach`** — a unix socket (named pipe on Windows)
    inside a `0700` directory, served by the same Hono app. This is what lets `connect` write
    a stdio entry carrying no token and no URL, it is the transport the MCP spec recommends
    first, and it is the whole of the no-supervisor degraded path — so it must exist before
    the installer that may refuse to install.
  - **`daemon.json` and `runtime.json`, and recording the port**, because `connect` must read
    a port rather than assume 8787 the first time it writes a real configuration file.
  - **The durable job store, exclusive ownership and boot reconciliation**
    ([ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md)). Exclusive ownership of the
    state directory is acquired **before** reconciliation and before bind — the recorded port
    makes a second `serve` exit `10` only at *bind*, which is already too late to stop it
    reconciling another daemon's jobs — job records are written durably and outlive the process
    that wrote them, and a boot reconciler turns every job whose owner is gone into `error`
    with `error_code: "daemon_restarted"`, a non-null `finished_at` and a bounded log tail.
    Without it the SIGTERM handler above covers only the *graceful* half: a `SIGKILL`ed daemon
    leaves a job stuck in `running` for ever, which is the failure P1-5 forbids reached by a
    different route. `recentStarts[]` and the `stalled` flag move here too, out of the
    `runtime.json` that systemd removes on every clean stop.
  - **The shim's contract-version check and the stdout ready line**
    ([ADR 0025](adr/0025-daemon-updates-and-readiness.md)). `xplainer mcp --attach` compares
    the daemon's **contract** version with its own — not the release version, or every patch
    release breaks every agent session that outlives it — and exits `8`, naming both versions
    and a remediation that exists in phase 1, when it deems the pair incompatible. `serve`
    writes exactly one line of JSON to stdout, once, after ownership is acquired,
    reconciliation has finished and both listeners are bound. Both belong here because this is
    the phase where `mcp --attach` and `serve`'s real startup path first exist, and because a
    published shim that cannot tell a skewed daemon from a compatible one gives a wrong answer
    silently.
  - *Amended 2026-09-06 ([ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md),
    [ADR 0025](adr/0025-daemon-updates-and-readiness.md)):* **six pieces, not four.** The two
    bullets above are the addition and the original four are unchanged. The value is amended
    here rather than edited into the sentence, the same way the criteria below record a changed
    value.
- **Two spikes, each settling a mechanism a decision record deliberately left open.** They are
  prerequisites of the work above rather than reports written beside it, and each is a judged
  criterion in its own right — P1-S1 and P1-S3 below.
  - **P1-S1 — the exclusive-ownership mechanism**, and with it the storage shape, what flushing
    a directory after a rename actually guarantees per platform, and how a recorded worker PID
    is confirmed to still be that worker. Settles
    [ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md) §Exclusive ownership,
    §Durability, §Durability of the write itself and §Scope — each of which states a binding
    decision over a mechanism marked *proposed*. It reports before the job store is built,
    because the four answers constrain one another.
    - *Amended 2026-09-06 ([ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md)
      §Note, 2026-09-06: P1-S1 settled):* **reported, and all four mechanisms are named there.**
      Ownership is an `O_EXCL` `owner.lock` carrying the pid, the process start time and a boot
      nonce, with a read-back-confirmed takeover of a stale one; the storage shape stays one JSON
      file per job; the write is temp-then-`rename` with the file and then the directory flushed,
      which on macOS is `F_FULLFSYNC` at no extra cost because libuv already issues it; and a
      worker's identity is that tuple, never the pid. The measurements, the six ownership
      scenarios, and what stays open — the shared-home question, and Linux and Windows, which were
      not measured — are in the note. The check that produced them is
      [`apps/cli/spikes/p1-s1-ownership.mjs`](../apps/cli/spikes/p1-s1-ownership.mjs), which is
      committed and exits non-zero if an ownership expectation stops holding.
  - **P1-S3 — the contract-version advertisement and the compatibility policy**: how the daemon
    advertises its contract version, whether the predicate is exact or major-compatible, how
    that predicate interacts with ADR 0024's `error_code` extension policy, and whether
    unknown-value tolerance is achievable at all. Settles
    [ADR 0025](adr/0025-daemon-updates-and-readiness.md) §Part two — version skew, and the open
    half of [ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md) §Extending the
    `error_code` enum. It reports **before the first publish** in this phase, because that is
    when the enum and the contract reach a registry and stop being cheap to change.
    - *Amended 2026-09-06 ([ADR 0025](adr/0025-daemon-updates-and-readiness.md)
      §Note, 2026-09-06: P1-S3 settled, and the matching note in
      [ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md)):* **reported, and all four
      questions are answered there.** The daemon advertises `contract_version` in the `/healthz`
      body, beside — never instead of — the release `version`; `MCP_CONTRACT_VERSION` has moved to
      `@xplainer/protocol`, which also exports `isContractCompatible()`; the predicate is
      **major-compatible**, so adding an `error_code` member is a **minor** contract change that
      leaves attached shims attached; and unknown-value tolerance turned out to be reachable in
      both languages, so `schemas/manifest.json` gains an `open_enums` table and codegen emits a
      decoder per language that falls back to `internal`. The measurements — including the strict
      Ajv refusal that ruled out an `x-open-enum` schema keyword, and the pydantic
      `ValidationError` that made the earlier tolerance promise unkeepable — are in the ADR 0025
      note.
- **The first public npm publish.** Publishing is phase 1 work because nothing else here
  reaches a user: phase 4 records that until code signing lands, `npx`/`npm` is the supported
  daemon-install path (ADR 0020), and both plugin bundles resolve `@xplainer/*` from a registry
  (ADR 0013). Six packages go public — `apps/cli` and
  `packages/{protocol,mcp-server,render-core,tts-client,skill}`; `packages/config` stays
  `private: true`. Each needs a `README.md`, `repository`, `homepage` and `author`, or its npm
  page renders blank, and `.changeset/config.json` `"access"` flips from `restricted` to
  `public`. **Do not carry this to phase 2**: an npm publish is close to irreversible.
  - *Amended 2026-09-06 (ADR 0022):* this bullet was written for a proprietary
    `"SEE LICENSE IN LICENSE-BINARY"` grant. That decision was reversed. The six packages are
    **Apache-2.0**, `LICENSE` (a copy of `LICENSE-APACHE-2.0`) and `NOTICE` are copied into
    every published package at pack time, and `LICENSE-BINARY` no longer exists. The *urgency*
    argument is unchanged and is why the amendment matters: a licence field that reaches a
    registry cannot be withdrawn from someone who already installed.
  - *Amended 2026-09-06 (US-011):* **everything on this bullet short of the publish itself is
    done, and asserted.** All six packages carry a `README.md`, `homepage`
    (`https://xplainer.video`), `repository` with the member's `directory`, `author`
    (`Rishav Anand <rishav@brewmytech.com>`) and `license: Apache-2.0`; `packages/config` is
    still `private: true`; `.changeset/config.json` `"access"` was already `public`.
    `scripts/check-publish-contract.mjs` now asserts all five metadata fields plus the README
    from `npm pack --dry-run --json`, adds a rule that no tarball carries the private
    repository's name, and holds **every** rule to a negative test that runs before the real
    check — a rule with no self-test is a hard failure. The editorial pass ADR 0022 booked is
    finished: `grep -rn 'explainer_mcp.py\|plan §' packages/*/dist/**/*.d.ts
    apps/cli/dist/**/*.d.ts` is empty after a build, fixed at the schemas and comments the
    declarations are generated from. `pnpm changeset version` was rehearsed in a scratch copy:
    it exits 0, bumps all six off `0.0.0` and writes each a `CHANGELOG.md` (that day: cli and
    mcp-server and skill `0.0.1`, protocol and render-core and tts-client `0.1.0` — later
    phase-1 changesets move these, which is why the numbers are dated and not a promise). The
    copy was thrown away; nothing here was versioned or committed. **One command is left and it
    is the owner's: `pnpm changeset version && pnpm changeset publish`.** Nothing in this
    repository runs it, and nothing should — a publish cannot be taken back.
- **The tarball hygiene rules that go with that publish, and their exemption list.** Source
  maps are produced and archived as CI artefacts keyed by version, and excluded from the
  tarball; `declarationMap` is off; comments are stripped from emitted `.js`. The rules are
  asserted against `npm pack --dry-run --json`, never against `git ls-files` — `.gitignore` and
  the npm `files` allowlist are different filters, which is how five `__pycache__/*.pyc` files
  came to be shipping from `packages/protocol`. **Four paths are exempt and must be exempt as
  named data in the CI config, with the reason beside each:**
  `packages/render-core/template/**`, the six
  `packages/render-core/{src,dist}/scaffold/templates/*.txt`, `packages/skill/SKILL.md` and its
  two built plugin copies, and `packages/protocol/schemas/**`. Each is read as text by a user or
  an agent at runtime, so obfuscating any of them breaks the product.
- **Finish the editorial pass phase 0 started.** The shipped `.d.ts` files cite ADR numbers and
  plan section ids. Most of those numbers now resolve, because the records are public; five do
  not, because they relocated. ADR 0022's ruling stands — the fix is editorial, at source, not
  a build-time strip — and this is the phase where the affected files are being touched anyway.

**Judged by:**

- **P1-1** An agent, using only the installed skill, drives `create → put_source → narrate →
  still → render` to a finished 1920×1080 @ 30 fps MP4 with burned captions — on a headless
  Linux VM **and** on macOS.
  - *Amended 2026-09-06 (US-010): the macOS half is proven; the Linux VM half was not yet.* `pnpm
    e2e:render` (`scripts/e2e/render.mjs`, deliberately **not** part of `pnpm verify`) starts a real
    `xplainer serve` in a temporary state directory, attaches an MCP client over `xplainer mcp
    --attach` — the daemon's unix socket, no URL and no token — and drives all five calls against
    Kokoro in Docker, polling `explainer_job` to `done` each time. The run of 2026-09-06 produced
    a 491-frame, 16.37 s MP4: `ffprobe` reports 1920×1080, `30/1` fps, `h264` with an `aac`
    stream, 13.67 ms from `timings.json`'s total, and `narration.wav` is 0.33 ms from that same
    total. The captions are burned in, not merely configured: frame 257 extracted from the MP4
    differs from the same frame of a captions-disabled render across 3.89% of the caption band
    and 0.001% of a band of equal size above it. The artefacts are `e2e-sample.mp4` and the
    transcript, both under `$COLLIE_ARTIFACTS_DIR`. (That run wrote `e2e-macos.log`; the script
    was `scripts/e2e/macos.mjs` until 2026-09-07 and now writes `e2e-render.log`.) **What it does
    not prove** is the sentence's first clause: the driver is a script calling the tools in order,
    not a language model reading `packages/skill`'s `SKILL.md` and deciding to. The tool path is
    proven; the instructions above it are judged by P1-4 and by using the thing.
  - *Closed 2026-09-07 (US-002): the headless Linux half is proven, and the "pending" note above
    it is discharged.* Nothing in the script was macOS-specific — it resolves `ffmpeg` and
    `ffprobe` from `PATH` — so the run that settles the other half is the same script, and it is
    now named for that: `scripts/e2e/macos.mjs` is `scripts/e2e/render.mjs`, `e2e:macos` is
    `e2e:render`, and the old script name is kept as an alias for one release only.

    ```bash
    pnpm e2e:render:linux          # local Docker, this laptop
    gh workflow run e2e-linux.yml --ref main   # the same proof on a GitHub runner
    ```

    What that image holds and what the wrapper does with it is written once, in
    [`infra/README.md` §The end-to-end proof image](../infra/README.md#the-end-to-end-proof-image).

    The run of **2026-09-07**, image `xplainer-e2e-linux:local` on Docker 29.4.0 `linux/arm64`
    (Node v24.20.0, `linux arm64`, `/usr/bin/ffmpeg`), passed in 30 seconds: Kokoro answered with
    68 voices, `explainer_narrate`, `explainer_still` and `explainer_render` each went
    `queued → running → done`, and `ffprobe` reports the MP4 as `1920`×`1080`, `r_frame_rate=30/1`,
    `codec_name=h264` with an `aac` stream at 48 kHz — 491 frames, 16.37 s, 13.67 ms from
    `timings.json`'s total, with `narration.wav` 0.292 ms from it. The captions are burned in on
    Linux too: frame 257 differs from the captions-disabled control across **3.893%** of the
    caption band and **0.010%** of the equal-sized band above it. The artefacts land on the host
    as `e2e-linux.log` and `e2e-linux.mp4` (1.45 MB) under `$COLLIE_ARTIFACTS_DIR`, beside
    `e2e-linux-still.png`, `e2e-linux-frame-captioned.png` and `e2e-linux-frame-nocaptions.png`.

    The repeatable form is `.github/workflows/e2e-linux.yml`, job **`end-to-end render (linux)`**,
    on `ubuntu-latest` with Kokoro as a service container and the transcript and MP4 uploaded as
    the `e2e-linux` artifact. It is `workflow_dispatch` **only**, for the reason its own header
    gives.
- **P1-2** `timings.json` is computed from word-level TTS timestamps, and every scene
  duration in the rendered video derives from it. No hand-written durations anywhere.
- **P1-3** Kokoro runs as a Docker container and `packages/tts-client` talks to it unchanged
  from phase 0 — the pinned contract holds against a live server.
- **P1-4** `xplainer connect claude` writes a working configuration; a fresh Claude Code
  session discovers the local tools without manual editing.
- **P1-5** `explainer_job` reports `queued → running → done` for a real render, and
  `output_lines` bounds the returned log tail.
- **P1-6** The narrate port has unit tests over the pacing and span logic, and phase 0's
  five byte-identity scaffold assertions still pass.
- **P1-7** `SIGTERM` to a running `xplainer serve` mid-render exits within 25 seconds, leaves
  no Chrome or ffmpeg process behind, removes its runtime state file and socket, and the
  interrupted job reports `error` with a bounded log tail — not `running`.
- **P1-8** The daemon answers 401 to a request with no token, 403 to `Host: evil.com:8787`,
  and 403 to `Origin: http://evil.com`, on `/healthz` and `/mcp` alike; a valid token with a
  loopback `Host` succeeds. Asserted in `apps/cli/src/server.test.ts`, beside the existing
  positive tests.
- **P1-9** `xplainer connect claude` writes a stdio entry containing no token and no URL; a
  fresh Claude Code session discovers the tools through the IPC socket; the same works
  against a daemon started by hand with `xplainer serve`.
- **P1-10** A stranger on a clean machine runs `npm i -g @xplainer/cli`, and the installed
  package contains a `LICENSE` file and a manifest reading `"license": "SEE LICENSE IN
  LICENSE-BINARY"`. No published tarball contains a `.map` file, a `//# sourceMappingURL=`
  comment, a `__pycache__` entry, a `src/` directory or a test file — asserted from
  `npm pack --dry-run --json` in CI, per package.
  - *Amended 2026-09-06 (ADR 0022):* the manifest reads `"license": "Apache-2.0"`, and the
    installed package contains `LICENSE` (the Apache-2.0 text) **and** `NOTICE`, which §4(d)
    propagates. The tarball-hygiene half of the criterion is unchanged.
  - *Amended 2026-09-06 (ADR 0023):* add — **no published tarball contains the private
    repository's name.** This is the phase-0 gate 1 above, re-asserted where it can be checked
    mechanically against what actually ships rather than against the working tree.
- **P1-11** The four exempt paths arrive byte-identical to their sources in the published
  tarballs, and phase 0's five byte-identity scaffold assertions still pass against the
  *published* package rather than only the workspace one.
- **P1-S1 (spike)** Four questions [ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md)
  assigns to this spike are answered and recorded **together**, because the answers constrain
  each other.
  1. **Ownership.** The exclusive-ownership mechanism for the state directory: it survives a
     `SIGKILL`ed holder on all three platforms and on a network or container-shared home
     directory, it is acquired before reconciliation and before bind, and a second `serve` that
     cannot acquire it exits `10` having written nothing.
  2. **Storage shape.** One JSON file per job under that directory, or `node:sqlite` in WAL
     mode. Measured, `node:sqlite` is built into Node 24.20.0, so this is a design choice and
     not a dependency question.
  3. **Write durability.** What flushing the containing directory after a rename actually
     guarantees on Linux, macOS and Windows, since the three do not offer the same promise and
     Windows has no directory handle to sync.
  4. **Process identity.** How a recorded worker PID is confirmed to still be the process that
     was recorded — start-time, boot-id, a process group, or a platform handle — and what
     proportion of real cases end in `workers_uncertain`.

  Settles ADR 0024 §Exclusive ownership, §Durability, §Durability of the write itself and
  §Scope.
- **P1-12** A render, still or narrate job is written to durable storage, and its `job_id` is
  not returned until the write is durable. `SIGKILL` to `xplainer serve` mid-job, then a
  restart, leaves that job reporting `error` with `error_code: "daemon_restarted"`, a non-null
  `finished_at` and a bounded log tail — not `running`, and not a `404`. **Every Chrome or
  ffmpeg child the reconciler positively identified as belonging to that job is gone;** a
  worker it could not identify is left running, the record carries `workers_uncertain: true`,
  the log names it, and the job's output directory is quarantined so a retry cannot collide
  with it. An earlier draft demanded "no surviving Chrome or ffmpeg child" unconditionally,
  which contradicted ADR 0024's own decision that a leaked worker is a smaller failure than a
  killed stranger. The agent's next `explainer_job` poll receives that answer. This is the
  ungraceful counterpart to P1-7, which covers `SIGTERM`.
- **P1-S3 (spike)** Four linked questions are settled together and recorded **before the first
  publish**: (a) the named mechanism by which the daemon advertises its **contract** version;
  (b) the compatibility predicate — exact or major-compatible; (c) how that predicate interacts
  with [ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md)'s enum-extension policy,
  since under exact matching a minor bump exits `8` on every live session; and (d) whether
  unknown-`error_code` tolerance is achievable at all, given that this repository's codegen
  turns a closed enum into a Python `StrEnum` that Pydantic rejects unknown members against,
  and if so for which languages and at what codegen cost. Settles
  [ADR 0025](adr/0025-daemon-updates-and-readiness.md) §Part two — version skew, and the open
  half of ADR 0024's extension policy.
- **P1-13** `xplainer mcp --attach` against a daemon whose contract version the shim deems
  **incompatible under the predicate P1-S3 selects** exits `8`, naming both versions and a
  remediation command that exists at that point. Against a daemon it deems compatible — which
  includes one whose release version differs — it attaches normally, and at least one such
  compatible-but-different pair is exercised. The criterion says "incompatible" and not
  "differs" deliberately: "differs" would presuppose the exact-match answer to P1-S3's own open
  question.
- **P1-14** `xplainer serve` writes exactly one line of JSON to stdout after ownership is
  acquired, reconciliation has finished and both listeners are bound. A parent that reads
  stdout until that line, then issues a request, is not refused **by a daemon that is still
  starting**; a bounded startup timeout and a premature-exit path are defined. A later crash is
  out of scope for this criterion and is covered by
  [ADR 0020](adr/0020-always-running-local-daemon.md)'s restart behaviour — an earlier draft
  said "never observes a request refused afterwards", which no readiness signal can promise
  across a subsequent crash.

---

## Phase 2 — Desktop GUI, first-run downloads, installed daemon

> Electron client attaches to the daemon: library, player, progress, settings; `xplainer
> setup` downloads TTS + Chrome; `xplainer daemon install` makes the daemon always-running on
> all three operating systems; bearer token for non-localhost daemons; unsigned installers;
> standalone CLI binaries.

The phase that makes the product usable by someone who does not live in a terminal. The
desktop app stops being a placeholder window and becomes a real client of the daemon — the one
that phase 0 only declared a dependency on.

**Work this phase owns:**

- **`xplainer setup`** — the real first-run downloads of Chrome Headless Shell and the TTS
  sidecar, with checksum verification, resumability and a legible failure when the network
  refuses ([ADR 0005](adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)). Phase 0
  ships a command that exits 2, and per-OS packaging stubs that refuse to run without an
  explicit flag. **This is the first consumer of the delivery infrastructure**: ADR 0005 books
  "a CDN and a version/checksum manifest become infrastructure, not an afterthought", and
  [ADR 0011](adr/0011-cloudflare-r2-for-storage-and-delivery-no-aws.md) is what it is built on.
  An `r2.dev` URL is not cached, so a several-hundred-megabyte TTS model served from one pays
  egress on every download; the custom domain and its Cache Rule are not optional.
- **`xplainer connect`** — the real agent-configuration writer for both Claude Code and
  Codex, invoked by the app's one-click "Add to Claude Code / Codex".
- **The daemon bearer token for non-localhost daemons**, so the Electron client can attach to
  a daemon on a remote Linux VM. Until this exists, exposing the daemon on a network is outside
  the supported configuration (ADR 0016). This is the *second* half of the token story: the
  **loopback** token, the `Host` allowlist and `Origin` validation land in phase 1 under P1-8,
  because an always-running loopback listener is reachable from any web page the user visits
  (ADR 0020). What this phase adds is TLS, an operator-supplied host allowlist and the explicit
  opt-in flags a non-loopback bind requires — and ADR 0020's rule that widening the bind must
  *tighten* validation, never skip it.
- **Standalone CLI binaries** — the Node single-executable recipe in
  `apps/cli/packaging/README.md`, which phase 0 documents as explicitly not run in CI,
  becomes a built artefact per OS.
- **The `asar` fix.** Spawning the bundled `@xplainer/cli` from a packaged Electron build
  fails, because the CLI lives inside `app.asar` and a spawned child process cannot read a
  virtual filesystem. `@xplainer/cli` goes into electron-builder's `asarUnpack` and the
  child path resolves through `app.asar.unpacked`. This is written down in ADR 0016 so this
  phase does not rediscover it.
- **`xplainer daemon install` and the rest of the command group** — `uninstall`, `start`,
  `stop`, `restart`, `status`, `logs` — writing a `systemd --user` unit with lingering on
  Linux, a LaunchAgent on macOS and a Scheduled Task on Windows, with **no administrator
  privileges on the supported path** (ADR 0020). It belongs here and nowhere else, for four
  reasons that are each sufficient:
  - This phase owns `xplainer setup`'s real downloads, and `install` refuses to run before
    setup has completed. An installer that cannot install is not a phase-1 deliverable.
  - This phase owns the standalone SEA binaries, which is what stops `ExecStart` pointing
    into a version-managed Node directory (deleted by an uninstall) or an `npx` cache (garbage
    collectable). Until they exist the installer pins a copy of `process.execPath` and the CLI
    under the state directory — roughly 120 MB of duplicated Node that the binary later removes.
  - This phase owns `apps/desktop`, the second consumer of `daemon.json`: `resolveDaemonUrl()`
    gains a third branch — configured remote URL → the recorded port → `DEFAULT_DAEMON_PORT` —
    so the discovery mechanism gets its second client in the same phase that defines it.
  - This is already the three-operating-system phase (P2-7 runs on three runners); phase 1's
    P1-1 names a headless Linux VM **and** macOS, with no Windows.

  **Three things this block also owns, put here rather than in phase 1 by
  [ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md) and
  [ADR 0025](adr/0025-daemon-updates-and-readiness.md), because none of them exists until the
  supervisor artefacts do:**

  - **The supervisor kill strategy and the grace values.** ADR 0024's drain gives in-flight
    jobs at most **20 seconds** to reach a checkpoint before Chrome and ffmpeg are
    hard-stopped, which is what fits the whole shutdown inside P1-7's 25-second budget. A
    supervisor grace longer than that budget is necessary and **not sufficient**: systemd's
    default `KillMode=control-group` sends the stop signal to every process in the cgroup, so
    Chrome and ffmpeg receive `SIGTERM` at the same instant the daemon does — a simultaneous
    execution with a longer countdown, not a drain. The unit therefore needs an explicit kill
    strategy that signals only the main process and leaves the daemon responsible for its
    children, and macOS and Windows need a tested equivalent: `launchctl kickstart -k` is
    documented only as kill-and-restart, `Restart-ScheduledTask` is not a cmdlet in the
    standard `ScheduledTasks` module, and Windows has no `SIGTERM` for Node to catch. What is
    decided is one application-level drain reached through a per-platform adapter; the systemd
    keys are P2-S4's and the adapters are P2-S5's.
  - **The staged post-install update sequence** (ADR 0025). Install, **stage** the new runtime
    beside the pinned copy instead of overwriting it in place, **drain**, **switch the
    executable the supervisor launches**, **restart and wait for the readiness signal**, and on
    a timeout stop the replacement *before* starting anything else, switch back to the retained
    previous copy, restart and verify **its** readiness. Two parts of that are easy to get
    wrong and are named here: staging is the **post-install hook's** work and never the
    daemon's, because the daemon must not write the runtime it is executing from; and the
    switch is an edit to the unit file, the plist or the Task XML, because rewriting
    `daemon.json` alone leaves `ExecStart` pointing at the old copy and reports success.
    `xplainer daemon restart` performs the drain-to-rollback half and is a deliverable of this
    phase for the same reason the installer is.
  - **Two spikes, each settling a mechanism a decision record deliberately left open**, and
    each a judged criterion below. **P2-S4** — systemd readiness: either an `sd_notify`
    mechanism with its dependency named and justified, or `Type=exec` retained with a readiness
    wait in the installer, since Node's `node:dgram` cannot open the `AF_UNIX` datagram socket
    `$NOTIFY_SOCKET` names. It settles [ADR 0025](adr/0025-daemon-updates-and-readiness.md)
    §Part three — readiness and the open question in
    [ADR 0020](adr/0020-always-running-local-daemon.md)'s note of 2026-09-06. **P2-S5** — the
    drain adapters: the Linux kill strategy plus a documented, tested equivalent on macOS and
    Windows. It settles [ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md) §Drain on
    planned restart.

  It also owns the degraded paths ADR 0020 documents, and `docs/daemon.md` — the
  self-supervision recipes for hosts with no user-scope supervisor, which we document and do
  not write.

**Judged by:**

- **P2-1** The Electron app spawns a bundled daemon **and** attaches to a remote daemon URL,
  and `resolveDaemonUrl()` decides which without the user editing a config file.
- **P2-2** A packaged installer — not a dev run — launches the daemon successfully on all
  three operating systems, which is the `asarUnpack` proof.
- **P2-3** Library, player, job progress and settings all work against the daemon's REST/SSE
  API; no render or TTS code has crept into `apps/desktop` (the phase-0 grep still passes).
- **P2-4** `xplainer setup` downloads, verifies and installs both artefacts on a clean
  machine per OS, and a corrupted download fails loudly rather than half-installing.
- **P2-5** A non-localhost daemon rejects an unauthenticated request and accepts a valid
  bearer token.
- **P2-6** Standalone binaries run `--version`, `serve` and `mcp` on each OS with no Node
  installed.
- **P2-7** Unsigned installers are still produced green on all three CI runners.
- **P2-8** `xplainer daemon install` completes with **no password prompt** on all three
  operating systems, and after a **reboot** the daemon answers `/healthz` — on Linux with
  nobody logged in, on macOS after the first login, on Windows after the first logon. The
  Linux case is proved by `ssh vm 'sudo reboot'`, waiting, then `curl -sf …/healthz` with no
  interactive login in between; that is the only test that actually proves lingering.
- **P2-9** `xplainer daemon uninstall` leaves no unit, plist or task, no state file, no
  `launchctl` disable record and no live token, and does **not** disable lingering it did not
  enable; a re-install afterwards succeeds first time.
- **P2-10** Each degraded path in ADR 0020 exits with its documented code, **writes nothing**,
  and prints the exact remediation command: no user service manager (6), lingering denied (5),
  no batch-logon right (5), Task Scheduler registration blocked (6), `xplainer setup` not run
  (3), recorded port held by another process (7). In the two "no supervisor" cases the message
  leads with `xplainer connect claude --spawn`, which delivers the tools with no supervision at
  all.
- **P2-11** A daemon whose port is permanently held stops respawning after five failed starts
  within 30 seconds and records the reason, on all three platforms; `xplainer daemon status`
  names the holding pid in words; `xplainer daemon restart` clears the latched failure and the
  daemon comes back.
- **P2-S4 (spike)** systemd readiness is settled: either an `sd_notify` mechanism with its
  dependency named and justified, or `Type=exec` retained with a readiness wait in the
  installer. Node's `node:dgram` cannot open an `AF_UNIX` datagram socket, so the "no new
  dependency" path an early draft assumed does not exist. Settles
  [ADR 0025](adr/0025-daemon-updates-and-readiness.md) §Part three — readiness and the open
  question in [ADR 0020](adr/0020-always-running-local-daemon.md)'s note of 2026-09-06.
  - *Amended 2026-09-08 ([ADR 0025](adr/0025-daemon-updates-and-readiness.md) §Note, 2026-09-08:
    P2-S4 settled):* **reported, and the mechanism is named there.** `Type=notify` is rejected and
    `Type=exec` stands with no `NotifyAccess=` beside it; the readiness wait is the caller's, an
    authenticated `GET /healthz` polled with a bounded timeout and a named failure. Measured in
    `apps/cli/spikes/p2-s4-readiness.mjs` against systemd 252 with the unit launching the payload-1
    artefact: `Type=exec` returns from `systemctl --user start` in 4.5 ms with nothing usable behind
    it (0/5 authenticated `200`s at that instant, first `200` at 130 ms), `Type=notify` returns in
    125.3 ms with 5/5. It is rejected on cost: Node cannot write `READY=1` at all, so the notifier
    is a child and `NotifyAccess=all` follows; that setting also lets `MAINPID=` move the main
    process off the one systemd forked, which was measured, so the unit type does not preserve the
    foreground-process invariant; and macOS and Windows need the `/healthz` wait regardless. The
    residual — `Type=exec` reports `active` for a daemon that never becomes ready — and the
    measured route that would close it are recorded in the note.
- **P2-S5 (spike)** The drain is reachable on all three platforms through one application-level
  operation: a kill strategy on Linux that signals the main process rather than the whole
  cgroup (the default `KillMode=control-group` signals Chrome and ffmpeg at the same instant,
  which is not a drain), and a documented, tested equivalent on macOS and Windows. `launchctl
  kickstart -k`'s graceful behaviour is unverified and `Restart-ScheduledTask` is not a
  standard cmdlet, so both need a method rather than a name. Settles
  [ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md) §Drain on planned restart.
  - *Amended 2026-09-08 ([ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md) §Note,
    2026-09-08: P2-S5 settled):* **reported on two of the three platforms, and the third is named
    as unmeasured.** One application-level drain over the IPC listener, three adapters that differ
    only in the restart command — `systemctl --user start xplainer`,
    `launchctl kickstart gui/$(id -u)/video.xplainer.daemon`,
    `schtasks /Run /TN "\xplainer\<user>-daemon"`. Measured in `apps/cli/spikes/p2-s5-drain.mjs`,
    which binds its own stub listener because the production route is T13's: on macOS 26.5 (13/13
    expectations) and on systemd 252 in `infra/e2e/Dockerfile.systemd` (11/11). `KillMode=mixed`
    signalled only the main process while the default signalled the child in the *same
    millisecond*; `TimeoutStopSec` was measured to be escalation and not a drain. **`launchctl
    kickstart -k` is graceful** — `SIGTERM` first, the command blocks for the drain, and the grace
    is bounded by `ExitTimeOut`, so the plist's `ExitTimeOut=45` is the counterpart of
    `TimeoutStopSec=45s`. The **Windows row is a design, not a measurement**: no Windows host was
    reachable, the spike's Task Scheduler arm is `[runner]` on `windows-latest`, and the note says
    so rather than letting the table imply otherwise.
- **P2-12** A supervisor-initiated restart during a job drains: the job either completes or
  reports `error` with `error_code: "daemon_shutdown"`; queued jobs report the same; no Chrome
  or ffmpeg process survives; the process exits within 25 seconds; and the supervisor's grace
  exceeds that budget. Proved on Linux by `systemctl --user restart xplainer` with
  `TimeoutStopSec` and the P2-S5 kill strategy in place, and on macOS and Windows by the
  adapters P2-S5 defines — each with its own named command, not by assertion.
  - **Update failure injection is part of this criterion, not an afterthought:** three further
    cases, each ending with a daemon that is running and answering. A staged copy that fails to
    start; a replacement that starts but never becomes ready within the timeout; and a rollback
    that must itself reach readiness. In every case the previous pinned copy is running at the
    end, state written by the newer version is intact, and exactly one daemon holds the
    exclusive ownership ADR 0024 requires.
- **P2-13** A parent knows the daemon is ready without sleeping or guessing. **The method is
  conditional on P2-S4's outcome**, because the two candidate mechanisms give different
  guarantees and it would be wrong to assert the stronger one while permitting the weaker:
  - **If P2-S4 adopts `Type=notify`:** `systemctl --user start xplainer` itself returns only
    after readiness — proved by a script that starts the unit and immediately issues an
    **authenticated** `GET /healthz`, with no sleep and no retry, and asserts a `200`. A `401`
    proves the port is bound and proves nothing about readiness, so the token ADR 0020
    §Security defines is part of the proof.
  - **If P2-S4 retains `Type=exec`:** `systemctl --user start xplainer` returns early **by
    design**, and the guarantee moves to the caller: the post-install hook polls the
    authenticated `/healthz` with a bounded timeout and a named failure, and the script proves
    the hook does not return success before a `200`. Asserting the bare `systemctl` behaviour
    here would be asserting something `Type=exec` never promised.

  Either way the daemon still writes its one stdout ready line, and a parent that spawned it
  directly — the desktop app, a `docs/daemon.md` recipe — reads that instead. The macOS and
  Windows equivalents are the P2-S5 adapters plus that same directly-spawned path, each with
  its own script.

---

## Phase 3 — RELOCATED

> FastAPI MCP with OAuth, media-service + TTS containers on one VM via Docker Compose, one
> cloud render, R2 link.

**Relocated on 2026-09-06 to `BrewMyTech/xplainer-hosted`
([ADR 0023](adr/0023-split-the-repository.md)).** It is deferred pending a written answer from
Remotion AG on the rendering-service question, **not cancelled**; the design is intact at commit
`ea4ff39f` in that repository.

Its criteria keep their ids there, and three of them are cited by name in accepted records here:
**P3-4** (a render executes in an ephemeral container with no network after staging) is cited by
[ADR 0019](adr/0019-sequencing-local-cli-before-hosted.md) as the criterion with "no local
analogue to fail" — the argument that the local tier does not inherit the hosted tier's
untrusted-code problem, because the agent writing the TSX is the user's own agent running under
the user's own uid. **P3-7** (ADR 0015 updated to `accepted` with the vendor's answer recorded)
is the gate this whole split routes around. **P3-8** is cited by
[ADR 0020](adr/0020-always-running-local-daemon.md) for the local analogue it *does* have —
P1-7's interrupted job reporting `error` rather than staying stuck in `running`.

---

## Phase 4 — Signed, auto-updating distribution

> Code signing and notarisation; a real update feed with a version and checksum manifest;
> `electron-updater` wired to it; marketplace submission of both plugin bundles.

**This is the phase that makes an install maintain itself**, and it is first-class work rather
than a release chore. Phases 0, 1 and 2 all ship artefacts a user has to replace by hand, and
each of them defers the same thing for the same reason.

**Nothing in this repository serves an update feed today, and that is deliberate rather than
missing.** `apps/desktop/electron-builder.yml` sets `publish: null` with the comment "No release
feed in this phase"; `.github/workflows/desktop.yml` runs `electron-builder --publish never`;
`electron-updater` is a declared dependency with no call site, and `apps/desktop/README.md` says
it "is deliberately not wired to anything today". What has to exist first is not a file but a
capability, and it already has a decision record behind it.

**Work this phase owns:**

- **The update feed itself, on R2 behind a cached custom domain.** This is the same primitive
  `xplainer setup` uses in phase 2 and the same one
  [ADR 0011](adr/0011-cloudflare-r2-for-storage-and-delivery-no-aws.md) argues for, applied to a
  different artefact class. It is a **separate bucket** from anything holding render output:
  release artefacts are immutable, publicly readable and cached hard, which is the opposite
  lifecycle and the opposite cache policy. Reusing one bucket for both would put them behind one
  Cache Rule.
- **The version and checksum manifest** ADR 0005 books as infrastructure — the file both
  `electron-updater` and `xplainer setup` resolve against, so a desktop update and a first-run
  download are verified the same way rather than by two mechanisms that drift.
- **Code signing and notarisation for macOS and Windows.** Phases 0 and 2 ship unsigned
  artefacts by design. This is also what makes the standalone binary a **recommended** way to
  install the always-on daemon: an npm-delivered CLI carries no `com.apple.quarantine`, so
  Gatekeeper never fires on it, while a binary the user downloads is the opposite case and since
  macOS 15 has no Control-click escape. Until this phase, `npx`/`npm` is the supported
  daemon-install path and the binary is a convenience for people who fetch it with `curl`
  (ADR 0020).
- **`electron-updater` wired to the feed**, replacing `publish: null`, with a staged rollout and
  a way for a user to decline.
- **CLI self-update**, or an explicit decision not to have one. The daemon is supervised and
  always running from phase 2, which makes an unattended update a different risk from an app the
  user restarts: an update that lands mid-render must not orphan a Chrome process, and P1-7's
  clean-shutdown contract is what it has to be built on.
  - *Amended 2026-09-06 ([ADR 0025](adr/0025-daemon-updates-and-readiness.md)):* the explicit
    decision was taken, and it is **no self-update**. The package manager updates the daemon;
    the post-install hook stages the new runtime beside the pinned copy, drains, switches the
    executable the supervisor launches, restarts, waits for the readiness signal, and rolls
    back to the retained previous copy when readiness does not arrive. What remains for this
    phase is therefore not the decision but the **signed artefact the package manager
    installs** — code signing and notarisation, and the version-and-checksum manifest the same
    hook verifies against. The clean-shutdown argument in the bullet above is unchanged and is
    exactly what ADR 0025's drain step is built on; the mid-render case is judged by P4-8, and
    its phase-2 counterpart by P2-12.
- **Marketplace submission of both plugin bundles**
  ([ADR 0013](adr/0013-plugin-packaging-for-claude-and-codex.md)). It waits for phase 1, not for
  signing: the bundles declare a local stdio server and `xplainer mcp` exits 2 until then.
  **A marketplace fetch is not retractable**, and publishing a command that exits 2 is the same
  failure as publishing a dead URL. Submission also needs real published pages, verified
  identity and icon assets, which ADR 0013's addendum records as the long pole.

**Judged by:**

- **P4-3** Both plugin bundles are accepted by their marketplaces and install cleanly from
  them.
- **P4-4** Signed and notarised installers run on macOS and Windows without a security
  warning, and auto-update moves a running app from version N to N+1.
- **P4-6** The update feed is served from the custom domain and cache-hits on a second request;
  an `r2.dev` URL appears nowhere in a shipped configuration.
- **P4-7** A tampered artefact fails the checksum check and is refused, on both the
  `electron-updater` path and the `xplainer setup` path, and the failure names the artefact
  rather than exiting silently.
- **P4-8** An update that arrives while a render is running does not orphan a Chrome or ffmpeg
  process, and the interrupted job reports `error` with a bounded log tail — the P1-7 contract,
  re-asserted against the updater rather than against `SIGTERM` alone.
- **P4-9** A user who declines an update keeps working on the version they have, and the
  declined version is not re-offered on every launch.

**Relocated with the hosted tier:** P4-1 (free-tier quota and upgrade in-session), P4-2 (Stripe
subscription state driving quota), P4-5 (server-side quota enforcement at the tool boundary), and
the plans, billing portal and share-link lifetime work behind them. They are judged in
`BrewMyTech/xplainer-hosted`. **The local tier has no quota, no sign-in and no plan** — that was
already the settled position before the split
([ADR 0019](adr/0019-sequencing-local-cli-before-hosted.md)) and the split does not change it.

---

## Phase 5 — The split: what is discharged, and what is not

Phase 5 was "open-source extraction". It happened on 2026-09-06, in a different shape than this
roadmap predicted: not one repository extracting a subset, but this repository *becoming* the
open-source product while the hosted tier relocated
([ADR 0023](adr/0023-split-the-repository.md)). The criteria kept their ids because accepted
records cite them.

| # | Criterion | Status |
|---|---|---|
| **P5-1** | The repository builds, lints, typechecks and tests from a clean clone with the same two bootstrap commands | **Holds.** Nine members; the bootstrap is unchanged |
| **P5-2** | No file contains an absolute local path, the private sibling repository's name, or a reference to a `hosted` package | **Not yet.** Absolute paths are gone — two occurrences in accepted records are redacted in place with a dated note, and one file was removed rather than scrubbed. The repository's name still ships in twelve schema `description` strings and their generated output, and hosted-package references remain in comments including one published `description`. Phase-0 gates 1 and 2 |
| **P5-3** | The private repository consumes the extracted packages from the registry at pinned versions | **Relocated.** It is that repository's criterion to meet, and it cannot be met before phase 1 publishes |
| **P5-4** | The tier checks still pass in both repositories, adapted to the new boundary | **Holds, with a stated caveat.** `pnpm lint:tiers` passes and still enforces that every member declares a tier. Its real-graph half is vacuous here — no `hosted` member remains for it to catch — and the synthetic fixture in `packages/config/src/tiers.test.ts` is what still proves the rule can fail. The Python import-linter contract retired outright. Recorded in ADR 0003's and ADR 0001's notes of 2026-09-06 |
| **P5-5** | A contributor outside the company can run the local tier end to end from the public repository alone | **Not yet, and not for a split reason.** Nothing renders until phase 1. This is the criterion phase 1 is judged against from the outside |
| **P5-6** | Every file is one whose copyright the company holds, or for which a CLA grants the relicensing | **Struck** by [ADR 0022](adr/0022-open-source-the-published-packages.md): Apache-2.0 §5 supplies the inbound grant in the licence text, so the instrument this criterion existed to protect is gone. It survives as a live question only for the parts of the tree that are **not** Apache-2.0 — see phase-0 gate 4 |
