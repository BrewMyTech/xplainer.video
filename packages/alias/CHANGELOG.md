# xplainer

## 0.1.0

### Minor Changes

- f23a63b: `npx -y xplainer` and `npm i -g xplainer` now install `@xplainer/cli` 0.1.0, so everything in that
  release reaches this name too. xplainer renders with its own renderer instead of Remotion, and
  `xplainer setup` acquires a pinned FFmpeg beside the browser and speech. **A daemon installed by
  0.0.11 or earlier has to be reinstalled**: `xplainer update` and `xplainer setup` refuse with exit
  `3` and print the three commands that do it, `xplainer daemon uninstall`, `xplainer setup` and
  `xplainer daemon install`.

### Patch Changes

- 9dff313: Wording only, no behaviour change: the `xplainer` README's licence paragraph and a doc comment in
  `@xplainer/mcp-server`'s published types describe xplainer's own renderer rather than Remotion.
- 839886c: Wording only, no behaviour change. Every package's `LICENSE` and `NOTICE` drop the paragraphs about
  Remotion, because nothing installs it any more, and `NOTICE` now closes by saying that Apache-2.0
  does not cover the components `xplainer setup` acquires, the FFmpeg builds among them; it names
  BtbN's FFmpeg-Builds at its current address, `github.com/FFmpeg-Builds/FFmpeg-Builds`. The
  `@xplainer/cli`, `xplainer` and `@xplainer/render-core` READMEs describe `setup` acquiring the
  browser, FFmpeg and speech, the licences those downloads carry, and the two-file workspace template,
  and a doc comment in `@xplainer/mcp-server`'s published types no longer names Remotion.
- 5ef65e9: No behaviour change for anyone who installs the package. Its `package.json` gains a
  `prepublishOnly` script, which runs this repository's release check before the package is
  published and refuses the publish while anything listed as blocking a release is still open. An
  install from the registry never runs it. Inside this repository, where pnpm also runs it when it
  installs the workspace, the check stands aside unless a publish started it.
- Updated dependencies [7ea82a6]
- Updated dependencies [71cfaf7]
- Updated dependencies [c184479]
- Updated dependencies [1147b52]
- Updated dependencies [69ba5f6]
- Updated dependencies [8852117]
- Updated dependencies [b634869]
- Updated dependencies [24a006e]
- Updated dependencies [d54227e]
- Updated dependencies [4756795]
- Updated dependencies [b1de65d]
- Updated dependencies [6fbbbc8]
- Updated dependencies [839886c]
- Updated dependencies [5ef65e9]
  - @xplainer/cli@0.1.0

## 0.0.11

### Patch Changes

- Updated dependencies [f5b4f26]
  - @xplainer/cli@0.0.11

## 0.0.10

### Patch Changes

- @xplainer/cli@0.0.10

## 0.0.9

### Patch Changes

- Updated dependencies [4f2b4d8]
- Updated dependencies [bb7c64c]
  - @xplainer/cli@0.0.9

## 0.0.8

### Patch Changes

- Updated dependencies
  - @xplainer/cli@0.0.8

## 0.0.7

### Patch Changes

- Updated dependencies [3932672]
  - @xplainer/cli@0.0.7

## 0.0.6

### Patch Changes

- Updated dependencies [e013f7a]
  - @xplainer/cli@0.0.6

## 0.0.5

### Patch Changes

- @xplainer/cli@0.0.5

## 0.0.4

### Patch Changes

- @xplainer/cli@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [7e68dee]
- Updated dependencies [c95126e]
  - @xplainer/cli@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [458aa0b]
- Updated dependencies [78a4358]
  - @xplainer/cli@0.0.2

## 0.0.1

### Patch Changes

- cd0544a: Add the unscoped `xplainer` package: an alias for `@xplainer/cli`, so that
  `npm i -g xplainer` and `npx xplainer` work without the scope.

  It carries one dependency — `@xplainer/cli` at the same exact version — and one file. Its `bin`
  resolves that package, reads `bin["xplainer"]` out of the dependency's own manifest, and imports
  the file it names **in the same process**, so the exit code, the signal handlers and all three
  streams are the CLI's own rather than a parent's approximation of them. That matters most for
  `xplainer mcp`, whose stdout is a JSON-RPC stream an agent parses: this forwarder writes to stdout
  on no path, not even to refuse.

  The alias has no behaviour of its own and no importable surface. Every command, flag and exit code
  is `@xplainer/cli`'s, and the version pin is the whole of the relationship between the two.

  **This entry was written by hand, and it is the only one in this repository that was.** This
  package was created after `changeset version` had already run for `0.0.1`, so its changeset was
  still unspent when `xplainer@0.0.1` was published; consuming it later would have filed content
  that had already shipped under `0.0.2`. The six other members' `0.0.1` sections were generated.
  See the note in [`AGENTS.md`](../../AGENTS.md) §Publishing a release about the tag.
