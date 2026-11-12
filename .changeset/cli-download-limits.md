---
"@xplainer/cli": patch
---

`xplainer setup`'s downloader stops a body at the first byte past the size the toolchain manifest
records and discards it, as `checksum-mismatch`, instead of writing an unbounded body to disk and
keeping it as a short download. A `HEAD` that answers outside `2xx` — a `503` from a busy origin —
is no longer read as the artefact's length, so it stops being reported as "a different artefact":
the `GET` decides, and fails as `unreachable` naming its status if it fails the same way. An
archive whose digest matched and that the reader or the provider then refused is deleted from
`.setup/`, rather than left there to be refused again, silently, on the next run.

The toolchain manifest's `version` fields are refused at parse time unless they are one path segment
(letters, digits, `.`, `_`, `+`, `-`, and never `.` or `..`), because each names the directory a
component is installed into. An FFmpeg row whose kept members would land on one name — on each
other, or on the `PROVENANCE.txt` and `.acquired.json` setup writes beside them, in any case — is
refused before anything is fetched.
