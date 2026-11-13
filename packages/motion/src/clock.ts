/**
 * Film time: the clock a captured page runs on instead of the wall clock.
 *
 * A browser animates against wall time — `Date.now()`, `performance.now()`, `setTimeout`,
 * `requestAnimationFrame` — and a capture that takes 40 ms per frame would otherwise see a scene
 * whose timers ran 40 ms per frame instead of 33. The harness replaces all four with **film
 * time**: `frame / fps · 1000` milliseconds, which only moves when the renderer asks for a frame.
 * These are the pieces of that replacement that need no `window`, so they are tested in Node; the
 * harness installs them.
 *
 * Three rules, each of which the spike found by being wrong first:
 *
 * - **Due timers fire in due order, ties in creation order** — the same order a browser would have
 *   fired them in, given time.
 * - **A timer created while the queue is draining waits for the next drain**, even with delay 0.
 *   Otherwise `setTimeout(tick, 0)` inside `tick` is an infinite loop inside one frame.
 * - **An interval fires as many times as fit**, so a 10 ms interval fires three times across one
 *   33 ms frame rather than once.
 */

/** 2020-01-01T00:00:00Z: what `Date.now()` reads at frame 0, so dates are stable across renders. */
export const FILM_EPOCH_MS: number = Date.UTC(2020, 0, 1);

/** Film milliseconds at a frame. Multiplies first, so whole frames at integer fps stay exact. */
export function frameToFilmMs(frame: number, fps: number): number {
  return (frame * 1000) / fps;
}

/**
 * A `Date` that reads film time when asked for "now" and is the native `Date` otherwise.
 *
 * A `Proxy` rather than a subclass because `Date()` called without `new` must keep working (it
 * returns a string), and `instanceof Date` must stay true for dates made either way; both fall out
 * of forwarding everything but the three "now" paths to the native constructor.
 */
