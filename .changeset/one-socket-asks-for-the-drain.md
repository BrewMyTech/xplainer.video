---
"@xplainer/cli": minor
---

`POST /api/daemon/drain` over the socket, and `xplainer daemon restart` behind it.

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
application's failure latch **first** — `daemon.json`'s `stalled` record *and* the start history
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
