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
| `runtime.ts` | The state scenes share with the harness: registration, render holds, failures, and the one `<Audio>` a video may mount |
| `static-file.ts` | `staticFile` over the bundle's `__XPLAINER_PUBLIC_BASE__` |
| `harness.ts` | The page driver; it composes the pure helpers below |
| `clock.ts`, `animations.ts`, `failures.ts`, `static-fetch.ts` | The harness's pure helpers — film-time queues, the render-hold wait's clock, frozen `Date`, Web Animation seeking and phase tracking, failure naming, the static `fetch` lookup — each tested in Node |
| `testing/` | Test-only: render a component at a frame with the real provider. Excluded from the build |

## Public surface

From `src/index.ts`: `useCurrentFrame`, `useVideoConfig`; `interpolate`, `Easing`, `spring`,
`measureSpring`, `random`; `AbsoluteFill`, `Sequence`, `Series`, `Loop`, `Freeze`, `Img`, `Audio`,
`Video`, `OffthreadVideo`; `staticFile`; `delayRender`, `continueRender`, `cancelRender`;
`registerRoot`, `Composition`, `registerVideo`; `paginateCaptions`, `createTikTokStyleCaptions`;
and the types `VideoConfig`, `CalculateMetadataFunction`, `Caption`, `TikTokPage` and every
component's props.

From `src/harness.ts`, as types only: `XplainerHarness`, `XplainerMetadata`, `XplainerReadiness`,
`XplainerRenderOptions`, `XplainerSetFrameOptions`, and the `Window` globals the bundle and the renderer agree on —
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
- **The `window.__xplainer` contract is the renderer's interface.** `metadata()`, `setFrame(n)`
  and `setFrame(n, { captured: false })` — a frame that will not be screenshotted, given a rendering
  update of its own when an animation changed phase on it, because that update is where animation
  and transition events are dispatched — `readiness()` and `frame`, the `pending` names (`metadata`, `first-settle`,
  `delayRender:<label>`, `img:<src>`, `fonts`), and the failure codes (`PAGE_ERROR`,
  `DELAY_RENDER_TIMEOUT`, `IMAGE_BROKEN`, `IMAGE_TIMEOUT`, `NOT_SUPPORTED_IN_V1`) are read by
  `apps/cli/src/render/`. Renaming one is a change on both sides in the same commit. Every
  rejection is an `Error` whose message starts with its code, because CDP reports only the message.
- **While a render hold is outstanding, the frame's own timers and animation-frame callbacks run
  on the wait's clock — and the wall clock is taken back out when it is released.** That is what
  releases `const h = delayRender(); setTimeout(() => continueRender(h), 100)` and its
  `requestAnimationFrame` twin, both of which deadlock on a pure film clock. The wait's clock
  (`HoldWaitClock`) moves one event at a time — the earliest due timer or its next 60 Hz frame,
  timers first on a tie — never ahead of the wall time waited, and the holds are checked after
  each, so the wait stops at the event that released it however late the poll that reached it:
  firing everything due by the wall time waited raced a second timer onto the held frame on some
  runs (ADR 0031's note of 2026-11-13). Film time, `Date` and `performance.now` stay frozen during
  the wait, and when the hold is released every timer the wait created is rebased onto the frame's
  film instant (`TimerQueue.rebase`), so how long a release took never reaches the video. The rule
  is in `harness.ts`'s docblock; do not "simplify" it away.
- **A frame is released once the page has stopped changing, or with a warning when it will not.**
  The settle runs in passes, and passes again while the last pass changed a node (a
  `MutationObserver` over the document), left a font loading, or left a hold or an image
  outstanding, up to `MAX_SETTLE_PASSES`; a frame whose DOM is still changing at the bound is
  released with one `console.warn` naming it, which the renderer puts in the job log. Every pass ends
  in two `MessageChannel` tasks, because that is one React effect → `setState` hop from effect to
  commit — one task was measured to release the frame between the two. So an `<img>` the frame's
  own work mounts — in the commit, behind a hold, or after effect hops that each change the DOM —
  is complete and decoded in that frame's capture. **There is still no late-image check, and that is
  deliberate:** what the settle cannot see — a `fetch` with no `delayRender`, renders that change
  no node, a chain longer than the pass bound — is just as invisible to a check on a later frame,
  and `delayRender` is how a scene says "wait for this".
- **The page's `Math.random` is seeded.** The harness replaces it with mulberry32 from a fixed seed
  (`random.ts`, `mulberry32Sequence`), reset at mount and never per frame, so a scene that uses it
  draws the same frames in every process. It is still order-dependent: front to back, which a
  render is and a pre-rolled still is.
- **The motion math is held to an independent derivation at 1e-9.** `math.test.ts` compares at
  least 200 seeded samples against closed forms, a bisection solve and an RK4 integration written
  in the test. A change that moves a curve fails there first; if the change is intended, it is a
  change to every existing video's motion and needs a changeset that says so. `random` is held
  **bit for bit** instead, to an FNV-1a and a mulberry32 written again in `BigInt` arithmetic in
  `random.test.ts`, and its golden table is the "stable across releases" promise `random.ts` makes.
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
