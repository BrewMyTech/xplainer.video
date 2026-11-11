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
  callback: () => void;
  /** `null` for a one-shot timer; the period for an interval. */
  interval: number | null;
};

/** `setTimeout` / `setInterval` against a clock somebody else advances. */
export class TimerQueue {
  readonly #timers = new Map<number, Timer>();
  #nextId = 1;

  /** Schedule `callback` `delayMs` after `nowMs`. A non-finite or negative delay is 0. */
  add(callback: () => void, delayMs: number, repeat: boolean, nowMs: number): number {
    const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, {
      id,
      due: nowMs + delay,
      callback,
      // A zero-period interval would fire without end inside one drain.
      interval: repeat ? Math.max(1, delay) : null,
    });
    return id;
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
      }
      fired += 1;
      invoke(next.callback);
    }
  }
}

/** `requestAnimationFrame` as a queue the harness drains once per captured frame. */
export class FrameCallbackQueue {
  #callbacks = new Map<number, (timestamp: number) => void>();
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

  /**
   * Run every queued callback with `timestamp`, in request order. A callback requested while this
   * runs belongs to the next frame, exactly as a browser schedules it.
   */
  drain(timestamp: number, invoke: (callback: () => void) => void): number {
    const queued = this.#callbacks;
    this.#callbacks = new Map();
    for (const callback of queued.values()) {
      invoke(() => callback(timestamp));
    }
    return queued.size;
  }
}
