---
"@xplainer/cli": patch
---

**A stale half-record made `serve` call an operator's own token file "the one this daemon minted for
itself" — at any path, for as long as the record stood.**

The correction of 2026-09-08 that split `token_origin` from the directory it lives in stopped short
of one branch. `resolveTokenOrigin` answered the half-record case — `token_origin: "minted"` with no
`token_file` beside it, which a start that minted and then failed used to leave — **before** it
compared the resolved path with anything. So a `serve --bind <LAN address> --token-file
/etc/xplainer/operator.token` against such a state directory was refused with:

> the bearer token in `/etc/xplainer/operator.token` is the one this daemon minted for itself

which is false, and whose remediation — "write a token of your own to a file and pass it with
`--token-file`" — is exactly what the operator had just done. It was fail-closed and one loopback
start cleared it, so nothing was exposed; what it cost was a true sentence.

The ordering is now the other way round. A half-record is inherited **only** at the path a mint of
that state directory would have written — `defaultTokenPath(stateDir)`, newly exported for the
comparison — because that is the only file such a start can have created. A token at any other path
is the operator's, which is what R-SEC-9's fifth precondition is asking about.

`daemon/token.ts`'s `TokenOriginRequest` and `TokenPresenceRequest` therefore carry `defaultPath`,
and `commands/serve.ts` supplies it at both call sites. `token.test.ts` covers both halves against
real files: the half-record at the state directory's own `token` is still `minted`, and the same
record against a file outside it is `operator`. Before the fix both answered `minted`.
