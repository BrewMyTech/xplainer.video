---
"@xplainer/cli": minor
---

`xplainer token rotate`, the token file's re-verified ACL, and a named pipe only its creator can open.

**`xplainer token rotate` is ADR 0020 §Security R-SEC-8's rotation, grace window and all.** The
window is the difference between a rotation and an outage: an agent holds the token in its
environment — Claude Code's `${VAR}` expansion, Codex's `bearer_token_env_var` — and nothing updates
that environment at the instant a file changes. So the retired value goes into `<token>.previous`,
at the same `0600` and behind the same Windows entry as the token itself, with the instant it stops
being accepted beside it; five minutes by default, a day at most, and `--grace 0` for a leak. No
value is printed and none reaches `daemon.json`, which records two instants and a path.

**A daemon that stays installed picks the rotation up on its next request.** The guard is handed a
*function* rather than a string, and `daemon/token.ts`'s ring re-reads the token and the grace file
whenever either changes — so both values open the daemon until the window closes, with no restart,
no signal and no control route. A read that fails keeps the values already held, because the one
moment the token file is unreadable is the moment something is renaming over it. `daemon uninstall`
still **deletes** rather than rotates, and now deletes the grace file too: a rotation leaves two
working credentials, and taking one of them would leave behind exactly the live token P2-9 forbids.

**`daemon status` re-verifies the Windows token entry, which is R-SEC-5's other half.** A mode is
not protection on that platform, so `icacls <path> /inheritance:r /grant:r "<user>:(R,W)"` is — and
one `icacls /inheritance:e`, a restored backup or an installer that resets a tree undoes it while
changing nothing else about the file. The entry is now read back with a plain `icacls <path>`
**query**, and a file carrying a second principal or an `(I)` flag gets a `WARNING —` line naming
what was found and the command that narrows it again.

**And the gap the record left open: the named pipe now carries a security descriptor of its own.**
Microsoft documents what libuv's pipe is born with — "full control to the LocalSystem account,
administrators, and the creator owner … **read access to members of the Everyone group and the
anonymous account**" — so on Windows "filesystem permissions are the authentication" was a claim
about POSIX. `net.Server.listen()` still takes no descriptor and this package still ships no native
addon, but creation was never the only moment available: the daemon opens a handle to its own pipe
asking for `ChangePermissions` and nothing that could read or write it, and replaces the DACL with
one protected `FullControl` entry for its own account's SID — full control because
`FILE_CREATE_PIPE_INSTANCE` is part of it and libuv creates an instance per accepted connection. The
descriptor belongs to the pipe rather than to one instance, which is what makes narrowing it once
enough. Reported and never fatal, exactly as the token's entry is, and `serve`'s line about the IPC
listener says which of the two protections this platform actually got.
