# 0022. The published packages are open source under Apache-2.0 — the reversal is licence-driven; supersedes ADR 0021

- Status: accepted
- Date: 2026-09-06
- Deciders: @rishavanand
- Settled by: owner decision the same day ADR 0021 was accepted, after research into
  Remotion's distribution terms — "open source the published packages, with Remotion
  declared as a dependency rather than bundled"

## Context and Problem Statement

[ADR 0021](0021-proprietary-licence-free-to-use.md) was accepted earlier today. It chose a
proprietary free-to-use licence (`LICENSE-BINARY`) for the six publishable packages, on one
stated ground: **the owner wanted replication to be harder in the first months.** It recorded
option 1 — permissive open source now — as "the strongest option on almost every axis except
the one the owner cares about", and rejected it "for now, on the owner's timing judgement,
not on the merits".

Between that record and this one, the Remotion licensing position was examined properly, and
it changes which shape of licence is *cleanest*, not merely which is friendlier. Two facts
matter:

- **Remotion imposes extra conditions on software that BUNDLES Remotion and is distributed**,
  over and above the conditions on software that merely depends on it. Distributing an
  artefact with Remotion inside it makes the distributor the party in the licensing
  relationship for every copy shipped.
- **Remotion forbids operating "a rendering service that allows end-users to bring or upload
  their own Remotion code"** absent "prior explicit and written approval" (ADR 0015, open
  question 2). That prohibition attaches to whoever *operates* the renderer.

Put together: the cleanest position available for the local tier is a package the user
installs, whose manifest **declares** Remotion, so that the user's own install fetches
Remotion under Remotion's terms and the user — plainly, unambiguously, on their own machine —
is the operator. Nothing about that position is improved by a proprietary wrapper, and the
wrapper actively muddies it: a redistribution-forbidding end-user licence sitting over a
thing whose job is to scaffold Remotion code onto someone's disk invites exactly the "who is
distributing what to whom" question that an open package with a declared dependency never
raises.

### The correction that makes this cheap: we already declare rather than bundle

This record confirms an architecture that is already true, rather than announcing a change to
it. Verified today:

- **`@xplainer/render-core` declares no Remotion at all.** Its only dependency is
  `@xplainer/protocol`.
- The Remotion versions live in `packages/render-core/template/package.json` — `remotion`,
  `@remotion/{captions,cli,media,tailwind-v4}` at `4.0.495` — which is `private: true` and
  **is the user's own workspace**, installed by the user, on the user's machine, by the
  user's package manager.
- **The only manifest in the repository that declares Remotion directly is
  `services/media-service`**, which is `hosted` and never published.

So "declare, don't bundle" costs nothing to adopt for the local tier: it is the status quo.
What was wrong was the licence sitting on top of it.

### Why this is being decided now rather than at phase 5

ADR 0021's own driver — "npm publishes are effectively permanent … a licence granted to
someone who already installed cannot be retracted from them" — cuts the other way today.
**All six manifests are at `0.0.0` and nothing has been published.** The reversal is free at
this instant and stops being free at the first publish. ADR 0021's fork-point consequence —
"versions 0.x and 1.x published at phases 1–4 stay proprietary forever" — evaporates
entirely if this lands before phase 1 ships, and becomes permanent if it does not.

**This is not a change of heart about replication.** The replication argument in ADR 0021 is
not refuted below. It is outweighed, and the barrier it bought is given up deliberately and
with the cost named (see Accepted costs).

## Decision Drivers

- **The licensing position for the local tier should be the one that is hardest to get
  wrong.** "The user installs it, the user runs it, the user's install pulls Remotion under
  Remotion's terms" is a sentence with no moving parts. Anything else needs a paragraph.
- **The window is open and closing.** Nothing is published; the change is a manifest edit
  today and an irreversible fork point after the first publish.
- **An SPDX identifier every scanner recognises.** This is software an *agent* installs into
  someone's employer's machine, where it lands in a corporate-scanned dependency tree.
  ADR 0021 booked "will be flagged by every corporate licence scanner as unrecognised" as an
  accepted cost of `SEE LICENSE IN LICENSE-BINARY`. That cost is refunded here.
- **An explicit patent grant is worth more than familiarity in that setting.**
- **Inbound contributions should be coherent under the licence text itself**, not under a
  side agreement that exists only to preserve an option.
- **Honesty about what the reversal does not buy.** Open source does not resolve the hosted
  tier, does not make Remotion free for the user, and is not the same thing as a public
  repository. A record that lets any of those three be inferred is worse than no record.

