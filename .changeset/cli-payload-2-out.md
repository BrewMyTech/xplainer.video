---
"@xplainer/cli": minor
---

The render workspace payload is gone, and with it every command that built, verified or installed
it. `xplainer setup --workspace`, `xplainer runtime build --workspace`, `runtime build
--from-runtime` and `runtime verify --workspace` are unknown options and exit `1`. `xplainer setup`
acquires three components — the browser, ffmpeg and speech — and `--skip-browser`, `--skip-ffmpeg`
and `--skip-speech` leave one out each; a run with all three skipped acquires nothing and still
rewrites a version-1 marker as version 2. `xplainer runtime` builds and verifies the runtime payload
only, and every refusal it makes exits `3`.

`xplainer setup` removes what an older `setup --workspace` installed in the video workspace —
`node_modules/`, `package.json`, `package-lock.json` and `workspace.manifest.json` — but only when
`workspace.manifest.json` records the previous renderer's entry **and** `package.json`'s name,
`dependencies` and `devDependencies` are exactly the last template's, and only after its refusal to
run under a daemon from before the `toolchain.json` cut has passed. It prints what it removed, and it
never touches `videos/`, `public/`, `out/`, `requests/`, `locks/`, `tailwind.css`, `tsconfig.json` or
anything else — so an `XPLAINER_VIDEOS_DIR` pointing at a project of your own is left exactly as it
is. A tree that looks like one `setup` wrote but whose `package.json` differs is kept, with a line
saying why.

`daemon update` no longer compares the two runtimes' template pins: its precondition is that both
runtimes read the same `toolchain.json` format and that the marker satisfies the incoming runtime.
Its step line reads "both runtimes read toolchain.json format 2, and the marker satisfies the
incoming runtime". Naming both `--from` and `--build`, neither, or a `--from` that does not exist is
still refused with exit `3`, now under its own reason.
