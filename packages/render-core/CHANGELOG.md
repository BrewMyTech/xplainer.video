# @xplainer/render-core

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

- 1ec8b8b: A segment that opens with punctuation no longer renders `Alpha , beta`.

  Kokoro timestamps a comma as its own token, so a narration segment whose first token is one hands
  `buildCaptions` punctuation in first position. The leading space that every _word_ after the first
  carries — the fix that stopped `one.Segment` welding together across a segment boundary — was being
  applied to that token too, which put a space in front of the comma and moved the burned caption
  from `Alpha, beta` to `Alpha , beta`.

  Punctuation in that position is now emitted bare. It is still emitted as its **own** caption rather
  than folded into the caption before it: the fold extends the previous caption's `endMs`, and the
  previous segment's last word is a whole inter-segment gap away, so folding would hold that caption
  on screen through the silence. The separation the earlier fix bought is untouched — two _words_
  across a boundary still read as `one. Segment`.

  `captions.json` is unchanged in shape and still validates against
  `packages/protocol/schemas/captions.json`.

- 26aade2: `decodeWav` reads Kokoro's streaming header, which is the one every live narration arrives in.

  `kokoro-fastapi` builds its response with a streaming writer and therefore does not know the length
  when it writes the header, so it puts the all-ones sentinel in both size fields —
  `RIFF ffffffff … LIST … data ffffffff` — and it does that for `stream: false` requests too. Read as
  a byte count, that sentinel made every real narration fail with `WAV chunk "data" claims 4294967295
bytes but only 322100 remain`, which is the shape of a decoder bug rather than of the server saying
  "the file ends where it ends". A chunk size of `0xffffffff` now means exactly that: everything left
  in the payload.

  A size that is merely too large still fails, unchanged, so a truncated download is not read as a
  short take — the two cases look alike in a header and are opposites in a track.

  Found by the end-to-end run against a live container (`pnpm e2e:render`), which is the only place
  this package meets a WAV it did not write.

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

- 574480c: Add the narration port: pacing, word spans, WAV concatenation, `timings.json` and `captions.json`.

  `src/narrate/` turns a narration script into three files — `narration.wav`, `captions.json` and
  `timings.json` — with every scene duration measured from real speech rather than written by hand.
  `narrate()` synthesises each segment through `@xplainer/tts-client` (a new `dependencies` edge; its
  contract is unchanged), and `planSegments()` is the pure half that places every segment and every
  word and can be tested from a fixture.

  Three decisions are worth knowing before calling it:
  - **A word's end is the server's `end_time`, never the next word's `start_time`.** The space
    between two Kokoro spans is real silence, and a caption stretched across it reads as lag.
  - **A segment's spoken length is measured from its PCM frames.** Synthesised audio routinely runs
    past its last word, so inferring the length from the spans would shift every later segment.
  - **Silence is quantised to whole samples in the plan, and the track builder writes exactly those
    counts**, so `timings.json`'s `totalMs` equals the WAV's own sample count over its sample rate
    rather than merely being close to it.

  `LEAD_IN_MS` (400), `GAP_MS` (620) and `TAIL_MS` (800) are exported, along with the WAV primitives
  (`decodeWav`, `encodeWav`, `silentFrames`, `silenceSamples`), the document builders (`buildCaptions`,
  `buildTimings`, `buildTrack`), the writers, `estimateSpeech` and `NarrationError`. WAV handling is a
  small RIFF reader and writer in this package rather than a dependency; it accepts 16-bit integer PCM
  and refuses every other encoding by name, because a zeroed frame is silence at that depth and is not
  at others.

  `narrate({ dryRun: true })` needs no server and no client: it estimates each segment and reports
  `mode: "dry_run"`, so an invented timing can never be mistaken for a measured one.

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