export function createFrozenDate(
  NativeDate: DateConstructor,
  filmMs: () => number,
): DateConstructor {
  // Whole milliseconds, as the native clock reports them; film time at 30 fps is fractional.
  const now = (): number => FILM_EPOCH_MS + Math.floor(filmMs());
  return new Proxy(NativeDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget);
    },
    apply() {
      return new NativeDate(now()).toString();
    },
    get(target, property, receiver) {
      if (property === "now") {
        return now;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

type Timer = {
  id: number;
  due: number;
  /** The delay it was scheduled with, after clamping; `rebase` reschedules from it. */
  delay: number;
  /** How many times an interval has fired. */
  ticks: number;
  callback: () => void;
  /** `null` for a one-shot timer; the period for an interval. */
  interval: number | null;
};

/** `setTimeout` / `setInterval` against a clock somebody else advances. */
export class TimerQueue {
  readonly #timers = new Map<number, Timer>();
  #nextId = 1;

  /**
   * Schedule `callback` `delayMs` after `nowMs`. The delay is whatever the page passed, converted
   * with `Number()` — `setTimeout(fn, "100")` waits 100 ms — and one that converts to a
   * non-finite or negative number is 0. A fractional delay is kept as it is; a browser would
   * truncate it to whole milliseconds. `minDelayMs` raises any shorter delay to itself: the
   * render-hold wait passes `HOLD_WAIT_MIN_DELAY_MS`, so a zero-delay chain cannot stop its clock.
   */
  add(
    callback: () => void,
    delayMs: unknown,
    repeat: boolean,
    nowMs: number,
    minDelayMs = 0,
  ): number {
    const requested = Number(delayMs);
    const delay = Math.max(Number.isFinite(requested) && requested > 0 ? requested : 0, minDelayMs);
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, {
      id,
      due: nowMs + delay,
      delay,
      ticks: 0,
      callback,
      // A zero-period interval would fire without end inside one drain.
      interval: repeat ? Math.max(1, delay) : null,
    });
    return id;
  }

  /**
   * Reschedule every pending timer with an id of at least `fromId` as if it had been added at
   * `nowMs`, keeping what has happened to it since: a one-shot timer becomes due its own delay
   * after `nowMs`, and an interval that has fired `n` times becomes due where the same interval
   * added at `nowMs` would be after `n` firings — the same phase, on the new origin. The due time is
   * recomputed rather than shifted, so it is the same number to the last bit whatever it was
   * scheduled from; a shift could land a timer due exactly on a frame one ulp past it. Returns how
   * many it moved.
   *
   * This is how the harness takes the wall clock back out of a render-hold wait: a timer the wait
   * created was scheduled from film time plus however long the wait had run, and once the hold is
   * released it is rebased onto the frame's film instant, so when it fires no longer depends on how
   * long the page took to release the hold.
   */
  rebase(fromId: number, nowMs: number): number {
    let moved = 0;
    for (const timer of this.#timers.values()) {
      if (timer.id < fromId) {
        continue;
      }
      let due = nowMs + timer.delay;
      if (timer.interval !== null) {
        for (let tick = 0; tick < timer.ticks; tick += 1) {
          due += timer.interval;
        }
      }
      timer.due = due;
      moved += 1;
    }
    return moved;
  }

  /** Cancel a timer or an interval. Anything that is not a live id is ignored, as in a browser. */
  clear(id: unknown): void {
    if (typeof id === "number") {
      this.#timers.delete(id);
    }
  }

  /**
   * The id the next timer will get. Every timer created from now on has an id at least this
   * large, which is how a caller marks "timers created after this point" for `runDue`.
   */
  get nextId(): number {
    return this.#nextId;
  }

  /**
   * The earliest due time among timers with an id of at least `fromId` (all of them by default),
   * or `undefined` when there is none.
   */
  nextDue(fromId = 1): number | undefined {
    let earliest: number | undefined;
    for (const timer of this.#timers.values()) {
      if (timer.id < fromId) {
        continue;
      }
      if (earliest === undefined || timer.due < earliest) {
        earliest = timer.due;
      }
    }
    return earliest;
  }

  get size(): number {
    return this.#timers.size;
  }

  /**
   * Fire every timer due at or before `targetMs`, earliest first, ties in creation order. Timers
   * created while this runs are left for the next call, and timers with an id below `fromId` are
   * left alone entirely. Returns how many fired. `invoke` is how a callback is called, so the
   * caller decides what a throwing one means.
   */
  runDue(targetMs: number, invoke: (callback: () => void) => void, fromId = 1): number {
    const watermark = this.#nextId;
    let fired = 0;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.#timers.values()) {
        if (timer.id < fromId || timer.id >= watermark || timer.due > targetMs) {
          continue;
        }
        if (
          next === undefined ||
          timer.due < next.due ||
          (timer.due === next.due && timer.id < next.id)
        ) {
          next = timer;
        }
      }
      if (next === undefined) {
        return fired;
      }
      if (next.interval === null) {
        this.#timers.delete(next.id);
      } else {
        next.due += next.interval;
        next.ticks += 1;
      }
      fired += 1;
      invoke(next.callback);
    }
  }
}

/** `requestAnimationFrame` as a queue the harness drains once per captured frame. */
export class FrameCallbackQueue {
  readonly #callbacks = new Map<number, (timestamp: number) => void>();
  #nextId = 1;

