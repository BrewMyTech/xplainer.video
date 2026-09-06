# 0019. Sequencing: the local CLI tier ships before the hosted tier

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: an **external architecture review** (Codex, 2026-09-05, artefact at
  [`.omc/artifacts/ask/codex-you-are-giving-an-outside-critical-architecture-review-of-th-2026-09-05T08-54-11-831Z.md`](../../.omc/artifacts/ask/codex-you-are-giving-an-outside-critical-architecture-review-of-th-2026-09-05T08-54-11-831Z.md))
  that recommended reversing the roadmap's ordering, and the owner's decision to decline the
  reversal.
- Builds on: **ADR 0016**, which decided *which process* owns the local runtime. This record
  decides *when that runtime ships relative to the hosted tier* — a question 0016 does not
  answer and does not contain.

## Context and Problem Statement

An external architecture review of the scaffold recommended changing the order in which this
product is built. The recommendation deserves to be recorded at the strength it was made,
and at the strength it *could* have been made, because the ordering it attacked has never
actually been argued anywhere in this repository.

Three facts frame the decision.

**First, the roadmap already leads with local.** [`docs/ROADMAP.md`](../ROADMAP.md) has, and
has had since the scaffold, five phases in this order: "Phase 1 — Local walking skeleton",
"Phase 2 — Desktop GUI + first-run downloads", "Phase 3 — Hosted skeleton", "Phase 4 —
Commercial", "Phase 5 — Open-source extraction". The same order is committed in
[`.omc/specs/deep-interview-xplainer-monorepo-init.md`](../../.omc/specs/deep-interview-xplainer-monorepo-init.md)
§Roadmap. **This record therefore changes no file and reverses nothing.** It is a refusal to
reverse, and it exists because a refusal with no written argument is indistinguishable, six
months from now, from not having read the review.

**Second, the ordering was never argued.** ADR 0016 chose CLI-first on installability and
contract-unity drivers — "**Linux VM installability.** This is the driver the user gave, and
it is the one that decides: the local stack has to run with no desktop environment present",
and "One implementation of the tool contract across local and hosted". Nothing in 0016
mentions audience, buyer, demand or phase ordering. The owner's actual reason for keeping
this order — *the initial audience is coding users, who will be free users that download and
run locally* — appears in no record. Without this one, the strongest reason for the sequence
exists only in a conversation, and the next reviewer re-opens the argument with the same
evidence and no reply waiting for them.

**Third, the review said something narrower than "lead with hosted", and the narrower thing
is still live.** At source it says: "I would reverse the roadmap's desktop-before-hosted
ordering. Three-OS TTS distribution is a substantial investment before testing demand. ADR
0005's downloads decouple releases; they do not eliminate building, testing and supporting
those binaries." It also says "Keep [ADR 0016]. Moving rendering into Electron would not
solve onboarding or authoring", and, for the engineer buyer, "launch a narrow plugin-driven
pilot and defer the full desktop application." That is *Phase 1 kept, Phase 2 deferred* —
not *Phase 1 replaced*. It also raises an audience flag that is correct on the evidence:
"the shipped skill explicitly targets bugs, root causes, architecture decisions and diffs.
That describes an engineering communication tool."

