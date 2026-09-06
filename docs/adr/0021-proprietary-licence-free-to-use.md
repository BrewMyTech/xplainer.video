# 0021. The published packages are proprietary and free to use — open source is deferred, not abandoned

- Status: **superseded by [ADR 0022](0022-open-source-the-published-packages.md)**
- Date: 2026-09-06
- Deciders: @rishavanand
- Settled by: owner decision while preparing the first public npm publish — "proprietary,
  free to use, open source later, to make replication harder early"

> **Superseded on 2026-09-06 by [ADR 0022](0022-open-source-the-published-packages.md)**,
> which licenses the six published packages Apache-2.0 — because Remotion's terms make
> "an open package that declares Remotion" the cleanest position for the local tier, not
> because the replication argument below was found wrong. The reasoning here is left
> intact; ADR 0022 records the replication barrier as a cost deliberately given up.

## Context and Problem Statement

ADR 0020 makes an installed daemon the local runtime and `docs/ROADMAP.md` phase 4 records
that until code signing lands, **`npx`/`npm` is the supported daemon-install path**. ADR 0013
ships two plugin bundles that resolve `@xplainer/*` from a registry. So the local tier cannot
reach a user without a public npm publish, and that publish happens at phase 1 — four phases
before the open-source extraction that ADR 0003 and ROADMAP phase 5 parked the licence
question in.

Publishing forces the question early, and the current answer is not merely incomplete, it is
wrong in a way that would ship:

- **All six publishable packages declare `"license": "UNLICENSED"`** — `apps/cli`,
  `packages/protocol`, `packages/mcp-server`, `packages/render-core`, `packages/tts-client`,
  `packages/skill`. `UNLICENSED` is not npm's way of saying "we have not decided yet". It is
  an affirmative statement that the package is proprietary and **the recipient is granted no
  right to run it**. A user who installs `@xplainer/cli` today receives a manifest telling
  them they may not use the thing they just installed.
- **No licence text ships in any of the six tarballs.** No package directory contains a
  `LICENSE*` file, so npm — which auto-includes one regardless of the `files` allowlist —
  includes nothing. `LICENSE-BINARY` exists only at the root of a private repository. The
  grant this record makes is not physically present in the artefact a user receives.
- **`.changeset/config.json` sets `"access": "restricted"`**, which publishes to a private
  registry scope and requires a paid npm plan. The local tier is free; the packages must be
  public.

That is incoherent against the product. ADR 0014's dated note states the positioning
plainly: "The local tier is not a limited free tier. It is free and unlimited, with no
account." A licence that grants no right to run the software contradicts the only thing the
local tier is for.

The question this record answers is therefore not *when do we open source*. It is: **under
what terms do users receive the software at phase 1**, and does that choice keep phase 5
open.

## Decision Drivers

- **The tier is advertised as genuinely free.** Whatever ships must contain an unambiguous,
  readable grant of free personal and commercial use, inside the tarball, not in a private
  repository.
- **The owner wants replication to be harder in the first months.** Stated as a timing
  choice about an early-stage product, not a permanent position on openness.
- **Nothing chosen now may foreclose the phase-5 relicensing.** ADR 0003 machine-checks the
  tier boundary from the first commit precisely so that extraction stays a directory move.
  A licence choice that quietly makes relicensing impossible costs exactly what the tier
  check was built to prevent.
- **npm publishes are effectively permanent.** The unpublish window is narrow and a licence
  granted to someone who already installed cannot be retracted from them. A wrong licence
  field is not a revert.
- **Honesty about what technical measures buy.** Shipping JavaScript to a user's machine
  means the user can read it. A decision record that pretends otherwise sets up build and CI
  work whose cost is real and whose benefit is imagined.

## Considered Options

1. **Permissive open source now** — MIT or Apache-2.0 on the six packages, phase 5 becomes
   a repository split rather than a licence change.
2. **Source-available with a non-compete** — BUSL-1.1, Elastic License 2.0, or the
   Functional Source Licence: publish the source, forbid competing use, and in BUSL's and
   FSL's case convert automatically to a real open-source licence on a fixed date.
3. **Proprietary with a broad use grant** — do not publish source; publish artefacts under
   an end-user licence that grants free personal and commercial use and forbids
   redistribution and resale-as-a-service. This is what `LICENSE-BINARY` already drafts.

