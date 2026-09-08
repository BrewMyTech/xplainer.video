---
"@xplainer/cli": patch
---

Four defects from B7 and B8's verification, each with the measurement that found it.

**`daemon.json`'s `token_origin` answers for the file `token_file` names, and for no other.** The
record was being read as an answer about the *state directory*, so once a directory had minted a
token of its own, an operator's `--token-file /elsewhere/token` inherited `minted` and a non-loopback
bind was refused for ever — in a sentence saying "the bearer token in /elsewhere/token is the one
this daemon minted for itself", about a file this daemon had never written. A recorded origin now
governs only when the recorded path is the path this start resolved; anything else is the operator's.

**And R-SEC-9's fifth precondition is asked before the mint rather than after it.** A remote bind on
a machine with no token file used to reach `loadOrMintToken`, create the token `0600`, stamp
`token_origin: minted` into `daemon.json`, and then refuse itself over the credential it had just
written — a refusal that left the machine changed, on the one path ADR 0020 says must leave it
exactly as it was found. The check is now three-way — `absent`, `minted`, `operator` — and runs
first: an absent token is refused in its own words, nothing is minted, and nothing is recorded.
Measured against the shipped binary, before and after, on a real non-loopback bind with a real
certificate.

**The Windows named pipe's narrowing could never run.** `NamedPipeClientStream` derives the pipe
direction from `desiredAccessRights` and throws `ArgumentOutOfRangeException` for a value carrying
neither `ReadData` nor `WriteData`, so the opener's `ChangePermissions,ReadPermissions` threw at
construction: every Windows start reported `failed` from a mechanism whose failures are reported and
not fatal, and the pipe kept the default descriptor Microsoft documents as granting "read access to
members of the Everyone group and the anonymous account". The opener now asks `ReadData` as well —
the connection still never reads a byte — while the entry it *grants* is unchanged. The whole
emitted script is a committed fixture, because it runs on a platform the suite cannot execute, and
the window between `CreateNamedPipeW` and the narrowing is written down: one promise resolution and
one `powershell.exe` start, with nothing of the daemon's in between.

**And the toolchain manifest's mirror was never wrong — its own suite was.** `manifest.test.ts`
drives the real `getChromeDownloadUrl` over all 80 branches by replacing the two predicates it reads
the host through, and never put them back, so the case that asks *this machine's* question compared
the mirror against a selector still answering "no remotion.media binaries". On macOS and Windows that
is the same URL either way; on linux-x64 with glibc ≥ 2.35 it is not, which is what failed on the
ubuntu runner. The stand-ins are now restored after every row, and the host case asserts it is
looking at the shipped module before it compares. Measured on Debian bookworm x64 (glibc 2.36): the
mirror and the unpatched selector both answer
`https://remotion.media/chromium-headless-shell-linux-x64-149.0.7790.0.zip?clear`, which is the URL
the manifest records for `linux-x64-glibc235` — re-verified by streaming it: 96,395,776 bytes,
sha256 `f11d8e76f043a8a70c7ebdae2834f94370ad329ed997ddcdfd5dbcd803f53f76`, exactly as recorded.
