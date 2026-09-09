---
"@xplainer/cli": patch
---

The circuit breaker counts each run's own life, and a Windows worker takes its whole tree with it.

**The breaker could not latch under two of the three supervisors, and now it can.** ADR 0020 words
it as "if the last five runs all failed within 30 seconds of starting", and `isStalled()` inferred
the second half of that from the **next** run's start time. That measures the supervisor's retry
cadence rather than the daemon's own life: launchd's `ThrottleInterval` is 30 s, which sits exactly
on the boundary, and Task Scheduler's `<RestartOnFailure>` has a one-minute schema minimum, which is
outside it — so a daemon crash-looping on a held port was restarted for ever on macOS and Windows.
Each run now records its **own** end. `recentStarts[]` carries an `outcome` (`failed` for a run that
ended without ever announcing itself, `stopped` for one that had) and an `ended_at`, both written by
the run itself as it goes down, and five starts two minutes apart that each die two seconds in now
trip the breaker. `FAILED_START_WINDOW_MS` and `STALL_AFTER_FAILED_STARTS` keep their values and
their meaning.

**A run that wrote no epitaph is governed by a rule that can be evaluated.** A `SIGKILL`, a panic or
a power cut leaves an entry with no outcome and no end. Such a start counts as a failure **only when
the next recorded start began within 30 s of its own `started_at`** — the only sound upper bound on
when it died — and **resets the streak otherwise**, so the breaker under-counts rather than
inventing a failure. Deciding that needs to know the dead process really is gone, and a
pre-readiness death writes no `runtime.json` at all, so `newDaemonStart()` now persists the run's
identity tuple — pid, process start token, machine boot id — beside its start record. A run that
reached readiness resets the streak outright, however it ended afterwards.

**Every interval is validated before it is used.** `started_at` is wall clock, so a backward NTP
correction or a VM resume can invert or shrink a real one; a negative or non-finite difference is
timing-uncertain and resets the streak rather than counting it. The residual is stated rather than
papered over: a backward adjustment that leaves a finite interval between zero and 30 seconds is
indistinguishable from a genuine fast failure and may over-count, and `xplainer daemon restart`
clears the latch it would produce.

**On Windows a worker is now put in a Job Object with kill-on-close.** `process.kill(-pid)` is a
POSIX process-group idiom Node does not implement there, so `process-group.ts` signalled the pid
alone and left every grandchild — an orphaned `chrome.exe` after every logoff, once a phase targets
Windows. Node has no Job Object API and this package ships no native addon, so the handle is held by
a `powershell.exe` keeper started with the worker: it creates the job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigns the worker and any descendant it already had, and then
waits for the worker to exit. Killing the keeper closes the job and takes the tree with it; the
keeper outliving a killed worker closes it a moment later and takes the survivors. A machine with no
`powershell.exe` falls back to `taskkill /T`, which is weaker and documented as such. Nothing
changes on macOS or Linux, where a real process group already did this.
