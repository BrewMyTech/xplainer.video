# AGENTS.md — `@xplainer/motion`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

**The authoring API explainer scenes import, and the page-side harness the renderer drives.** Two
entry points with opposite rules:

- **`.` (`src/index.ts`) — side-effect free.** Frame hooks, `interpolate`, `Easing`, `spring`,
  `random`, the timing components, `staticFile`, the render holds, `registerRoot`/`Composition`,
  and caption paging. It imports in Node with no DOM; nothing touches `window` until a component
  renders.
- **`./harness` (`src/harness.ts`) — browser only, side effects on import.** The renderer's
  generated bundle entry imports it before the video's `index.ts`. It freezes the clock to film
  time, answers `fetch` for the bundle's static files, mounts the registered video into `#root`,
  and installs `window.__xplainer`, the driver the renderer calls over CDP.

It is clean-room: written from public behaviour and documented math (the damped harmonic
oscillator, the closed-form easings, CSS `cubic-bezier`), with no other renderer's source open.
Published, emits declarations, carries `api/motion.api.md` (the `.` entry point only — the harness
exports types and nothing a scene calls). Peer-depends on `react` and `react-dom` ^19.

| Module | What it owns |
|---|---|
| `interpolate.ts`, `easing.ts`, `spring.ts`, `random.ts` | The motion math, each a pure function |
| `captions.ts` | `paginateCaptions` and the compat `createTikTokStyleCaptions`; the paging rule is its docblock |
| `context.ts`, `provider.tsx`, `hooks.ts` | The timeline model: one context holding the frame a subtree sees |
| `components.tsx` | `AbsoluteFill`, `Sequence`, `Series`, `Loop`, `Freeze`, `Img`, `Audio`, `Video`/`OffthreadVideo` |
| `composition.tsx` | `Composition`, `registerRoot`, `registerVideo`, `calculateMetadata` resolution |
| `runtime.ts` | The state scenes share with the harness: registration, render holds, failures, `<Audio>` count |
| `static-file.ts` | `staticFile` over the bundle's `__XPLAINER_PUBLIC_BASE__` |
| `harness.ts` | The page driver; it composes the pure helpers below |
| `clock.ts`, `animations.ts`, `failures.ts`, `static-fetch.ts` | The harness's pure helpers — film-time queues, frozen `Date`, Web Animation seeking, failure naming, the static `fetch` lookup — each tested in Node |
| `testing/` | Test-only: render a component at a frame with the real provider. Excluded from the build |

## Public surface

From `src/index.ts`: `useCurrentFrame`, `useVideoConfig`; `interpolate`, `Easing`, `spring`,
`measureSpring`, `random`; `AbsoluteFill`, `Sequence`, `Series`, `Loop`, `Freeze`, `Img`, `Audio`,
`Video`, `OffthreadVideo`; `staticFile`; `delayRender`, `continueRender`, `cancelRender`;
`registerRoot`, `Composition`, `registerVideo`; `paginateCaptions`, `createTikTokStyleCaptions`;
and the types `VideoConfig`, `CalculateMetadataFunction`, `Caption`, `TikTokPage` and every
component's props.

From `src/harness.ts`, as types only: `XplainerHarness`, `XplainerMetadata`, `XplainerReadiness`,
`XplainerRenderOptions`, and the `Window` globals the bundle and the renderer agree on —
`__xplainer`, `__XPLAINER_STATIC__`, `__XPLAINER_PUBLIC_BASE__`, `__XPLAINER_RENDER__`.

## Commands

```bash
pnpm --filter @xplainer/motion test
pnpm turbo build --filter @xplainer/motion   # where TS9010 appears
```

Then the root procedure: `pnpm verify`.

## Invariants

- **`src/index.ts` and everything it reaches stay free of side effects.** No module-scope access to
  `window`, `document` or a timer; `sideEffects` in `package.json` names `dist/harness.js` alone,
  and a bundler is entitled to drop anything else that is unused. `runtime.test.tsx` imports the
  entry in Node and asserts nothing was installed.
- **The harness patches the clock only after `react-dom` has been imported.** React and its
  scheduler capture `setTimeout` and `MessageChannel` when their modules evaluate; patching first
  would put React's own scheduling on film time and stall it. The import order at the top of
  `harness.ts` is load-bearing.
- **The `window.__xplainer` contract is the renderer's interface.** `metadata()`, `setFrame(n)`,
  `readiness()` and `frame`, the `pending` names (`metadata`, `first-settle`,
  `delayRender:<label>`, `img:<src>`, `fonts`), and the failure codes (`PAGE_ERROR`,
  `DELAY_RENDER_TIMEOUT`, `IMAGE_BROKEN`, `IMAGE_TIMEOUT`, `NOT_SUPPORTED_IN_V1`) are read by
  `apps/cli/src/render/`. Renaming one is a change on both sides in the same commit. Every
  rejection is an `Error` whose message starts with its code, because CDP reports only the message.
- **While a render hold is outstanding, film timers run on the wall clock.** That is what releases
  `const h = delayRender(); setTimeout(() => continueRender(h), 100)`, which deadlocks on a pure
  film clock. Film time, `Date` and `performance.now` stay frozen during the wait. The rule is in
  `harness.ts`'s docblock; do not "simplify" it away.
- **There is no late-image check, and that is deliberate.** Every `<img>` must be complete and
  decoded before a frame is released, so an image cannot be captured blank and arrive later. A
  check for that case would have no reachable input.
- **The motion math is held to an independent derivation at 1e-9.** `math.test.ts` compares at
  least 200 seeded samples against closed forms, a bisection solve and an RK4 integration written
  in the test. A change that moves a curve fails there first; if the change is intended, it is a
  change to every existing video's motion and needs a changeset that says so.
- **The caption paging rule is shared with `@xplainer/render-core`.** `buildCaptions()` gives every
  word but the first a leading space precisely because the pager opens a page only on such a
  token. Changing either side alone welds or splits burned-in captions; `captions.test.ts` derives
  its expectations from the rule over `render-core`'s narration fixtures.
- **`isolatedDeclarations` is on `tsconfig.build.json`**, so `TS9010` surfaces under
  `pnpm turbo build` — not under `typecheck`, and not in your editor.

## How to add

**An export:** add it to `src/index.ts` explicitly (no `export *`), keep it free of module-scope
side effects, run `pnpm api:report` and commit `api/motion.api.md`.

**An easing or a motion function:** write the closed form, and add its independent derivation and
samples to `math.test.ts` in the same commit; the table's count only ever goes up.

**A component:** read the parent's timeline with `useTimeline`, decide whether the children mount,
and re-provide `TimelineContext` relative to the component. Test it through `src/testing/` with
`renderAtFrame`, asserting what a probe sees rather than the implementation's state.

**A harness behaviour:** put the logic in a pure helper next to `clock.ts` and test it in Node;
`harness.ts` should only wire helpers to `window`. The page itself is exercised by the renderer's
Chrome tests in `apps/cli`.

Finish with `pnpm verify`.
