---
"@xplainer/cli": minor
"@xplainer/render-core": minor
---

`xplainer setup` acquires the toolchain, and the daemon reads what it wrote.

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
