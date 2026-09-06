# AGENTS.md — `@xplainer/tts-sidecar`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

The **TTS sidecar**: a pinned upstream Kokoro-FastAPI image plus the connection contract this
product talks to it with — the base URL, the pinned image digest, the two endpoint paths and the
default voice. In this phase it holds the contract only; synthesis, audio and timings land at
roadmap phase 1.

It is the **sole Python-only member** of the workspace, and `private: true`.

## Public surface

`src/xplainer_tts_sidecar/__init__.py` declares `__all__ = ["KOKORO_IMAGE", "KokoroSettings"]`.
That list is the surface. Nothing in the TypeScript workspace imports this package; the TypeScript
side of the same contract is `@xplainer/tts-client`, and the two must not disagree
([ADR 0006](../../docs/adr/0006-kokoro-fastapi-http-contract-as-tts-interface.md)).

## Commands

```bash
pnpm --filter @xplainer/tts-sidecar lint       # uv run --no-sync --project . ruff check .
pnpm --filter @xplainer/tts-sidecar typecheck  # uv run --no-sync --project . pyright
pnpm --filter @xplainer/tts-sidecar test       # uv run --no-sync --project . pytest
docker build services/tts-sidecar              # AC-11b; build context is this directory
```

Then the root procedure: `pnpm verify`.

## Invariants

- **Three scripts, and deliberately no `build`.** `lint`, `typecheck` and `test` only — there is
  nothing to compile. This is the one exception to the workspace's four-scripts rule, and it is why
  the `build` task covers eight members while the other three cover nine (`AC-2f`, `AC-2g`).
- **Every `uv run` carries `--no-sync`.** Every one, with no exception for scope. A uv workspace
  shares one environment and `uv run` is exact by default, so a bare member-scoped run prunes the
  other Python member out of it, and a bare root-scoped run prunes both. The reason is written in
  `pyproject.toml` and must not be rediscovered.
- **The ruff config is `extend = "../../ruff.toml"` plus this member's `src = ["src"]`.** It narrows
  what the rules run over, never what they are; `src` is declared so isort classifies
  `xplainer_tts_sidecar` as first-party under the src layout.
- **`pnpm turbo lint` is the contract, because it is what gates** — not because a root
  `ruff check .` would resolve configuration differently. Measured, the root form honours each
  member's exclusions and gives the same result. Run the gate, not an equivalent.
- **The image is pinned by digest**, and the build context is `services/tts-sidecar`, not the
  repository root: the image is a pinned upstream base plus a healthcheck and copies nothing from
  the workspace (`AC-11b`).
- **`packaging/{macos,linux,windows}/` are deliberately not run in CI** (`AC-11c`), and
  `packaging/README.md` says so. Do not wire them into a workflow without changing that criterion.

## How to add

**A setting:** add it to `KokoroSettings`, export it through `__all__`, and add a test that asserts
the default. A setting nothing asserts is a default that will drift.

**A contract change:** change ADR 0006 first, then this package **and** `@xplainer/tts-client`
together. The two sides of one HTTP contract do not move independently.

Finish with `pnpm verify`.
