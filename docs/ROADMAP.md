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

**What remained before this repository was made public.** These were gates, not aspirations, and
the first one was the reason the others mattered.

*Amended 2026-09-09.* **The repository is public.** Six of these six are now closed, and the list
is kept rather than deleted because each item says what was wrong and each amendment says what
answered it — a deleted gate is a gate nobody can audit. What is written below survives as the
record; the status line under each item is the current truth. The remaining gate for the **first
npm publish** is no longer on this list at all: it is `pnpm changeset publish` itself, which is
close to irreversible and is a decision rather than a task.

1. **The private repository's name still ships inside published packages.** It appears in the
   `description` strings of twelve JSON Schema files under `packages/protocol/schemas/`, and in
   the TypeScript and pydantic output generated from them. `packages/protocol`'s `files` ships
   `schemas`, `python/**/*.py` and `dist/**/*.d.ts`, so all three surfaces are on the
   distribution path today. A grep for absolute paths does not find this; a grep for the name
   does. Fixing the schema descriptions requires re-running
   `pnpm --filter @xplainer/protocol codegen` in the same commit, or CI's staleness check
   (AC-9c) goes red.
   - *Closed 2026-09-09, and it took two passes rather than one. The hosted repository's own
     name went earlier. What outlived it was the **other** private path: `captions.json` and
     `narration.json` cited `max/.explainers/scripts/narrate.py` by file and line, and
     `packages/protocol` ships `schemas`, `python/**/*.py` and `dist/**/*.d.ts`, so that citation
     was live on three surfaces at once. Twelve descriptions named the reference implementation,
     a hand pass scrubbed ten, and these two survived it — which is the argument for the rule
     rather than the grep. `check-publish-contract` now carries
     `no-private-reference-path` beside `no-private-repository-name`, with its own negative test,
     so the class fails a gate instead of waiting for a reader. The descriptions keep their claim
     and lose the coordinate.*
2. **Comment-level references to the relocated packages, in surviving and published code.**
   `apps/cli/package.json`'s `description` names the hosted media-service and **ships to npm**;
   the same class of reference sits in `apps/cli/src/`, `packages/mcp-server/src/` and
   `packages/protocol/tests/`. Editorial, at source — the same call
   [ADR 0022](adr/0022-open-source-the-published-packages.md) already made for the shipped
   `.d.ts` citations. Re-check `dist/**/*.d.ts` after the edit.
   - *Closed 2026-09-09. `apps/cli/package.json`'s `description` no longer names the hosted
     media-service, and the comment-level references across `apps/cli/src/`,
     `packages/mcp-server/src/` and `packages/protocol/`'s Python half now name **the hosted media
     service (relocated to a private repository, ADR 0023)** in prose rather than citing a
     `services/media-service` path that is not in this checkout. The reasoning each comment
     carries — a seam is a parameter because a second binder supplies its own guard, state or
     socket — is unchanged. `generated/` and `schemas/` were deliberately left alone: the tool
     contract is backend-agnostic on purpose, and its "local backend / hosted backend" wording is
     the published contract rather than a stale path.*
