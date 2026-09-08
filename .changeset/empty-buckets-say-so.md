---
"@xplainer/cli": patch
---

`setup` says why the manifest address is empty, and what still works on this machine.

Nothing is published to `https://cdn.xplainer.video/toolchain/v1/manifest.json` in this phase and no
command in this repository publishes to it: `infra/terraform` creates the R2 bucket and the proxied
`cdn.<zone_name>` record, connecting the bucket to that custom domain and adding its Cache Rule are
manual steps that module deliberately does not manage, neither is scheduled here, and the upload is
the release owner's step in the phase-4 work that builds the per-platform speech bundles. So the
published address answers nothing usable — by design, not by accident.

A refusal that reported only a DNS or HTTP error would send every reader looking for a broken CDN.
`ManifestUnreachable` now carries `deliveryPosition()`: the state of the delivery, and then the
routes that still work on the machine reading the message.

**It is per platform, because the position is.** On macOS and Linux it names the two speech routes
that do work and that never read this manifest — `--tts-url <url>` for a Kokoro-FastAPI server you
already run, and the `docker` route's image pinned by digest — and it says that a browser
acquisition needs a reviewed manifest named with `--manifest`, since only the expected digest comes
from the document. On Windows it says instead that there is **no working speech route at all**:
nothing is published for `bundle` to fetch, the `docker` route needs a linux/amd64 container engine
a Windows host need not have and `windows-latest` does not have, and `--tts-url` records a server
somebody else already runs rather than acquiring one. It names phase 4 — a native speech bundle per
platform, published with the manifest behind the connected custom domain — as the milestone that
closes it, rather than offering a route that will fail.

That asymmetry is roadmap **P2-4**'s, which this change moves to its real status: met on macOS and
Linux, **pending on Windows**. `docs/ROADMAP.md` and `infra/README.md` record the same position, and
`infra/terraform/**` is unchanged — there was nothing to change in it.
