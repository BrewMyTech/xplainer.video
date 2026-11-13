/**
 * Film time, without a page: the timer and animation-frame queues the harness drives, and the
 * frozen `Date`. The harness installs these on `window`; here they are exercised directly.
 */

import { describe, expect, it } from "vitest";
import {
  createFrozenDate,
  FILM_EPOCH_MS,
  FrameCallbackQueue,
  frameToFilmMs,
  HOLD_WAIT_FRAME_RATE,
  HOLD_WAIT_MIN_DELAY_MS,
  HoldWaitClock,
  TimerQueue,
} from "./clock.js";

const invoke = (callback: () => void): void => callback();

describe("frameToFilmMs", () => {
  it("is frame / fps · 1000, exact for whole frames", () => {
    expect(frameToFilmMs(0, 30)).toBe(0);
    expect(frameToFilmMs(3, 30)).toBe(100);
    expect(frameToFilmMs(90, 30)).toBe(3000);
    expect(frameToFilmMs(1, 24)).toBeCloseTo(41.6667, 4);
  });
});

describe("TimerQueue", () => {
  it("fires due timers in due order, ties in creation order, and leaves the rest", () => {
    const queue = new TimerQueue();
    const fired: string[] = [];
    queue.add(() => fired.push("b@50"), 50, false, 0);
    queue.add(() => fired.push("a@20"), 20, false, 0);
    queue.add(() => fired.push("c@50"), 50, false, 0);
    queue.add(() => fired.push("late@200"), 200, false, 0);
    expect(queue.runDue(100, invoke)).toBe(3);
    expect(fired).toEqual(["a@20", "b@50", "c@50"]);
    expect(queue.size).toBe(1);
    expect(queue.nextDue()).toBe(200);
  });

  it("holds a timer created during a drain for the next drain, even at delay 0", () => {
    const queue = new TimerQueue();
    let ticks = 0;
    const tick = (): void => {
      ticks += 1;
      queue.add(tick, 0, false, 0);
    };
    queue.add(tick, 0, false, 0);
    queue.runDue(0, invoke);
    expect(ticks).toBe(1);
    queue.runDue(0, invoke);
    expect(ticks).toBe(2);
  });

  it("fires an interval as many times as fit, then keeps it scheduled", () => {
    const queue = new TimerQueue();
    const at: number[] = [];
    let now = 0;
    queue.add(() => at.push(now), 10, true, 0);
    now = 100 / 3;
    queue.runDue(now, invoke);
    expect(at).toHaveLength(3);
    expect(queue.nextDue()).toBe(40);
  });

  it("treats a negative, missing or non-finite delay as 0, and clamps an interval period to 1 ms", () => {
    const queue = new TimerQueue();
    queue.add(() => {}, -5, false, 7);
    queue.add(() => {}, Number.NaN, false, 7);
    expect(queue.nextDue()).toBe(7);
    const fast = new TimerQueue();
    let count = 0;
    fast.add(() => (count += 1), 0, true, 0);
    fast.runDue(5, invoke);
    expect(count).toBe(6);
  });

  it("converts a delay with Number(), as a browser does, so a numeric string is its number", () => {
    const queue = new TimerQueue();
    queue.add(() => {}, "100", false, 0);
    expect(queue.nextDue()).toBe(100);
    for (const delay of ["abc", undefined, null, {}, "-5", Number.POSITIVE_INFINITY]) {
      const other = new TimerQueue();
      other.add(() => {}, delay, false, 7);
      expect(other.nextDue(), String(delay)).toBe(7);
    }
    const interval = new TimerQueue();
    let ticks = 0;
    interval.add(() => (ticks += 1), "10", true, 0);
    interval.runDue(35, invoke);
    expect(ticks).toBe(3);
  });

  it("clears by id and ignores anything that is not a live id", () => {
    const queue = new TimerQueue();
    let fired = false;
    const id = queue.add(() => (fired = true), 1, false, 0);
    queue.clear(undefined);
    queue.clear("1");
    queue.clear(id);
    queue.runDue(10, invoke);
    expect(fired).toBe(false);
  });

  it("leaves timers below fromId alone, for the harness's render-hold wait", () => {
    const queue = new TimerQueue();
    const fired: string[] = [];
    queue.add(() => fired.push("old interval"), 10, true, 0);
    const released = queue.nextId;
    queue.add(() => fired.push("release"), 50, false, 0);
    expect(queue.nextDue(released)).toBe(50);
    expect(queue.runDue(100, invoke, released)).toBe(1);
    expect(fired).toEqual(["release"]);
    expect(queue.nextDue(released)).toBeUndefined();
    expect(queue.nextDue()).toBe(10);
  });

  describe("rebase, for a timer a render-hold wait created", () => {
    const FILM = 100 / 3;

    /** What the harness does: schedule from film time plus the wall time the wait has run. */
    function waitThenRelease(wallMs: number): { queue: TimerQueue; fired: number[] } {
      const queue = new TimerQueue();
      const fired: number[] = [];
      queue.add(() => fired.push(-1), 50, true, 0); // an interval from an earlier frame
      const createdDuringWait = queue.nextId;
      // The image arrived `wallMs` into the wait; its onload armed a 90 ms timeout.
      queue.add(() => fired.push(90), 90, false, FILM + wallMs);
      queue.rebase(createdDuringWait, FILM);
      return { queue, fired };
    }

    it("makes a timeout due its own delay after the frame, however long the wait ran", () => {
      for (const wallMs of [20, 600, 1500]) {
        const { queue } = waitThenRelease(wallMs);
        expect(queue.nextDue(2)).toBe(FILM + 90);
      }
    });

    it("so the frame it fires on does not depend on the wait", () => {
      const firstFrameFiring = (wallMs: number): number => {
        const { queue, fired } = waitThenRelease(wallMs);
        for (let frame = 2; ; frame += 1) {
          queue.runDue(frameToFilmMs(frame, 30), invoke, 2);
          if (fired.includes(90)) {
            return frame;
          }
        }
      };
      expect([20, 600, 1500].map(firstFrameFiring)).toEqual([4, 4, 4]);
    });

    it("keeps an interval's ticks and its phase: where the same interval added at the frame would be", () => {
      const queue = new TimerQueue();
      const createdDuringWait = queue.nextId;
      let ticks = 0;
      // Created 5 ms into the wait with a 10 ms period, then 32 ms of wall clock ran it 3 times.
      queue.add(() => (ticks += 1), 10, true, FILM + 5);
      queue.runDue(FILM + 37, invoke);
      expect(ticks).toBe(3);
      queue.rebase(createdDuringWait, FILM);

      const atTheFrame = new TimerQueue();
      atTheFrame.add(() => {}, 10, true, FILM);
      expect(atTheFrame.runDue(FILM + 30, invoke)).toBe(3);
      expect(queue.nextDue()).toBe(atTheFrame.nextDue());
      expect(queue.nextDue()).toBeCloseTo(FILM + 40, 9);
    });

    it("lands a timer due exactly on a frame on that frame, to the last bit, from any wall offset", () => {
      // 100 ms after frame 1 at 30 fps is frame 4 exactly; a shift by the offset could miss it.
      for (let wallMs = 0.1; wallMs < 2000; wallMs = wallMs * 1.37 + 0.01) {
        const queue = new TimerQueue();
        queue.add(() => {}, 100, false, FILM + wallMs);
        queue.rebase(1, FILM);
        expect(queue.nextDue()).toBe(FILM + 100);
        expect(queue.runDue(frameToFilmMs(4, 30), invoke)).toBe(1);
      }
    });

    it("leaves timers created before the wait where they were, and reports what it moved", () => {
      const queue = new TimerQueue();
      queue.add(() => {}, 50, true, 0);
      const createdDuringWait = queue.nextId;
      queue.add(() => {}, 10, false, 70);
      expect(queue.rebase(createdDuringWait, 30)).toBe(1);
      expect(queue.nextDue()).toBe(40);
      expect(queue.nextDue(1)).toBe(40);
      queue.runDue(45, invoke);
      expect(queue.nextDue()).toBe(50);
    });
  });

  it("lets the caller decide what a throwing callback means", () => {
    const queue = new TimerQueue();
    const errors: string[] = [];
    queue.add(
      () => {
        throw new Error("boom");
      },
      0,
      false,
      0,
    );
    let after = false;
    queue.add(() => (after = true), 1, false, 0);
    queue.runDue(5, (callback) => {
      try {
        callback();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    });
    expect(errors).toEqual(["boom"]);
    expect(after).toBe(true);
  });
});

describe("FrameCallbackQueue", () => {
  it("runs queued callbacks once, in order, with the film timestamp", () => {
    const queue = new FrameCallbackQueue();
    const seen: string[] = [];
    queue.request((time) => seen.push(`a@${time}`));
    const cancelled = queue.request(() => seen.push("cancelled"));
    queue.request((time) => seen.push(`b@${time}`));
    queue.cancel(cancelled);
    expect(queue.drain(500, invoke)).toBe(2);
    expect(seen).toEqual(["a@500", "b@500"]);
    expect(queue.drain(533, invoke)).toBe(0);
  });

  it("defers a callback requested during a drain to the next one", () => {
    const queue = new FrameCallbackQueue();
    const seen: number[] = [];
    const loop = (time: number): void => {
      seen.push(time);
      queue.request(loop);
    };
    queue.request(loop);
    queue.drain(0, invoke);
    queue.drain(33, invoke);
    expect(seen).toEqual([0, 33]);
    expect(queue.size).toBe(1);
  });

  it("drains only callbacks requested since fromId, for the harness's render-hold wait", () => {
    const queue = new FrameCallbackQueue();
    const seen: string[] = [];
    queue.request(() => seen.push("an earlier frame's"));
    const released = queue.nextId;
    expect(queue.pending(released)).toBe(0);
    queue.request((time) => seen.push(`release@${time}`));
    expect(queue.pending(released)).toBe(1);
    expect(queue.pending()).toBe(2);
    expect(queue.drain(100, invoke, released)).toBe(1);
    expect(seen).toEqual(["release@100"]);
    expect(queue.pending(released)).toBe(0);
    expect(queue.drain(133, invoke)).toBe(1);
    expect(seen).toEqual(["release@100", "an earlier frame's"]);
  });

  it("does not run a callback an earlier one in the same drain cancelled", () => {
    const queue = new FrameCallbackQueue();
    const seen: string[] = [];
    let second = 0;
    queue.request(() => {
      seen.push("first");
      queue.cancel(second);
    });
    second = queue.request(() => seen.push("second"));
    expect(queue.drain(0, invoke)).toBe(1);
    expect(seen).toEqual(["first"]);
    expect(queue.size).toBe(0);
  });
});

describe("HoldWaitClock, for a render-hold wait", () => {
  const FILM = 5000;
  const STEP = 1000 / HOLD_WAIT_FRAME_RATE;

  /**
   * The harness's wait over the scene that raced: a hold released by a 100 ms timeout, a 120 ms
   * timeout beside it, and a `requestAnimationFrame` loop — all made on the held frame. `polls`
   * are the wall-clock offsets the wait happened to wake at; each takes events up to its own offset,
   * one at a time, and stops at the one that released the hold.
   */
  function heldFrame(polls: readonly number[]): {
    fired: string[];
    loopCalls: number;
    released: boolean;
    nowMs: number;
    nextDue: number | undefined;
  } {
    const timers = new TimerQueue();
    const frames = new FrameCallbackQueue();
    const fired: string[] = [];
    let held = true;
    let loopCalls = 0;
    const loop = (): void => {
      loopCalls += 1;
      frames.request(loop);
    };
    frames.request(loop);
    timers.add(
      () => {
        held = false;
        fired.push("release at 100");
      },
      100,
      false,
      FILM,
    );
    timers.add(() => fired.push("show at 120"), 120, false, FILM);
    const clock = new HoldWaitClock(FILM);
    for (const wallMs of polls) {
      while (held) {
        const event = clock.advance(timers.nextDue(), frames.pending() > 0, FILM + wallMs);
        if (event === undefined) {
          break;
        }
        if (event.kind === "timers") {
          timers.runDue(event.atMs, invoke);
        } else {
          frames.drain(FILM, invoke);
        }
      }
    }
    return { fired, loopCalls, released: !held, nowMs: clock.nowMs, nextDue: timers.nextDue() };
  }

  it("stops at the timer that released the hold, however late the poll that reached it", () => {
    const everyTwoMs = heldFrame(Array.from({ length: 80 }, (_, poll) => poll * 2));
    const oneLatePoll = heldFrame([0, 150]);
    const onlyLate = heldFrame([1000]);
    for (const wait of [everyTwoMs, oneLatePoll, onlyLate]) {
      expect(wait).toEqual({
        fired: ["release at 100"],
        // 0, 16.7, 33.3, 50, 66.7 and 83.3; the frame at 100 loses its tie to the release.
        loopCalls: 6,
        released: true,
        nowMs: FILM + 100,
        // The 120 ms timeout stays on film time, for the frame it belongs to.
        nextDue: FILM + 120,
      });
    }
  });

  it("takes no event the wall time waited has not reached, and leaves the clock where it was", () => {
    const clock = new HoldWaitClock(FILM);
    expect(clock.advance(FILM + 100, false, FILM + 99.9)).toBeUndefined();
    expect(clock.advance(undefined, false, FILM + 1000)).toBeUndefined();
    expect(clock.nowMs).toBe(FILM);
    expect(clock.advance(FILM + 100, false, FILM + 100)).toEqual({
      kind: "timers",
      atMs: FILM + 100,
    });
    expect(clock.nowMs).toBe(FILM + 100);
  });

  it("gives animation frames on a 60 Hz grid from the wait's start, one per step", () => {
    const clock = new HoldWaitClock(0);
    const at = [0, 1, 2, 3].map(() => clock.advance(undefined, true, 1000)?.atMs);
    expect(at).toEqual([0, STEP, 2 * STEP, 3 * STEP]);
  });

  it("runs timers before a frame at the same instant, and puts a frame a timer asked for on the next step", () => {
    const clock = new HoldWaitClock(0);
    expect(clock.advance(0, true, 1000)).toEqual({ kind: "timers", atMs: 0 });
    expect(clock.advance(undefined, true, 1000)).toEqual({ kind: "frame", atMs: 0 });
    expect(clock.advance(25, false, 1000)).toEqual({ kind: "timers", atMs: 25 });
    expect(clock.advance(undefined, true, 1000)).toEqual({ kind: "frame", atMs: 2 * STEP });
  });

  it("counts a timer and a frame a last bit apart as one instant, timers first", () => {
    const frameAt = (index: number): number => (index * 1000) / HOLD_WAIT_FRAME_RATE;
    const clock = new HoldWaitClock(0);
    for (const index of [0, 1, 2, 3, 4]) {
      expect(clock.advance(undefined, true, 1000)?.atMs).toBe(frameAt(index));
    }
    // Made on the frame at 33.3 with a 50 ms delay: due 83.33333333333334, the frame at
    // 83.33333333333333. One instant, so the timer runs first and the frame still follows.
    const due = frameAt(2) + 50;
    expect(due).not.toBe(frameAt(5));
    expect(clock.advance(due, true, 1000)).toEqual({ kind: "timers", atMs: due });
    expect(clock.advance(undefined, true, 1000)).toEqual({ kind: "frame", atMs: frameAt(5) });
  });

  /**
   * Run a wait the way the harness does — one event at a time, each timer created during the wait
   * scheduled from the clock's instant with the wait's minimum delay — until the hold is released
   * or `events` have run.
   */
  function wait(
    setUp: (page: {
      timers: TimerQueue;
      frames: FrameCallbackQueue;
      clock: HoldWaitClock;
      setTimeout: (callback: () => void, delay: number) => void;
      release: () => void;
    }) => void,
    events = 10_000,
  ): { released: boolean; nowMs: number } {
    const timers = new TimerQueue();
    const frames = new FrameCallbackQueue();
    const clock = new HoldWaitClock(FILM);
    let released = false;
    setUp({
      timers,
      frames,
      clock,
      setTimeout: (callback, delay) => {
        timers.add(callback, delay, false, clock.nowMs, HOLD_WAIT_MIN_DELAY_MS);
      },
      release: () => {
        released = true;
      },
    });
    for (let ran = 0; ran < events && !released; ran += 1) {
      const event = clock.advance(timers.nextDue(), frames.pending() > 0, Number.POSITIVE_INFINITY);
      if (event === undefined) {
        break;
      }
      if (event.kind === "timers") {
        timers.runDue(event.atMs, invoke);
      } else {
        frames.drain(FILM, invoke);
      }
    }
    return { released, nowMs: clock.nowMs };
  }

  it("lets the clock move past a zero-delay polling chain to the timer that ends it", () => {
    const result = wait(({ timers, setTimeout, release }) => {
      let ready = false;
      timers.add(
        () => {
          ready = true;
        },
        100,
        false,
        FILM,
      );
      const poll = (): void => {
        if (ready) {
          release();
        } else {
          setTimeout(poll, 0);
        }
      };
      timers.add(poll, 0, false, FILM);
    });
    expect(result.released).toBe(true);
    expect(result.nowMs).toBeGreaterThanOrEqual(FILM + 100);
    expect(result.nowMs).toBeLessThanOrEqual(FILM + 100 + HOLD_WAIT_MIN_DELAY_MS);
  });

  it("gives a frame that releases the hold its turn beside a zero-delay spin", () => {
    const result = wait(({ timers, frames, setTimeout, release }) => {
      const spin = (): void => {
        setTimeout(spin, 0);
      };
      timers.add(spin, 0, false, FILM);
      frames.request(release);
    });
    expect(result).toEqual({ released: true, nowMs: FILM });
  });

  it("schedules a timer made during the wait from the wait's instant, on the page's own order", () => {
    const timers = new TimerQueue();
    const clock = new HoldWaitClock(FILM);
    const fired: number[] = [];
    timers.add(
      () => {
        fired.push(clock.nowMs);
        timers.add(() => fired.push(clock.nowMs), 30, false, clock.nowMs);
      },
      50,
      false,
      FILM,
    );
    timers.add(() => fired.push(clock.nowMs), 70, false, FILM);
    for (;;) {
      const event = clock.advance(timers.nextDue(), false, FILM + 1000);
      if (event === undefined) {
        break;
      }
      timers.runDue(event.atMs, invoke);
    }
    expect(fired).toEqual([FILM + 50, FILM + 70, FILM + 80]);
  });
});

describe("createFrozenDate", () => {
  let film = 0;
  const FrozenDate = createFrozenDate(Date, () => film);

  it("reads film time for now, from 2020-01-01", () => {
    film = 0;
    expect(FrozenDate.now()).toBe(FILM_EPOCH_MS);
    expect(new FrozenDate().toISOString()).toBe("2020-01-01T00:00:00.000Z");
    film = 1500;
    expect(FrozenDate.now()).toBe(FILM_EPOCH_MS + 1500);
    expect(new FrozenDate().getTime()).toBe(FILM_EPOCH_MS + 1500);
  });

  it("reports whole milliseconds, as the native clock does, at a fractional film time", () => {
    film = 100 / 3;
    expect(FrozenDate.now()).toBe(FILM_EPOCH_MS + 33);
    expect(new FrozenDate().getTime()).toBe(FILM_EPOCH_MS + 33);
  });

  it("returns the film-time string when called without new", () => {
    film = 0;
    expect(Reflect.apply(FrozenDate, undefined, [])).toBe(new Date(FILM_EPOCH_MS).toString());
  });

  it("is the native Date for everything else", () => {
    expect(new FrozenDate(0).getTime()).toBe(0);
    expect(new FrozenDate(2024, 1, 3).getMonth()).toBe(1);
    expect(FrozenDate.UTC(2021, 0, 1)).toBe(Date.UTC(2021, 0, 1));
    expect(FrozenDate.parse("2021-01-01T00:00:00Z")).toBe(Date.UTC(2021, 0, 1));
    expect(new FrozenDate()).toBeInstanceOf(Date);
    expect(new Date(5)).toBeInstanceOf(FrozenDate);
  });
});
