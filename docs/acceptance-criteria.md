# Acceptance criteria — phase 0

Phase 0 of this project was the monorepo scaffold, and it was judged against a numbered set
of acceptance criteria written down before the work started. Fifty-two comments, test names
and CI step names in this repository cite those criteria by id — `AC-2c`, `AC-7b`, `AC-14b`
— so the ids have to resolve to something.

They used to live in two planning documents under `.omc/`. Those documents were relocated to
the private repository when this repository was reduced to its local, open-source shape
([ADR 0023](adr/0023-split-the-repository.md)); the reasoning is in
[`adr/README.md` § Provenance](adr/README.md#provenance). This file is the replacement home
for the criteria that still apply here.

## How to read this file

- **Ids are never renumbered.** Same discipline as the ADR filenames, for the same reason: a
  citation written in 2026 must still resolve in 2027. `AC-8` is gone from this repository,
  and the row where it used to be says so rather than closing the gap.
- **Criterion text is verbatim.** Where the split changed a *value* inside a criterion — a
  member count, a members list — the original wording is kept and the new value is stated
  beneath it as a dated amendment. The criterion is not rewritten.
- **Relocated, not retired.** A criterion that judged hosted work still judges it, in
  `BrewMyTech/xplainer-hosted`. It is marked *relocated* here, not deleted, so a citation of
  it in a surviving comment resolves to an answer instead of to nothing.

---

## Values that changed at the split

Three of the twelve workspace members left. Every criterion that counts members changed
value, and none changed meaning.

| Quantity | Before | After |
|---|---|---|
| Workspace members | 12 | **9** |
| `uv` workspace members | 3 | **2** |
| Members with a `test` task | 12 | **9** |
| Members with a `lint` task | 12 | **9** |
| Members with a `typecheck` task | 12 | **9** |
| Members with a `build` task | 10 | **8** |
| Members with a `codegen` task | 1 | 1 (`@xplainer/protocol`) |

The nine are `apps/cli`, `apps/desktop`, `packages/config`, `packages/mcp-server`,
`packages/protocol`, `packages/render-core`, `packages/skill`, `packages/tts-client` and
`services/tts-sidecar`. `services/tts-sidecar` is the sole Python-only member and declares no
`build`, which is why eight build and nine test.

---

## AC-1 — Bootstrap

> Fresh clone: `corepack enable && pnpm install` and `uv sync` succeed on macOS, Linux,
> Windows without manual steps beyond Node LTS + uv.

- **1a** `corepack enable && pnpm install --frozen-lockfile` exits 0 with `packageManager` pinned in the root `package.json`.
- **1b** `uv sync --all-packages` exits 0 and resolves the three members declared in the root `pyproject.toml` `[tool.uv.workspace]`.
  - *Amended 2026-09-06 (ADR 0023):* **two** members — `packages/protocol` and `services/tts-sidecar`. `apps/api` was the third and relocated. The criterion is unchanged in shape: it still asserts that the declared workspace resolves whole, which is what catches a member dropped out of the environment.
- **1c** `.node-version` and `.python-version` exist and are honoured by `actions/setup-node` and `astral-sh/setup-uv` in `.github/workflows/ci.yml`.
- **1d** No `postinstall` script anywhere downloads a browser, a model, or a binary (grep `package.json` files for `postinstall`).
- **1e** **The three-OS claim is actually executed.** The `bootstrap` job in `.github/workflows/ci.yml` runs 1a and 1b on a `[ubuntu-latest, macos-latest, windows-latest]` matrix and does nothing else, so a Windows-only or macOS-only install failure surfaces as its own red job rather than hiding behind a green ubuntu run.

## AC-2 — One command over both languages

> `pnpm turbo build lint typecheck test` passes for every workspace member, including Python
> members via `uv run` wrappers; each package has at least one real smoke test (no
> `test.skip`, no `.only`, no TODO placeholders).

- **2a** `pnpm turbo build lint typecheck test` exits 0 from a clean checkout.
- **2b** `pnpm turbo run test --dry=json` lists a `test` task for all **twelve** members.
  - *Amended 2026-09-06 (ADR 0023):* **nine**.
- **2c** `grep -rnE '\.(skip|only)\(|\bTODO\b|\bFIXME\b' --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.py' apps packages services` returns no hits.
- **2d** Each member's test asserts behaviour, not existence.
- **2e** **The dual-language member runs both halves.** `pnpm --filter @xplainer/protocol test` output contains both a vitest summary and a pytest summary, and the same holds for `lint` and `typecheck`. `packages/protocol` is the only member with TypeScript and Python in one package, so it is the only place where a task can pass having exercised half of what it names.
- **2f** **Every task reaches every member it should.** `pnpm turbo run lint --dry=json` and `pnpm turbo run typecheck --dry=json` each list all **twelve** members, mirroring 2b's assertion for `test`. Turbo skips an undeclared script silently, so a member that never declares `lint` produces a green run over unlinted code; only counting the tasks catches it.
  - *Amended 2026-09-06 (ADR 0023):* **nine** each.
- **2g** **The `build` task covers exactly the ten members that declare it:** `pnpm turbo run build --dry=json` lists **ten** — the ten TypeScript members — and does **not** list `@xplainer/api` or `@xplainer/tts-sidecar`, which have nothing to compile. Ten is the expected number, not a shortfall.
  - *Amended 2026-09-06 (ADR 0023):* **eight**, and the exclusion list is `@xplainer/tts-sidecar` alone; `@xplainer/api` relocated.

## AC-3 — Tier boundary

> Tier boundary rule exists (Biome/ESLint import restriction + a Python import-linter
> contract) and a unit test proves an `open-later → hosted` import is rejected.

- **3a** Every `package.json` under `apps/`, `packages/`, `services/` carries `"xplainer": { "tier": "hosted" | "open-later" }`.
- **3b** `pnpm lint:tiers` exits 0 on the real graph and exits 1 on the violating fixture.
  - *Amended 2026-09-06 (ADR 0023):* **the real-graph half of this check is now vacuous, and that is recorded rather than hidden.** No `hosted` member remains in this repository, so the checker cannot produce a violation from the real graph; what it still enforces here is 3a — an unclassified member exits 2. The proof that the rule *can* fail is now carried entirely by the synthetic fixture in `packages/config/src/tiers.test.ts` (3c). See ADR 0003's 2026-09-06 note.
- **3c** `packages/config/src/tiers.test.ts` asserts `hosted → open-later` passes and `open-later → hosted` is reported.
- **3d** *(Python half — relocated.)* `uv run --no-sync lint-imports` exits 0; `uv run --no-sync --directory apps/api --project . pytest tests/test_tier_boundary.py` proves the contract fails on `apps/api/tests/fixtures/tier_violation/`.
  - *Retired here 2026-09-06 (ADR 0023).* `apps/api` was the only `hosted` Python module, so the import-linter contract has no forbidden target left; a contract that cannot be violated proves nothing. The `[tool.importlinter]` block, the `import-linter` dev dependency and the CI step were removed with it, and `apps/api/tests/test_tier_boundary.py` left with `apps/api`. It judges the Python tier boundary in `BrewMyTech/xplainer-hosted`, where both ends of the edge still exist.
- **3e** `biome.json` `overrides` restrict hosted specifiers inside `packages/**`, `apps/cli/**`, `apps/desktop/**`, `services/tts-sidecar/**` — all four open-later roots.
  - *Note 2026-09-06 (ADR 0023):* kept, with the ban's message retargeted at the private repository. It is now the only remaining mechanism that stops this repository re-acquiring a dependency on the relocated tier, and it costs nothing to keep.

## AC-4 — CI

> GitHub Actions: `ci.yml` runs lint/typecheck/test on ubuntu; `desktop.yml` runs
> `electron-builder --publish never` on ubuntu/macos/windows and uploads unsigned artifacts;
> both green on the initial commit.

- **4a** `.github/workflows/ci.yml` and `.github/workflows/desktop.yml` parse (`actionlint`).
- **4b** `desktop.yml` matrix is exactly `[ubuntu-latest, macos-latest, windows-latest]` and calls `actions/upload-artifact`.
- **4c** Both runs conclude `success`.

## AC-5 — Decision records

> `docs/adr/` contains one ADR per decision listed under Stack and Contract (≥12 ADRs) in
> MADR format, plus `docs/ROADMAP.md` with the phases below.

- **5a** `ls docs/adr/0*.md | wc -l` ≥ 16.
  - *Restated 2026-09-06 (ADR 0023):* still satisfied at **18** files. Five records relocated (0010, 0012, 0014, 0015, 0017) and one was added (0023). This is restated deliberately rather than left accidentally true: the floor is not what the criterion is for, and the tombstone rows in `adr/README.md` are what keep the numbering honest.
- **5b** Each ADR file contains the MADR headings `## Context and Problem Statement`, `## Considered Options`, `## Decision Outcome`.
- **5c** `docs/ROADMAP.md` names all five phases from spec §Roadmap.
  - *Amended 2026-09-06 (ADR 0023):* the roadmap is local-only and now names four phases. The hosted phases relocated to the private repository's own roadmap.

## AC-6 — Desktop client

> `pnpm --filter @xplainer/desktop dev` opens an Electron window titled "Xplainer" showing
> version; `pnpm --filter @xplainer/desktop package` produces a platform installer locally.

- **6a** `pnpm --filter @xplainer/desktop dev` launches and the window title is `Xplainer`, plus `apps/desktop/src/main/window.test.ts` asserting `buildWindowOptions().title === "Xplainer"`.
- **6b** `pnpm --filter @xplainer/desktop package` writes an installer under `apps/desktop/release/`.

## AC-7 — Render core and the scaffold fixtures

> `packages/render-core` builds; contains the Remotion workspace template (package.json with
> pinned deps, `remotion.config.ts`, `tailwind.css`, `tsconfig.json`) and the scaffold
> generator, which writes six files — five engine-owned and one agent-owned — each proved
> byte-identical to its golden.

- **7a** `packages/render-core/template/` holds all four template files with the pinned versions (`remotion@4.0.495`, `react@19.2.3`, `tailwindcss@4.0.0`, `typescript@5.7.3`).
- **7b** The four *inherited* wiring files — `index.ts`, `types.ts`, `Root.tsx`, `Captions.tsx` — are produced **byte-identically to the upstream reference implementation's scaffold**, compared with `Buffer.compare` against `test/fixtures/scaffold/*.golden`, extracted from the reference implementation's `server/explainer_mcp.py::_SCAFFOLD` at commit `d11615e1`.
  - *Note 2026-09-06 (ADR 0023):* the criterion is unchanged. What changed is that a public reader cannot open the repository the bytes came from, so the assertion is real but not independently reproducible from this repository alone. `packages/render-core/test/fixtures/README.md` says so in those words.
- **7c** The generator never overwrites the agent-owned `Scenes.tsx`, and restores any engine-owned file that is missing or whose bytes differ from the template, reporting it in `restored`. A second `scaffoldVideo()` call on the same directory returns all five names as `skipped`, an empty `created`, and leaves the on-disk bytes unchanged.
- **7d** `Video.tsx` **deliberately diverges from the upstream copy** (ADR 0018): upstream's is agent-owned and mounts the narration audio and captions; xplainer's is engine-owned and `explainer_put_source` refuses to write it. The upstream bytes are retained at `test/fixtures/scaffold/upstream/Video.tsx.max`, and a test asserts both that the template differs from them and that the difference is the intended one — audio, captions and per-segment sequencing present in the engine file and absent from the agent file.
- **7e** `Video.tsx` and the agent-owned `Scenes.tsx` are each produced byte-identically to their own goldens (`Video.tsx.golden`, `Scenes.tsx.golden`). These two are xplainer-authored **change detectors, not provenance fixtures**: editing either template without updating its fixture in the same commit fails the test. The distinction from AC-7b is deliberate and is recorded in `test/fixtures/README.md`.

## AC-8 — RELOCATED

> `uv run --project apps/api uvicorn xplainer_api.main:app` serves `GET /healthz` → 200 and a
> Streamable HTTP MCP endpoint at `/mcp` whose `tools/list` returns the placeholder tool set;
> a pytest asserts the list matches `packages/protocol`'s manifest.

*Relocated 2026-09-06 to `BrewMyTech/xplainer-hosted` with `apps/api` (ADR 0023).* Sub-criteria
8a, 8b, 8c and 8d relocate with it. Its local mirror is **AC-14d**, which drives `tools/list`
against `xplainer serve`'s `/mcp` and asserts the names equal `TOOL_NAMES` from
`@xplainer/protocol`. The two were written to be independent of each other on purpose — both
compare against the protocol manifest, never against each other — so the local half stands
unchanged now that the hosted half is judged in another repository.

## AC-9 — Protocol as the single source of truth

> `packages/protocol` holds JSON Schema (source of truth) for all eight tool inputs/outputs +
> job states; `pnpm --filter @xplainer/protocol codegen` regenerates TS types and pydantic
> models; CI fails if generated output is stale.

- **9a** `packages/protocol/schemas/tools/` holds sixteen files (input + output for each of the eight tools) plus `packages/protocol/schemas/job-state.json` and `packages/protocol/schemas/manifest.json`.
- **9b** The eight names are exactly `explainer_create`, `explainer_put_source`, `explainer_put_media`, `explainer_narrate`, `explainer_still`, `explainer_render`, `explainer_job`, `explainer_list`.
- **9c** `pnpm --filter @xplainer/protocol codegen && git diff --exit-code -- packages/protocol/src/generated packages/protocol/python/xplainer_protocol/generated` exits 0. This only holds if codegen is deterministic, so `datamodel-code-generator` is invoked with `--disable-timestamp` and both generators are pinned to exact versions rather than ranges.
- **9d** `.github/workflows/ci.yml` runs 9c as its own step.

## AC-10 — Plugin bundles

> `packages/skill` builds `dist/claude-plugin/` and `dist/codex-plugin/`; schema tests
> validate both manifests; SKILL.md present in both; a check that tool names in SKILL.md ⊆
> protocol tool names.

- **10a** `pnpm --filter @xplainer/skill build` writes `dist/claude-plugin/.claude-plugin/{plugin.json,marketplace.json}`, `dist/claude-plugin/.mcp.json`, `dist/claude-plugin/skills/xplainer/SKILL.md`, `dist/codex-plugin/.codex-plugin/plugin.json`, `dist/codex-plugin/.mcp.json`, and `dist/codex-plugin/skills/xplainer/SKILL.md`.
- **10b** Both `.mcp.json` files point at `https://mcp.xplainer.video/mcp`.
  - *Retired here 2026-09-06 (ADR 0023).* That endpoint is served by the relocated hosted tier and this repository no longer describes the DNS record behind it, so the criterion as written now asserts a dead URL. It is **replaced, not merely dropped**, by **AC-10b′**: *both `.mcp.json` files declare a local stdio server (`npx -y @xplainer/cli mcp`) and neither declares `oauth_resource`, because a loopback daemon has no authorization server.* The original 10b judges the hosted bundles in `BrewMyTech/xplainer-hosted`.
- **10c** `pnpm --filter @xplainer/skill test` Ajv-validates both manifests and asserts the SKILL.md tool-name subset relation.

## AC-11 — Container images

> `services/media-service` has a Dockerfile (Node + Chrome Headless Shell via
> `remotion browser ensure` at build time) that builds in CI and serves `GET /healthz`;
> `services/tts-sidecar` has a Dockerfile building or pinning the Kokoro-FastAPI CPU image
> plus a documented, non-CI packaging script stub per OS.

- **11a** *(Relocated.)* `docker build -f services/media-service/Dockerfile .` succeeds (build context is the **repository root**, because the image installs from the pnpm workspace) and the image's `/healthz` returns 200. — *Relocated 2026-09-06 with `services/media-service` (ADR 0023).*
- **11b** `docker build services/tts-sidecar` succeeds against the pinned `ghcr.io/remsky/kokoro-fastapi-cpu` digest. Build context is **`services/tts-sidecar`**, not the repo root: the image is a pinned upstream base plus a healthcheck and copies nothing from the workspace.
- **11c** `services/tts-sidecar/packaging/{macos,linux,windows}/` each hold a script stub, and `services/tts-sidecar/packaging/README.md` states they are deliberately not run in CI.

## AC-12 — Infrastructure validates without credentials

> `infra/docker-compose.hosted.yml` passes `docker compose config` with services api, worker,
> media-service, tts, postgres; `infra/terraform/` passes `terraform validate` (no
> credentials) declaring a VM, firewall, R2 bucket and DNS records with the provider as a
> variable.

- **12a** *(Relocated.)* `docker compose -f infra/docker-compose.hosted.yml config` exits 0 and its output names all five services. — *Relocated 2026-09-06 with the hosted stack (ADR 0023).*
- **12b** `terraform -chdir=infra/terraform init -backend=false && terraform -chdir=infra/terraform validate` exits 0 with no credentials in the environment.
  - *Note 2026-09-06 (ADR 0023):* unchanged in wording and still run in CI, now against the reduced Cloudflare-only module — object storage plus a cached custom domain, which is what release artefacts and the first-run downloads of ADR 0005 are delivered from ([ADR 0011](adr/0011-cloudflare-r2-for-storage-and-delivery-no-aws.md)).
- **12c** *(Relocated.)* `infra/terraform/variables.tf` declares `vm_provider` with default `"hetzner"`. — *Relocated 2026-09-06 with the VM module (ADR 0023).*

## AC-13 — Root documentation and repository files

> Root `README.md` explains layout, tiers, how to run each app, and links to ADRs;
> `.editorconfig`, `.gitignore`, `.gitattributes`, `LICENSE` placeholder (proprietary for
> now), `CODEOWNERS`.

- **13a** All six root files the criterion names exist: `README.md`, `.editorconfig`, `.gitignore`, `.gitattributes`, `LICENSE`, `CODEOWNERS`.
- **13b** `README.md` contains the layout tree, a tier table, a run command per app, and a relative link to `docs/adr/`.
- **13c** `.gitattributes` sets `* text=auto eol=lf` so the AC-7 byte-identity assertion holds on Windows.
- *Amended 2026-09-06 (ADR 0022 and ADR 0023):* **"`LICENSE` placeholder (proprietary for now)" is no longer true and has not been since ADR 0022.** The six published packages are Apache-2.0; `LICENSE` states the split per directory and `LICENSE-APACHE-2.0` and `NOTICE` sit beside it. The criterion's *requirement* — that a licence file exists and is unambiguous about what it covers — is met and is now load-bearing rather than a placeholder.

## AC-14 — The CLI is the local runtime

> `pnpm --filter @xplainer/cli build` then `node apps/cli/dist/bin.js --version` prints the
> package version; `--help` lists `serve`, `mcp`, `setup`, `connect`; `xplainer serve --port
> 8787` serves `GET /healthz` → 200 and a Streamable HTTP MCP endpoint at `/mcp` whose
> `tools/list` equals `packages/protocol`'s manifest (a Vitest asserts this, mirroring AC-8);
> `apps/desktop` depends on `@xplainer/cli` and contains no render/TTS code;
> `apps/cli/packaging/README.md` documents the standalone-binary recipe per OS as non-CI.

*Amended 2026-09-06 (ADR 0020):* `--help` lists `serve`, `mcp`, `setup`, `connect`, `daemon`,
and `xplainer daemon --help` lists `install`, `uninstall`, `start`, `stop`, `restart`,
`status`, `logs`. The assertion changes value, not shape: `program.test.ts` keeps `toEqual`
and gains a second `toEqual` pinning the seven verbs. Widening to `toContain` would destroy
the criterion — its value was never the number four, but that the command surface is **fixed
and asserted** and that commander's implicit `help [command]` can never reappear in it.

- **14a** `pnpm --filter @xplainer/cli build && node apps/cli/dist/bin.js --version` prints the version from `apps/cli/package.json`.
- **14b** `node apps/cli/dist/bin.js --help` lists exactly `serve`, `mcp`, `setup` and `connect` (as amended above, plus `daemon`). **This only holds because commander's implicit help subcommand is disabled**, which is added automatically as soon as a program has subcommands; left on, the listing would also contain `help [command]` and the assertion could never pass.
- **14c** `node apps/cli/dist/bin.js serve --port 8787` then `curl -sf localhost:8787/healthz` returns 200.
- **14d** `pnpm --filter @xplainer/cli test` includes a Vitest that drives `tools/list` against the served `/mcp` endpoint and asserts the names equal `TOOL_NAMES` from `@xplainer/protocol`.
  - *Note 2026-09-06 (ADR 0023):* this was written as the TypeScript mirror of AC-8c's pytest, with an explicit rule that the two must not drift. AC-8 relocated; 14d did not change, and it is now the only place the tool contract is asserted against the manifest in this repository.
- **14e** `apps/desktop/package.json` lists `@xplainer/cli` in `dependencies`.
- **14f** **`apps/desktop` contains no render or TTS code**, asserted by grep rather than by reading: `grep -rnE '@remotion/|\bremotion\b|kokoro|captioned_speech|tts' apps/desktop/src apps/desktop/*.ts apps/desktop/package.json` returns no hits.
- **14g** `apps/cli/packaging/README.md` exists and states per-OS standalone-binary steps for the Node single-executable route, marked explicitly as not run in CI.

---

## Tombstones

Criteria that judged hosted work. They are not deleted, because comments and CI step names in
both repositories still cite them. They are judged in `BrewMyTech/xplainer-hosted`.

| Id | What it judged | Where it lives now |
|---|---|---|
| **AC-8** | `apps/api` serves `/healthz` and a hosted Streamable HTTP `/mcp` whose `tools/list` matches the protocol manifest | `BrewMyTech/xplainer-hosted` |
| **AC-8a–8d** | The commands and pytest files behind AC-8 | `BrewMyTech/xplainer-hosted` |
| **AC-3d** | The Python import-linter contract and its violating fixture | `BrewMyTech/xplainer-hosted` |
| **AC-10b** | Both `.mcp.json` bundles point at `https://mcp.xplainer.video/mcp` | `BrewMyTech/xplainer-hosted`; replaced here by **AC-10b′** (local stdio, no `oauth_resource`) |
| **AC-11a** | The `services/media-service` image builds from the repository root and serves `/healthz` | `BrewMyTech/xplainer-hosted` |
| **AC-12a** | `infra/docker-compose.hosted.yml` configures all five hosted services | `BrewMyTech/xplainer-hosted` |
| **AC-12c** | `infra/terraform/` declares `vm_provider` defaulting to `"hetzner"` | `BrewMyTech/xplainer-hosted` |

The phase-1..phase-4 criteria (`P1-*`, `P2-*`, …) are not repeated here; they live in
[`ROADMAP.md`](ROADMAP.md), which is where they are still being written.