So there are two distinct questions, and this record answers only one of them. See
[§What this record does not decide](#what-this-record-does-not-decide).

## Decision Drivers

The decisive driver is a distinction the review's cost argument does not make, and it is the
substance of this record: **several of the review's own top risks do not move under
local-first, they stop existing.** Others do merely move. Recording them in one list would
be dishonest in both directions — it would overclaim the cheapness of local-first and
understate what hosted-first would have bought.

Three categories, not two:

- **Dissolved** — no code, no phase, ever, on the local path. The requirement is absent
  because the condition that creates it is absent.
- **Dissolved as a precondition, deferred as a body of work** — the work still lands at
  Phase 3, but it is not standing between this codebase and its first rendered MP4. This is
  the category the cost argument turns on and the one most easily blurred.
- **Deferred** — the same work, later, unchanged in size. Local-first buys nothing here and
  claiming otherwise is how a decision record becomes useless.

### Dissolved

| Risk, as our own records state it | Why it does not exist locally |
|---|---|
| "Hosted rendering has to execute **untrusted TypeScript** … That is arbitrary code execution by design, and it is the security-defining property of the hosted tier" (ADR 0010) | The agent writing the TSX is the user's own agent, running under the user's own uid, on a machine where Claude Code or Codex already writes and executes files. Rendering their output confers no privilege they did not hold. No ephemeral child container, no `--network none` cutover after asset staging, no read-only rootfs, no "gVisor (`runsc`) … **if the chosen VM image supports it**" provisioning question, no `--no-sandbox` temptation. P3-4 has no local analogue to fail. |
| Identity, quota, billing: "`Account`, `Plan` and `Quota` are core hosted entities and gate the remote MCP tools" (ADR 0014); "OAuth 2.1 is on the critical path for the hosted tier, not an add-on for paid plans" (ADR 0014) | There is no server to authorise against and no metered compute to cap. `apps/cli/src/server.ts` binds `DEFAULT_HOSTNAME = "127.0.0.1"` — "Loopback only: this is a local daemon" — and ADR 0016 records "The daemon has no authentication and binds localhost." `xplainer connect claude` writing a config file is the entire local auth story. |
| "**Share links are R2 URLs behind our own domain**, which means link lifetime, expiry and revocation are product decisions we still owe (phase 4)" (ADR 0011) | A local render produces a file path. There is no link, so there is no link policy, no bucket, no custom domain with Cache Rules, no retention question and no answer owed to a customer's security team. |
| Source egress. `explainer_put_source(slug, files)` and `explainer_put_media(slug, name, base64)` are, on the hosted path, an upload of the customer's code and screenshots of their internal tooling | The local backend returns `write_source_to` and the agent writes to the user's own disk. SKILL.md's workflow is explicit about what gets uploaded — "Read the code, the diff, the logs", "the excerpt held still, with emphasis moving to the line under discussion", "If the caller handed you screenshots, recordings, or diagrams, use them". None of it leaves the machine. The class of objection — DPA, source-egress policy, security review — does not arise rather than being answered. |
| Fixed monthly cost before the first user: Remotion's "$100/month floor at 4+" personnel (`docs/open-questions-resolution.md`), Workers Paid's "$5/month account minimum … effectively required" (ADR 0017), and "roughly €15–40/month for 4–8 vCPU" (ADR 0010) | ADR 0005's local artefacts are "downloaded on first run, from a CDN" — one fetch per user, then zero. A free local user costs a tarball. |
| "Postgres *and* `api.cloudflare.com` are both on the critical path, and a local in-process dependency has become a remote one" (ADR 0017) | One process on one machine. No second system to be unavailable, no per-user request ceiling that "would take down the agent's enqueue path and the workers' ack path at the same time", no 128 KB message limit that agent-authored TSX would exceed. |
| "**No documented local emulator for the pull/ack REST endpoints** … This is a daily friction tax on every developer, forever" (ADR 0017) | There is no queue to emulate. |

### Dissolved as a precondition, deferred as a body of work

The hosted queue's correctness scaffolding is real and it is coming at Phase 3. What
local-first buys is that **none of it stands between this repository and its first rendered
MP4.** ADR 0017 itemises the bill against itself: "Transactional enqueue is gone. This
directly reverses ADR 0012's central claim"; an outbox relay, a status-guarded claim, a
heartbeat and reaper because "There is no lease extension. This is the sharpest constraint
in the whole adoption"; a DLQ drain; a compensating quota refund keyed on `job_id`; a
`visibility_timeout` override because "The 30-second default will silently double-render
every job if it is not overridden". Priced by the ADR at "**roughly two developer-days that
Procrastinate gave for free**, plus a permanently larger debugging surface — a stuck job can
now be stuck in Postgres, in the relay, in Queues, or in the DLQ."

Phase 1's entire durability requirement is P1-5: "`explainer_job` reports `queued → running →
done` for a real render, and `output_lines` bounds the returned log tail." The same applies
to the ephemeral render sandbox and to R2 provisioning: deferred as work, absent as a
gate.

The reason this matters is diagnostic, not budgetary. The product rests on one mechanic —
P1-2, "`timings.json` is computed from word-level TTS timestamps, and every scene duration in
the rendered video derives from it. No hand-written durations anywhere." When that mechanic
first comes out drifting or silent, local-first debugs it with a file on disk that a human
can open. Hosted-first debugs it by polling `output_lines` out of a job row, through an MCP
call, through a relay, through a queue, in a `--network none` container on a VM whose
renders-per-vCPU is, by ADR 0010's own admission, "unmeasured".

### Deferred, and honestly so

- **The three-OS distribution tax.** ROADMAP Phase 2 owns `xplainer setup`'s checksummed
  resumable downloads per OS, the per-OS SEA binaries, the `asarUnpack` fix and P2-7's
  unsigned installers on three runners; Phase 4 owns signing and notarisation.
  `apps/cli/packaging/README.md` states the sharp edges — "**Nothing in this directory runs
  in CI, in this phase or by accident**", "roughly 110 MB before compression", "**each
  target must be built on that target's OS and CPU**", and a known unfixed defect where
  `xplainer --version` "throws unless a manifest happens to sit there". The review is right
  that this is a substantial investment. Local-first postpones it; it does not avoid it.
  What is worth stating precisely is that this cost is **not in Phase 1**: P1-1 names "a
  headless Linux VM **and** on macOS" — two targets, no Windows — and P1-3 is "Kokoro runs
  as a Docker container", so there is no per-OS TTS packaging in Phase 1 at all.
- **The Remotion `put_source` permission question.** ADR 0015 is the repository's only
  non-`accepted` record, and its addendum calls open question 2 "an *existence* question for
  the hosted tier". Local-first keeps it off the critical path; it does not answer it, and
  the addendum's instruction stands regardless of ordering: "The vendor email should go out
  now."
- **Willingness to pay, unit economics, and renders-per-vCPU.** All three are Phase 3 or
  Phase 4 measurements under this ordering. See §Accepted costs.
- **Marketplace discovery.** ADR 0013 puts submission at Phase 4 in either ordering.

## Considered Options

1. **Keep local-CLI-first** — Phase 1 as written, hosted at Phase 3.
2. **Hosted-first**, in its strongest available form.
3. **Local-first, with Phase 2 and Phase 3 swapped** — the external review's literal
   recommendation.

### Option 2, argued at full strength

The weak version of this option is "test demand before investing", which is generic and
easy to dismiss. The strong version is not, and it should be read before the decision is
trusted.

The strong version does **not** reverse ADR 0016. It keeps CLI-first as the architecture —
`services/media-service/package.json` declares `"@xplainer/cli": "workspace:*"` and
`services/media-service/src/app.ts` opens "**This service does not build a server of its
own.** It calls `createServer()` from `@xplainer/cli`" — and reverses only the *phase order
and Phase 1's target environment*. Concretely: narrow Phase 1 from "on a headless Linux VM
**and** on macOS, with Kokoro in Docker" to *renders inside `services/media-service`'s own
image* — one target, `node:24-bookworm-slim`, already built and probed by
`.github/workflows/ci.yml`'s `images` job. Then promote Phase 3 to Phase 2, promote Phase 4
to Phase 3, and demote the desktop client and per-OS distribution to Phase 4, where it
becomes a conversion feature for users who exist rather than a distribution bet placed
before anyone has asked for the product.

Its five best arguments:

1. **The feedback loop, not the effort, is the asymmetry.** Both orderings cost roughly the
   same number of acceptance criteria. But every Phase 3 item runs on one box we own and is
   fixed by a redeploy; every Phase 2 item runs on a machine we will never see and is fixed
   only by a release the user must choose to install. Ordering by *which failures can I
   still fix* gives hosted-first.
2. **The local tier is structurally unobservable, and we have no instrumentation decision.**
   A repository-wide grep for `posthog|amplitude|mixpanel|sentry|analytics|telemetry` returns
   no product telemetry anywhere — only Remotion's own mandatory telemetry and transitive
   lockfile entries. Yet ADR 0014 names the metric that would re-open it: "conversion from
   install to first render is the number that would re-open this ADR." Under local-first that
   number does not exist until Phase 3 at the earliest. Render volume, per-content failure
   rate, retry counts and iteration depth are invisible by construction; npm downloads
   measure curiosity, not use. From Remotion 5.0, telemetry is mandatory and sends an event
   per render — the vendor will have a better picture of our local render volume than we do.
3. **Heterogeneous machines produce a failure mode that is silent.**
   `services/media-service/Dockerfile` installs the font packages deliberately, and ADR 0010
   states the consequence: "**Fonts must be installed in the image** (`fonts-liberation`,
   `fonts-noto-color-emoji`); without them text renders blank and the failure looks like a
   bug in the user's scene." That render succeeds, exits 0, and produces an MP4 with
   invisible text. There is no error and no stack trace, and we have neither the user's
   machine nor any telemetry. In an image we own, ADR 0010 notes the same class of problem
   becomes "a red build rather than a failed first render".
4. **The free local tier is the paid tier's competitor, and it was designed to win.** ADR
   0014: "the local tier is free and unlimited, but it needs installation, and the hosted
   tier's whole value is that it does not." SKILL.md instructs the agent: "**Prefer the
   local tools when they are present.** … it renders on the machine the user is already
   sitting at, **it has no quota**". Once a developer has paid the install cost, that cost is
   sunk, and what remains to sell them is a share link. If a free local tier is right, it is
   arguably right *after* the paid product exists and has known unit economics, rather than
   as the thing that sets the market's expectation of the price.
5. **The deliverable this audience needs is a link, and only hosted produces one.** SKILL.md
   describes the use as "when a fix is subtle enough that **the team** will understand it
   faster from ninety seconds of animation than from a diff" — a PR, a Slack thread, an
   incident review. Local-first ends at "report the output path or URL" with a file in a
   build directory the user must upload themselves. The review's audience flag is correct
   and it cuts this way too: an engineering-communication artifact has to be sendable. And
   the one distribution artifact this repository can publish today is a hosted client —
   `packages/skill/claude-plugin/.mcp.json` and `codex-plugin/.mcp.json` declare exactly one
   server, `https://mcp.xplainer.video/mcp`, with no local entry, so during Phases 1–2
   anyone who installs the bundle reaches a dead endpoint.

**What option 2 would have avoided, specifically:** seven Phase 2 acceptance criteria of
pure per-OS distribution with zero CI coverage by explicit decision and zero capability
hosted also needs; four SEA binary targets at ~110 MB each, plus the two defects already
documented as known and unfixed (the `--version` manifest bug and ADR 0016's `asarUnpack`
child-spawn failure); ADR 0005's "**Two acquisition paths for one binary**" collapsing to
one, making version drift against the pinned `remotion@4.0.495` template structurally
impossible; the whole download-on-first-run apparatus, including the CDN, checksums,
resumability and "a download that fails behind a corporate proxy must say so"; the blank-text
and tofu-emoji failure classes becoming build failures instead of unreproducible tickets;
and — the sharpest one — the Remotion §End-user code access exposure, where
`docs/open-questions-resolution.md` concludes "**every local-tier customer with 4+ people
needs their own Remotion Company License**" and notes "a customer who receives only an MP4 is
protected; a customer whose machine holds an editable Remotion codebase is not." On the
hosted path the licence key and development-render flag are threaded through
`services/media-service` and redeployed in an afternoon; ADR 0015's addendum says the local
alternative is "a full release to retrofit into a shipped daemon on end users' machines."

Option 2 was **rejected**, not refuted. Its strongest points — unobservability, the silent
font failure, and the competitor-not-funnel argument — survive this decision intact and
reappear below as accepted costs and kill criteria.

### Option 3

The review's literal recommendation: keep Phase 1, swap Phase 2 and Phase 3. It is not
decided here, in either direction. See §What this record does not decide.

## Decision Outcome

Chosen: **option 1 — the local CLI tier ships first; the hosted tier follows at Phase 3.**
`docs/ROADMAP.md` already encodes this order and is left unchanged; manufacturing a diff to
make a decision look like an action would misrepresent what happened.

The owner's stated reasoning, recorded as given: **the initial audience is coding users, who
will be free users that download and run locally, so the CLI is the right first surface.**

That reasoning is consistent with the one artifact in the repository that addresses an
audience at all. SKILL.md is written for engineers by its own text — "People understand a bug
when they watch the wrong thing happen"; "a race or an ordering bug | two lanes against one
clock, drifting out of order"; "**Spell out symbols.** 'the agent underscore id field', not
`agent_id`". That population already has Node and Docker, which are exactly Phase 1's two
prerequisites (P1-1, P1-3). Hosted's advantage over local is "nothing to install", which is
worth least to precisely this audience; hosted's costs — an account (ADR 0014), a daily
quota, and uploading employer source — bind hardest on precisely this audience.

Two supporting facts carried the decision beyond that reasoning:

- **Local-first front-loads the shared code and defers the non-transferable code, and this
  is verifiable rather than asserted.** Phase 1 builds the `narrate.py` port into
  `packages/render-core/src/narrate/`, the real `RenderBackend`, the stdio MCP transport and
  the job runner — all in `open-later` packages that `services/media-service` already
  imports today through `createServer()`. Its only non-transferable deliverables are
  `xplainer connect claude` and a loopback bind. Phase 3 builds the OAuth resource server,
  the outbox relay, the DLQ drain, the reaper, the sandbox and the R2/Queues provisioning —
  none of which a local user ever touches. Hosted-first is the ordering that spends its first
  budget on the half of the codebase that does not transfer.
- **The reversal costs differ in kind.** Local → hosted is a new `RenderBackend` behind an
  existing interface. Hosted → local means removing auth from the tool boundary, taking the
  render out of the container, taking the job out of Cloudflare and re-deriving a local
  runner while keeping tool names and schemas identical — which ADR 0016 identifies as
  exactly the promise a second implementation breaks.

**ADR 0014 does not apply to local rendering, and this record says so plainly.** Its own text
already scopes it — the title is "The hosted free tier requires sign-in", and its consequence
reads "the local tier has none of them and stays free and unlimited" — but under this
ordering the first product anyone meets is unlimited, account-free and runs on their own
hardware, which is the opposite shape of "one video per day behind sign-in". A dated
clarifying note has been added to ADR 0014 pointing here; the accepted record was not
rewritten. The positioning currently has no home in any customer-facing file: `README.md`
contains zero occurrences of "free", `apps/web/src/lib/site.ts` carries only name, tagline,
`mcpUrl` and `docsUrl`, and ROADMAP Phase 4's headline says "quotas (1/day free)" without
scoping "free" to hosted. Anyone writing Phase 1 copy has no source of truth to copy from,
which is how the hosted 1/day number leaks into local marketing and makes the free product
look worse than it is.

## Consequences

### Gains

- **The product's single non-negotiable mechanic is proved in the cheapest place in the
  plan.** P1-2 — every scene duration derived from word-level TTS timestamps — is tested in
  an environment where a human can open `timings.json` and look at it.
- **Everything in §Dissolved above is genuinely absent from the first shipping phase**: the
  untrusted-code sandbox, `Account`/`Plan`/`Quota`, OAuth, share-link policy, source egress,
  the second system on the critical path, and the queue emulator gap.
- **No fixed monthly spend starts.** Roughly $105–145/month of Remotion floor, Workers Paid
  minimum and VM rent begins when there is a reason for it, not before. Related: the Remotion
  addendum's warning that internal and CI renders "count toward chargeable Server Renders …
  unless they are classified as development renders" does not make our own development loop
  billable yet.
- **The Remotion licensing gate stops being a launch blocker.** ADR 0015 is `proposed —
  pending vendor confirmation` and ROADMAP P3-7 requires the vendor's answer before Phase 3
  ships. This ordering buys calendar time for that answer with no code waiting on it.
- **The two-implementations risk ADR 0016 was written to kill is exercised early.** Phase 1
  drives `createServer()`, `createMcpServer()` and the protocol manifest end to end, so the
  hosted image at Phase 3 inherits a proven code path rather than a stub. Under hosted-first,
  `apps/cli` would be the untested half of a shared core for two phases.
- **Demand signal is bought at zero marginal cost**, from the population that can diagnose
  its own failures and file a usable bug report.

### Accepted costs

- **Willingness to pay stays invisible for two phases, and this is the largest cost.**
  Stripe, plans and quotas are Phase 4, behind hosted at Phase 3. The first dollar is three
  judged phases away, and Phases 1–2 ship a product whose entire user base is free by design.
  We will not learn what anyone will pay, what a plan should contain, or where the price
  breaks. Every pricing decision made at Phase 4 will be made on inference, not observation.
- **Unit economics stay unmeasured.** ADR 0010: "**Renders-per-vCPU is unmeasured.** Sizing
  is a phase-3 measurement on a real VM, not a guess recorded here." Local-first defers that
  discovery indefinitely because users supply the CPU, so we also will not know whether the
  free hosted tier is affordable until we are building it.
- **We ship blind.** There is no telemetry or crash-reporting decision anywhere in this
  repository. As currently specified, local-first cannot measure install-to-first-render —
  which is the exact number ADR 0014 nominates as its own falsifier. The corollary is
  actionable: if this ordering stands, instrumentation is Phase 1 work, not later.
- **Support cost per local user is unbounded and unreproducible.** Every Chrome build, font
  set, glibc version, Docker daemon, corporate proxy and codec on a user's machine is ours to
  debug from a report we cannot reproduce, and the worst instance is silent — a successful
  render with invisible text. Hosted has one environment and full logs.
- **We build our own best competitor first.** A free, unlimited, no-account, no-upload local
  tier gives a coding user little reason to reach the hosted tier, whose only differentiator
  over it is the thing that audience needs least. SKILL.md actively instructs their agent to
  prefer local.
- **The discovery channel points at hosted and will be dead for two phases.** Both plugin
  bundles declare only `https://mcp.xplainer.video/mcp`. Anyone who installs one before
  Phase 3 gets a connection failure. During Phases 1–2 the real distribution channel is
  `npx xplainer` plus `xplainer connect`, which is a materially narrower top of funnel than a
  marketplace listing, and the listing is delayed by two phases. The shipped bundle's two
  halves also disagree today: SKILL.md says "Prefer the local tools when they are present"
  while the `.mcp.json` beside it registers only the hosted server.
- **The Remotion licence-key seam gets harder, by our own record.** Shipping a daemon to an
  installed base we do not control, before the key and development-render seams exist, turns
  a cheap change into a coordinated upgrade — "a full release to retrofit into a shipped
  daemon on end users' machines" (ADR 0015 addendum). The §End-user code access exposure —
  "every local-tier customer with 4+ people needs their own Remotion Company License" — lands
  on the tier we are shipping first, and ADR 0013's listings inherit a disclosure item for it.
- **The demand signal is cheap but biased.** Engineers who will run `npx xplainer` and
  `docker run` a Kokoro image are the users most tolerant of a rough tool and most able to
  work around its failures. A positive signal from that population systematically
  over-predicts what a general audience would tolerate. The review's core objection — that
  nothing here is yet evidence that anyone wants explainer videos — is not answered by this
  ordering, only made cheaper to ask.
- **The three-OS tax lands before any revenue**, and ADR 0005's "Two acquisition paths for
  one binary … can drift on version" runs on the drift-prone path first and for longest.

## Kill criteria

Reverse or re-sequence if any of the following is observed. These are the record's
falsifiers; a decision with none is a belief.

1. **P1-1 does not hold cheaply.** If `npx xplainer` plus a Docker Kokoro container to a
   finished 1920×1080 MP4 on both macOS and a headless Linux VM takes materially longer than
   a few weeks — because Chrome Headless Shell, fonts, codecs or the TTS container behave
   differently per OS — then "local distribution is light" is false and the review's cost
   estimate was right, applied one phase earlier than it claimed.
2. **Install-to-first-render is low.** Instrument it in Phase 1 (see §Accepted costs). If a
   large share of `npx xplainer` runs never reach a completed render because setup, Docker or
   the download path failed, the free local user is not free: we are paying in engineer hours
   per user instead of vCPU-minutes, and the cost-of-serving argument inverts. The specific
   suspect is P1-3: if the median coding user must install Docker first, local onboarding is
   no better than the option ADR 0005 already rejected.
3. **Inbound demand asks for a link, not a binary.** If the first unsolicited requests are
   "can I just use it in the cloud" or "send me a URL", or arrive from non-engineers, the
   audience premise behind this ordering is wrong and the hosted tier is the product.
4. **The privacy constraint does not bind.** If early users at companies with a security
   review happily send internal source to a hosted endpoint, or ask for hosted specifically,
   the source-egress argument was a rationalisation rather than a purchase blocker, and
   hosted's distribution advantage is unopposed. The converse also kills: three or more
   design partners refusing hosted on data-egress grounds means the local daemon is the
   product, not the free tier.
5. **Active local users convert at ~0%.** If a cohort that renders regularly on the local
   tier shows no paid intent when hosted arrives, local-first built a free competitor with no
   wedge, and two phases bought usage that can never become revenue.
6. **The render core stops being shared.** Concrete tripwire:
   `services/media-service/src/app.ts` ceasing to call `createServer()` from `@xplainer/cli`,
   or local-only concerns leaking into `packages/mcp-server`. The reuse claim is the
   load-bearing half of this decision; if it fails, local-first is a detour rather than a
   prefix.
7. **Remotion answers that end-user-machine renders are chargeable**, or that local and
   hosted are two licensed use cases — ADR 0015 open question 3 is currently the local tier's
   strongest quote, and open question 4 notes "If two, that is a second $100 floor." Either
   answer removes the fixed-cost asymmetry that makes this ordering cheap.
8. **Local render latency or reliability on typical laptops is materially worse than on a
   4–8 vCPU VM.** Local rendering is CPU-bound minutes on the same machine the agent is
   running on; if the local experience is the weaker product, hosted should lead.
9. **Support load per local user exceeds hosted's marginal render cost.** If the median local
   user costs more than a few minutes of engineer attention, serving free users on hardware
   we control and can observe is cheaper — the exact inversion of this record's cost
   argument.

One signal is not a kill criterion but weakens this record and should be noted when it
arrives: **if Remotion approves `put_source` promptly and unconditionally**, the largest
non-technical risk to hosted-first disappears and the case for deferring hosted narrows to a
cost argument alone.

## What this record does not decide

- **The roadmap is unchanged.** It already leads with local; no diff was manufactured.
- **Whether Phase 2 and Phase 3 should swap is still open.** That — not "lead with hosted" —
  is the external review's literal recommendation: "I would reverse the roadmap's
  desktop-before-hosted ordering", alongside "launch a narrow plugin-driven pilot and defer
  the full desktop application." The owner's stated reasoning does not settle it, and if
  anything argues *for* the swap: "coding users download and run locally" is an argument for
  Phase 1's CLI and against Phase 2's Electron GUI, `xplainer setup` downloads, SEA binaries
  and three-runner installers. Keeping Phase 2 where it is needs its own justification and
  none is on record. This is the live question left after this decision.
- **The audience question.** The review's flag is correct: SKILL.md is an
  engineering-communication tool by its own text, while the engine under it carries no domain
  assumption at all — "Nothing about what a scene may contain is constrained: a scene is
  ordinary React and you can draw anything", and `packages/protocol`'s eight tools are
  domain-neutral. Widening the audience is not an edit, because ADR 0013's first driver is
  "One SKILL.md. The craft guidance is the product's differentiator and must not fork." A
  second, general-audience skill therefore requires amending 0013. That is a separate
  decision.
- **ADR 0014 is not reopened**, only scoped. Its dated note points here.

## Note, 2026-09-06: one row of the Dissolved table is narrowed by ADR 0020

[ADR 0020](0020-always-running-local-daemon.md) makes the local runtime an installed,
supervised, always-running per-user daemon, at the owner's request. That changes the premise
of one row above and the row is narrowed rather than left to be read as written.

The first Dissolved row justifies itself with: "The agent writing the TSX is the user's own
agent, running under the user's own uid, on a machine where Claude Code or Codex already
writes and executes files. Rendering their output confers no privilege they did not hold."

That holds for the **stdio and IPC transports**, where the caller is provably a local process
the user's own uid can already reach, and it is why ADR 0020 makes `xplainer connect` write a
stdio entry by default. It does **not** hold for the **TCP transport** once the daemon is
permanently listening on loopback: the caller may then be a web page the user visited, reaching
`127.0.0.1` through DNS rebinding — the MCP specification names this attack against local
servers directly. The TSX is then written and executed under the user's uid on behalf of
somebody who is not the user's agent, which is the condition this row says is absent.

So the row stays Dissolved for the transport agents actually use, and ADR 0020 carries the
loopback bind, the `Host` and `Origin` allowlists and the local bearer token as acceptance
requirements of the TCP transport. Nothing about the *sequencing* decision this record makes
is affected — local still ships first — and nothing above is rewritten. The second Dissolved
row's supporting quote from ADR 0016, "The daemon has no authentication and binds localhost",
is amended by ADR 0020; ADR 0016 carries its own dated note saying so.

## Note, 2026-09-06: sequencing became a split, and two cited documents relocated

Added as a dated note rather than a rewrite. This record's decision — the local CLI tier ships
before the hosted tier — is unchanged, and [ADR 0023](0023-split-the-repository.md) is its
strongest form rather than a departure from it: the two tiers no longer share a repository, and
the local tier ships from this one.

One thing this record could not have known is now known: the reason the ordering held is not
only the one argued below. **The hosted tier is blocked on a written answer from a vendor**,
not on engineering sequencing. ADR 0023 records that the hosted tier is deferred pending that
answer and is **not cancelled**, and that reversing the split is restoring directories rather
than reconstructing anything.

Several things this record cites are no longer resolvable from this repository. Every citation
in the body above is left exactly as written, and this list is where each one resolves:

- `docs/open-questions-resolution.md`, cited at the "Fixed monthly cost before the first user"
  row of the Dissolved table and again below it, was **removed to the private repository**
  `BrewMyTech/xplainer-hosted` (ADR 0023). It is an internal risk memo with margin arithmetic
  and an unsent vendor email, and it is not a decision record.
- `.omc/specs/deep-interview-xplainer-monorepo-init.md`, linked in the body above, moved to the
  same repository. That link no longer resolves and is deliberately left as written. See
  [`README.md` § Provenance](README.md) for the paths and the commit SHA at which it resolves.
- ADR 0010 and ADR 0017, cited in the same table row for their cost figures, relocated there
  too. The index carries tombstone rows for both.
- **The external architecture review this record is a response to has never been committed to
  any repository.** The link in the header — `.omc/artifacts/ask/codex-…-2026-09-05T08-54-11-831Z.md`
  — has been dangling since this record was written: `.omc/` was ignored except for the two
  negated paths above, and that file was not one of them. It is a ~400 KB agent transcript that
  exists only on the author's machine. This is recorded rather than quietly repaired because
  this record's whole argument is that "a refusal with no written argument is
  indistinguishable, six months from now, from not having read the review" — and the review
  itself turns out not to be in the repository. What *is* here is this record's own quotation
  and rebuttal of it, in the Dissolved table and the sections around it, which is the part that
  carries the argument.
