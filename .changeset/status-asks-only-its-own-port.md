---
"@xplainer/cli": patch
---

`status` and `daemon status` no longer report on a daemon that is not yours.

A state directory holding neither `daemon.json` nor `runtime.json` has never had a daemon of ours
in it — `serve` writes the port as it binds — so there is no address of ours to ask. Both commands
probed the fallback port anyway, which on any machine already running xplainer is somebody else's
daemon: it answered `401`, and a machine with nothing installed was reported as `token_absent`,
"a 401 and no token to present", about a daemon the user does not own.

Both now answer from their own files in that case and send no request. Nothing changes for a daemon
that has actually bound, because that one recorded its port.

The desktop's discovery gets the matching correction: a foreign process holding the *fallback* port
is no longer reported as `occupied`. That outcome means exit `10`, serve-time ownership — "the port
this daemon recorded is taken" — and a machine that has claimed no port cannot be in it. A clash
there belongs to `install`'s preflight and exit `7`, which has a different remedy.

Found by three tests that had silently assumed nothing listens on the default port: they pass in CI,
where no daemon exists, and failed on any developer machine running the product.
