/**
 * `@xplainer/motion` — the authoring API explainer scenes are written against.
 *
 * Side-effect free and importable in Node with no DOM: nothing here touches `window` until a
 * component renders. The page-side half — the frozen clock, the film-time timers and the
 * `window.__xplainer` driver the renderer calls — is `@xplainer/motion/harness`, a separate entry
 * point with side effects, which only the renderer's generated bundle entry imports.
 */

export {
  type Caption,
  type CreateTikTokStyleCaptionsInput,
  createTikTokStyleCaptions,
  type PageableCaption,
  type PaginateCaptionsOptions,
  paginateCaptions,
  type TikTokPage,
  type TikTokToken,
} from "./captions.js";
export {
  AbsoluteFill,
  type AbsoluteFillProps,
  Audio,
  type AudioProps,
  Freeze,
  type FreezeProps,
  Img,
  type ImgProps,
  Loop,
  type LoopProps,
  OffthreadVideo,
  Sequence,
  type SequenceLayout,
  type SequenceProps,
  Series,
  type SeriesProps,
  type SeriesSequenceProps,
  Video,
  type VideoProps,
} from "./components.js";
export {
  type CalculateMetadataFunction,
  type CalculateMetadataOptions,
  type CalculateMetadataResult,
  Composition,
  type CompositionProps,
  type RegisterVideoOptions,
  registerRoot,
  registerVideo,
} from "./composition.js";
export type { VideoConfig } from "./context.js";
export { Easing, type EasingFunction, type EasingModule } from "./easing.js";
export { useCurrentFrame, useVideoConfig } from "./hooks.js";
export { type ExtrapolateType, type InterpolateOptions, interpolate } from "./interpolate.js";
export { random } from "./random.js";
export { cancelRender, continueRender, type DelayRenderOptions, delayRender } from "./runtime.js";
export {
  type MeasureSpringOptions,
  measureSpring,
  type SpringConfig,
  type SpringOptions,
  spring,
} from "./spring.js";
export { staticFile } from "./static-file.js";
