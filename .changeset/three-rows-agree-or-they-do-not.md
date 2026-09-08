---
"@xplainer/cli": minor
---

`/healthz` advertises who is answering, and `daemon status` compares three rows rather than two.

**`GET /healthz` gains `run_id` and `runtime_digest`.** `run_id` is the ownership acquisition's own
`boot_nonce` — a fresh value per run, the same one `recentStarts[]`, `runtime.json` and every job
record's owner already carry — so a stale process is distinguishable from a fresh one. Every existing
field is unchanged, and a server built with no identity (the hosted `services/media-service`) reports
both as `null` rather than omitting them, so the body's shape does not depend on the caller.

**`runtime_digest` is an immutable startup snapshot**, taken once, after ownership is acquired and
before anything binds, over the **effective argv**, the **resolved settings**, the **working
directory** and the staged payload's **content hash**. It is computed from what the process was
actually launched with and **never from `daemon.json`** — a value read back out of the record would
agree with the record by construction, and on macOS that record is the only thing a check could
otherwise compare against.

**`daemon status` compares three things, because two cannot see the failure the check exists for.**
An update rewrites the supervisor artefact and records a new launch spec; if the supervisor never
reloads the definition, the daemon that is answering is still the old one and every file we own says
otherwise. So:

* **desired** — `daemon.json`'s launch spec;
* **loaded** — what the supervisor is actually holding: `systemctl --user show -p ExecStart
  -p Environment -p WorkingDirectory --value` on Linux, all three properties, and `Get-ScheduledTask`
  for the **registered task** on Windows, its working directory included, never the local XML mirror;
* **responding** — the two fields above, advertised by the process that answered.

**macOS has no loaded row, and that is a decision rather than an omission.** The only `launchd`
surface that would answer is `launchctl print`, whose manual says "Do NOT rely on the structure or
information emitted for ANY reason" — and its output interleaves duplicate keys and `state = active`
lines inside the `arguments` block. macOS therefore detects a failed switch through the responding
identity alone, and `daemon status` **names which detector fired**, because "the configuration is
wrong" and "the identity is wrong" are different sentences and only one of them is available there.

`daemon status --json` gains an additive `identity` object and two additive `health` fields; the
condition set, the exit codes and every existing field are unchanged. The Windows loaded-configuration
query now composes three `Key=value` lines itself instead of going through `Format-List`, which wraps
a long value across lines — and an installed `Arguments` is two absolute paths and six flags long.

`pnpm e2e:identity` runs the whole of it: the comparison on all three platforms, a real `xplainer
serve` whose advertised digest is recomputed from its own launch, and the four drift scenarios
against this machine's real service manager.
