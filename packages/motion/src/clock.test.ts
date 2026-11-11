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
