---
"@xplainer/render-core": minor
---

The workspace template no longer carries a `package.json` or a `package-lock.json`. Both pinned the
previous renderer's packages for `xplainer setup --workspace` to install, and that command is gone:
the renderer bundles every video against `@xplainer/cli`'s own install, so the workspace is sources
and outputs and nothing a package manager reads.

`WORKSPACE_FILES` is `tailwind.css` and `tsconfig.json`, so `materialiseWorkspace()` copies those
two and creates `videos/`, `public/` and `out/`. `@xplainer/render-core/template/package.json` and
`@xplainer/render-core/template/package-lock.json` no longer resolve. A workspace materialised
earlier keeps the two files it was given until `xplainer setup` removes the tree they belonged to.
