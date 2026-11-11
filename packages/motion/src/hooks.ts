/**
 * `useCurrentFrame()` and `useVideoConfig()` — the two reads every scene makes.
 *
 * Both throw outside a video rather than returning a default. A component rendered outside the
 * tree the harness mounts would otherwise animate as if it were permanently at frame 0, which is
 * a bug that looks exactly like a design choice.
 */

import { useContext } from "react";
import { type Timeline, TimelineContext, type VideoConfig, VideoConfigContext } from "./context.js";

function outside(hook: string): Error {
  return new Error(
    `${hook} was called outside a video. Call it from a component rendered under the <Composition> (or registerVideo) component.`,
  );
}

/** The timeline this component sees; shared by the hooks and the timing components. */
export function useTimeline(caller: string): Timeline {
  const timeline = useContext(TimelineContext);
  if (timeline === null) {
    throw outside(caller);
  }
  return timeline;
}

/**
 * The current frame, relative to the nearest enclosing `Sequence` (0 at its `from`), wrapped by
 * the nearest `Loop` and pinned by the nearest active `Freeze`.
 */
export function useCurrentFrame(): number {
  return useTimeline("useCurrentFrame()").frame;
}

/**
 * The video's size, fps, duration and props. Inside a `Sequence`, `durationInFrames` is how long
 * that sequence can be on screen — its own duration clipped to what is left of its parent's window,
 * open or not — and inside a `Loop`, one iteration's.
 */
export function useVideoConfig(): VideoConfig {
  const video = useContext(VideoConfigContext);
  const timeline = useContext(TimelineContext);
  if (video === null || timeline === null) {
    throw outside("useVideoConfig()");
  }
  return video.durationInFrames === timeline.durationInFrames
    ? video
    : { ...video, durationInFrames: timeline.durationInFrames };
}