### Option 1 — permissive open source now

The strongest option on almost every axis except the one the owner cares about.

For: MIT and Apache-2.0 are two SPDX identifiers that every tool, scanner, corporate legal
department and package registry already understands, which matters for software an *agent*
installs into someone's employer's machine. It removes the contributor-licence problem
entirely, because inbound-equals-outbound works when the outbound licence is the one you
want to keep. It is the only option where phase 5 costs nothing, because phase 5 has already
happened. And it buys the adoption a developer tool lives on.

Against, and this is the owner's actual objection: MIT hands a competitor the *right* to
fork, rebrand and resell on day one, at a stage where release velocity is the only moat and
there is no customer base to lose. That is a real asymmetry and it is not answered by
"the code is readable anyway" — readability is a fact, the right to redistribute is a
grant, and only the second is ours to withhold.

**Rejected for now, on the owner's timing judgement, not on the merits.** The intent to
adopt it later is recorded below and in `LICENSE-BINARY` §8.

### Option 2 — source-available with a non-compete

This is closer to what the owner described than either neighbour, and it deserves the
argument rather than a dismissal.

For: BUSL-1.1 and FSL both carry an automatic conversion — a Change Date, or FSL's two-year
step down to MIT or Apache-2.0. That property is worth more than it first looks, because
**the conversion grant is made up front, in the same licence, by whoever contributes under
it.** A contribution accepted under BUSL arrives already carrying its future open-source
grant. Option 2 is the only one of the three that solves the relicensing trap described in
the Consequences *as a side effect of the licence itself*, with no CLA and no copyright
round-up. Elastic License 2.0 has no conversion and does not have this property.

Against: every one of these requires publishing the source. That is the specific thing the
owner declined, so the option pays the full cost of the objection while collecting none of
the benefit. It also takes the reputational cost of the "source-available is not open
source" argument — these licences are actively disliked in the ecosystem, and OSI does not
recognise them — while still not being open source. Paying that cost twice, now and again at
phase 5 when we adopt a real licence anyway, is the worst ordering available.

**Rejected**, but with the conversion-date property explicitly noted, because if the
contributor problem below ever becomes acute, FSL is the cheapest escape from it.

### Option 3 — proprietary with a broad use grant

Chosen. `LICENSE-BINARY` §1 grants worldwide, royalty-free, non-exclusive use on any number
of machines, for any purpose including commercial, with no purchase, registration or
sign-in. §2 disclaims any claim over what the user produces. §3 forbids redistribution and
offering the software to third parties as a hosted or managed service. §4 discloses the
Remotion dependency. §8 records the intent to relicense.

For: it is the only option that delivers a real, usable free tier at phase 1 without
publishing source, which is precisely the shape the owner asked for. §3(a) and §3(b) are
enforceable against the actors that can actually be enforced against — companies with
something to lose — and they forbid the exact behaviour the fork objection is about.

Against, and these are accepted rather than answered: it is not an SPDX-standard licence, so
it needs `SEE LICENSE IN LICENSE-BINARY` and will be flagged by every corporate licence
scanner as "unrecognised", which costs adoption in exactly the enterprise setting where an
agent-installed tool needs to be uncontroversial. It creates the contributor problem in full.
And it makes the phase-5 transition a fork point rather than a clean change of terms.

## Decision Outcome

Chosen: **option 3 — proprietary, free to use, per `LICENSE-BINARY`.** The software is not
open source today. It is free to run, personally and commercially, and may not be
redistributed or resold as a service.

The decision is deliberately provisional. **The intent to relicense the `open-later` tier
under an open-source licence at roadmap phase 5 stands** — ADR 0003's tier boundary exists
to make that cheap and is unchanged by this record. `LICENSE-BINARY` §8 states the intent to
the user. What this record adds is that the intent is now *conditional on holding the
copyright*, which is a live constraint rather than a formality (see Consequences).

### What follows mechanically

Recorded here as the decision; the manifests, build configuration and CI that implement it
are owned outside this record.

- The six publishable manifests move from `"license": "UNLICENSED"` to
  `"license": "SEE LICENSE IN LICENSE-BINARY"` — SPDX's documented form for a non-standard
  licence carried in a file.
