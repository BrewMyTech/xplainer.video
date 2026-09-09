---
"@xplainer/cli": patch
---

**A failed start used to leave `daemon.json` claiming an origin for no file, and the next remote
bind read the daemon's own minted token as the operator's.**

`token_origin` answers for the file `token_file` names, and the two were being written at different
moments: the origin the instant the token was read or minted, the path only in `markReady()`, after
ownership, reconciliation and both binds. So any ordinary start that failed *between* them — a held
port, a certificate pair that will not load, a socket path the platform refuses — recorded
`token_origin: "minted"` with `token_file: null`. On the next start `resolveTokenOrigin` compared
the resolved path with the recorded one, found the record named no file at all, and answered
`operator` for the very token this daemon had minted seconds earlier. ADR 0020 §Security R-SEC-9's
fifth precondition — "a bearer token this daemon did not mint" — was then met by bookkeeping rather
than by an operator, and the daemon said so: *"with an operator token from `<state>/token`"*, about
a file nobody but the daemon had ever written.

The two fields are now one durable write, in `commands/serve.ts`, at the moment the provenance is
decided; `markReady()` writes neither, and `DaemonBinding` no longer carries `tokenFile`. Recording
the path before the bind is the point rather than a side effect: the mint is the event whose answer
the next start inherits, so the run that mints and then fails is exactly the run that has to leave a
complete record behind.

Measured against the shipped binary, on macOS, before and after, in a throwaway state directory:
`serve --port <a port held by another process>` exits `10` having minted the token, and then a
non-loopback `serve --bind <LAN address>` with TLS and an allowlist **bound the LAN address and
announced itself ready** — before the fix — and **exits `1` with "the bearer token … is the one this
daemon minted for itself", having bound nothing** after it. `commands/serve.test.ts` carries the
same sequence as a spawned-child regression test; without the fix it fails twice, once on the
incomplete record and once on the bind that should never have happened (exit `70` from the refused
address instead of the refusal's `1`).
