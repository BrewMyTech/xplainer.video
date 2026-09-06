# @xplainer/protocol

**The single source of truth for the xplainer tool contract.** `schemas/` holds hand-written
JSON Schema for the eight explainer tools and the documents they exchange; codegen turns those
same files into TypeScript types and a manifest, and into pydantic models and a manifest for
Python. Both languages come from the same schemas, which is the only reason the two halves
cannot drift.

```bash
npm i @xplainer/protocol
```

```ts
import { TOOL_NAMES, ENGINE_OWNED_FILES, type JobState } from "@xplainer/protocol";
```

The schemas ship as readable JSON and are importable directly:

```ts
import jobOutput from "@xplainer/protocol/schemas/tools/explainer_job.output.json" with { type: "json" };
```

Python consumers get the generated pydantic models from the same tarball, under `python/`.

## What is in here

- `schemas/tools/*.json` — one input and one output schema per tool
- `schemas/*.json` — the shared documents: `slug`, `job-state`, `job-error-code`, `timings`,
  `captions`, and the `manifest` that names the tools and the engine-owned files
- `dist/` — the generated TypeScript types, the tool manifest, and their declarations
- `python/` — the generated pydantic models

The generated files are never hand-edited; a schema change and its regenerated output land
together. The exported surface is recorded in `api/protocol.api.md` in the repository.

## Docs

- [Architecture][architecture] — the members and the dependency direction
- [Decision records][adr] — the tool contract is ADR 0007
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package.

[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
