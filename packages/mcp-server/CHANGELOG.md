# @xplainer/mcp-server

## 0.0.1

### Patch Changes

- b3e1be8: **The published packages described a repository that no longer exists and a service that was never
  here.** This is the editorial pass ADR 0022 booked and ADR 0023 made necessary, done before the
  first publish rather than after it.

  `apps/api`, `apps/web` and `services/media-service` moved to a private repository on 2026-09-06.
  What stayed behind was a tree full of sentences citing them as siblings — and those sentences ship.
  `apps/cli`'s npm `description` named "the HTTP/MCP server core shared with the hosted
  media-service", which is the one line a human reads before installing a daemon; twenty-three
  docblocks across `apps/cli/src/` and `packages/mcp-server/src/` cited a `services/media-service`
  path that no reader of this repository can open, and every one of them travels inside
  `dist/**/*.d.ts` and the committed API reports.

  The reasoning in those comments was never wrong and is untouched: a seam is a parameter _because_ a
  second binder supplies its own guard, state directory or socket. Only the naming changed — the
  second binder is now **the hosted media service**, located once per file as _relocated to a private
  repository, ADR 0023_. Where a comment quotes ADR 0020 or `apps/cli/AGENTS.md`, the quotation still
  says what the record said and the surrounding sentence carries the correction, because a quote that
  has been tidied is no longer evidence.

  `LICENSE` — which ships inside all six tarballs — stopped listing three directories that are not
  here and now states the decision it used to leave open: `apps/desktop`, `packages/config` and
  `services/tts-sidecar` stay proprietary and stay `UNLICENSED`. Making the repository public made
  them readable, not usable.

  `@xplainer/skill` changes most. `SKILL.md`'s "Two backends, one tool set" sold a hosted service to
  an agent that cannot reach one, which is the same failure as publishing a dead URL: it is now "One
  tool set, and it runs on this machine", and an agent told no server is registered is told to stop
  rather than to reach for a route that does not exist. The three plugin and marketplace manifests
  drop the same framing and gain the Remotion disclosure ADR 0022 requires on a pre-install surface —
  completing the five surfaces that record named, none of which existed when it was written.

  Two schema `description` strings did move, and they are the reason this pass was not editorial
  after all. `captions.json` and `narration.json` cited `max/.explainers/scripts/narrate.py` by file
  and line — a path into the private reference implementation this product was derived from — and
  `@xplainer/protocol` ships `schemas`, `python/**/*.py` and `dist/**/*.d.ts`, so one citation was
  live on three surfaces at once. Twelve descriptions named that implementation, an earlier hand pass
  scrubbed ten, and these two outlived it. Both keep their claim and lose the coordinate: caption
  timing is still "measured rather than inferred", narration defaults still "mirror the reference
  implementation". `check-publish-contract` now carries a `no-private-reference-path` rule beside the
  one that matches the hosted repository's name, with its own negative test, because a class scrubbed
  by hand comes back and a class matched by a gate does not.

  What did NOT move is the local/hosted wording itself. The tool contract describes both backends
  deliberately, that wording is the published contract rather than a stale path, and narrowing it
  would be a contract change wearing an editorial hat.

- 574480c: Give every published package a `README.md`, a `homepage`, a `repository` and an `author`.

  None of the six had a README, so each one's npm page would have rendered blank —
  including `@xplainer/cli`, which is the page a human reads before deciding to
  install a background daemon on their machine. Each README is derived from the
  member's own `AGENTS.md`, states what the package is and links to the repository
  docs rather than restating their invariants; `@xplainer/cli` and
  `@xplainer/render-core` also carry the Remotion disclosure ADR 0022 requires on
  a surface a user reads _before_ installing — Remotion is declared, never bundled,
  and a company above three people needs its own licence.

  `repository.directory` names the member inside the monorepo, so "view source"
  lands on the package a reader is looking at instead of on the repository root.

- 574480c: Advertise the contract version, and make the `error_code` enum open.

  Spike P1-S3 settled the four questions ADR 0025 §Part two left proposed, and
  this is the code half of that answer.

  `MCP_CONTRACT_VERSION` moves to `@xplainer/protocol`, generated from
  `schemas/manifest.json`'s `version` and exported from the entry point.
  `@xplainer/mcp-server` re-exports it, so no caller changes; the value now comes
  from the package that owns the contract, which is what lets
  `xplainer mcp --attach` read a daemon's version without depending on the MCP
  server it may be about to refuse. `@xplainer/protocol` also gains
  `isContractCompatible(daemon, shim)` — **major-compatible**, symmetric, and
  fail-closed on a version it cannot parse.

  `xplainer serve` now answers `GET /healthz` with `contract_version` beside the
  existing `version`. The two are different numbers on purpose: `version` is the
  release, and it is what the MCP handshake reports in `serverInfo.version`, which
  is why the handshake could never have carried this.

  The `error_code` enum is now **open**: adding a member is a minor contract
  change, and both generated bindings decode a member they do not know as
  `internal` rather than rejecting the record. `schemas/manifest.json` gains an
  `open_enums` table, and codegen emits a decoder per language from it — an
  `enum._missing_` hook on the Python `StrEnum`, which pydantic otherwise rejects
  unknown members against, and a `toJobErrorCode()` function beside a frozen
  `JOB_ERROR_CODE_VALUES` tuple in TypeScript, where the erased union gave a
  consumer nothing to call. A non-string `error_code` is still rejected: tolerance
  is for a newer contract, not for a malformed record.

- 1a95fee: Documentation only: `RenderBackend`'s local implementation is now `createLocalBackend()` in
  `apps/cli/src/backend.ts`, not the stub this package's AGENTS.md pointed at. No behaviour, no
  exports and no types changed — the registration is exactly as backend-agnostic as it was, which is
  the point of the seam.
- c572ac0: Add a machine-readable `error_code` to `explainer_job`'s output.

  `error` is prose, so an agent deciding whether to retry has to parse it. The new
  `job-error-code.json` enum — `daemon_restarted`, `daemon_shutdown`,
  `toolchain_missing`, `render_failed`, `tts_failed`, `cancelled`, `internal` —
  says which class of failure produced that prose, and each member's description
  says whether retrying is worth anything. `error_code` is required and nullable,
  sitting immediately after `error` in both `properties` and `required`; it lands
  now because `@xplainer/protocol` is published for the first time in phase 1, and
  after that a required field is a breaking change to every consumer.

- Updated dependencies [b3e1be8]
- Updated dependencies [574480c]
- Updated dependencies [574480c]
- Updated dependencies [ce26d75]
- Updated dependencies [7c81808]
- Updated dependencies [d01d6db]
- Updated dependencies [574480c]
- Updated dependencies [c572ac0]
  - @xplainer/protocol@0.0.1