- **`LICENSE-BINARY` is copied into every published package directory at pack time**, so the
  grant is inside the tarball. A licence a user cannot read is not a grant they have.
- Each published package gets a `README.md`, or its npm page renders blank, and
  `repository`, `homepage` and `author` fields.
- `.changeset/config.json` `"access"` becomes `"public"`.
- `packages/config` is `private: true` and stays unpublished. Its tier field still reads
  `open-later`; not publishing is not a tier decision.

### Two licence files, two different scopes

The repository now carries two licence files that say opposite things, and the difference is
load-bearing. It is stated in the root `README.md` for the same reason.

| File | Covers | Says |
|---|---|---|
| [`LICENSE`](../../LICENSE) | **The repository.** Every file in the git tree, both tiers, source included. | Proprietary, all rights reserved. No permission to use, copy, modify or distribute anything. |
| [`LICENSE-BINARY`](../../LICENSE-BINARY) | **The artefact.** What a user receives from `npm i @xplainer/…` or a desktop installer. | Free personal and commercial use on any number of machines. No redistribution, no resale as a service. |

The asymmetry is the decision: **use is licensed, source is not.** Reading the repository
requires access we do not grant; running the published package requires nothing at all.

## Consequences

### Relicensing later requires holding all the copyright — this is what can quietly kill the plan

A licence is granted by the copyright holder. To relicense the `open-later` tier at phase 5
we must hold, or control by contract, the right to relicense **every line**. If someone else
holds copyright in a file and gave us no relicensing grant, that file cannot be relicensed —
it must be rewritten, or the contributor must be found and must agree.

**Today the position is clean and should be locked while that is free.** `git log` shows
five commits by one author; `CODEOWNERS` is `* @rishavanand`. Nothing is owned by anyone
else yet.

**The trap is that this decision makes it worse, not better.** The moment the repository is
public — or merely accepts an outside pull request while private — contributions arrive with
no inbound licence terms, because neither of our two licence files provides any. GitHub's
Terms of Service §D.6 make contributions to a public repository inbound-under-the-repo's-own
terms; here those terms are `LICENSE`, which grants nobody any right to contribute anything,
and `LICENSE-BINARY`, which is an end-user licence that forbids redistribution and is silent
on inbound contributions. **An inbound pull request under this repository's stated terms is
legally incoherent: there is no inbound grant to rely on.** Merging one leaves a file whose
copyright we do not hold and whose licence we cannot change.

**A DCO is not sufficient here, and that is the counter-intuitive part.** `Signed-off-by`
plus a CI check is the cheap, standard answer, and it works by asserting
inbound-equals-outbound. Our outbound licence is proprietary. Contributions arriving under
our *current* proprietary terms give us no right to relicense them to Apache-2.0 later. DCO
solves provenance; it does not preserve the option this record is built to preserve.

What actually works, in ascending friction:

1. **Accept no outside contributions until after relicensing.** A `CONTRIBUTING.md` saying
   the repository does not accept external pull requests while it is proprietary, and will
   after the phase-5 relicensing. At five commits this closes the hole completely, in one
   file, at zero cost. It is the recommended answer for now.
2. **A CLA with an explicit future-relicensing grant** — a contribution licensed to us
   "under any licence, including future versions of this project's licence". This is the
   only mechanism that both accepts contributions and preserves the option. CLA-assistant
   automates the signature flow.
3. **Copyright assignment**, the heaviest and rarely worth it at this size.

**One of these must be in place before the repository is public or before the first outside
pull request, whichever comes first.** If neither is, phase 5's choices are: rewrite the
contributed lines, chase every contributor for retroactive permission — people leave, change
email, refuse, or want something — or ship open source we have no right to ship. That is how
an open-source plan dies without anyone deciding to kill it.

### Name one copyright holder, consistently, before publishing

Three documents currently give three different answers, and a licence with no identified
grantor is a weak licence:

- `LICENSE-BINARY`: "Copyright (c) 2026 BrewMyTech."
- Root `LICENSE`: "Copyright (c) 2026." — **no holder named at all.**
- The sole committer's git identity is a personal address, distinct from the
  `rishav@brewmytech.com` in `LICENSE-BINARY`.
- The six publishable manifests name no `author` and no copyright holder.

