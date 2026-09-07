/**
 * `timings.json`: the document every scene duration is derived from
 * (`narrate.py:266-298`) — roadmap P1-2, docs/ROADMAP.md.
 *
 * This is the single source of truth for how long a scene lasts. Nothing in a
 * composition may hand-write a duration: the shell reads this file, and because
 * every number in it was measured from the audio that was actually written, the
 * picture cannot drift from the voice.
 *
 * The frame numbers are derived here rather than in the composition so the
 * rounding happens once. `preflight()` refuses a render whose `timings.json` is
 * missing or unreadable, which is the other half of the same guarantee.
 */

import type { Timings, TimingsSegment } from "@xplainer/protocol";
import type { NarrationPlan } from "./plan.js";

/**
 * Render a plan as the `timings.json` document.
 *
 * @param plan what `planSegments()` measured
 * @param audio filename of the narration track, relative to the video's public
 *   directory — the same directory this document is written to
 */
export function buildTimings(plan: NarrationPlan, audio: string): Timings {
  const segments: TimingsSegment[] = plan.segments.map((segment) => ({
    id: segment.id,
    index: segment.index,
    startMs: segment.startMs,
    endMs: segment.endMs,
    from: segment.from,
    durationInFrames: segment.durationInFrames,
  }));

  return {
    fps: plan.fps,
    durationInFrames: plan.durationInFrames,
    totalMs: plan.totalMs,
    audio,
    segments,
  };
}
