/**
 * Web Animations on film time.
 *
 * CSS animations, CSS transitions and `element.animate()` all run on the document timeline, which
 * is wall time and is not something the harness can replace. So instead of replacing the clock,
 * the harness pauses every animation on the document timeline after each frame commits and sets
 * its `currentTime` itself: film time now, minus the film time at which the harness first saw that
 * animation. An animation that starts when its element mounts at frame 40 is therefore at 0 ms on
 * frame 40 and at 1000 ms on frame 70 at 30 fps, however long the capture of the frames between
 * took.
 *
 * **The start is when the harness first saw the animation, so the order of `setFrame` calls
 * matters.** A video rendered front to back sees every animation start at the frame its element
 * mounted. A single still taken at frame 70 of an element that was already mounted at frame 40
 * has no earlier frame to have seen it on, and shows it at 0 ms. That is the price of seeking an
 * animation the scene never tied to a frame; a scene that needs a still to match the video
 * animates with `interpolate()` on `useCurrentFrame()` instead, which is a pure function of the
 * frame.
 *
 * Scroll- and view-driven animations (`animation-timeline: scroll()` / `view()`) are not on the
 * document timeline and are not touched: their progress is the scroll position, not time.
 */

/** The part of `Animation` the seeker touches, so Node tests can hand it plain objects. */
export type SeekableAnimation = {
  pause(): void;
  currentTime: CSSNumberish | null;
  /** Compared by identity with the document's own timeline; nothing else is read from it. */
  readonly timeline: unknown;
};

export class AnimationSeeker {
  readonly #firstSeen = new WeakMap<SeekableAnimation, number>();

  /**
   * Pause and seek each animation on `timeline` — the document's — to film time; returns how many
   * were seeked. Any other animation is left alone: one driven by a scroll or view timeline
   * (`animation-timeline: scroll()`) measures its time in percentages of a scroll range, not in
   * milliseconds, and setting a number of milliseconds on it throws. Its progress follows the
   * scroll position, which a frame's own render already decides.
   */
  seek(animations: Iterable<SeekableAnimation>, filmMs: number, timeline: unknown): number {
    let count = 0;
    for (const animation of animations) {
      if (animation.timeline !== timeline) {
        continue;
      }
      let start = this.#firstSeen.get(animation);
      if (start === undefined) {
        start = filmMs;
        this.#firstSeen.set(animation, start);
      }
      animation.pause();
      animation.currentTime = filmMs - start;
      count += 1;
    }
    return count;
  }
}