If BrewMyTech is a company and the author is its employee or director, there should be a
written assignment or the company's ownership rests on an implied term. If it is a trading
name for the same individual, say so once and consistently. Either way, one holder, named in
`LICENSE`, `LICENSE-BINARY` and all six manifests.

### Relicensing does not reach backwards

`LICENSE-BINARY` §8 is drafted correctly and the consequence should be stated plainly:
anyone who received a version under these terms keeps it under these terms, permanently.
Open-sourcing later therefore produces a **fork point, not a transition**. Versions 0.x and
1.x published at phases 1–4 stay proprietary forever, and any "when did this become open
source" question has a version number as its answer. That is acceptable; it is not free.

### Shipped JavaScript is readable, and minification is a speed bump, not protection

The owner asked that shipped code be obfuscated and that no source maps leak, enforced by
CI. Both are worth doing at modest settings. Neither is protection, and this record says so
in the terms a future reader needs:

- **It does not stop anyone reading the code.** `npm pack` the published tarball, untar,
  run a formatter, and the logic is legible in minutes. Minification removes comments and
  local variable names. It does not remove program structure, string literals, exported
  names, or the call sequence into `hono`, `commander`, `zod` and the MCP SDK.
- **The measured leak is the comments, not the identifiers.** 62% of shipped `.js` bytes and
  77% of shipped `.d.ts` bytes are comments, and 29 shipped files cite `ADR 00NN` or
  `plan §` sections of documents that are not public — including, in `@xplainer/mcp-server`,
  a written description of where argument validation is missing at the tool boundary and why
  the code generators miss it. **That is a replication guide, published to every user.**
  Removing it is one compiler flag on the `.js` side and editorial discipline on the `.d.ts`
  side. It is worth more than every obfuscation option combined.
- **Source maps must be produced and must not ship.** They are excluded from the tarball and
  archived as CI artefacts keyed by version, so a crash in a long-running daemon stays
  symbolicatable. Note the ordering: without a minification step a no-maps rule is hygiene,
  and with one, a single leaked map undoes the entire step. Adopt both together or neither.
  `declarationMap` is dead weight — it points a consumer's editor at `src/` we do not
  publish — and should be off.
- **Identifier mangling is deferred and conditional.** It turns a journald stack frame into
  `at n (…/dist/index.js:1:48213)`. It is turned on only alongside the map-archiving and
  symbolication workflow, never before, and it buys roughly an hour against a determined
  reader.
- **Aggressive obfuscation is rejected outright.** `javascript-obfuscator`'s own
  documentation puts control-flow flattening at up to 1.5× slower and dead-code injection at
  up to 200% larger, and its `selfDefending` mode breaks if the output is reformatted — that
  is, it forbids the one tool needed to debug it. Bytecode compilation (`bytenode`) is
  disqualified on facts: all six packages are ESM, and a `.jsc` file must run on the same
  Node version and architecture that compiled it, which we do not control for a stranger's
  machine. Both also fight a user we have *licensed* to run this software on their own
  hardware.
- **The `.d.ts` files are a complete specification of the public API** — every export, every
  parameter type, every union member. That is their job and a consumer's `tsc` cannot work
  without them. It is not worth fighting. What is worth fixing is that they currently also
  carry the design rationale.
- **It adds no legal weight.** The enforceable protection is `LICENSE-BINARY` §3 — no
  redistribution, no resale as a service. That clause does the work obfuscation is being
  asked to do. Note also that §3(d)'s anti-reverse-engineering restriction carefully carves
  out mandatory law; pairing it with heavy technical measures invites the argument that
  carve-out already anticipates, for no gain.

**What obfuscation actually raises the bar against is lazy copy-paste, not serious
replication.** The early moat is release velocity and the hosted tier, which none of this
touches.

### Files that must ship as readable source, and why

These are exempt from minification, name mangling and any "no `.ts` in a tarball" or "no
`tsconfig` in a tarball" rule. **The exemption list belongs in CI configuration as data,
with the reason beside each entry**, because a naive rule breaks the product silently and
the next person to write one will not know why.

