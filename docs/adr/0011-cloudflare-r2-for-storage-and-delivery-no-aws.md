# 0011. Cloudflare R2 (S3 API) for all storage and delivery, behind a custom domain; no AWS

- Status: accepted — **the hosted render bucket is relocated; the delivery primitive stays**, see [ADR 0023](0023-split-the-repository.md)
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview rounds 9 and 10

> **Relocated in part on 2026-09-06 by [ADR 0023](0023-split-the-repository.md).** The bucket
> this record was written for — hosted render output — moves with the hosted tier to the
> private repository `BrewMyTech/xplainer-hosted`, deferred pending a vendor answer and **not
> cancelled**. The decision below is unchanged and is not rewritten, and the record stays here
> because its reasoning outlived its original subject: **R2 behind a custom domain with a Cache
> Rule is the storage-and-delivery primitive this repository now uses for release artefacts and
> for the first-run downloads of [ADR 0005](0005-download-on-first-run-chrome-headless-shell-and-tts.md).**
> The "an `r2.dev` URL is not cached" argument applies identically, and costs more here: a
> ~110 MB CLI binary or a several-hundred-megabyte TTS model served uncached pays egress on
> every download. The public repository provisions a **separate** bucket for artefacts rather
> than reusing the renders bucket — different lifecycle, different cache policy, immutable and
> publicly readable.

## Context and Problem Statement

Every hosted render produces an MP4 that has to be stored and then delivered to a user, and
often to a share link that outlives the session. Rendered video is the largest artefact this
product moves, and egress is the line item that turns a fixed-cost hosting decision (ADR
0010) back into a variable one if it is chosen carelessly.

Round 9 raised R2 in the context of Remotion Lambda writing output directly to it; round 10
kept R2 and dropped Lambda. "No AWS anywhere" survived as an explicit constraint.

## Decision Drivers

- **Egress cost.** S3 charges for every byte served; R2 charges zero egress. For video
  delivery that is not a rounding difference, it is the difference between a predictable
  bill and an unpredictable one.
- The no-AWS constraint from round 10.
- An S3-compatible API, so the client library is boring and portable and the decision is
  reversible.
- The hosted compute already sits behind Cloudflare DNS (ADR 0010, `infra/terraform/`), so
  one fewer vendor.

## Considered Options

1. **AWS S3 + CloudFront** — the default answer, excluded by the no-AWS constraint and
   expensive on egress for video.
2. **Cloudflare R2** via its S3-compatible API, delivered behind a **custom domain with
   Cache Rules**.
3. **Backblaze B2** with a Cloudflare CDN in front (the Bandwidth Alliance route).
4. **Local disk on the render VM**, served by the VM itself.

## Decision Outcome

Chosen: **option 2 — Cloudflare R2**, accessed with an S3-compatible client (`boto3`) and
delivered from a **custom domain with Cache Rules configured**.

Option 1 is excluded by constraint. Option 3 is a reasonable alternative that adds a second
vendor for no gain once R2's egress is already zero and Cloudflare is already in the stack.
Option 4 was rejected because it couples delivery to a render VM's uptime, bandwidth and
disk, and turns "scale by adding VMs" (ADR 0010) into "figure out which VM has the file".

**The custom domain is not cosmetic and this is the part most likely to be skipped.** R2's
default `r2.dev` URL **does not cache** — serving from it means every view is an origin
request against the bucket. Delivery therefore has to go through a custom domain with Cache
Rules, and that requirement is written into `infra/README.md` as a provisioning step rather
than left as tribal knowledge, because the failure is silent: everything works, and the bill
and the latency are both worse than they should be.

`infra/terraform/` declares the R2 bucket and the `mcp` and `cdn` DNS records with the
Cloudflare provider, alongside the VM and firewall.

## Consequences

- **`boto3` is decided now and installed at roadmap phase 3.** It is deliberately absent
  from `apps/api/pyproject.toml` in this phase: the scaffold stores no objects, and every
  unused dependency adds resolution weight to AC-1, install time to every CI run, and
  pyright-strict surface over code that does not exist. Its absence is a deferral, **not a
  reversal** of this decision, and `docs/ROADMAP.md` phase 3 names it explicitly so nobody
  reads the manifest as a change of mind. ADR 0017 carries the same note for the queue, and
  also inherits this record's Cloudflare account, provider pin and credential handling.
- **An S3-compatible API keeps this reversible.** If R2 ever stops being the right answer,
  the change is an endpoint and a credential, not a rewrite of the upload path.
- **Bucket names, tokens and the account id are Terraform variables**, `sensitive = true`
  with no defaults, so `terraform validate` passes with **no credentials in the
  environment** — which is exactly what AC-12b asserts.
- **The Cloudflare provider renamed and moved resources across its v4 and v5 majors**, so
  `versions.tf` pins the provider with a constraint chosen after checking the actual
  resource name against the pinned version. If `cloudflare_r2_bucket` is unavailable in the
  pinned major, the bucket is documented as a manual provisioning step in `infra/README.md`
  and the VM, firewall and DNS resources stay — recording the gap rather than declaring a
  resource that does not exist.
- **Share links are R2 URLs behind our own domain**, which means link lifetime, expiry and
  revocation are product decisions we still owe (phase 4), not something the storage layer
  answers for us.