3. **The plugin bundles are retargeted, and must not be published yet.** Both `.mcp.json`
   files declared `https://mcp.xplainer.video/mcp` — an endpoint this repository no longer
   describes — and the Codex bundle declared an `oauth_resource` that a loopback daemon cannot
   answer. Both now declare a local stdio server, `npx -y @xplainer/cli mcp`
   ([ADR 0013](adr/0013-plugin-packaging-for-claude-and-codex.md)'s note of 2026-09-06). **That
   command is still a stub that exits 2**, so the bundles are correct and not yet publishable:
   publishing a dead URL and publishing a command that exits 2 are the same failure in different
   clothes, and a marketplace fetch is not retractable. `xplainer mcp` becomes real in phase 1;
   submission is phase 4.
   - *Status 2026-09-09: `xplainer mcp` is real — phase 1 built it and phase 2's proofs drive it
     over the daemon's socket — so the bundles are no longer describing a command that exits 2.
     They remain unpublished, and submission is still phase 4.*
4. **`LICENSE` Part Two still names three directories that no longer exist here**, and still
   covers `apps/desktop`, `packages/config`, `services/tts-sidecar`, `docs/`, `infra/` and
   `scripts/` as proprietary. Making the repository public does not relicense them, and ADR 0023
   is explicit that it did not. Correcting the file, and deciding whether the remainder is
   relicensed, is open work.
   - *Closed 2026-09-09. `LICENSE` Part Two no longer lists `apps/api`, `apps/web` or
     `services/media-service`; it records in one paragraph that no `hosted` member remains here
     and why. The decision the sentence above left open was taken and is **no relicensing**:
     `apps/desktop`, `packages/config` and `services/tts-sidecar` stay proprietary and stay
     `UNLICENSED`, and Part Two now says in as many words that making the repository public made
     them readable rather than usable.*
5. **The Remotion disclosure is still owed on three surfaces.** ADR 0022 named five: the root
   `README.md`, `apps/cli/README.md`, `packages/render-core/README.md`, the three plugin
   manifest `description` fields, and one line in `SKILL.md`. The root README carries it; the two
   package READMEs do not exist and the manifests do not say it. The manifests also still declare
   `"license": "UNLICENSED"` against packages whose own `package.json` says `Apache-2.0` — a
   defect ADR 0022 identified and that ships inside the published bundles.
   - *Closed 2026-09-09. All three manifests declare `"license": "Apache-2.0"`. The root
     `README.md`, `apps/cli/README.md` and `packages/render-core/README.md` all exist and all
     carry the disclosure, and the three manifest `description` fields and one line of `SKILL.md`
     now carry it too — the five surfaces ADR 0022 named, complete.*
6. **`SKILL.md` still sells a hosted backend** — a whole "Two backends, one tool set" section
   and two more sentences. Rewriting it is constrained: `packages/skill/src/build.test.ts`
   asserts a literal sentence is present and that the set of `explainer_*` names mentioned
   **equals** the protocol's `TOOL_NAMES` exactly, so a rewrite keeps all eight names and moves
   the assertion in the same commit.
   - *Closed 2026-09-09. The section is now "One tool set, and it runs on this machine" and says
     what is true today: one runtime, on the user's own machine, and no second route to reach for.
     `build.test.ts` needed no change — the literal sentence it pins, "Prefer the local tools when
     they are present", survives the rewrite, and the **set** of `explainer_*` names the document
     mentions still equals `TOOL_NAMES`. Set equality is what that assertion measures: it
     de-duplicates before comparing, so what it forbids is a name the contract does not have and a
     contract name the document never mentions, not a second mention of `explainer_create`.*

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
  - *Amended 2026-09-09: the proof now runs `xplainer setup`, because batch 6 put a gate in front
    of the two tools it drives.* `explainer_still` and `explainer_render` refuse a machine whose
    `<state>/toolchain.json` does not record a complete toolchain
    (`apps/cli/src/setup/toolchain.ts`), and `render.mjs` used a scratch state directory nobody had
    ever run `setup` against — so the first dispatch after that gate landed (run `34304136498`, on
    `phase-2`) failed at `still`. Two things were wrong and both are fixed. The script's `callTool`
    parsed `content[0].text` **before** it looked at `isError`, so the refusal — which opens with
    the marker's path — was reported as `Unexpected token '/', "/tmp/xplai"... is not valid JSON`
    rather than as the sentence that says to run `setup`; the refusal is now read first, as
    `runtime.mjs` has always read it. And the gate is now satisfied the way the product satisfies
    it: a real `xplainer setup --manifest <the reviewed manifest this checkout commits> --tts-url
    <the Kokoro this proof already needs>`, which acquires the headless shell, records the external
    speech route and resolves the render workspace with `npm ci`. The borrowed
    checkout `node_modules` is gone — it can never satisfy the workspace half of the gate, which is
    judged from the `workspace.manifest.json` only `setup`'s own workspace route writes — and no
    marker is written from the proof: `recordTestToolchain` in `apps/cli/src/setup/testing/` is
    excluded from the build and must not ship, and a gate that asserts its own precondition proves
    nothing. Measured on macOS arm64, 2026-09-09: `setup` took **14.3 s** (a 98 MB browser and 247
    packages resolved), and the run passed with the same numbers as before — 491 frames, 16.37 s,
    13.67 ms from `timings.json`, 3.890% of the caption band against 0.001% elsewhere. `pnpm
    e2e:render:linux` passed the same day inside the Debian image, where `setup` took **16.7 s**,
    took the `linux-arm64-glibc235` row of the manifest and resolved the same 247 packages. The one
    thing still borrowed is Remotion's **browser cache**, linked in where the checkout has one
    (`infra/e2e/Dockerfile` fills it at build time on purpose) so a second copy of the same
    headless shell is not fetched inside the measured still job. That second copy is the product's
    own shape and not the proof's: the gate checks `chrome.path` exists and nothing hands it to
    Remotion.
  - *Amended 2026-09-11: the hosted form of this proof has run green, which the amendment above
    reports only a **failed** dispatch of.* The note above names run `34304136498` as the first
    dispatch after the toolchain gate landed and as the one that failed at `still`. With both fixes
    in, `e2e-linux` run **`34364354535`** (2026-09-09, `phase-2`@`fe67b3e`) succeeded — job
    **`end-to-end render (linux)`** on `ubuntu-latest` with Kokoro as a service container, and
    *Upload the transcript and the MP4* green, so the artefacts this row's local runs wrote to
    `$COLLIE_ARTIFACTS_DIR` now exist as a run artifact as well. The Linux half of P1-1 was already
    closed on 2026-09-07 by the local Docker run; this is the same proof on a hosted runner and is
    cited so the workflow's own status is not left reading as a failure.
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

**Where these criteria stand, 2026-09-08 (T30).** Every row below carries a dated line saying
whether it is **met**, **pending on a runner**, or **pending on a human**, with the evidence named
rather than implied. **Three of them are not passes and say so in their own words**: **P2-4** is
pending on Windows, **P2-6** is not met as this roadmap words it and names a substitution in its
place, and **P2-7** is pending for as long as the artifact upload fails. **P2-8** is human-evidenced
and no transcript exists yet, so it is pending too.

*Amended 2026-09-10 ([ADR 0028](adr/0028-in-process-onnx-speech-and-a-g2p-we-own.md)): the count
above is now two rather than three.* **P2-4's Windows half no longer waits on an artefact nobody has
published** — a fourth speech route acquires an in-process engine from its components' own upstream
homes and reaches every platform ONNX Runtime publishes a binding for. That row's own note of this
date says exactly what is proven and on which platform, and it does not claim a Windows run.
**P2-6, P2-7 and P2-8 are unchanged**, and so is the billing paragraph below: what changed is a
missing route, not the runner situation.

*Amended 2026-09-11: the count is **one**, and it is P2-6.* **P2-4 is met on all three platforms**
(`e2e-speech` run `34496585851`) and **P2-7 is met** (`desktop` run `34364401949`, the upload step
green on all three), so neither is a not-pass any longer. What remains is **P2-6**, which is not a
pass and never will be as this roadmap words it, because standalone binaries were **descoped** to
phase 4 rather than deferred by evidence. **P2-8 stays pending on a human**, which the sentence above
already said and which no run below changes.

*Amended 2026-09-09: RESOLVED. The paragraph below is kept as the record of why every
"pending on a runner" line was stuck, and it is no longer the current state.* Making the repository
public moved it to free standard runners, and on 2026-09-09 every Phase 2 proof was dispatched and
went green on ubuntu, macOS and Windows — the twelve workflows behind `main` at `0cde7d6`. A
"pending on a runner" line below that still reads as blocked is stale; the constraint now is only
that a **new** proof workflow must reach the default branch before `workflow_dispatch` can register
it.

*Amended 2026-09-11: **every runner half below is now reconciled against a named run.*** The
amendment of 2026-09-09 above declared the blockage resolved and then left every row beneath it
saying what it had said while the blockage lasted, which is worse than either state on its own: a
reader could not tell a pending that means *nobody has run this* from a pending that meant *the
account cannot pay for a runner*, and so no "pending" in this list was worth anything. Each row now
carries its own dated line naming the run that answered it, or saying what is still missing. **The twelve runs of 2026-09-09** were all dispatched on `phase-2`
at `fe67b3e`, which is the commit `0cde7d6` merged to `main`, and every one of them succeeded at the
run level. **Four of the twelve upload anything at all** — `e2e-linux`, `e2e-runtime`,
`e2e-toolchain` and `desktop` — and in those four **every upload step is green**, which answers the
artifact-storage quota in the paragraph below and not only the billing block; the eight daemon and
proof workflows have no upload step to fail:

| Workflow | Run | Platforms green |
|---|---|---|
| `e2e-linux` | `34364354535` | linux |
| `e2e-runtime` | `34364358658` | ubuntu, macOS, Windows |
| `e2e-toolchain` | `34364362924` | ubuntu, macOS, Windows, + the Windows T20 criterion-3 job |
| `phase-2 proofs` | `34364366726` | P2-S4 on ubuntu; P2-S5 on ubuntu and Windows |
| `daemon lifecycle` | `34364371567` | ubuntu, macOS, Windows (six jobs) |
| `daemon restart` | `34364376444` | ubuntu, macOS, Windows (six jobs) |
| `daemon breaker` | `34364380810` | ubuntu, macOS, Windows (six jobs) |
| `daemon update` | `34364384414` | systemd, launchd, Task Scheduler |
| `daemon identity` | `34364389162` | ubuntu, macOS, Windows |
| `daemon remote` | `34364393120` | ubuntu, macOS — the whole of that workflow's matrix |
| `daemon-windows` | `34364397390` | Windows (six jobs) |
| `desktop` | `34364401949` | ubuntu, macOS, Windows, **including *Upload unsigned installers*** |

**And two runs of 2026-09-10**, after ADR 0028's in-process speech route landed: `e2e-speech` run
**`34496585851`** green on all three platforms — 86 assertions on ubuntu, 90 on macOS, 93 on Windows,
each ending `SPEECH END-TO-END PASSED` — and `e2e-toolchain` run **`34492622026`**, the Windows-only
dispatch that reads back what `deliveryPosition()` says today. `ci` and `desktop` are green on `main`
at `250e52a` (runs `34497948400` and `34497948352`).

**What is actually left, now that the noise is gone. Two things need a human and nothing else does.**

1. **P2-8 — reboot persistence.** Pending on a **human** on all three operating systems, and no
   machine in or out of this repository can discharge it: a reboot with **nobody logged in** on
   Linux, a real login on macOS, a real logon on Windows, each observed from outside the machine. A
   hosted runner has no persistent machine to reboot and no console session to log into. **No
   transcript exists.**
2. **The packaged window has never been looked at.** The `human` half shared by P2-1, P2-2 and P2-3
   — install a packed artefact, open the application, see the window, play a video in it. The
   screenshots this phase recorded are from a **dev run**, not from an installer. This is
   observation, not a dispatch, so no workflow can produce it either.

**Two further rows are not passes for reasons that are not about evidence at all**, and they are
listed separately so they are not mistaken for things a dispatch would fix. **P2-6** is **descoped**:
standalone binaries moved to phase 4 on measurement and the row names its substitution, which is met
on all three platforms. And the macOS and Linux legs of **P2-9**'s runner half stay pending because
**no workflow runs an uninstall proof on those two platforms** — `daemon-windows.yml` is the only one
that calls the verb at all. That is a gap in coverage; only a new job closes it.

*One reading correction that applies to every row below.* Ten notes said a fix "landed in `d376533`"
and had "no runner evidence" or was "not re-run since". `d376533` is an **ancestor of `fe67b3e`**, so
every one of those fixes was carried by all twelve runs of 2026-09-09 and each has runner evidence
now. The sentences are kept where they stand, because each says what was true when it was written;
the dated line under it says what the evidence is.

**One fact every "pending on a runner" line below shared, and it was not a code problem.** GitHub
Actions was **billing-blocked for this organisation**. Every job dispatched on `d376533` on
2026-09-08 at 12:08Z was refused before it started with *"The job was not started because recent
account payments have failed or your spending limit needs to be increased"* — runs `34224329592`
(`ci`), `34224329595` (`desktop`), `34224368464` (`daemon-windows`), `34224371557`, `34224375439`,
`34224378914`, `34224381893`, `34224385387` and `34224388372`. Before that, and for the whole of
this phase, **every `upload-artifact` step failed on the organisation's artifact-storage quota**
while the steps that are the evidence passed. So the runner halves recorded below are the ones that
ran on `d01d6db`, `f73e8cc` and `dbfe59d`; the Windows portability fixes in `d376533` and the
Linux toolchain fix in the same commit have **no runner evidence at all**, and this roadmap says
that rather than reporting the local run in their place. Restoring billing and re-dispatching is the
owner's, and it is what turns those lines from pending into met or into defects.

- **P2-1** The Electron app spawns a bundled daemon **and** attaches to a remote daemon URL,
  and `resolveDaemonUrl()` decides which without the user editing a config file.
  - *Amended 2026-09-08 (T30): **met locally; the runner half is blocked, and the packaged window
    stays `human`.*** Both branches are exercised against a real daemon rather than a stub:
    `apps/desktop/src/main/discovery.test.ts` drives all seven discovery outcomes — `absent`,
    `ready`, `degraded`, `incompatible`, `unauthorized`, `occupied` and `disabled` — with the
    machine put into each state by `main/testing/live-daemon.ts` (a real `xplainer serve` behind a
    payload laid out as the packaged application's is), and a configured remote URL is used as the
    origin with no child spawned. **The pre-install path is part of this row**
    ([ADR 0027](adr/0027-relocatable-runtime-artefact-and-the-supervisor-switch.md) §D10): with no
    launcher written, `resolveCliProgram` runs `<resources>/xplainer-runtime/bin/node` against the
    payload's own entry, refuses **by name** when there is neither launcher nor payload, and the
    app switches to `<state>/bin/xplainer` only after `install` has written it — `discovery.test.ts`
    (`resolveCliProgram`, `handOffToInstall`), `spawn.test.ts` and `paths.test.ts`, with
    `controls.test.ts` asserting that the install control stops the app's own spawned daemon first
    and rediscovers afterwards. **Runner half:** `desktop`'s `package` job was green on
    `macos-latest` and `ubuntu-latest` through **Check the packaged payload** (run `34217857540`,
    `dbfe59d`) and red on `windows-latest` at the desktop main-process unit tests; those win32
    fixes landed in `d376533` and their re-dispatch is billing-blocked. **Still `human`:** opening
    the packaged application and seeing the window.
  - *Amended 2026-09-11: **the runner half is met on all three; the `human` half is unchanged and is
    now the only thing outstanding on this row.*** `desktop`'s `package` job was green on
    `windows-latest`, `macos-latest` **and** `ubuntu-latest` in run `34364401949` (2026-09-09,
    `phase-2`@`fe67b3e`) — including *Unit tests for the desktop main process*, which is the step the
    `d376533` win32 fixes were for and the step that had failed on Windows in `34217857540`. Every
    step of all three jobs succeeded, *Check the packaged payload* included. **Still `human`, and
    still nobody has done it:** opening the packaged application and seeing the window. That is
    observation, not a dispatch, and it is shared with P2-2 and P2-3.
- **P2-2** A packaged installer — not a dev run — launches the daemon successfully on all
  three operating systems, which is the `asarUnpack` proof.
  - *Amended 2026-09-08 (T30): **PENDING — met on macOS and Linux against the packed artefact,
    not re-run on Windows, and there is no Intel Mac artefact at all this phase. The mechanism this
    row names is also no longer the one that makes it true.*** The proof is two steps of `desktop`'s
    `package` job: **Pack unsigned installers**, then **Check the packaged payload**
    (`apps/desktop/scripts/check-packaged-payload.mjs`), which asserts that `@xplainer/cli` was
    packed as a real directory rather than a pnpm symlink, that the payload and its manifest sit at
    each platform's own resources root (`Contents/Resources/` on macOS, `resources/` on Linux and
    Windows), that the architectures match — compared by the runner's own already-running Node,
    because an interpreter built for another architecture cannot perform that check on itself —
    that `runtime verify` re-hashes the payload **as it was packed**, and that the production call
    path runs: `<payload>/bin/node[.exe] <payload>/…/dist/bin.js --version`, with no
    `ELECTRON_RUN_AS_NODE` anywhere. Both steps were green on `macos-latest` and `ubuntu-latest` in
    run `34217857540` (`dbfe59d`); neither was reached on `windows-latest`, where the job had
    already failed at the desktop main-process unit tests.
  - *Amended 2026-09-08 (T30): **"which is the `asarUnpack` proof" no longer describes the
    mechanism, and the criterion is met by a different one.*** `apps/desktop/electron-builder.yml`
    carries **no `asarUnpack` list at all**, deliberately, and says so where the list would be: the
    only executable the app starts is the payload's **own** interpreter, and `extraResources` places
    the whole payload at `<resources>/xplainer-runtime` — outside the archive — because Electron
    patches `fs` so a child can *read* `app.asar` and nothing can `execve` a path that exists only
    inside it. The property the clause was protecting is unchanged and is now asserted directly, by
    running that interpreter out of the packaged tree; the rule for the next person is written
    beside the empty list rather than in a criterion: anything that must be **spawned** from
    `node_modules` has to be unpacked, and the preference is to move it into the payload instead.
  - *Amended 2026-09-08 (T30): **the macOS `x64` targets are dropped this phase, and what that
    costs is stated rather than footnoted.*** `electron-builder.yml`'s `mac:` block lists `dmg` and
    `zip` for `arm64` only, because `macos-latest` is arm64 and an x64 installer built there would
    ship an arm64 interpreter inside an x64 application and fail to spawn on an Intel Mac. So
    **every Intel Mac user has no supported desktop installer for the whole phase** — unavailable
    platform support, not an occasional failure, and a prioritisation choice rather than a technical
    limit: GitHub supplies Intel runners, and a native x64 build on one would copy its own
    `process.execPath` exactly as the arm64 build does. Per-architecture payload builds are named
    as phase-4 work. The runtime manifest records the **interpreter architecture** and the app
    compares it from an already-compatible process before spawning, so the mismatch is a named
    refusal rather than `Bad CPU type in executable`. The graphical launch stays `human`.
  - *Amended 2026-09-11: **the Windows half is met, so the packed-artefact proof now holds on all
    three. Two things this row records stay exactly as they are.*** In `desktop` run `34364401949`
    (2026-09-09, `fe67b3e`) the `package (windows-latest)` job reached and passed **both** steps this
    row names — *Pack unsigned installers* and *Check the packaged payload* — where in `34217857540`
    it had failed earlier and reached neither. So the payload assertions the second step makes (the
    real directory rather than a pnpm symlink, the platform's own resources root, the architecture
    comparison, `runtime verify` re-hashing the payload as packed, and the production call path with
    no `ELECTRON_RUN_AS_NODE`) now hold on `resources/` on Windows as well as on macOS and Linux.
    **What does not change:** the `arm64`-only `mac:` block, so **an Intel Mac still has no supported
    desktop installer for the whole phase** and per-architecture payload builds are still phase-4
    work; and **the graphical launch is still `human`** and still unobserved.
- **P2-3** Library, player, job progress and settings all work against the daemon's REST/SSE
  API; no render or TTS code has crept into `apps/desktop` (the phase-0 grep still passes).
  - *Amended 2026-09-08 (T30): **met locally; playback in the packaged window stays `human`.***
    Each screen is exercised against the daemon's own `/api` routes with a real started daemon:
    `apps/desktop/src/renderer/src/screens.test.tsx` names an assertion per screen — library,
    player, progress, settings — and `main/bridge.test.ts` covers the authenticated main-process
    bridge they talk through, with the token never reaching the renderer. The phase-0 grep is not
    the whole of the evidence but it still passes, as **its own CI step**: *apps/desktop holds no
    render or TTS code (AC-14f)*, green in run `34217857571` (`dbfe59d`). The observed run's
    artefacts are recorded under `.session/artifacts/`: `desktop-library.png`, `desktop-player.png`,
    `desktop-progress.png`, `desktop-progress-done.png`, `desktop-settings.png`,
    `desktop-connect.png`, and `desktop-playback.json`, which records a 1920×1080 video played to
    7.93 s of its 16.41 s. **One consequence of this row belongs beside it**: the render path is
    reachable on a clean machine because payload 1 carries npm and `setup --workspace` resolves the
    template's pins, so a **first run needs a network** — stated here rather than discovered.
  - *Amended 2026-09-11: **the grep step is green on `main`; the `human` half is the packaged
    window's playback and is one of the two things left in this phase.*** *apps/desktop holds no
    render or TTS code (AC-14f)* passes as its own step of `ci` on `main` at `250e52a` (run
    `34497948400`) and at `0cde7d6` (run `34371645413`). The distinction this row's `human` half
    turns on is worth stating plainly, because the artefact list above can be misread as
    discharging it: `desktop-library.png` … `desktop-playback.json` were observed in a **dev run**,
    against a real daemon but not from a packaged installer. **Nobody has yet installed a packed
    artefact, opened the window and played a video in it.** No workflow can produce that — a headless
    runner has no window to look at — so it stays `human` beside P2-8 rather than pending on a
    dispatch.
- **P2-4** `xplainer setup` downloads, verifies and installs both artefacts on a clean
  machine per OS, and a corrupted download fails loudly rather than half-installing.
  - *Amended 2026-09-08 (T19): three artefacts, not two, and the delivery position is stated rather
    than assumed.* `setup` acquires the browser, a speech route and the **render workspace** — the
    third is payload 2, which survives daemon updates and is materialised by
    `xplainer setup --workspace`, the visible user step
    [ADR 0005](adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md) defines. The browser
    is admitted on the **expected** digest the toolchain manifest carries for the exact URL the
    pinned Remotion line resolves, never on a digest taken from the bytes that arrived. Speech has
    three routes — `--tts-url`, the Docker image pinned by digest, and the manifest's bundle — and
    when none is possible `setup` exits `3` naming all three. **Nothing is published to
    `cdn.xplainer.video` in this phase**, so a `bundle` acquisition cannot succeed anywhere and
    **Windows has no working speech route at all**; that half of this row stays *pending*, and T20
    is where the message a user meets says so. `pnpm e2e:toolchain` is the proof, and the run of
    **2026-09-08** on macOS arm64 passed every leg: `setup --workspace` exits `0` under
    `env -i PATH=/usr/bin:/bin` with no `node` resolvable for the parent, the resolved tree matches
    the template's pins, `remotion versions` exits `0` against it, every path `toolchain.json`
    records exists, and `/healthz` answers
    `{"status":"degraded","reason":"toolchain_missing"}` when one is moved aside and `ok` when it is
    put back (`.session/artifacts/e2e-toolchain.log`).
  - *Amended 2026-09-08 (T20): the status of this row is **PENDING — met on macOS and Linux, not met
    on Windows**, and the delivery position behind that is written down rather than implied.*
    Nothing is published to the R2 bucket in this phase and **no command in this repository publishes
    to it**: `infra/terraform` creates the bucket and the proxied `cdn.<zone>` record, connecting the
    bucket to that custom domain and adding its Cache Rule are manual steps Terraform does not
    manage, neither is scheduled here, and the upload is the release owner's. So
    `https://cdn.xplainer.video/toolchain/v1/manifest.json` answers nothing usable, which is the
    intended state and not an outage. On **macOS and Linux** the row is met over the other two speech
    routes — `--tts-url` and the `docker` image pinned by digest — with the browser admitted on the
    expected digest a manifest named by `--manifest` carries. On **Windows none of the three routes
    exists**: nothing is published for `bundle` to fetch, the pinned Kokoro-FastAPI image is
    linux/amd64 and a `windows-latest` runner has no engine that runs one, and `--tts-url` records a
    server somebody else already runs rather than acquiring one. **The milestone that closes it is phase 4** — a native speech bundle per platform,
    published with the manifest to that bucket behind the connected custom domain and its Cache Rule.
    Until then the `bundle` provider's download, resume, checksum and atomic-install machinery is
    implemented and proved against the fixture server, `setup`'s refusal says all of this in the
    message a user meets (`deliveryPosition()` in `apps/cli/src/setup/manifest.ts`), and
    `infra/README.md` §*The delivery position, phase 2* records it. One consequence belongs here too:
    because the installer carries the interpreter payload and not the render workspace, and nothing
    is published for it to download, **first-run rendering needs a network** — the first
    `xplainer setup --workspace` resolves the template's pins with the shipped npm from the public
    registry, which is [ADR 0005](adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)'s
    contract for the other two artefacts applied to the third.
  - *Amended 2026-09-08 (T33): what `setup` installed is now asserted by rendering with it, and the
    live speech route is exercised once with no fixture.* `pnpm e2e:toolchain` carries the render
    half: from the same isolated artefact, out of the **materialised** workspace — never the
    checkout's `node_modules`, which was `scripts/e2e/render.mjs`'s deliberate shortcut until
    2026-09-09 and was never this gate's — `narrate → still → render`, with the MP4 read back by
    `ffprobe` exactly as
    `apps/cli/src/workers/render.test.ts` reads one. Measured on **2026-09-08**, macOS arm64, with
    `XPLAINER_TTS_FIXTURE` unset and the narration synthesised by a real Kokoro-FastAPI: a
    1920×1080 30/1 h264 MP4 with an **aac** stream, 259 frames — `timings.durationInFrames` exactly,
    and not `Root.tsx`'s 300-frame Studio placeholder — lasting within 7.67 ms of `timings.json`,
    whose own 8641 ms total matches the WAV's measured duration within 0.292 ms; a 960×540 still at
    scale 0.5; and the scene changing on boundary frame 150 by 2.822% of the marker band against
    0.000% of the frame-to-frame noise either side of it. **Who starts the speech provider is
    decided and recorded**: `XPLAINER_TTS_URL` if one is supplied — which is `e2e-linux.yml`'s
    `services:` block, and was one of the two runs measured — else a container the gate starts from
    the digest in the receipt `setup` wrote and **stops in a `finally`**, which was the other
    (`xplainer-t33-kokoro-98316`, started from
    `ghcr.io/remsky/kokoro-fastapi-cpu@sha256:28d6f0b6…` on a port the OS chose, answering with 68
    voices on attempt 11 and gone afterwards); else the leg is **skipped with its reason** — which
    is what Windows gets this phase, where the render half still runs from T3's fixture audio after
    `setup --skip-speech --workspace`. The `docker` question is asked with the **scrubbed** `PATH`
    the artefact is run under, because a probe from the gate's own `PATH` promises a route `setup`
    then cannot take. Transcript: `.session/artifacts/e2e-toolchain.log`.
  - *Amended 2026-09-08 (T30): the status of this row, in one line, so it cannot be read as a
    pass.* **PENDING — met on macOS and Linux; pending on Windows, closed by the phase-4
    milestone: native speech bundles per platform, published with the manifest behind the connected
    custom domain.** Each platform's evidence is named separately, because "met on macOS and Linux"
    is two claims and they rest on two different runs. **macOS** is the T19, T20 and T33 amendments
    above: `pnpm e2e:toolchain` on macOS arm64 on 2026-09-08, transcript
    `.session/artifacts/e2e-toolchain.log`. **Linux** is the `ubuntu-latest` leg of `e2e-toolchain`
    run `34206449083` (`f73e8cc`), on a real x86-64 Linux VM, where **phases 1–6 passed** — `setup`
    under the scrubbed `PATH`, the workspace resolved from the template's pins, the browser admitted
    on its expected digest, live narration from a Kokoro container the gate started from the digest
    in the receipt `setup` wrote and stopped in its `finally`, then the still and the render. That
    run's **last** phase did not pass and it is not this criterion's: T16's rollback-render rerun
    exited `5`, because `apps/cli/src/setup/testing/rollback-render.ts` built its fixture
    environment without the injected linger marker and so met the real
    `/var/lib/systemd/linger/<user>` on a Linux host — a defect in the harness, fixed in `d376533`,
    and **not re-dispatched**, because Actions is billing-blocked for this organisation — the note
    above this list, which names that fix among the ones with no runner evidence at all. So the
    Linux half of this row is proven for what P2-4 asks, and its gate has not been green
    end-to-end since the fix. The **Windows** half has no route this phase rather than a failing
    one: nothing is published for `bundle` to fetch, the pinned Kokoro-FastAPI image is linux/amd64,
    and `--tts-url` records a server somebody else already runs. The runner leg matches: in that
    same run, the `windows-latest` job's **setup refuses and names no working speech route** step
    passed and only its upload step failed — which is the refusal being correct, not the criterion
    being met.
  - *Amended 2026-09-10 ([ADR 0028](adr/0028-in-process-onnx-speech-and-a-g2p-we-own.md)): **the
    Windows half is no longer waiting on a phase-4 artefact. A fourth speech route reaches every
    platform ONNX Runtime publishes a binding for, so what is left of this row on Windows is
    evidence rather than a route.*** `setup` now acquires an **in-process** speech engine: the
    Kokoro-82M ONNX graph and one voice pack from the HuggingFace repository they live in, and this
    platform's ONNX Runtime from the npm registry — four artefacts, each pinned by digest, each
    verified before use, each committed by one `rename`, measured at **39.7 s** for all four on
    darwin arm64. **Nothing has to be published for it to work**, which is the whole of the change:
    the three sentences above about `cdn.xplainer.video`, the connected custom domain and its Cache
    Rule are still true and no longer stand between any platform and speech, because this route
    reads no manifest of ours at all. `win32-x64` and `win32-arm64` are both in `onnxruntime-node`'s
    published set, so `deliveryPosition()` has lost its Windows paragraph and the sentence saying
    Windows has no working speech route is now false rather than merely unhelpful. Three things this
    row must not be read as claiming. **It has not been run on Windows or Linux** — the numbers
    above are darwin arm64's, and Actions is still billing-blocked for this organisation, so the
    runner halves named in the note at the head of this list are unchanged. **`darwin-x64` is
    refused by name**: `onnxruntime-node` ships no Intel-Mac binding, so that platform keeps the two
    routes it already had and is now the one with no in-process engine. And the *corrupted-download*
    half of this criterion got stronger rather than staying level — `providers/speech-bundle.ts`
    used to skip the download **and the verification** whenever its destination existed, so a warm
    cache defeated verify-before-install; cache identity now binds the digest and every committed
    acquisition re-verifies a record written inside the tree it commits.
  - *Amended 2026-09-10, later the same day
    ([ADR 0028](adr/0028-in-process-onnx-speech-and-a-g2p-we-own.md) §Note): **the product now
    selects the route it acquired, which the amendment above did not yet claim.*** Two halves.
    `resolveSpeech()` reads `<state>/toolchain.json`, so a daemon on a machine that has run `setup`
    finds its own engine — until this, the locator defaulted to the three `XPLAINER_ONNX_*`
    variables and `pnpm e2e:speech` supplied them by hand out of the marker it had just read, which
    means the acquisition worked and no ordinary machine used it. And `onnx` moved **above**
    `docker`, because below it every host with a container engine recorded `docker` and never took
    the in-process route — the one machine class the work exists for. `scripts/e2e/toolchain.mjs`
    now names the provider it proves (`setup --speech docker`) instead of inferring it from that
    order, `--speech <route>` is how a user pins one, and a recorded, still-working `docker` route
    keeps the machine it is on so a re-run of `setup` never moves narration onto a different engine
    unasked. The proof's three lines are deleted and it asserts the marker's own path on the
    worker's provenance line instead. `.github/workflows/e2e-toolchain.yml`'s
    `windows-delivery-position` job now reads back what `deliveryPosition()` says today, with the
    three retired sentences asserted absent; it is `workflow_dispatch` only and, per the note at the
    head of this list, has not been dispatched.
  - *Amended 2026-09-11: **MET, on all three platforms, and the two halves of the line above are
    both now false.*** This is the correction that matters most on this row, because the line of
    2026-09-08 (T30) still read *"PENDING — met on macOS and Linux; pending on Windows, closed by
    the phase-4 milestone: native speech bundles per platform, published with the manifest behind
    the connected custom domain"* — and **neither clause survives**.

    **Windows is met.** `pnpm e2e:speech` ran green on `windows-latest`, `macos-latest` and
    `ubuntu-latest` in run **`34496585851`** (2026-09-10, `workspace-win-spawn`@`7f70360`) —
    **93 assertions on Windows**, 90 on macOS, 86 on ubuntu, each job ending
    `SPEECH END-TO-END PASSED`. It proves the **first** clause of this criterion — downloads,
    verifies and installs on a clean machine per OS — and not the second: the *corrupted download*
    clause is proved where the amendment above puts it, against the fixture server and by the
    cache-identity fix, and no run of `e2e:speech` corrupts anything. The machine is **clean of
    every alternative**, proved rather than assumed: the child's `PATH` is one
    directory holding exactly the executables the proof put there — 6 on Windows (`cmd.exe`,
    `icacls.exe`, `node.exe`, `npm.cmd`, `powershell.exe`, `taskkill.exe`), 5 on macOS, 3 on ubuntu
    — and spawning `docker`, `python` and `python3` in that environment fails with `ENOENT` on all
    three, by the same call `providers/speech-docker.ts` uses to ask whether a host has an engine.
    `setup` then acquires the browser and the four speech artefacts on each platform, printing the
    digest it expects before it fetches (`sha256 c0c02b32…`, 92,361,055 bytes for the model graph),
    and `narrate → still → render` produces a real MP4: 1920×1080, `30/1`, `h264` with an `aac`
    stream, 908 frames over 4 segments, `timings.json`'s 30,255.000 ms total equal to the WAV's
    within **0.000 ms** on every platform and the video within 11.67 ms of it, and the captions
    burned in — the caption band differs from a captions-disabled render across 2.271% of its pixels
    on Windows (0.001% elsewhere), 2.745% on macOS (0.000%) and 3.490% on ubuntu (0.011%). The
    assertion the route exists for also holds on all three: all 58 words of a script full of
    out-of-dictionary terms appear in `captions.json` as 58 spans, `frobnicator` among them by name.

    **And it was closed by [ADR 0028](adr/0028-in-process-onnx-speech-and-a-g2p-we-own.md), not by
    the phase-4 bundle.** That is not a bookkeeping distinction. The phase-4 milestone the T30 line
    named — a native relocatable speech bundle per platform, published with the manifest to R2
    behind a connected custom domain and its Cache Rule — **was superseded and never built**, and
    the four-platform build matrix, the standalone CPython, the wheel closure and the relocation
    tooling it implied were never built either. Nothing was published to `cdn.xplainer.video`, and
    nothing needs to be: the `onnx` route reads no manifest of ours at all. A reader who follows the
    T30 line to phase 4 looking for the artefact that closed this row will not find one, which is
    why the phase-4 sub-bullet it points at now carries its own note saying so.

    **The `windows-delivery-position` job has been dispatched**, which the amendment above says it
    had not. `e2e-toolchain` run **`34492622026`** (2026-09-10, Windows only) is green in both its
    jobs, and the one named *setup names the delivery position (windows, T20 criterion 3)* is the
    reader that asserts the three retired sentences are **absent** from what `deliveryPosition()`
    says today. The earlier job under that criterion, *setup names no speech route (windows, T20
    criterion 3)*, was also green in run `34364362924` a day before — asserting the **opposite**
    sentence, correctly, because on 2026-09-09 Windows genuinely had no route. Both runs are cited
    because together they are the record of the sentence changing rather than of a gate being
    rewritten.

    **`darwin-x64` is met by a different route from the other platforms, which is the one asymmetry
    left on this row.** `onnxruntime-node` publishes no `darwin/x64` binding, so an Intel Mac never
    reaches the in-process engine: it takes `docker` — the route that met macOS and Linux in the T19
    and T20 amendments above, and which still works — or `--tts-url`. So the criterion holds there,
    on older evidence and by an older mechanism, and **the docker route is therefore not retired**.
    Its retirement is booked in the phase-4 entry behind the per-architecture work that closes
    `darwin-x64`, and not behind this row, which is already met.
- **P2-5** A non-localhost daemon rejects an unauthenticated request and accepts a valid
  bearer token.
  - *Amended 2026-09-08 (T30): **met locally; the runner half has never run.*** `pnpm e2e:remote`
    binds a **non-loopback** address over TLS with a real certificate and drives the whole sequence:
    `401` unauthenticated, `200` with the operator's token, `403` on a `Host` the allowlist does not
    carry — including the address the daemon is itself bound to, because an authority nobody asked
    for with `--allow-host` is an authority nobody decided about — `403` on a disallowed `Origin`,
    the same request without TLS not answered at all, and a **refusal before bind** for each
    missing precondition. Transcript `.session/artifacts/e2e-remote.log`, 2026-09-08, ending
    `REMOTE GATE PASSED`. `daemon-remote.yml` carries the runner job and **has never been
    dispatched**: `workflow_dispatch` registers from the default branch, so it must be mirrored to
    `main` first, and Actions is billing-blocked.
  - *Amended 2026-09-11: **met, local and runner.*** `daemon-remote.yml` has been dispatched:
    *R-SEC-9 on a non-loopback address* succeeded on `ubuntu-latest` **and** `macos-latest` in run
    `34364393120` (2026-09-09, `fe67b3e`). Those two are the **whole** of that workflow's matrix and
    not a subset of three — it carries `linux` and `macos` inputs and no Windows leg, because the
    proof binds a real non-loopback address with a real certificate — so this row has no third
    platform waiting on anything.
- **P2-6** Standalone binaries run `--version`, `serve` and `mcp` on each OS with no Node
  installed.
  - *Amended 2026-09-08 (T30): **NOT met as this row words it, and what is proved instead is
    named here as a substitution rather than counted as a pass.*** Standalone binaries are
    **deferred to phase 4 on measurement**: the Node single-executable route and the five
    measurements against it are recorded in `apps/cli/packaging/README.md`, and this phase ships a
    **relocatable runtime artefact carrying its own interpreter** instead
    ([ADR 0027](adr/0027-relocatable-runtime-artefact-and-the-supervisor-switch.md)). The
    substitute proof, which is stronger than the row in what it exercises and weaker in what it
    ships, is: **`pnpm e2e:runtime`** (`create → narrate`) and **`pnpm e2e:toolchain`**
    (`still → render`, with provider-guarded live narration on macOS and Linux) run **from the
    assembled artefact, outside the checkout, under `env -i`, with `node` asserted unresolvable**,
    plus `--version`, `serve` and `mcp`. Local transcripts: `.session/artifacts/e2e-runtime.log`
    (`RUNTIME GATE PASSED`) and `.session/artifacts/e2e-toolchain.log` (`TOOLCHAIN GATE PASSED`).
    The render leg passes only because Remotion is spawned through the runtime's **own**
    interpreter; under the earlier design it exited `127` with `env: node: No such file or
    directory`. **Runner half:** `e2e-runtime`'s artefact gate step was green on `ubuntu-latest`,
    `macos-latest` **and** `windows-latest` in run `34166471340` (`d01d6db`) — only *Upload the
    transcript* failed, on the artifact quota — and `e2e-toolchain`'s **gate step** passed on
    `macos-latest` and `windows-latest` in run `34206449083` (`f73e8cc`) while `ubuntu-latest`
    failed there in the rollback rerun. Both of those runs are red at the run level **only because
    their upload steps are**, which is why the step is named here rather than the job; the Linux
    fix is in `d376533` and has no runner evidence yet.
  - *Amended 2026-09-11: **the substitution's runner half is met on all three platforms, and this
    row stays NOT met for a reason that has nothing to do with runners.*** Both gates are green at
    the **job** level now, so the step-level reporting above is no longer necessary: `e2e-runtime`
    run `34364358658` — *runtime gate* on `ubuntu-latest`, `macos-latest` and `windows-latest`, with
    *Upload the transcript* green in all three — and `e2e-toolchain` run `34364362924`, *toolchain
    gate* on the same three plus the Windows criterion-3 job, again with every upload green. The
    ubuntu rollback-rerun failure named above was the `d376533` harness defect, which `fe67b3e`
    carries. So the artifact quota is answered as well as the billing block, and nothing about this
    row is pending on a dispatch. **It is still not met as worded**, and it will not become met by
    running anything: standalone binaries were **descoped** to phase 4 on measurement, and what
    ships is the relocatable runtime artefact
    ([ADR 0027](adr/0027-relocatable-runtime-artefact-and-the-supervisor-switch.md)). This row is a
    scope decision recorded as a criterion, which is why it is the one remaining not-pass in the
    header list and why it reads differently from a pending.
- **P2-7** Unsigned installers are still produced green on all three CI runners.
  - *Amended 2026-09-08 (T30): **PENDING. A green build with a red upload has not produced an
    installer, and this row is not met until a run uploads one.*** In run `34217857540`
    (`dbfe59d`), `macos-latest` and `ubuntu-latest` were green through **Assemble the runtime
    payload (payload 1)**, **Pack unsigned installers** and **Check the packaged payload**, and
    both then failed at **Upload unsigned installers** on GitHub's artifact-storage quota, which is
    organisation-wide and was hit again after 12.8 GB of superseded installers were deleted and
    retention was cut to five days. `windows-latest` never reached the pack step. The upload step
    keeps `if-no-files-found: error`, which is the point of it. **The build half is partial
    evidence and is reported as that, never as the criterion**; re-dispatching `desktop` once
    billing and the quota recalculation allow it is what closes this row.
  - *Amended 2026-09-11: **MET. A run has uploaded an installer, on each of the three runners.***
    `desktop` run `34364401949` (2026-09-09, `fe67b3e`) is green at the job level on
    `ubuntu-latest`, `macos-latest` and `windows-latest`, and the step this row was held open by —
    ***Upload unsigned installers*** — **succeeded in all three**. That is the whole of the
    criterion: the step still carries `if-no-files-found: error`, so a green upload is an installer
    that exists, which is exactly the distinction the note above insisted on rather than counting a
    green build. `windows-latest` reached the pack step this time, having failed before it in
    `34217857540`. The artifact-storage quota that refused the uploads in that run is answered by
    the same evidence and is not a live constraint on any row below.
- **P2-8** `xplainer daemon install` completes with **no password prompt** on all three
  operating systems, and after a **reboot** the daemon answers `/healthz` — on Linux with
  nobody logged in, on macOS after the first login, on Windows after the first logon. The
  Linux case is proved by `ssh vm 'sudo reboot'`, waiting, then `curl -sf …/healthz` with no
  interactive login in between; that is the only test that actually proves lingering.
  - *Amended 2026-09-08 (T30): **PENDING on a human, on all three operating systems. No
    transcript exists.*** Nothing in this repository can produce one: the criterion is a reboot
    with nobody logged in on Linux, a real login on macOS and a real logon on Windows, each
    observed from outside the machine. What exists in its place, and is **not** a substitute for
    it: `daemon install` completes with no password prompt against a **real** launchd on macOS and
    a **real** systemd in `infra/e2e/Dockerfile.systemd`
    (`apps/cli/src/install/testing/supervisor-proof.ts`), and the linger marker is **read** and
    never enabled by the installer, which is why the lingering-denied path is a refusal rather than
    a prompt (`install/preflight.test.ts`, `install/install.test.ts`). **The phase is not complete
    without the Linux transcript**, and this line is the record of that rather than an excuse for
    it.
  - *Amended 2026-09-11: **STILL PENDING ON A HUMAN, unchanged, and now one of only two things in
    this phase that a dispatch cannot close.*** Every other "pending on a runner" line in this list
    moved to met against the runs of 2026-09-09 and 2026-09-10. **This row did not move at all, and
    it is important that it reads that way rather than blending into the reconciliation around it.**
    No transcript exists. Nothing was dispatched for it, because there is nothing to dispatch: the
    criterion is a `reboot` with **nobody logged in** on Linux, a real login on macOS and a real
    logon on Windows, each observed from outside the machine, and a hosted runner cannot supply any
    of the three — it has no persistent machine to reboot, no console session to log into, and its
    lifetime ends with the job. The eleven proof workflows have never claimed otherwise; none of
    them contains a reboot.

    **What discharging it takes, stated so it can be picked up rather than rediscovered.** A real
    Linux VM the owner controls: `xplainer daemon install`, then `ssh vm 'sudo reboot'`, then a wait,
    then `curl -sf http://127.0.0.1:<port>/healthz` with an `Authorization` header **and no
    interactive login in between**. That last clause is the whole of the test — a `curl` after an
    `ssh` login proves the daemon starts on session start, which is what a LaunchAgent does anyway
    and what lingering exists to make unnecessary. macOS and Windows are the same shape with a real
    login and a real logon in place of the reboot-with-nobody-there. **The phase is not complete
    without the Linux transcript**, which the line above already says, and the phase-2 merge to
    `main` did not change it.
- **P2-9** `xplainer daemon uninstall` leaves no unit, plist or task, no state file, no
  `launchctl` disable record and no live token, and does **not** disable lingering it did not
  enable; a re-install afterwards succeeds first time.
  - *Amended 2026-09-08 (T30): **met locally against a seam and against two real supervisors;
    the runner ×3 half is blocked.*** `install/uninstall.test.ts` asserts each clause separately:
    the token is **deleted rather than rotated**, even when it lives outside the state directory,
    and no grace file from an earlier rotation survives; lingering is **never disabled**, not even
    when this install enabled it, and is reported instead; a `launchctl` disable record for our own
    label is cleared with `launchctl enable` while a record the install itself created is named and
    left; every install artefact is removed while the setup marker and the workspace stay; and the
    whole thing is idempotent on a state directory that was never installed into. The last clause
    of the criterion is asserted where it belongs, in `install/install.test.ts`: *removes the
    artefact, the state files, the launcher and the token — and **re-installs first time***, with
    the setup marker deliberately outside the artefact set because a re-install needs it. The
    write-nothing refusals are proved by **hashing** every location an install could touch —
    including the Windows task store and the linger marker — in `install/install.test.ts`. Against
    real service managers: `install/testing/supervisor-proof.ts` on macOS launchd and on systemd in
    the container. **Runner half: pending, and not by a failure.** No workflow runs the uninstall
    proof on a macOS or Linux runner — the local proof against those two real supervisors is all
    there is — and on Windows the verb runs inside `daemon-windows.yml`'s install job, which calls
    `daemon uninstall` after the S4U install and was **red** at `f73e8cc` (run `34206429621`) for
    reasons fixed in `d376533` and not re-run since. So the `runner` ×3 half of this row is
    **pending**; what is met is the local half.
  - *Amended 2026-09-09 (Windows runner): the **Windows** leg of the runner half is met, and that is
    a narrower claim than this row's ×3.* `daemon-windows.yml`'s install job runs the shipped
    `daemon uninstall` after a real S4U install on `windows-latest` and now **asserts** two things
    where it previously printed one: the command exits `0`, and `Get-ScheduledTask -TaskPath
    '\xplainer\'` comes back empty afterwards. Both are needed, because the defect being guarded is
    an uninstall that reported success having removed nothing — which is exactly what
    `Unregister-ScheduledTask` does when it is given a task's full path in `-TaskName` (run
    `34304152961`) — so a status alone and an empty folder alone are each satisfiable by a
    regression. The two assertions are made only when nothing earlier in the job failed: the step is
    `always()` so that the removal after a failed install still runs, and uninstalling an install
    that never happened is not a regression. Green with both assertions in run `34319269304`, which
    prints `daemon uninstall exited 0` and `uninstalled, and nothing is left registered`. **No macOS
    or Linux runner runs an uninstall proof at all**, so on those two the row stays pending exactly
    as the note above leaves it.
  - *Amended 2026-09-11: **the Windows leg is re-confirmed on the merged commit; macOS and Linux stay
    pending, and the reason is a missing workflow rather than a missing dispatch.*** `daemon-windows`
    run `34364397390` (2026-09-09, `fe67b3e`) is green in all six jobs, *install under the S4U
    principal, then create → narrate* among them, which is the job that calls the shipped
    `daemon uninstall` and makes the two assertions the 2026-09-09 note added. So the Windows leg
    holds on the code that reached `main`, not only on the branch it was fixed at, and the
    `d376533` sentence above is answered — that commit is an ancestor of `fe67b3e`.

    **The ×3 half of this row is the one genuine coverage gap in the list, and it is a different
    thing from every other pending here.** There is no macOS or Linux uninstall job to dispatch:
    `daemon-lifecycle.yml`, `daemon-restart.yml`, `daemon-breaker.yml`, `daemon-update.yml` and
    `daemon-identity.yml` all run on those platforms and **none of them calls `daemon uninstall`**,
    while the only workflow that does is `daemon-windows.yml`. So this row cannot be closed by
    running anything that exists; it is closed by adding the verb to a job on those two platforms —
    the local proof against real launchd and real systemd
    (`install/testing/supervisor-proof.ts`) is what the workflow would lift. Recorded here as work
    rather than as a wait.