| Must ship readable | Why obfuscating it breaks the product |
|---|---|
| `packages/render-core/template/**` — `remotion.config.ts`, `tsconfig.json`, `package.json`, `tailwind.css` | This is the Remotion workspace the user's videos render in. It is a project the user owns and edits, not our runtime. It must arrive as readable TypeScript. |
| `packages/render-core/src/scaffold/templates/*.txt` → `dist/scaffold/templates/*.txt` — `Video.tsx.txt`, `Root.tsx.txt`, `Captions.tsx.txt`, `Scenes.tsx.txt`, `types.ts.txt`, `index.ts.txt` | Read **verbatim at runtime** by `dist/scaffold/index.js` via `readFileSync` relative to `import.meta.url`, and written to the user's project byte-for-byte. They are stored as `.txt` precisely so that neither Biome nor `tsc` touches their bytes, and ROADMAP P1-6 keeps five byte-identity assertions over them. `Scenes.tsx` is the file the agent then *edits* (ADR 0018). Minifying them produces code the agent cannot read or modify. |
| `packages/skill/SKILL.md`, and its two build copies under `dist/{claude,codex}-plugin/skills/xplainer/SKILL.md` | 14,891 bytes of prose an agent reads as instructions (ADR 0013). Obfuscating prose is not a coherent operation. |
| `packages/protocol/schemas/**` — 22 JSON Schemas, plus the two copies published inside `@xplainer/skill` | The published tool contract, which consumers validate against. By design a complete, precise description of the eight MCP tools (ADR 0007). |

**Said honestly: those four exemptions cover the parts of this product that are actually
hard to reproduce.** The schemas *are* the protocol; SKILL.md *is* the prompt engineering;
the scaffold templates *are* the Remotion know-how. All three ship as readable text because
the product does not function otherwise. Whatever is done to the compiled `.js` does not
change that, and any argument that obfuscation protects the valuable part of this codebase
is wrong on the file list.

### A public registry is a public surface, four phases before phase 5 expected one

- **`packages/render-core` published publicly hands every installer a manifest that will
  install Remotion on their machine under Remotion's terms.** ADR 0015 is still
  `proposed — pending vendor confirmation`, and its open question 5 — whether
  `write_source_to` makes a customer liable for their own Remotion licence — now needs an
  answer **before publish**, not before phase 5. `LICENSE-BINARY` §4 discloses the
  dependency to users, which is the right call and not a substitute for the answer.
- **ADR 0003's scrub item is about repository publication; the same class of leak is already
  in the tarballs.** `.omc/specs/` and `.omc/plans/` do not appear in any of the six
  tarballs — that was checked. But 29 shipped files cite ADR numbers and plan section IDs
  for documents that are not public. The phase-5 checklist item and the shipped-comment
  problem are the same problem at two scopes.
- **npm publishes are close to permanent.** The unpublish window is narrow, and a grant made
  to someone who already installed cannot be withdrawn. Getting the licence field right on
  the first publish matters more than it would anywhere else in this repository.

### What this record does not change

- **The tier boundary (ADR 0003) is untouched.** The checks stay, the direction stays, and
  `open-later` still means "intended for extraction". This record qualifies the *terms and
  the timing*, not the boundary. If anything the boundary matters more now, because the
  `open-later` packages become externally visible at phase 1.
- **`packages/config` stays `private: true`** and unpublished.
- **The hosted tier is unaffected.** `LICENSE-BINARY` explicitly does not cover the hosted
  service, which is governed by separate terms of service, and `apps/api`, `apps/web` and
  `services/media-service` stay proprietary with no published artefact.
- **ADR 0014's "free and unlimited, no account" positioning is now backed by an actual
  grant.** Before this record it was a claim in a document with a licence that contradicted
  it.

### Revisit triggers

This record is expected to be superseded, not merely aged out. It re-opens when:

- someone outside the company wants to contribute — settle the CLA or `CONTRIBUTING.md`
  question first, because merging comes with a permanent cost;
- roadmap phase 5 arrives, where its checklist item 4 now reads "relicense per ADR 0021";
- a competitor ships a fork of the published packages, which `LICENSE-BINARY` §3 forbids and
  which is the test of whether that clause, rather than obfuscation, is doing the work;
- or the owner concludes the replication-hardness argument did not hold, in which case
  option 1 is on the table immediately and the only thing standing in the way is whether the
  copyright is still wholly held.
