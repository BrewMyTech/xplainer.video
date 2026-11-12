---
"@xplainer/motion": patch
---

0.1.0 was published without `dist/`. The tarball held `LICENSE`, `NOTICE`, `README.md` and `package.json` and nothing its `exports` named, so every import of `@xplainer/motion` failed with `ERR_MODULE_NOT_FOUND`. 0.1.1 ships the built package.
