---
"@xplainer/protocol": patch
"@xplainer/render-core": patch
"@xplainer/skill": patch
---

Stop citing documents an installer cannot open, and fix the plugin manifests' licence.

Ten JSON Schema `description` strings and four declaration comments cited
`max/server/explainer_mcp.py` by file and line — the reference implementation
this contract was ported from, which lives in a repository nobody who installs
these packages can read. Codegen carried those strings into the generated
TypeScript, the generated pydantic models and the emitted `.d.ts`, so they were
shipping. The substance of each description is unchanged; only the citation is,
and it now says "the reference implementation" rather than pointing at a path
that resolves for one person. ADR 0022 booked this as editorial work at the
source, and this is it.

Separately, `packages/skill`'s three plugin and marketplace manifests still
declared `"license": "UNLICENSED"`, contradicting the package they ship inside
and telling a prospective installer — on the marketplace listing, before they
install — that they have no right to run the plugin. They now declare
`Apache-2.0`, which is what the package has been licensed under since ADR 0022.
