---
"@xplainer/tts-client": patch
---

Make the published entry point loadable by Node's ESM resolver.

`src/index.ts` re-exported from `"./client"` and `"./types"` without an extension. TypeScript's
`bundler` module resolution accepts that in source and emits it verbatim, so `dist/index.js` shipped
`from"./client"` — which Node refuses with `ERR_MODULE_NOT_FOUND`, because ESM does not guess
extensions. Anything importing this package at runtime rather than through a bundler failed on the
first import; `@xplainer/render-core`'s narration port is the first such caller, which is how it was
found. Both specifiers now carry `.js`, as `@xplainer/protocol`'s entry point already did.

No exported name, type or value changed.