  request(callback: (timestamp: number) => void): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#callbacks.set(id, callback);
    return id;
  }

  cancel(id: unknown): void {
    if (typeof id === "number") {
      this.#callbacks.delete(id);
    }
  }

  get size(): number {
    return this.#callbacks.size;
  }

  /** The id the next request will get; the same "requested after this point" mark as `TimerQueue`'s. */
  get nextId(): number {
    return this.#nextId;
  }

  /** How many queued callbacks have an id of at least `fromId`. */
  pending(fromId = 1): number {
    let count = 0;
    for (const id of this.#callbacks.keys()) {
      if (id >= fromId) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Run every queued callback with an id of at least `fromId` (all of them by default) with
   * `timestamp`, in request order, and leave the rest queued. A callback requested while this runs
   * belongs to the next drain, and one cancelled by an earlier callback in the same drain does not
   * run — both exactly as a browser runs a frame's callbacks.
   */
  drain(timestamp: number, invoke: (callback: () => void) => void, fromId = 1): number {
    const handles = [...this.#callbacks.keys()].filter((id) => id >= fromId);
    let ran = 0;
    for (const id of handles) {
      const callback = this.#callbacks.get(id);
      if (callback === undefined) {
        continue;
      }
      this.#callbacks.delete(id);
      ran += 1;
      invoke(() => callback(timestamp));
    }
    return ran;
  }
}

/** How often a render-hold wait gives the page an animation frame, on its own clock. */
export const HOLD_WAIT_FRAME_RATE = 60;

/**
 * The shortest delay a timer created during a render-hold wait gets. A browser clamps a nested
 * zero-delay timer to 4 ms; without a floor, `setTimeout(poll, 0)` re-armed from inside the wait
 * would be due at the wait's own instant every time, and its clock would never move on to the
 * timer or the frame that releases the hold.
 */
export const HOLD_WAIT_MIN_DELAY_MS = 1;

/**
 * How far apart a timer and a frame may be and still be one instant. A timer created on a frame of
 * the wait's grid is due at `(origin + k·1000/60) + d`, and the frame it should tie with is at
 * `origin + (k + n)·1000/60`; the two sums can differ in their last bit.
 */
const HOLD_WAIT_TIE_MS = 1e-6;

/** What a render-hold wait runs next: the due timers at one instant, or one animation frame. */
export type HoldWaitEvent = {
  kind: "timers" | "frame";
  /** The wait's own instant for it, in film milliseconds from the wait's origin. */
  atMs: number;
};

/**
 * The clock a render-hold wait runs its timers and animation frames on, so that the order they
 * run in is the page's own and never the wall clock's.
 *
 * A hold released by its own timer — `setTimeout(() => continueRender(h), 100)` — needs time to
 * pass while film time stands still, and the harness used to let the wall clock supply it: every
 * poll fired whatever was due by "film time plus the wall time waited". A poll that came late fired
 * the releasing timer and a later one together, so a `setTimeout(show, 120)` made beside the
 * release landed on the held frame on one run and four frames later on the next. This clock moves
 * one event at a time instead — the earliest due timer, or the next of its own 60 Hz animation
 * frames, timers first on a tie (to within `HOLD_WAIT_TIE_MS`) — and the harness re-checks the
 * holds after each, so the wait
 * stops at the event that released it however late the poll that reached it was.
 *
 * The wall clock still bounds it: an event is taken only once the wall time waited has reached
 * it (`limitMs`), so while a hold waits on something outside the page — an image, a `fetch` — the
 * timers already waiting run at the pace they would have, rather than every one of them at once. A
 * timer that outside work creates is scheduled from the wait's last instant, and so may run as
 * soon as the wall time allows.
 */
export class HoldWaitClock {
  readonly #originMs: number;
  #nowMs: number;
  /** The index of the next animation frame this wait can give, counted from the origin. */
  #frameIndex = 0;

  constructor(originMs: number) {
    this.#originMs = originMs;
    this.#nowMs = originMs;
  }

  /** The wait's current instant: where a timer created now is scheduled from. */
  get nowMs(): number {
    return this.#nowMs;
  }

  #frameAt(index: number): number {
    return this.#originMs + (index * 1000) / HOLD_WAIT_FRAME_RATE;
  }

  /**
   * Take the next event no later than `limitMs` and move the clock to it, or answer `undefined`
   * and leave the clock where it is. `timerDueMs` is the earliest due time among the timers the
   * wait may run; `framePending` is whether an animation-frame callback is waiting for one. A frame
   * falls on the first step of the 60 Hz grid from the origin that is not before now and has not
   * been given already, so a callback requested by a timer waits for the next step, as it would
   * in a browser.
   */
  advance(
    timerDueMs: number | undefined,
    framePending: boolean,
    limitMs: number,
  ): HoldWaitEvent | undefined {
    let frameMs: number | undefined;
    if (framePending) {
      while (this.#frameAt(this.#frameIndex) < this.#nowMs - HOLD_WAIT_TIE_MS) {
        this.#frameIndex += 1;
      }
      frameMs = this.#frameAt(this.#frameIndex);
    }
    let event: HoldWaitEvent | undefined;
    if (
      timerDueMs !== undefined &&
      (frameMs === undefined || timerDueMs <= frameMs + HOLD_WAIT_TIE_MS)
    ) {
      event = { kind: "timers", atMs: Math.max(timerDueMs, this.#nowMs) };
    } else if (frameMs !== undefined) {
      event = { kind: "frame", atMs: frameMs };
    }
    if (event === undefined || event.atMs > limitMs) {
      return undefined;
    }
    this.#nowMs = Math.max(this.#nowMs, event.atMs);
    if (event.kind === "frame") {
      this.#frameIndex += 1;
    }
    return event;
  }
}
