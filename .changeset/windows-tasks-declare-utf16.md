---
"@xplainer/cli": patch
---

Windows: the Task Scheduler document registers, and the bearer token gets the ACL a mode cannot give
it.

**`daemon install` could not register a task on Windows at all, and the reason was one attribute.**
The document `supervisors/schtasks.ts` renders declared `encoding="UTF-8"`, and
`Register-ScheduledTask -Xml` is handed a **string** — UTF-16 by construction — so MSXML refused it
with `(1,40)::ERROR: unable to switch the encoding`, the service reported `SCHED_E_MALFORMEDXML`
(`0x8004131a`), and the install rolled back everything it had written and exited `5` saying a
privilege or a policy had refused it. It had not: nothing about the machine was wrong. The
declaration now says `UTF-16`, which is what `Export-ScheduledTask` emits and what a registration of
an otherwise identical document had already been measured to accept on `windows-latest`; the bytes
on disk stay UTF-8 so the mirror under `%LOCALAPPDATA%` is readable text, and the registration
command names the encoding it decodes with (`Get-Content -Raw -Encoding UTF8`, which also stops
Windows PowerShell reading a profile path through the active ANSI code page). The same one-line
defect had been failing `daemon update`'s re-registration and three of this project's four
Task Scheduler proofs. The refusal that reported it has been corrected too: it asserted "a
privilege or a policy" for every command a supervisor declines, which was not true of this one and
sent the reading in the wrong direction. It now says only what a non-zero status establishes — the
service manager is there, it refused, and the line it printed is the reason.

**The bearer token is now narrowed to the account that minted it.**
[ADR 0020](https://github.com/xplainer-hosted/xplainer.video/blob/main/docs/adr/0020-always-running-local-daemon.md)
§R-SEC-5 records that a mode is not protection on Windows — Node documents that only the write
permission is settable and that the owner/group/other distinction is not implemented — so
`open(path, "wx", 0o600)` was leaving a token every account on the machine could read, and names the
remedy it assigns to phase 2. `serve` now applies it at creation:
`icacls <path> /inheritance:r /grant:r "<user>:(R,W)"` on the token, and the container-inheriting
form on the state directory it is minted in. `/inheritance:r` is the half that matters — a file
under `%LOCALAPPDATA%` inherits its parent's entries, which routinely include `BUILTIN\Users` on a
machine with a second account, and granting the owner changes nothing while those are still there.
A failure is **reported and never fatal**: the one line `serve` already printed about the token now
says which of a mode and an ACL this platform got, and names the `icacls` that did not run, because
refusing to start over a missing `icacls` would trade a weaker file for no service at all. Nothing
changes on macOS or Linux, where the mode is the protection.

**And the install preflight no longer names the current working directory as a place an install
writes.** `preflightWriteLocations()` reports every path an install could touch, so that a refusal
can be proved to have written nothing; the Windows entry among them is composed with `win32.join`,
and taking its directory with the *host's* `dirname` answered `"."` on macOS and Linux, where that
string carries no `/` at all. Nothing was ever written there — the list is read, not acted on — but
a caller checking it was checking the wrong directory, and this project's own refusal test was
hashing its checkout to do it.

The named pipe is **not** narrowed the same way and the gap is stated rather than implied:
`net.Server.listen({ path })` offers no way to pass a security descriptor, and a native addon is
what this phase's packaging cannot carry. Its name is still derived from the state directory, so two
accounts and two runs never meet on one endpoint.
