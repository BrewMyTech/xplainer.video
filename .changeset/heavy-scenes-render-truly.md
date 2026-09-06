---
"@xplainer/cli": minor
---

The eight tools do real work: `createLocalBackend()` replaces the phase-0 stub.

`explainer_create` scaffolds a video into the shared Remotion workspace and never overwrites the
agent's `Scenes.tsx`; `explainer_put_source` writes the agent's files and refuses the five
engine-owned ones **at the disk boundary**, case-folded, all-or-nothing — that is ADR 0018's layer 3,
and it exists because layer 2 sits on the MCP registration and this backend is also reachable
without it; `explainer_put_media` decodes base64 strictly, because `Buffer.from` drops anything
outside the alphabet in silence and would otherwise write a truncated asset that only fails inside a
render minutes later; `explainer_list` reports what is actually on disk. `explainer_narrate`,
`explainer_still` and `explainer_render` enqueue against the daemon's job runner and answer with a
`job_id`, and `explainer_job` **is** that runner's own answer, relayed. The "not implemented in this
phase" wording is gone from all eight; it now describes deferred *commands* and nothing else.

Two workers carry the queued work, registered in `daemon/start.ts`. Narration is a child process
running `@xplainer/render-core`'s narration port against `@xplainer/tts-client`: `XPLAINER_TTS_URL`
names the Kokoro server, and `XPLAINER_TTS_FIXTURE` points at recorded WAVs and word spans instead,
so a machine with no container still produces *measured* timings rather than estimates. Stills and
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