- **P2-10** Each degraded path in ADR 0020 exits with its documented code, **writes nothing**,
  and prints the exact remediation command: no user service manager (6), lingering denied (5),
  no batch-logon right (5), Task Scheduler registration blocked (6), `xplainer setup` not run
  (3), recorded port held by another process (7). In the two "no supervisor" cases the message
  leads with `xplainer connect claude --spawn`, which delivers the tools with no supervision at
  all.
  - *Amended 2026-09-08 (T30): **met locally for the four paths a machine here can reach, and for
    the read-only rule; the two Windows paths are pending on a runner.*** `install/preflight.test.ts`
    covers, each with its exit code and its remediation: `xplainer setup` not run (`3`, in three
    shapes — no marker, a marker whose files are gone, a marker that cannot be parsed); no user
    service manager (`6`, one case per platform, including a booted machine whose user manager does
    not answer, and a launchd with no GUI domain); the recorded port held by another process (`7`,
    **naming the holding pid in words**); and Task Scheduler answering a query with access denied
    (`6`) — that last one against the command seam, because the machine-level judgement of the two
    Windows paths is the runner's and is recorded as pending below. Lingering denied (`5`) is proved with
    nothing staged and nothing registered in `install/install.test.ts`, and again in a polkit-free
    container (`.session/artifacts/rollback-linger-linux-container.log`). The preflight **writes
    nothing anywhere it could write, even when every probe refuses**, which is what lets the
    hash-based assertions above be exact, and the two no-supervisor cases lead with
    `xplainer connect claude --spawn` — which exists, and bypasses its own daemon preflight —
    except where lingering is the reason, where the message names lingering instead. **Runner
    half:** the two Windows paths are judged on a `windows-latest` runner and are not judged here.
    `daemon-windows.yml` carries what measures them — the S4U install under a freshly created
    standard user, and the probe that records **which** call surfaces
    `SCHED_S_BATCH_LOGON_PROBLEM` rather than asserting a guess about it — and that job was **red**
    at `f73e8cc` (run `34206429621`) for reasons fixed in `d376533` and not re-run since. So `5`
    (batch logon) and `6` (registration blocked) on Windows are **pending**, not met.
  - *Amended 2026-09-09 (Windows runner): the two Windows paths are met, and the paragraph above
    describes a measurement `daemon-windows.yml` no longer makes.* Two corrections, both taken from
    real `windows-latest` runs rather than reasoned:
    - **The freshly created standard user proves the refusal; it does not carry the install.** A
      standard user cannot register an S4U task **at any path**. A four-way probe — first run
      `34306540942`, and re-printed by `daemon-windows.yml` on every dispatch since — registers
      `InteractiveToken` at the root and in a subfolder and is answered "Access is denied" for `S4U`
      at both, so the folder was never the obstacle and the logon type needs an elevated token. The
      standard-user leg therefore asserts the refusal it is:
      `daemon install` exits **`5` exactly** — not merely non-zero, because telling `5` (the
      supervisor is here and refused *this* account) from `6` (there is no supervisor at all) is the
      whole of what this row asks — while quoting `Register-ScheduledTask`'s own "Access is denied",
      saying the supervisor was present, and leaving no task under `\xplainer\`, no `daemon.json`
      and no mirrored artefact behind. Green with the exact code asserted in run `34319269304`,
      which prints `refused with exit 5, which is what it must do`.
    - **Criterion 11's S4U install is made by the runner's own account**, which is the account whose
      token can register that logon type. Everything else about it is the shipped command: the same
      payload, the same port, `<LogonType>S4U</LogonType>` read back out of the mirrored XML, and no
      interactive session — which is the property that makes S4U worth having.

    One consequence is recorded here rather than left implicit: that job's `create → put_source →
    narrate` gate narrates with **`dry_run: true`**, so **no speech is synthesised on Windows
    anywhere in this phase**. The pinned Kokoro image is `linux/amd64`, and `XPLAINER_TTS_FIXTURE`
    is read in the daemon process — which Task Scheduler starts with the system environment, not
    the step's. `dry_run` is the contract's own mode and still produces a real `timings.json` and
    `captions.json`, and the subject of the gate — a job enqueued over the *installed* daemon's
    pipe, under an S4U principal with no interactive session behind it, reaching terminal `done` —
    is unchanged by it.
  - *Amended 2026-09-11: **met on all six paths, re-confirmed on the merged commit; and the
    "no speech is synthesised on Windows anywhere in this phase" sentence above is now false.***
    `daemon-windows` run `34364397390` (2026-09-09, `fe67b3e`) is green in all six jobs, so the two
    Windows paths this row was pending on — `5` (batch logon) and `6` (registration blocked) — hold
    on the code that reached `main` rather than only on the branch they were measured at. The
    `d376533` sentence in the T30 note is answered: that commit is an ancestor of `fe67b3e`, so the
    run that was "not re-run since" it has happened. **The speech consequence is the part worth
    correcting.** That paragraph's reasoning was sound when written — the pinned Kokoro image is
    `linux/amd64` and `XPLAINER_TTS_FIXTURE` is read in a daemon process Task Scheduler starts with
    the system environment — but its conclusion described the *phase*, and the phase acquired a
    fourth route. Real speech **is** synthesised on Windows now, in `e2e-speech` run `34496585851`
    (P2-4's note of 2026-09-11 has the numbers), which needs neither a container nor an inherited
    environment variable because the engine is a library call inside the narration worker. The
    `dry_run: true` narration in *this* job is unchanged and is still the right choice for it: what
    that gate's subject is — a job over the **installed** daemon's pipe under an S4U principal with
    no interactive session — is not made stronger by synthesising audio inside it.
- **P2-11** A daemon whose port is permanently held stops respawning after five failed starts
  within 30 seconds and records the reason, on all three platforms; `xplainer daemon status`
  names the holding pid in words; `xplainer daemon restart` clears the latched failure and the
  daemon comes back.
  - *Amended 2026-09-08 (T30): the wording of this criterion, because the original describes
    something the design does not promise.* It read "stops respawning after five failed starts
    within 30 seconds", which measures **the supervisor's retry cadence** rather than each run's
    own life — so a supervisor spacing its retries wider than the window could never trip the
    breaker, and launchd's 30 s `ThrottleInterval` sits exactly on the boundary while Task
    Scheduler's one-minute schema minimum is outside it. **Amended to:** *five consecutive starts,
    each failing within 30 s of its own start, excluding the supervisor's retry delays; a start
    with no recorded outcome counts as a failure only when the next start began within 30 s of its
    own `started_at`, and resets the streak otherwise; an interval that is negative or non-finite
    is timing-uncertain and resets*. This is the same amendment shape ADR 0020's own AC-14
    amendment used: the criterion's property is unchanged — the daemon stops respawning, records
    the reason, names the holding pid in words, and `xplainer daemon restart` clears the latch —
    and what changed is the predicate that decides when it has happened. The design and the
    residual it does not close (a backward clock adjustment leaving a finite sub-30-second interval
    may over-count, and a spurious latch is cleared by `xplainer daemon restart`) are in
    [ADR 0027](adr/0027-relocatable-runtime-artefact-and-the-supervisor-switch.md) §D6.
  - *Amended 2026-09-08 (T30): **met on macOS and Linux under their real supervisors; the Windows
    leg is pending on a runner.*** The rules are asserted in `daemon/daemon-state.test.ts` — the
    boundary at exactly 30,000 ms and 30,001 ms, an `unknown` start whose successor arrives inside
    the window (**counts**) and outside it (**resets**), a start that reached readiness and was
    killed much later (**resets**), and a backward clock step (**resets**) — and then each real
    supervisor drives its own natural retries in `install/testing/breaker-proof.ts`. **Runner
    half:** in run `34206438487` (`f73e8cc`), *the breaker's own rules* passed on `macos-latest` and
    `ubuntu-latest`, *ThrottleInterval 30 s drives the latch* passed on macOS and *RestartSec=2
    drives the latch* on ubuntu; both Windows jobs failed and have not been re-run since `d376533`.
  - *Amended 2026-09-09 (Windows runner): the Windows leg was red because of a **product** defect,
    which is now fixed and measured; the cadence this criterion is judged at on Windows is not the
    one the note above assumes.* Two facts about Task Scheduler, both measured on `windows-latest`
    on 2026-09-09 (run `34317779107`, job `102357526877`), and the argument is in
    [ADR 0020](adr/0020-always-running-local-daemon.md)'s note of that date. **(1)** A
    `<Repetition>` belongs to a trigger that has *fired*, and the shipped document's only trigger
    was a `<LogonTrigger>` — which a hosted runner never fires, and which a real machine has already
    fired before a user runs `install` in a terminal. `Start-ScheduledTask` is an on-demand run and
    starts no trigger. So nothing brought a failed daemon back between an install and the next
    logon: measured three times as one run and a `LastRunTime` frozen for thirty minutes (runs
    `34308488886`, `34311062150`, `34313848702`). `supervisors/schtasks.ts` now emits a
    `<RegistrationTrigger>` carrying the same `PT5M` repetition beside the logon one, and the same
    measurement watched that document run three times, five minutes apart, started by nothing but
    its own registration. **(2)** `<RestartOnFailure>` 3 × `PT1M` does not restart an action that
    exits non-zero — it restarts a task that failed to *launch* — so the sentence above about "Task
    Scheduler's one-minute schema minimum" describes a cadence that never happens. The Windows
    cadence is the `PT5M` repetition alone, five failed starts are about twenty minutes of wall
    clock, and `install/testing/breaker-proof.ts` and `daemon-breaker.yml` carry that budget with
    the measurement written beside it. Nothing about the criterion's predicate changes: each start
    still has to fail within 30 s of *its own* start, which the spacing between starts has never
    been part of. **The Windows leg is now met**, in run `34319237168` — all eleven expectations,
    with the cadence printed start by start: five failed starts at `06:29:53`, `06:34:54`,
    `06:39:54`, `06:44:54` and `06:49:54` (300954, 299440, 300168 and 299826 ms apart, and *no*
    one-minute retry between any of them), each living 22–463 ms and so well inside the 30-second
    window; the latch and an exit `0`; two further repetitions at `06:54:53` and `06:59:53` that
    each read the flag, exited `0` and added no start record; `daemon status` saying "stopped after
    5 failed starts; port 18790 is held by pid 8956, which is not an xplainer daemon"; and
    `daemon restart` clearing the latch and bringing a daemon back on the port it could not bind.
    The macOS and Linux legs of this row have not been dispatched since this file reached `main`
    and stay exactly as the note above leaves them.
  - *Amended 2026-09-11: **met on all three platforms — the macOS and Linux legs the note above left
    undispatched have been dispatched.*** `daemon breaker` run `34364380810` (2026-09-09,
    `fe67b3e`) is green in all six of its jobs, which is this row's whole matrix at once: *the
    breaker's own rules* on `ubuntu-latest`, `macos-latest` **and** `windows-latest`, plus each
    platform's own supervisor driving its own natural retries — *RestartSec=2 drives the latch* on
    ubuntu, *ThrottleInterval 30 s drives the latch* on macOS, and *the PT5M repetition drives the
    latch* on Windows. So the three cadences the amendments above describe are each measured against
    the real supervisor that produces them, and the `PT5M` correction of 2026-09-09 holds on the
    merged commit rather than on the branch it was found at.
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
  - *Amended 2026-09-08 (T30): **met, local and runner.*** `node apps/cli/spikes/p2-s4-readiness.mjs`
    exits `0` and [ADR 0025](adr/0025-daemon-updates-and-readiness.md) carries the note, which is
    exactly what this row asks for. On a runner: the **P2-S4 systemd readiness (ubuntu-latest)** job
    of `phase-2 proofs` succeeded in run `34166469014` (`d01d6db`).
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
  - *Amended 2026-09-08 (T30): **met, and the Windows row is no longer a design.*** The note
    above says the Windows arm was unmeasured because no Windows host was reachable. It has since
    been measured: the **P2-S5 drain adapters (windows-latest)** job of `phase-2 proofs` succeeded
    beside the ubuntu one in run `34166469014` (`d01d6db`), so the spike now exits `0` on all three
    platforms — macOS and the systemd container locally, ubuntu and windows on runners. The
    adapters themselves are proved against the **production** route by P2-12's evidence below,
    which is what the note deferred to T13.
- **P2-S6 (spike)** `node apps/cli/spikes/p2-s6-packaging.mjs` exits `0`. It **records** the
  single-executable measurements — the CommonJS bundle, the six `import.meta.url` sites, the
  `dist`-only payload — in `apps/cli/packaging/README.md` with their dates, and **asserts** only
  what must keep holding, all of it against the **assembled artefact**: every path the built
  payload resolves at run time exists inside it, nothing it resolves falls outside a package's
  `files` allowlist, no `.ts` source is resolved out of a package's build output, nothing is
  resolved from the checkout, and it answers `--version` with no `node` on `PATH` and again with no
  environment at all. The six source sites are **recorded and not asserted**, so a refactor that
  moves one cannot fail this gate by tidying.
  - *Added 2026-09-08 (T30): this row was settled by T1 at the start of the phase and is recorded
    here, where the other two spikes are, rather than only in the plan.* **Met, `local`.** Run on
    2026-09-08 on macOS arm64: `ALL PACKAGING EXPECTATIONS HELD`, exit `0` — 0 files read from
    outside the artefact, 0 missing, 0 outside a `files` allowlist, 0 `.ts` sources out of a build
    output, 0 resolved from the checkout, and `--version` answering `0.0.0` both with a `PATH` that
    resolves nothing and under `env -i`. The one shipped TypeScript file it reports as data rather
    than failing on is `@xplainer/render-core/template/remotion.config.ts`, which is copied into a
    user's workspace and compiled by that workspace's own toolchain.
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
  - *Amended 2026-09-08 (T33): the sixth assertion — **the rolled-back daemon renders** — is now
    run, and running it found a blocking defect in the precondition that guards it.* B5 ends every
    rollback with readiness (the installed workspace satisfies the pins of the runtime that came
    back) and defers the PNG to this batch, where `setup` has supplied a browser and a real
    workspace. `apps/cli/src/setup/testing/rollback-render.ts`, the last phase of
    `pnpm e2e:toolchain`, reruns **every case that ends in a rollback** — the five durable
    boundaries an updater can be killed at, and the replacement that never becomes ready — against
    a payload the shipped assembler produced, and asks the daemon each recovery put back for a
    still. Measured on **2026-09-08**, macOS arm64: all six recovered daemons answered `/healthz`
    as release A with `status: ok` and each rendered a 960×540 PNG of 21311 bytes.
    **That measurement required a one-line local change that is not in this tree**, because the
    precondition as written refuses every real machine:
    `openTransaction()` (`apps/cli/src/install/update/transaction.ts:806`) verifies the **live**
    workspace with `verifyWorkspacePayload()`, which re-hashes the whole workspace root and refuses
    every file its payload manifest does not describe — and that manifest describes only
    `node_modules/`, `package.json` and `package-lock.json`. So the three template files
    `materialiseWorkspace()` copies in (`remotion.config.ts`, `tailwind.css`, `tsconfig.json`) fail
    it **before any tool call**, and Remotion's own `node_modules/.cache/webpack/` fails it after
    the first render: `xplainer daemon update` exits `3` on every machine `setup --workspace` has
    run on. `apps/cli/src/setup/toolchain.ts` states the rule the call breaks — a live workspace is
    checked from its own manifest and never re-hashed, because `videos/`, `public/` and `out/` are
    files the manifest has never described and never should. **The gate asserts the precondition
    up front and fails there**, so this row stays *pending* until the check asks the manifest
    question instead.
  - *Amended 2026-09-08 (T30): **met on macOS and Linux, including the sixth assertion the T33
    note above left pending; the Windows leg is pending on a runner.*** The restart half is proved
    against each real supervisor — `systemctl --user restart` on Linux and
    `launchctl kickstart -k` on macOS, during a job, with the terminal `daemon_shutdown`, no
    surviving Chrome or ffmpeg, and the exit inside the 25-second budget
    (`install/testing/restart-proof.ts`; `.session/artifacts/t13-restart-proof-macos.log` and
    `t13-restart-proof-linux-container.log`). The update-failure half — the updater killed between
    every pair of durable transitions, a replacement that never becomes ready, and the two
    pin-mismatch refusals that disturb nothing — is `pnpm e2e:update`,
    `.session/artifacts/e2e-update.log`, 2026-09-08, `PASSED: every boundary reported and
    recovered, both refusals disturbed nothing`. **The pending note above is discharged.** The
    precondition defect it named — `openTransaction()` re-hashing the live workspace and refusing
    every file its payload manifest does not describe — was fixed by giving tree verification an
    explicit mode: payload 1 stays **exhaustive**, where an extra file is an integrity failure, and
    payload 2 is **described**, where every manifest entry must match and an undescribed file is
    allowed unless it shadows a described one. `pnpm e2e:toolchain` then reran **all six** rollback
    cases against this run's browser and workspace, and each recovered daemon answered `/healthz` as
    release A with `status: ok` **and rendered a 960×540 PNG of 21311 bytes**
    (`.session/artifacts/e2e-toolchain.log`, 2026-09-08:
    `ROLLBACK RERUN PASSED: 6 rollback cases, each ending in a PNG`). **Runner half:** *the drain
    route and the restart verb* and *systemctl --user restart during a job* were green on ubuntu,
    and *launchctl kickstart -k during a job* on macOS, in run `34206435651`; *the update
    transaction against a real systemd* and *against a real launchd* in run `34206442565`. The
    Windows jobs in both runs failed — *the drain route and the restart verb*, *the Task Scheduler
    adapter, executed at all*, and *the failure injection against a real Task Scheduler* — and have
    not been re-run since `d376533`.
  - *Amended 2026-09-11: **met on all three platforms. The three Windows jobs named above have been
    re-run and are green.*** `d376533` is an ancestor of `fe67b3e`, and both workflows were
    dispatched there on 2026-09-09. `daemon restart` run `34364376444` is green in all six jobs:
    *the drain route and the restart verb* on `ubuntu-latest`, `macos-latest` **and**
    `windows-latest`, *systemctl --user restart during a job* on ubuntu, *launchctl kickstart -k
    during a job* on macOS, and ***the Task Scheduler adapter, executed at all*** on Windows — the
    third of those being the job that had been red and the one P2-13 also waits on. `daemon update`
    run `34364384414` is green in all three: *the update transaction against a real systemd*,
    *against a real launchd*, and ***the failure injection against a real Task Scheduler***. So the
    restart half and the update-failure half are each proved against every real service manager the
    product supports, and nothing on this row is pending.
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

  - *Amended 2026-09-08 (T30): **met by the `Type=exec` branch — the only one that applies —
    locally and on ubuntu; the Windows equivalent is pending on a runner.*** P2-S4 retained
    `Type=exec`, so the branch this criterion is judged by is the second one: `systemctl --user
    start xplainer` returns early **by design**, and the guarantee is the caller's. It is
    `awaitHealthy()` in `apps/cli/src/install/health.ts` — an **authenticated** `GET /healthz`
    polled with a bounded budget and a named failure — and `install` reports `installed` only after
    it answers, which is the assertion that the hook does not return success before a `200` —
    `install/install.test.ts` drives a real install against a real loopback `/healthz` and
    `install/lifecycle.test.ts` counts the connections that poll made. The spike measured the difference it
    rests on: `Type=exec` returns in 4.5 ms with 0/5 authenticated `200`s at that instant and the
    first `200` at 130 ms. The directly-spawned path is proved separately on both platforms — the
    daemon's one stdout ready line, read from the pipe by the desktop app
    (`apps/desktop/src/main/spawn.test.ts`, `discovery.test.ts`) and by every `scripts/e2e/*.mjs`
    gate. **Runner half:** ubuntu in run `34166469014` (the P2-S4 job) and in `34206432574` (*the
    queries against a real systemd*); macOS in that same lifecycle run (*the queries against a real
    launchd*), where *what Get-ScheduledTask actually reports* also passed on `windows-latest`. What
    has **not** passed on Windows is the adapter that drives the restart around that wait — *the
    Task Scheduler adapter, executed at all*, red in run `34206435651` (`f73e8cc`) — so the Windows
    equivalent of this row is pending, and has not been re-run since `d376533`.
  - *Amended 2026-09-11: **met, and the Windows equivalent is no longer pending.*** The one job the
    note above names as the obstacle — *the Task Scheduler adapter, executed at all* — succeeded on
    `windows-latest` in `daemon restart` run `34364376444` (2026-09-09, `fe67b3e`, which contains
    `d376533`). The rest of the row's evidence is re-confirmed on the same commit: `daemon lifecycle`
    run `34364371567` is green in all six jobs, *the queries against a real systemd* and *the queries
    against a real launchd* and *what Get-ScheduledTask actually reports* among them, and the P2-S4
    readiness job succeeded again in `phase-2 proofs` run `34364366726`. So the `Type=exec` branch
    this criterion is judged by holds on all three platforms with the adapter that drives the restart
    around the readiness wait proved on each.

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
  - *Amended 2026-09-08 (T30): this phase also owns the artefact that closes **P2-4** on Windows,
    and it is named here so that criterion's "pending" has a milestone rather than a hope.* A
    **native relocatable speech bundle per platform**, published with that same manifest to the R2
    bucket **behind the connected custom domain and its Cache Rule** — the two steps Terraform does
    not manage and no command in this repository performs. Phase 2 implements and proves the
    `bundle` provider's download, resume, checksum and atomic install against a fixture server, and
    ships a refusal that says all of this in the message a user meets; what it cannot do is publish.
    Windows has no other route — the pinned Kokoro-FastAPI image is linux/amd64 and `--tts-url`
    records a server somebody else already runs — so this bullet is the whole of the closure.
  - *Amended 2026-09-10 ([ADR 0028](adr/0028-in-process-onnx-speech-and-a-g2p-we-own.md)): **this
    sub-bullet is obsolete, and it stays here saying why rather than being deleted.*** Its last
    sentence — "Windows has no other route … so this bullet is the whole of the closure" — is now
    false. Windows has a route, it is the **same** route every other platform uses, and it needs
    nothing published: `setup` acquires the Kokoro-82M ONNX graph, a voice pack and this platform's
    ONNX Runtime from their own upstream homes, each pinned by digest, and speech then runs inside
    the narration worker. So **a native speech bundle per platform is no longer phase-4 work at
    all** — not deferred, not descoped, but unnecessary, and the four-platform build matrix,
    standalone CPython, the wheel closure and the relocation tooling it implied are unnecessary with
    it. This phase keeps the two things this sub-bullet was attached to and that are still owed: the
    **update feed** and the **version-and-checksum manifest**, which remain infrastructure for the
    browser's expected digest, for the `bundle` route that still reads one, and for
    `electron-updater`. What made the bundle avoidable was a licence problem rather than a
    packaging one — the phonemizer every route to Kokoro's Python stack reaches is GPL, and removing
    it deletes words from the audio — and ADR 0028 carries that argument.
  - *Amended 2026-09-11: **the Docker speech route is NOT retired, and its retirement is booked here
    behind the per-architecture work rather than behind the platform proofs.*** The plan booked
    "retire the docker speech route once the platforms are proven". The platforms **are** proven —
    `e2e-speech` run `34496585851`, green on ubuntu, macOS and Windows on 2026-09-10 — and the route
    **stays**, because the condition that plan named turned out to be the wrong one.

    The reason is one platform and it is named in the code. `onnxruntime-node` ships five
    `<platform>/<arch>` subtrees and **`darwin/x64` is not one of them** —
    `ONNX_RUNTIME_PLATFORMS` at
    [`apps/cli/src/setup/providers/speech-onnx.ts:199`](../apps/cli/src/setup/providers/speech-onnx.ts),
    with the argument in that file's docblock at line 80 — so on an Intel Mac
    `runtimePlatformKey()` (line 390) refuses **by name**: *"notably no darwin/x64 — so the
    in-process speech path cannot run here at all, rather than running slowly. Nothing was
    downloaded."* It raises `OnnxUnavailable`, which `providers/speech.ts` treats as an **absence**
    rather than a failure and walks past to the next route. Since 2026-09-10 `onnx` sits **above**
    `docker` in that precedence (`ACQUIRING_ROUTES`), which changes what `docker` is for: it is no
    longer the route most machines take, it is the route reached **only where ONNX is unavailable**,
    and `darwin/x64` is the only platform where that is structural rather than a transient failure.
    Retiring it would therefore leave `darwin-x64` with `--tts-url` as its sole route — "run your own
    Kokoro server" — on the one platform that **also** has no supported desktop installer (P2-2's
    `arm64`-only `mac:` block). One platform losing both its speech route and its installer in the
    same phase is not a tidy-up.

    **So the condition is rewritten rather than met: the route is retired when `darwin-x64` has an
    in-process engine, and not when the other platforms are proven.** That closure is phase 4's
    per-architecture work, and what it takes for **speech** is worth separating from the installer
    bullet below it, because the two are not the same job and the payload build does not do both.
    An x64 runner building its own payload closes P2-2's installer gap; it does **not** make
    `onnxruntime-node` publish a binding it does not publish. Closing `darwin-x64` for speech needs
    a darwin-x64 ONNX Runtime from somewhere other than that package's published set — the `bundle`
    route is the mechanism already built for exactly that shape of artefact, and this is the one
    platform that would still justify one — or ONNX Runtime Web, which ADR 0028 measured at 1.0×
    realtime and 1019 MB and rejected. Neither is decided here; what is decided is that **the
    `docker` route does not go first**.

    Until then the route is **load-bearing for exactly one platform**, which is the sentence to read
    before proposing its removal: `services/tts-sidecar`, `@xplainer/tts-client` and the pinned
    `linux/amd64` image are all still live for it, exactly as
    [ADR 0028](adr/0028-in-process-onnx-speech-and-a-g2p-we-own.md) §Consequences says — *"This adds
    a route; it retires none"* — and as that record's note of this date restates.
- **Code signing and notarisation for macOS and Windows.** Phases 0 and 2 ship unsigned
  artefacts by design. This is also what makes the standalone binary a **recommended** way to
  install the always-on daemon: an npm-delivered CLI carries no `com.apple.quarantine`, so
  Gatekeeper never fires on it, while a binary the user downloads is the opposite case and since
  macOS 15 has no Control-click escape. Until this phase, `npx`/`npm` is the supported
  daemon-install path and the binary is a convenience for people who fetch it with `curl`
  (ADR 0020).
  - *Amended 2026-09-08 (T30): this bullet also owns the artefact that closes the Intel Mac gap in
    **P2-2**.* `apps/desktop/electron-builder.yml` builds `dmg` and `zip` for `arm64` only in phase
    2, so **per-architecture payload builds** — an x64 runner building its own payload, wired to
    electron-builder's per-arch `extraResources` — belong here, with the phase that signs and
    publishes installers, rather than with the one that first produced them. Until then an Intel
    Mac has no supported desktop installation at all, which P2-2 records rather than implies.
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
| **P5-2** | No file contains an absolute local path, the private sibling repository's name, or a reference to a `hosted` package | ~~**Not yet.** Absolute paths are gone — two occurrences in accepted records are redacted in place with a dated note, and one file was removed rather than scrubbed. The repository's name still ships in twelve schema `description` strings and their generated output, and hosted-package references remain in comments including one published `description`. Phase-0 gates 1 and 2~~ — *amended 2026-09-11:* **Holds.** The two gates this row deferred to, **phase-0 gates 1 and 2, both closed on 2026-09-09**; that is recorded at each of them above and was never carried down here, which left the phase-5 table reading as the only outstanding blocker on a repository that is already public. The twelve schema `description` strings no longer name the private repository, and `check-publish-contract` carries `no-private-reference-path` beside `no-private-repository-name`, each with its own negative test, so the class now fails a gate rather than waiting for a reader; the comment-level `hosted` references — `apps/cli/package.json`'s published `description` included — name the relocated service in prose instead of citing a path that is not in this checkout. The struck wording is kept because it is what those gates were opened for |
| **P5-3** | The private repository consumes the extracted packages from the registry at pinned versions | **Relocated.** It is that repository's criterion to meet, and it cannot be met before phase 1 publishes |
| **P5-4** | The tier checks still pass in both repositories, adapted to the new boundary | **Holds, with a stated caveat.** `pnpm lint:tiers` passes and still enforces that every member declares a tier. Its real-graph half is vacuous here — no `hosted` member remains for it to catch — and the synthetic fixture in `packages/config/src/tiers.test.ts` is what still proves the rule can fail. The Python import-linter contract retired outright. Recorded in ADR 0003's and ADR 0001's notes of 2026-09-06 |
| **P5-5** | A contributor outside the company can run the local tier end to end from the public repository alone | **Not yet, and not for a split reason.** Nothing renders until phase 1. This is the criterion phase 1 is judged against from the outside |
| **P5-6** | Every file is one whose copyright the company holds, or for which a CLA grants the relicensing | **Struck** by [ADR 0022](adr/0022-open-source-the-published-packages.md): Apache-2.0 §5 supplies the inbound grant in the licence text, so the instrument this criterion existed to protect is gone. It survives as a live question only for the parts of the tree that are **not** Apache-2.0 — see phase-0 gate 4 |
