/**
 * The three React contexts the whole package hangs off.
 *
 * - `VideoConfigContext` — the resolved video (size, fps, duration, props). Set once, at the root.
 * - `TimelineContext` — **the frame as this subtree sees it**, plus the duration of the window it
 *   lives in. The root sets it to the absolute frame; every `Sequence`, `Loop` and `Freeze`
 *   re-provides it relative to itself. That single idea is the whole timing model: nested offsets
 *   add because each level subtracts its own `from` from what its parent saw, and
 *   `useCurrentFrame()` is nothing more than reading the nearest value.
 * - `CompositionCollectorContext` — how `registerRoot()` learns what `<Composition>` declared
 *   without the composition rendering anything (see `composition.tsx`).
 */

import { type Context, createContext, type ReactElement } from "react";

/** What `useVideoConfig()` returns. */
export type VideoConfig = {
  id: string;
  width: number;
  height: number;
  fps: number;
  /** The video's length, or the enclosing `Sequence`'s, clipped to its parent's window. */
  durationInFrames: number;
  defaultProps: Record<string, unknown>;
  /** The props the component was rendered with: `calculateMetadata`'s, else `defaultProps`. */
  props: Record<string, unknown>;
};

/** The frame a subtree sees, and the length of the window it is mounted in. */
export type Timeline = {
  frame: number;
  durationInFrames: number;
};

/** A video's metadata after `calculateMetadata` ran, and how to render it. */
export type ResolvedVideo = {
  config: VideoConfig;
  render: () => ReactElement;
};

/**
 * A `<Composition>` or `registerVideo()` call with its props type erased.
 *
 * The generic `Props` never leaves the closure `resolve` was built in, which is how a video with
 * any props shape fits one runtime slot without a cast.
 */
export type VideoRegistration = {
  id: string;
  resolve: (abortSignal: AbortSignal) => Promise<ResolvedVideo>;
};

export const VideoConfigContext: Context<VideoConfig | null> = createContext<VideoConfig | null>(
  null,
);

export const TimelineContext: Context<Timeline | null> = createContext<Timeline | null>(null);

export const CompositionCollectorContext: Context<
  ((registration: VideoRegistration) => void) | null
> = createContext<((registration: VideoRegistration) => void) | null>(null);
