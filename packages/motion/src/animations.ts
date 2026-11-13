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
 * mounted. A page asked for frame 70 alone, of an element that mounts at frame 40, has no earlier
 * frame to have seen it on, and shows it at 0 ms — which is why the renderer steps a still's page
 * through every frame before the one it captures, at the cost of setting each of them. A scene
 * whose animation is `interpolate()` on `useCurrentFrame()` is a pure function of the frame and
 * needs none of this.
 *
 * Scroll- and view-driven animations (`animation-timeline: scroll()` / `view()`) are not on the
 * document timeline and are not touched: their progress is the scroll position, not time.
 *
 * **Seeking moves an animation; it does not deliver its events.** `animationstart`,
 * `animationiteration`, `animationend`, the `transition*` events and their cancellations are
 * dispatched in a rendering update, from the phase each animation is in then against the phase it
 * was in at the previous one. A captured frame gets that update from its screenshot; a frame the
 * renderer only sets — a still's pre-roll — gets none, so an `onAnimationEnd` would record the
 * frame after the one it belongs to. The seeker therefore notes whether any animation appeared,
 * went, or changed phase or iteration (`takePhaseChange`), and the harness gives a frame it will not
 * capture a rendering update of its own exactly then. Most frames change no phase, so the pre-roll
 * stays a run of seeks.
 */

/** The part of `Animation` the seeker touches, so Node tests can hand it plain objects. */
export type SeekableAnimation = {
  pause(): void;
  currentTime: CSSNumberish | null;
  /** Compared by identity with the document's own timeline; nothing else is read from it. */
  readonly timeline: unknown;
  /** Read for the phase and iteration only; an animation without one is tracked by identity. */
  readonly effect?: { getComputedTiming(): ComputedEffectTiming } | null;
};

/** A number from a timing value, which a document-timeline animation always reports as one. */
function milliseconds(value: CSSNumberish | null | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Which phase an animation's effect is in, and which iteration — the two things whose change is an
 * event. The phases are Web Animations' own: before the active interval, in it, after it, or idle
 * with no local time. A paused animation plays forwards, so a local time exactly on the end is
 * after, as the specification places it.
 */
function phaseOf(animation: SeekableAnimation): string {
  const timing = animation.effect?.getComputedTiming();
  if (timing === undefined) {
    return "";
  }
  const local = milliseconds(timing.localTime);
  if (local === undefined) {
    return "idle";
  }
  const delay = timing.delay ?? 0;
  const end = milliseconds(timing.endTime) ?? 0;
  const active = milliseconds(timing.activeDuration) ?? 0;
  const beforeActive = Math.max(Math.min(delay, end), 0);
  const activeAfter = Math.max(Math.min(delay + active, end), 0);
  const phase = local < beforeActive ? "before" : local >= activeAfter ? "after" : "active";
  return `${phase}:${String(timing.currentIteration ?? null)}`;
}

export class AnimationSeeker {
  readonly #firstSeen = new WeakMap<SeekableAnimation, number>();
  /** Each animation the last seek touched, and the phase it left it in. */
  #lastPhase = new Map<SeekableAnimation, string>();
  #phaseChanged = false;

  /**
   * Pause and seek each animation on `timeline` — the document's — to film time; returns how many
   * were seeked. Any other animation is left alone: one driven by a scroll or view timeline
   * (`animation-timeline: scroll()`) measures its time in percentages of a scroll range, not in
   * milliseconds, and setting a number of milliseconds on it throws. Its progress follows the
   * scroll position, which a frame's own render already decides.
   */
  seek(animations: Iterable<SeekableAnimation>, filmMs: number, timeline: unknown): number {
    let count = 0;
    const phases = new Map<SeekableAnimation, string>();
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
      const phase = phaseOf(animation);
      phases.set(animation, phase);
      if (this.#lastPhase.get(animation) !== phase) {
        this.#phaseChanged = true;
      }
      count += 1;
    }
    // An animation that went owes a cancel event only if it went before it finished: a paused one
    // that reached its end with no fill leaves `document.getAnimations()` on the next seek, and that
    // is no event at all.
    for (const [animation, phase] of this.#lastPhase) {
      if (!phases.has(animation) && !phase.startsWith("after:")) {
        this.#phaseChanged = true;
        break;
      }
    }
    this.#lastPhase = phases;
    return count;
  }

  /**
   * Whether, since this was last asked, any seek found an animation it had not touched the time
   * before, missed one it had that had not finished, or moved one into another phase or iteration
   * — the changes a rendering update turns into events. Asking clears it.
   */
  takePhaseChange(): boolean {
    const changed = this.#phaseChanged;
    this.#phaseChanged = false;
    return changed;
  }
}
