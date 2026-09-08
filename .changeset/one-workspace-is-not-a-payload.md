---
"@xplainer/cli": patch
---

`daemon update` stops refusing every workspace `setup` has ever produced.

`runtime verify` re-hashed both payloads with one rule — "the tree holds the manifest and nothing
else" — and `daemon update`'s pre-drain check runs that rule over the **live render workspace**. A
workspace's manifest describes `node_modules/`, `package.json` and `package-lock.json` and
deliberately nothing else, while `setup` also copies in `remotion.config.ts`, `tailwind.css` and
`tsconfig.json`, and `videos/`, `out/`, `public/`, `.remotion/` and Remotion's
`node_modules/.cache/` arrive around them. Every one of those was reported as a file "in the payload
and not in the manifest", so `xplainer daemon update` exited `3` on every machine that had run
`xplainer setup` — before anything was staged, and with no way for a user to get past it.

Verification now takes an explicit mode per payload rather than a single rule:

- **Payload 1, the runtime, is unchanged and stays exhaustive.** Nothing but `runtime build` and
  `install stage` writes inside a runtime payload, so a file that appeared in one is an integrity
  failure whatever it is called.
- **Payload 2, the workspace, is checked as *described*.** Every file the manifest names must be
  present with its recorded size and digest — that is what proves the pins the check exists for —
  and a file the manifest does not describe is allowed *unless it shadows a described one*: a
  package copy nested under the described `node_modules/` whose name that tree also carries at the
  top level. Node resolves the nearest `node_modules` first, so such a copy is the version a render
  would load while the manifest still records the pinned one, which is the one way an extra file can
  make the pin comparison a lie. It is reported as a new `shadowed` reason, by the package it
  shadows.

`daemon status` also stops polling `/healthz` through the platform's `fetch`. Node's bundled undici
calls `socket.setTypeOfService()` on every request it writes and `node:net` reports a failed
`setsockopt` by *throwing* — from inside the socket's own event handler, so `EINVAL` on a pooled
socket the daemon has torn down between two asks is an uncaught exception that no `try`/`catch`
around the call can see. The probe now uses the same unpooled `node:http` client the install's
readiness poll already used, one connection per ask.
