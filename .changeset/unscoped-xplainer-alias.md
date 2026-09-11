---
"xplainer": patch
---

Add the unscoped `xplainer` package: an alias for `@xplainer/cli`, so that `npm i -g xplainer` and
`npx xplainer` work without the scope.

It carries one dependency — `@xplainer/cli` at the same exact version — and one file. Its `bin`
resolves that package, reads `bin["xplainer"]` out of the dependency's own manifest, and imports
the file it names **in the same process**, so the exit code, the signal handlers and all three
streams are the CLI's own rather than a parent's approximation of them. That matters most for
`xplainer mcp`, whose stdout is a JSON-RPC stream an agent parses: this forwarder writes to stdout
on no path, not even to refuse.

The alias has no behaviour of its own and no importable surface. Every command, flag and exit code
is `@xplainer/cli`'s, and the version pin is the whole of the relationship between the two.
