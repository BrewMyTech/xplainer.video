/**
 * Web Animations on film time.
 *
 * CSS animations, CSS transitions and `element.animate()` all run on the document timeline, which
 * is wall time and is not something the harness can replace. So instead of replacing the clock,
 * the harness pauses every animation after each frame commits and sets its `currentTime` itself:
 * film time now, minus the film time at which the harness first saw that animation. An animation
 * that starts when its element mounts at frame 40 is therefore at 0 ms on frame 40 and at
 * 1000 ms on frame 70 at 30 fps, however long the capture of the frames between took.
 *
 * **The start is when the harness first saw the animation, so the order of `setFrame` calls
 * matters.** A video rendered front to back sees every animation start at the frame its element
 * mounted. A single still taken at frame 70 of an element that was already mounted at frame 40
 * has no earlier frame to have seen it on, and shows it at 0 ms. That is the price of seeking an
 * animation the scene never tied to a frame; a scene that needs a still to match the video
 * animates with `interpolate()` on `useCurrentFrame()` instead, which is a pure function of the
 * frame.
 */

/** The part of `Animation` the seeker touches, so Node tests can hand it plain objects. */
export type SeekableAnimation = {
  pause(): void;
  currentTime: CSSNumberish | null;
};

export class AnimationSeeker {
  readonly #firstSeen = new WeakMap<SeekableAnimation, number>();

  /** Pause and seek each animation to film time; returns how many were seeked. */
  seek(animations: Iterable<SeekableAnimation>, filmMs: number): number {
    let count = 0;
    for (const animation of animations) {
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
