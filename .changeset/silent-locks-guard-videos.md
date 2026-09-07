---
"@xplainer/cli": patch
---

One writer per video, a shutdown that always finishes, and exit code `1` in the table.

- **`<workspace>/locks/<slug>.lock`.** `xplainer mcp` runs the real worker registry over the same
  workspace root a daemon resolves and deliberately does not take `owner.lock`, so a daemon and two
  stdio sessions could each drive Remotion at one `out/<slug>/explainer.mp4`. The worker factory now
  takes a per-video write lock — last, after every refusal — and the runner gives it back in
  `finish()`, the one place every terminal outcome passes through. A second process asking for a
  video that is held gets *that job* failed with a message saying to retry; different videos never
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
