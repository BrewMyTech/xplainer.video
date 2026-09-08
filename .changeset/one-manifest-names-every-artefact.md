---
"@xplainer/cli": minor
---

The toolchain manifest, and a downloader that resumes, verifies and commits whole.

[ADR 0005](docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md) books "a CDN and a
version/checksum manifest" as infrastructure rather than an afterthought, and requires that "the
download path has to verify the checksum before extracting". `apps/cli/src/setup/` is that manifest,
that download, and the archive reader between them. Nothing calls it yet — `xplainer setup` is still
a stub, and the three providers that use this are the next story — but the document and the
transport are settled here.

**The manifest is fetched from the one hostname Terraform provisions.**
`https://cdn.<zone_name>/toolchain/v1/manifest.json`, where `infra/terraform/main.tf` declares
`cdn_hostname = "cdn.${var.zone_name}"` as a **proxied** CNAME onto the R2 bucket. The bucket's own
`r2.dev` URL is refused by name, on that file's own argument: it "is explicitly not cached by
Cloudflare, so serving a ~110 MB CLI binary or a several-hundred-megabyte voice pack from it would
pay origin egress on every single download". A speech bundle recorded against any other host is
refused when the manifest is parsed.

**The expected Chrome digest is selected by the exact URL the pinned Remotion line resolves, not by
an `<os>-<arch>` key.** `@remotion/renderer`'s own `getChromeDownloadUrl` branches on Amazon Linux
2023, on `chromeMode` and on whether the host's glibc is at least 2.35 — so `linux-x64` alone
resolves to three different artefacts, and a key that ignores the C library selects one that
installs and cannot run, which is what ADR 0020's "Alpine is blocked on rendering, not on init"
costs. `manifest.ts` mirrors that selector branch for branch, its suite drives the **real** function
over all 80 combinations and compares, and the manifest is then searched for the entry carrying that
URL. Two properties fall out: the manifest cannot redirect a download, because the URL fetched is
the selector's rather than the document's, and a configuration with no recorded entry is a refusal
naming the URL rather than a download of unreviewed bytes.

**Digests are expected, never recorded.** `sha256` is a required input to the download, captured
when the manifest was built and reviewed like any other pinned input; nothing in this code writes a
manifest or takes a digest from the bytes that arrived. A digest recorded on first acquisition
cannot reject an incorrect-but-intact archive — it only detects later drift.

**The committed manifest carries eight platform entries with real digests, and says so where it
carries none.** The ninth configuration — arm64 Linux below glibc 2.35 and not Amazon Linux —
resolves to a Playwright build whose CDN answers `400 GatewayExceptionResponse` through its own
redirect (measured 2026-09-08), so it is recorded as unavailable with that measurement and the
remedy, rather than left as a hole. The four speech platforms are recorded the same way, because
nothing is published to the CDN in this phase and the two routes that do exist are the pinned Docker
image and `--tts-url`.

**Every failure has a name.** `short-body` keeps the partial, so the next run resumes it;
`checksum-mismatch` deletes it, so a wrong body is never resumed onto; `resume-not-honoured` refuses
a `206` that answers a different range than the one asked for, because appending it produces a file
of the right length and the wrong contents; and `proxy-interception` names a `407`, an HTML filter
page — quoted back — or a TLS handshake that never reached the origin. That last one is ADR 0005's
own acceptance condition: "a download that fails behind a corporate proxy must say so, not produce a
render that fails later with a missing-binary error."

**It speaks `node:http` rather than `fetch`, on a measurement.** On Node 24 a `407` never reaches a
`fetch` caller at all — undici turns it into a network error whose `cause` is an empty `Error` with
no `code` — so the branch naming the likeliest corporate-proxy response would have been dead code.
The artefact URLs also redirect, and a redirect that leaves `https` is refused rather than followed.

**The commit is a `rename` of a staging directory beside the destination**, so a half-unpacked
toolchain is never visible under the name a later `setup`, an install preflight or a render will
look for — the argument `install/stage.ts` makes for a payload, applied to an archive.

The zip reader is written here rather than taken as a dependency: a new runtime dependency of this
package is a change to payload 1, to the publish contract and to every installer. It reads the
central directory, checks each member's CRC-32, preserves modes and symlinks the way Remotion's own
extractor does, and refuses every entry that would write outside the directory it is unpacked into.
