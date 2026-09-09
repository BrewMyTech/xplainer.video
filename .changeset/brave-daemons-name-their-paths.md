---
"@xplainer/cli": minor
---

`serve` takes its three settings as flags, records them, and `status --json` reports them.

**`serve` gains `--state-dir`, `--token-file` and `--socket`, each above its environment variable.**
Task Scheduler's `<Exec>` action carries a command, a working directory and arguments and has **no
per-action environment map**, so a daemon that could only be told where its state lives through
`XPLAINER_STATE_DIR` would, once installed on Windows, silently take the platform default while
`daemon.json` recorded something else. The spellings are the launch contract's `SETTING_FLAGS`, and
a test compares the two rather than trusting them to stay in step: an argv the installer writes and
the daemon refuses is the failure this is guarding.

`--token-file` names a **path and never a token value**, so R-SEC-6 — "the unit carries a token
*path*, never a token value" — holds on the argv route exactly as it did on the environment one.
`--socket` has **no variable at all**, because `daemon/ipc.ts` reads none; that absence is why all
three settings travel in argv on every platform rather than only where they must, and it is what
makes a rendered `RuntimeDirectory=xplainer` a directory the daemon actually binds in rather than an
empty one beside it. The `0700` chmod-on-every-start rule follows the flag: the directory narrowed
is the one the socket is really in, which is also the cost of the flag — point it at a directory
dedicated to the socket.

**All three are read back into `daemon.json`**, so what is recorded is what the process used rather
than what somebody intended, and `serve` says on stderr which of flag, variable and default decided
each one.

**`daemon.json` gains the fields the installer and the desktop read**: `socket_path`,
`supervisor_kind`, `supervisor_artefact`, `runtime_dir`, `launch_spec`, `program_source`,
`linger_enabled_by_us`, `log_sink` and `installed_version`. They are typed and parsed rather than
merely preserved, because `status` reports them, the consistency check compares them and `uninstall`
acts on `linger_enabled_by_us` — a field that is only preserved is a field nobody can read without a
cast at every call site. A value outside a closed set, and a half-written `launch_spec`, read back
as `null` rather than as something a later branch would trust. The file now has **two writers split
by field**: `serve` owns what a run establishes, `daemon install` owns what an installation does,
and each preserves the other's keys.

**`xplainer status --json`** writes one object on one line with a **stable condition code** from a
closed set — `ready`, `stalled`, `unauthorized`, `token_absent`, `unhealthy`, `unreachable`,
`absent` — rather than prose a consumer would have to parse. `unauthorized` and `token_absent` are
the same `401` and completely different problems; `absent` and `unreachable` are the same silence
and the difference between an install and an investigation. Contract compatibility is deliberately
**not** a condition: it is a relation between a daemon and the shim asking, so the daemon's
`contract_version` is reported for the caller's own `isContractCompatible()`. The document carries
the token's path and never its value, and the two refusals that happen before a report can exist — a
state file that cannot be read (`11`) and a `--url` that is not an endpoint (`1`) — write a sentence
to stderr and nothing to stdout.

No exit code changed: `status` still exits `0` when the daemon answers and `4` when it does not.
