---
"@xplainer/cli": minor
---

Harden `xplainer serve`: a bearer token, a loopback guard, a `SIGTERM` drain, a ready line, and
`xplainer status`.

Every TCP route now needs a bearer token — `/healthz` included, deliberately: an unauthenticated
`{status, version}` tells any web page which xplainer to attack, and a `401` against *our own* token
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
reaches loopback too. A deliberately widened bind *adds* its authority and removes nothing — a
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
