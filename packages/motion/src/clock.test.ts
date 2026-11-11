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