- 83db21c: Add the grapheme-to-phoneme port under `src/g2p/`: English text to Kokoro's IPA phoneme string,
  plus a character span per word so the model's own per-token duration predictions can be accumulated
  back into word-level timings.

  A word resolves through four layers, in order, and the order is the design:
  1. a **curated domain lexicon** (`src/g2p/data/lexicon.txt`), committed as reviewable data with a
     gloss on every line — "nginx" is "engine X" and "PostgreSQL" is "post-gres-Q-L", and no rule
     about English would ever produce either;
  2. **CMUdict**, vendored verbatim under its 2-clause BSD licence, which covers ordinary narration
     prose completely;
  3. a **deterministic letter-to-sound ruleset** for the long tail, plus an initialism speller, both
     of which report what they derived so the caller can log it;
  4. a **named refusal** — `G2pError`, carrying the word — never an empty string.

  That last point is the reason for the shape. Kokoro's own pipeline builds its G2P with `unk=''` and
  filters unknown symbols away, so an out-of-dictionary word becomes silence and the narration is
  quietly missing a word. Nothing here can produce that: `phonemise()` refuses, and `kokoroTokenIds()`
  refuses a phoneme outside the model's 115-symbol vocabulary rather than dropping it — a property
  asserted over every symbol every layer can emit.

  Affricates and diphthongs are emitted as misaki's single characters — `ʧ ʤ A I O W Y` — rather than
  as `tʃ dʒ eɪ aɪ oʊ aʊ ɔɪ`. Kokoro was trained against misaki and reads a two-symbol sequence as two
  segments: measured against misaki's own output, the affricate region stretches ×1.70 and the
  diphthong ×1.66, and a sentence with eight of them ran 9.5% long. The choice is made in the
  ARPAbet table, which is the only place that can make it correctly — English has genuine `t`+`ʃ` and
  `ɔ`+`ɪ` sequences ("nutshell", "drawing") that are character-identical in IPA, and ARPAbet is the
  last representation that still separates them.

  New exports: `phonemise`, `kokoroVocabulary`, `kokoroTokenIds`, `unsupportedSymbols`, `G2pError`,
  and the types `Phonemisation`, `WordSpan`, `DerivedPronunciation`, `PhonemeSource` and
  `G2pErrorCode`. The package now ships `dist/g2p/data/`, which includes CMUdict and its licence.

- 26aade2: Captions no longer weld two segments together: `segment one.Segment two` reads `segment one.
Segment two`.

  `buildCaptions()` gave the first token of _every segment_ no leading space, on the belief that a
  segment starts a caption page and a page never begins with a space. Only the first half of that was
  ever true. `@remotion/captions`' `createTikTokStyleCaptions()` — the pager the engine-owned
  `Captions.tsx` calls — cuts a new page by elapsed time, and the token it cuts on is precisely one
  that _begins with a space_; it then trims that space off the token it opens the page with. So the
  bare token could not start a page, welded onto the previous segment's last word inside the page it
  landed in, and burned into the video as `one.Segment`. The leading space is what permits the page
  break, not what spoils it.

  Now only the first token of the whole track is bare. The fold that folds a punctuation-only token
  into the word before it is unchanged and still stops at a segment boundary — it extends the previous
  caption's `endMs`, and the previous segment's last word is a whole inter-segment gap away. Timings
  are untouched: this changes `text` and nothing else, so no existing `captions.json` shifts on the
  clock, and `packages/protocol/schemas/captions.json` describes the rule it always meant to.

  Re-narrate to pick it up; a `captions.json` already on disk keeps the old spacing.

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

- 687279b: Widen `SCAFFOLD_FILES` from a six-element readonly tuple to a readonly array.

  `isolatedDeclarations` cannot infer a type through the two spreads that build the
  list, so the declaration is written out as
  `readonly (EngineOwnedFile | AgentOwnedFile)[]` rather than emitted as a tuple.
  The order is unchanged and is still a guarantee about the values — the engine's
  five first, `Scenes.tsx` last — but it is no longer a guarantee expressed in the
  type: a consumer indexing by position or reading `.length` loses the narrowing.
  Nothing in this workspace does either, and `ScaffoldFile` is still the union of
  the same six literal types.

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

- 1a95fee: The workspace layout, as code: `src/workspace.ts`.

  `template/` said what a Remotion workspace contains; nothing said where a video's pieces go inside
  one, so every caller would have had to join those paths itself. `videoPaths(root, slug)` is now the
  only place `videos/<slug>` and `public/<slug>` are paired, which matters because the pairing is
  load-bearing and fails quietly: `--public-dir` is what Remotion serves `staticFile()` from and
  `Root.tsx` fetches `timings.json` through it at metadata time, so pointing it at the source
  directory does not error — it renders the `durationInFrames={300}` placeholder, silently.

  `materialiseWorkspace()` copies the four template files in and creates `videos/`, `public/` and
  `out/`, never overwriting a file that is already there: `package.json` is what a package manager
  recorded `node_modules/` against, and rewriting it from the template on every `explainer_create`
  would un-pin a workspace someone had already installed. It installs nothing —
  `remotionBinary()` answers `null` for a workspace nobody has run `npm install` in, and
  `workspaceNotInstalledMessage()` is the sentence a caller shows instead of failing inside `spawn`
  with an `ENOENT`.

  Also exported: `stillOutput()`, `isWorkspaceInstalled()`, `listVideoSlugs()`, and the directory and
  filename constants the layout is built from.

- Updated dependencies [b3e1be8]
- Updated dependencies [687279b]
- Updated dependencies [574480c]
- Updated dependencies [574480c]
- Updated dependencies [ce26d75]
- Updated dependencies [7c81808]
- Updated dependencies [d01d6db]
- Updated dependencies [574480c]
- Updated dependencies [574480c]
- Updated dependencies [c572ac0]
  - @xplainer/protocol@0.0.1
  - @xplainer/tts-client@0.0.1