## Considered Options

1. **Keep ADR 0021** — proprietary, free to use, per `LICENSE-BINARY`.
2. **MIT** on the six published packages.
3. **Apache-2.0** on the six published packages.

### Option 1 — keep ADR 0021

For: it is accepted, implemented and committed (4bf8f2a), and its central claim is true —
MIT or Apache-2.0 hands a competitor the *right* to fork, rebrand and resell on day one, at a
stage where release velocity is the only moat. `LICENSE-BINARY` §3(a) and §3(b) forbid
precisely that, and are enforceable against the actors that can actually be enforced
against.

Against: it takes the licensing position from "the user installs a package that declares
Remotion" to "the user accepts our end-user licence over an artefact that scaffolds Remotion
code", for no gain on the Remotion axis and a real loss of clarity on it. It costs the SPDX
recognition in the enterprise setting where an agent-installed tool most needs to be
uncontroversial. It creates the contributor problem in full (ADR 0021's own Consequences).
And it funds a build-and-CI programme — minification, source-map exclusion,
`declarationMap: false`, comment stripping — whose stated benefit ADR 0021 itself measured at
"a speed bump, not protection" and "no legal weight".

**Rejected.** The owner has reversed the timing judgement that carried it.

### Option 2 — MIT

For: the smallest possible surface. One file of roughly 1 KB, no `NOTICE`, no per-file
headers, no §4 redistribution conditions to comply with. Maximum familiarity: no reader has
ever had to think about MIT.

Against: **MIT is silent on patents.** Any patent grant is implied at best. It also carries
no written inbound-contribution clause, so the discharge in the Consequences below would rest
on GitHub's Terms of Service alone rather than on the licence text.

**Rejected**, narrowly and on the two clauses below. If the owner later wants the smallest
possible surface at the cost of those two properties, MIT is a defensible change and not a
mistake.

### Option 3 — Apache-2.0

Chosen.

For:

- **§3, the express patent grant.** Each contributor grants a patent licence covering their
  contributions, with defensive termination if the licensee sues over patents. For software
  that ends up in a corporate dependency tree, this is precisely what legal review looks
  for, and it is why Apache-2.0 is the default for developer infrastructure.
- **§5 supplies the inbound grant in the licence text** — "any Contribution intentionally
  submitted for inclusion … shall be under the terms and conditions of this License."
  Inbound-equals-outbound, written down, with no side agreement.
- **§6 does not license the trademark.** Opening the code does not open the name. A fork may
  ship the code; it may not ship it as xplainer.video.
- A real SPDX identifier, understood by every scanner, registry and legal department.

Against, accepted:

- It is ~11 KB of licence text rather than ~1 KB, and **§4(a) makes shipping it a condition
  of redistribution** — so the licence file must be physically inside each tarball. That is
  more obligation than MIT, not less, and it is why the sync-and-verify tooling built for
  ADR 0021 survives rather than being deleted.
- `NOTICE` is conventional, not mandatory: §4(d) obliges propagation of a `NOTICE` only if
  the work already has one. **Creating one is a ratchet** — once it exists, every downstream
  redistributor must carry it forever — so if one is created it should hold a copyright line
  and attributions actually owed, and nothing else.
- Per-file licence headers are conventional and are **not** adopted; `SPDX-License-Identifier:
  Apache-2.0` per file is the cheap alternative if machine-readable provenance is ever wanted.

## Decision Outcome

Chosen: **option 3 — the six published packages are licensed Apache-2.0.**

`apps/cli`, `packages/protocol`, `packages/mcp-server`, `packages/render-core`,
`packages/tts-client` and `packages/skill` ship as open source. Remotion is **declared** by
the workspace template the user installs, never bundled into a published artefact.

### Scope, stated precisely, because three boundaries are easy to blur

- **The hosted tier is excluded.** `apps/api`, `apps/web` and `services/media-service` stay
  proprietary and unpublished. `check-publish-leaks.mjs`'s roster check enforces the
  publishable set in both directions and keeps them out; that check becomes *more* valuable
  once the repository invites manifest edits from outside.
- **Three `open-later` members are not in the six and are not opened by this record:**
  `apps/desktop` (`open-later`, `private: true`, not published to npm),
  `packages/config` (`open-later`, `private: true`, holds this very tooling),
  `services/tts-sidecar`. "Open the published packages" and "open the `open-later` tier" are
  different sentences and this record only says the first.
- **The root `LICENSE` does not become Apache-2.0.** It covers *the repository*, which still
  contains the hosted tier; blanket-relicensing the root would open `apps/api`, `apps/web`
  and `services/media-service` by accident — the exact boundary ADR 0003 machine-checks. The
  root `LICENSE` stays a repository-scoped proprietary notice, rewritten so it no longer
  says the `open-later` tier "will be relicensed at phase 5", which is now false on timing
  for six of its members. Each of the six carries its own Apache-2.0 `LICENSE`.

### What follows mechanically

Recorded here as the decision; the manifests, build configuration and CI that implement it
are owned outside this record.

- The six manifests move from `"license": "SEE LICENSE IN LICENSE-BINARY"` to
  `"license": "Apache-2.0"`. **The direction of ADR 0021 is preserved and only its value
  changes** — `UNLICENSED` granted a user no right to run the software, and moving off it was
  correct.
- Each of the six carries `LICENSE` (the Apache-2.0 text) instead of `LICENSE-BINARY`. **The
  rename retires an obligation:** npm auto-includes a package-root file named `LICENSE`
  regardless of the `files` allowlist, which was the sole reason the per-package copy
  machinery existed.
- `packages/config/bin/sync-license.mjs` is **retargeted, not deleted.** Its invariant — the
  licence text is physically inside the artefact and the manifest agrees with it — gets
  stronger under §4(a). If a `NOTICE` is created, the script keeps its copy step for that
  file, because npm does *not* auto-include `NOTICE`.
- **The minification step is removed**, and `packages/config/bin/minify-dist.mjs` with it —
  which leaves `packages/config` with zero runtime dependencies (`esbuild` was there for this
  alone). ADR 0021 already recorded that minification "is a speed bump, not protection" and
  "adds no legal weight"; under open source its residual value is exactly zero, because a
  reader cannot be made to work harder for code we are handing them. Its cost is unchanged
  and lands on a **supervised background daemon** (ADR 0020) whose crashes surface in journald
  and Console, where a frame from a single-line bundle is the difference between a triageable
  bug report and none. Pre-minifying a published library is also against ecosystem
  convention: it defeats the consumer's own tree-shaking and source maps.
- **`sourceMap` and `declarationMap` are turned on** in all six `tsconfig.build.json`.
  ADR 0021 called `declarationMap` "dead weight — it points a consumer's editor at `src/` we
  do not publish". That is a conditional whose antecedent we have now chosen to make false.
  `removeComments` stays `false`, but its recorded reason changes from "so the targeted strip
  pass can do it instead" to "comments are documentation and we publish them".
- **`scripts/check-publish-leaks.mjs` is retargeted, not deleted**, and the CI step keeps its
  placement. It stops being an anti-leak gate and becomes a **tarball-hygiene, licence-presence
  and published-contract-integrity** gate. Three of its rules die or invert with the
  minification step (`no-source-map`, `no-typescript-source`/`no-src-directory` if `src` ships,
  and `no-source-mapping-url`, whose real invariant is "no dangling map pointer" and which
  inverts rather than disappearing). The rest survive and carry no licence content at all:
  no tests or fixtures, no Python bytecode, the roster check, the built check, the schema-tree
  completeness check, and the byte-identity assertions.
- **One warning, because deleting the minifier removes a guard nobody will miss until it
  matters:** `minify-dist.mjs` carried a second, independent hard-fail over the files that
  must ship byte-identical — the scaffold templates read verbatim at runtime by
  `dist/scaffold/index.js`, and `SKILL.md`, which must be identical across both plugin
  bundles or the two agent surfaces disagree about how to drive the tools. Once the minifier
  is gone, the leak gate's byte-identity assertions are the **sole** remaining protection.
  Reframed away from ADR 0021's obfuscation-exemption language, those assertions are a plain
  product-correctness invariant with no licence content — and they matter more now, not less.
- `.changeset/config.json` `"access": "public"` is unchanged. ADR 0021 set it; open source
  needs the same value.
- **A `README.md` per published package is still owed and none of the six has one.**
  ADR 0021 required it ("or its npm page renders blank") and it was never done. It is now
  also the primary Remotion disclosure surface — see below.
- **A defect this record sweeps up:** `packages/skill/claude-plugin/plugin.json`,
  `packages/skill/claude-plugin/marketplace.json` and `packages/skill/codex-plugin/plugin.json`
  still declare `"license": "UNLICENSED"`. They contradict `packages/skill/package.json`,
  they ship inside the built bundles, and they are what a marketplace listing renders to a
  prospective installer — telling them they have no right to run the plugin. The leak gate
  does not catch this, because it only inspects `package.json`. Wrong today, wrong under
  ADR 0021, and fixed here.

## Consequences

### Gains

- **The local tier's Remotion position is now stated in one sentence with no moving parts.**
  The user installs an open package; the package's workspace template declares Remotion; the
  user's own package manager fetches Remotion under Remotion's terms; the user operates it on
  the user's machine. No question about who bundled what, or who is distributing Remotion to
  whom, has to be answered — because the answers are the plain ones.
- **`Apache-2.0` is an SPDX identifier every scanner, registry and legal department already
  understands.** ADR 0021 booked the opposite as an accepted cost; it is refunded.
- **The phase-5 fork point disappears.** ADR 0021's §8 consequence — versions published at
  phases 1–4 stay proprietary forever, and "when did this become open source" has a version
  number as its answer — required a publish to exist. None has happened. Phase 5 becomes a
  repository split, not a licence change.
- **The contributor-agreement blocker is discharged** (below), which removes an item ADR 0003
  had moved onto the critical path.
- **The daemon becomes debuggable at the user's end.** Unminified output plus `sourceMap` and
  `declarationMap` means a journald or Console stack trace names a real file and line,
  go-to-definition lands in real TypeScript, and the CI map-archiving workflow ADR 0021
  needed is no longer load-bearing.
- **Roughly a phase of build and CI work is deleted rather than maintained** — the minifier,
  the map-exclusion rules, the comment-stripping pass, the `declarationMap: false` decision
  and the archive-and-symbolicate workflow that was supposed to compensate for them.

### Accepted costs

- **The replication barrier is given up, deliberately, and this is the real price.** From the
  first publish, anyone may fork the six packages, rebrand them and resell them, including as
  a hosted service. `LICENSE-BINARY` §3(a) and §3(b) forbade exactly that and nothing replaces
  them. ADR 0021's framing was correct and is not refuted here: *readability is a fact, the
  right to redistribute is a grant, and only the second was ours to withhold* — and we have
  now made the grant. What is left as the moat is what ADR 0021 said was left anyway: release
  velocity, and the hosted tier, which this record does not open. Apache-2.0 §6 withholds the
  trademark, so a fork may ship the code but not the name; that is a narrow protection and it
  should not be mistaken for the one being surrendered.
- **This is irrevocable for every version published under it.** The same permanence argument
  ADR 0021 used against a wrong proprietary field applies symmetrically. A future move to
  BUSL, FSL or dual-licensing would apply to future versions only, and every version already
  published stays Apache-2.0 for everyone who received it.
- **Apache-2.0 §4 is real compliance work**, not a formality: the licence text must be
  physically present in each redistributed artefact. That is why the licence-presence and
  byte-equality checks survive.
- **Published `.d.ts` files cite documents a reader may not be able to open.** Shipped
  declarations reference `ADR NN` and plan section IDs. ADR 0021's minifier stripped the
  leading module headers — incompletely, and only the headers — and that pass goes away with
  the minifier. If this repository stays private (see below), those citations stop being a
  leak and become a documentation-quality defect. **The fix is editorial, at source, not a
  build-time strip.**

### What this record does NOT do — carry these forward, they are not side notes

**1. It does not resolve the hosted tier, and does not touch it.**

When BrewMyTech's servers render, **BrewMyTech operates Remotion**, regardless of what
licence the wrapper carries. ADR 0015's open question 2 is unchanged and still open: the
Terms forbid operating "a rendering service that allows end-users to bring or upload their
own Remotion code" without "prior explicit and written approval", and the AI carve-out is
conditioned by the FAQ on the code being "initially generated by your service" — which our
authorship chain (ADR 0007: the TSX is generated by the *customer's* agent, on the
customer's machine, by a skill we publish) may fail. Open-sourcing the wrapper is not an
input to that question. `apps/api`, `apps/web` and `services/media-service` stay proprietary,
unpublished, and on the wrong side of an unanswered vendor question.

**2. It does not make Remotion free for users above three people.**

Remotion is free for individuals and for **companies of up to three people** (ADR 0015);
above that a user needs their own Remotion licence. Making our wrapper open source does not
change that by one word, and the "declare rather than bundle" position has as its *direct
consequence* that the user's own install pulls Remotion under Remotion's terms — which is
exactly the fact a user needs told.

**This has to be said out loud to users, and today it is said in exactly one place:
`LICENSE-BINARY` §4 — the file this reversal retires.** Done naively, the reversal deletes
the only Remotion disclosure that exists anywhere in this repository and replaces it with
nothing. It must move, and it must move to surfaces a user reads **before** installing:

- `packages/render-core/README.md` and `apps/cli/README.md` — neither exists; both are
  already owed; `npm i -g @xplainer/cli` is the documented install path (ADR 0020), which
  makes the second the page most humans actually read.
- The root `README.md` `## Requirements` section, which currently lists Node 24, uv and
  Docker and says nothing about Remotion.
- The three plugin/marketplace manifests, whose `description` fields are the pre-install
  surface for the plugin route — the same three files that need the `UNLICENSED` fix above.
  ADR 0015's addendum already booked this as owed and it was never actioned.
- `packages/skill/SKILL.md`, one line, so the agent can surface it.

Match `LICENSE-BINARY` §4's wording when moving it: *depending on the size of your company
and how you use it, you may need your own Remotion licence — see https://remotion.pro/license*.

Separately, and binding **today** regardless of this record: `packages/render-core/template`
scaffolds Remotion code onto a user's disk, which triggers Remotion's attribution requirement
that exported code "clearly indicate it is built with Remotion and include a link to the
Remotion licensing page" (ADR 0015 addendum, "a one-line fix and should just be done").

**This is a disclosure, not a resolution.** ADR 0015 remains
`proposed — pending vendor confirmation`, and its open question 5 — whether the scaffolded
workspace and `write_source_to` make a 4+-person customer liable for their own Company
Licence under §End-user code access — is still unanswered. This record does not answer it. It
sharpens it.

**3. An open-source LICENCE is not a PUBLIC REPOSITORY. That is a separate decision and this
record does not make it.**

Apache-licensed packages publish to npm perfectly well from a private repository. Making
*this* repository public is a different act with a different prerequisite, and the
prerequisite is already written down in three places — ADR 0003's extraction checklist item
1, `docs/adr/README.md`, and ROADMAP **P5-2**:
`.omc/specs/deep-interview-xplainer-monorepo-init.md` and
`.omc/plans/ralplan-xplainer-monorepo-init.md` are committed on purpose, because they are the
decision provenance every ADR cites, and both carry **absolute local paths under
`/Users/<redacted>/`** and the **name of a private sibling repository**. They must be
scrubbed or excluded before anything becomes public. Nothing in this record discharges that.

Note the second-order effect: **if the repository stays private, the `.d.ts` ADR-citation
problem does not go away with the minifier.** Published type declarations would cite
documents nobody outside the company can read.

### The contributor-agreement consequence from ADR 0021 is discharged

ADR 0021 devoted its longest Consequence to this, concluded that "a DCO is not sufficient
here", and recommended a `CONTRIBUTING.md` declining outside pull requests. **That argument
was entirely instrumental**, and its instrument is gone.

Its logic was: relicensing later requires holding the copyright to every line; inbound
contributions under a *proprietary* outbound licence grant no right to relicense them to
Apache-2.0; therefore an inbound pull request under this repository's stated terms is
"legally incoherent: there is no inbound grant to rely on". Every step of that turned on the
outbound licence being proprietary and the destination being somewhere else.

Under Apache-2.0 the outbound licence **is** the destination:

- **§5 supplies the inbound grant in the licence text.** A contribution arrives under exactly
  the terms we ship, permanently. GitHub's Terms of Service §D.6 — inbound under the
  repository's own terms — now yields a coherent result instead of an empty one.
- **A DCO flips from insufficient to sufficient and appropriate.** ADR 0021 rejected it for a
  reason that was correct then and is void now. The residual risk a DCO addresses — provenance;
  did the contributor have the right to submit this — never went away, and a `Signed-off-by`
  check in CI is the standard, cheap answer for a permissively-licensed project. **Adopt it.**
- **There is no longer an option to preserve, so there is nothing for a CLA to preserve it
  for.** No CLA is required.
- `CONTRIBUTING.md` is still worth writing and its content inverts: from "this repository
  declines outside pull requests" to "contributions welcome under Apache-2.0 §5; sign off your
  commits."

**The honest caveat:** a CLA remains the only mechanism if the company ever wants to relicense
*away from* Apache-2.0 — dual-licensing commercially, or moving a package to BUSL or FSL. If
the owner wants that door open, the CLA argument returns **for a different reason than the one
ADR 0021 recorded**, and it should be decided on its own merits rather than inherited from a
superseded record.

Four places assert the old consequence and are corrected alongside this record: ADR 0021's own
Consequences (left intact, as history — the record is superseded, not rewritten), ADR 0003's
2026-09-06 dated note, `docs/ROADMAP.md` phase 5 checklist item 5 and acceptance criterion
**P5-6**, and the root `README.md`'s outside-pull-request paragraph. **P5-6 is struck** rather
than left standing: "every file whose copyright the company holds, or for which a signed CLA
grants the relicensing" is no longer a gate on anything.

### What this record does not change

- **The tier boundary (ADR 0003) is untouched.** The checks stay, the direction stays, and
  `open-later` still means "intended for extraction". If anything it matters more: the
  publishable roster is now the line between what is open and what is not, and outside
  contributors will be editing manifests.
- **`packages/config` stays `private: true`** and unpublished. Not publishing is not a tier
  decision.
- **ADR 0014's "free and unlimited, no account" positioning** is unchanged and now sits on a
  standard open-source grant rather than a bespoke one.
- **`.changeset/config.json` `"access": "public"`, and `biome.json`'s tier-boundary specifier
  bans, are correct as committed** and need no edit.

### Revisit triggers

- **Before the first publish, the Remotion disclosure must exist on a before-install
  surface.** Publishing the six with `LICENSE-BINARY` removed and nothing put in its place is
  a net regression on disclosure against what 4bf8f2a shipped.
- **ADR 0015 reaching `accepted`**, particularly on open questions 2 and 5. Neither is
  answered here.
- **A decision on repository visibility**, which is separate, and which the ADR 0003 scrub
  gates.
- **A decision on `apps/desktop`.** `LICENSE-BINARY`'s stated scope is "the CLI and daemon,
  the desktop client, and the `@xplainer/` packages". The six leave that scope here. If the
  desktop client is also opened, `LICENSE-BINARY` has nothing left to cover; if it ships as a
  proprietary installer, `LICENSE-BINARY` narrows to that alone. Until then it stays as
  committed and its scope statement is stale.
- **A wish to dual-license or move to a non-compete licence**, which is when the CLA question
  returns on its own merits.

## Note, 2026-09-06: the repository decision this record deferred has been taken

Added as a dated note rather than a rewrite. The licence decision below — Apache-2.0 for the
six published packages, Remotion declared rather than bundled — is unchanged and is not
affected by anything here.

This record said, in its own words, that "an open-source LICENCE is not a PUBLIC REPOSITORY.
That is a separate decision and this record does not make it", and named the prerequisite:
the two `.omc/` planning documents must be scrubbed or excluded first.
[ADR 0023](0023-split-the-repository.md) makes that decision on this date. **The two documents
were removed to the private repository `BrewMyTech/xplainer-hosted` rather than scrubbed**,
because the absolute paths were the smallest problem in either file, and the hosted tier
relocated with them — deferred pending a vendor answer, not cancelled.

Three of this record's own carried-forward items are touched by it:

- **Item 1 — "It does not resolve the hosted tier."** Still true, and now literal: the hosted
  members are in a different repository. The Remotion rendering-service question stated in item
  1 is what makes the hosted tier's timing a vendor's decision rather than ours, and it is the
  stated reason for the split.
- **Item 2 — the Remotion disclosure a user needs told.** Unchanged and still owed, on the five
  surfaces this record names. `packages/render-core/README.md` and `apps/cli/README.md` still
  do not exist. The root `README.md` and `NOTICE` carry the sentence; the three plugin manifest
  `description` fields and `SKILL.md` do not yet.
- **The `.d.ts` ADR-citation problem grows slightly.** This record noted that if the repository
  stayed private, published type declarations would cite documents nobody outside the company
  could read. Public, most of those citations resolve for the first time — except the five
  records that relocated (0010, 0012, 0014, 0015, 0017), which do not. This record's ruling is
  unchanged: the fix is editorial, at source, not a build-time strip. The index carries
  tombstone rows so a relocated number resolves to "relocated" rather than to nothing.

**The absolute path quoted in "What this record does NOT do", item 3, is redacted in place** to
`/Users/<redacted>/`, and this note is the record of that redaction. It is announced rather than
silent because this record is `accepted` and its body is not rewritten; the redaction changes no
argument, no option and no outcome, and it exists because ROADMAP **P5-2** forbids an absolute
home-directory path in a public file. The same treatment and the same reasoning are applied to
ADR 0003, where the equivalent string is load-bearing; see its note of this date.
