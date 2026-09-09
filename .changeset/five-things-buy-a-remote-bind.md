---
"@xplainer/cli": minor
---

A non-loopback `serve` now costs all five of R-SEC-9's preconditions, and the guard never weakens.

**`serve` gains `--tls-cert`, `--tls-key` and a repeatable `--allow-host`.** ADR 0020 §Security
R-SEC-9 does not make remote exposure a flag; it makes it a list, and the list is `all` rather than
`any`. A bind that is not loopback now requires an explicit `--bind`, the existing
`--i-understand-remote-exposure`, a PEM certificate and its key, at least one operator hostname, and
a bearer token this daemon did not mint. `0.0.0.0`, `::`, `[::]` and `*` are still refused outright,
acknowledgement or not: a wildcard bind is not a decision about which interface to expose, it is the
absence of one.

Four of the five are decided **before the state directory is taken** and the fifth before anything
is bound, so a refusal leaves the machine exactly as it found it — `serve` exits `1` naming
**every** missing precondition in one sentence, rather than one flag per run.

**`daemon.json` gains `token_origin`.** "A non-default token" cannot be decided from the value —
32 random bytes an operator wrote and 32 random bytes the daemon minted are the same thing — so
provenance is recorded at the moment it is known and inherited by every later start. A token file
`serve` created is `minted` and is refused for a remote bind; one it found and cannot attribute to a
mint of its own is the `operator`'s. Every uncertainty falls towards `minted`, which is the answer
that refuses.

**The `Host`/`Origin` allowlist is loopback *plus* the operator's hosts, and it is unconditional.**
That is CVE-2026-65105 written down as a rule: Ollama's `Host` validation was conditional on a
loopback bind, so widening the bind silently disabled the whole defence. Here widening adds
authority and removes none — `Host: evil.com` is `403` on a daemon bound to a LAN address exactly as
it is on one bound to `127.0.0.1`, `127.0.0.1` stays on the list, and `/healthz` still asks for the
token. There is no branch on the bind address anywhere in the guard.

**TLS on a *loopback* bind is refused**, which R-SEC-9 does not say and the rest of the machine
does: `xplainer status`, `xplainer daemon restart` and the desktop all reach a loopback daemon over
`http`, and a listener that quietly stopped answering them would be a working machine turned broken
with no message. `startServer()` takes an optional `tls` pair — the PEM text, never a path, because
it does no I/O — and reports an `https:` origin when it has one.

Nothing here generates a certificate. The operator brings the pair, `serve` checks that the two
files are a certificate and a private key **and that the key is that certificate's**, and refuses by
name rather than failing inside a handshake on somebody else's machine.
