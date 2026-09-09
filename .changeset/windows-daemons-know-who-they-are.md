---
"@xplainer/cli": patch
---

Windows reads the whole identity triple, so reconciliation there can decide instead of only doubt.

**The decision existed and the platform did not implement it.** ADR 0024 §A recorded PID is not an
identity makes the identity of a recorded process the triple `(pid, process start time, machine boot
id)`, and only a positive match of it licenses a kill. On Windows the daemon had one member of the
three: `processStartToken()` spawned `ps -o lstart=` on every platform that is not Linux, and
Windows has no `ps`; `machineBootId()` answered `null` outside Linux and macOS. So `selfIdentity()`
was `(pid, null, null)`, every job record and every `owner.lock` written on Windows carried a tuple
with nothing in it to compare, and the consequences ran through the whole daemon: `classifyWorker()`
answered `uncertain` for any live pid, so boot reconciliation could never kill an orphaned worker
and never positively identify a stranger — it quarantined the output directory and set
`workers_uncertain` in both cases; `classifyHolder()` could never tell a live lock holder from a
process that had merely inherited its number, so a stale `owner.lock` naming a reused pid blocked
the daemon until somebody deleted the file; and `startIsProvablyGone()` was `false` for any recorded
start whose pid Windows had since handed out again, which is one of the two things the circuit
breaker needs to latch on a run that died before it could record its own end.

**Both halves now come out of one CIM query.** `Win32_Process.CreationDate` is the start token and
`Win32_OperatingSystem.LastBootUpTime` the boot id, each rendered by `ToFileTimeUtc()` as an exact
64-bit count of 100 ns intervals — an integer rather than a formatted date, so no locale, no time
zone and no output formatter can make two readers of the same process disagree. `selfIdentity()`
asks one `powershell.exe` for both, because the spawn is what either of them costs. `wmic` is
deliberately not used: it is deprecated and absent from current Windows images, so a probe built on
it would answer `null` — "uncertain" — on exactly the machines this is for.

**A probe that cannot run still answers `null`, and `null` is still `uncertain`.** No
`powershell.exe`, a WMI service that will not answer, output that arrived mangled: each of those is
a machine that cannot say, which leaves a live worker alone and quarantines its output rather than
guessing. Nothing changes on macOS or Linux, and the cost discipline the tuple has always had is
unchanged — the probe is read once per acquisition and once per worker at reconciliation, never per
write, and `classifyWorker()` reaches it only for a recorded pid that something is still using.
