/**
 * The harness's pure helpers: Web Animation seeking, failure naming, the static `fetch` lookup and
 * `staticFile`. Each is what the page-side harness calls; none needs a page.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AnimationSeeker, type SeekableAnimation } from "./animations.js";
import { describeFailure, FAILURE_CODES, failure, messageOf } from "./failures.js";
import { contentTypeFor, findStaticText, requestUrl } from "./static-fetch.js";
import { staticFile } from "./static-file.js";

const DOCUMENT_TIMELINE = { kind: "the document's timeline" };

class FakeAnimation implements SeekableAnimation {
  currentTime: number | null = 999;
  paused = false;
  readonly timeline: unknown;
  constructor(timeline: unknown = DOCUMENT_TIMELINE) {
    this.timeline = timeline;
  }
  pause(): void {
    this.paused = true;
  }
}

/**
 * An animation whose effect reports its timing the way a browser's does — a delay, then
 * `iterations` iterations of `durationMs`, filling forwards — so the seeker can read its phase.
 */
class TimedAnimation extends FakeAnimation {
  readonly effect: { getComputedTiming(): ComputedEffectTiming };
  constructor(durationMs: number, iterations: number, delayMs: number) {
    super();
    const active = durationMs * iterations;
    this.effect = {
      getComputedTiming: () => {
        const local = this.currentTime;
        return {
          localTime: local,
          delay: delayMs,
          activeDuration: active,
          endTime: delayMs + active,
          currentIteration:
            local === null
              ? null
              : Math.min(Math.floor(Math.max(local - delayMs, 0) / durationMs), iterations - 1),
        };
      },
    };
  }
}

/** A scroll timeline's animation: its time is a percentage, and a number of ms is refused. */
class ScrollDrivenAnimation implements SeekableAnimation {
  readonly timeline = { kind: "a scroll timeline" };
  paused = false;
  #time = 0;
  get currentTime(): number {
    return this.#time;
  }
  set currentTime(_value: CSSNumberish | null) {
    throw new TypeError("CSSNumericValue must be a percentage for progress based animations.");
  }
  pause(): void {
    this.paused = true;
  }
}

describe("AnimationSeeker", () => {
  it("pauses each animation and seeks it to film time since it was first seen", () => {
    const seeker = new AnimationSeeker();
    const early = new FakeAnimation();
    expect(seeker.seek([early], 1000, DOCUMENT_TIMELINE)).toBe(1);
    expect(early).toMatchObject({ paused: true, currentTime: 0 });

    const late = new FakeAnimation();
    seeker.seek([early, late], 1500, DOCUMENT_TIMELINE);
    expect(early.currentTime).toBe(500);
    expect(late.currentTime).toBe(0);

    seeker.seek([early, late], 2500, DOCUMENT_TIMELINE);
    expect(early.currentTime).toBe(1500);
    expect(late.currentTime).toBe(1000);
  });

  it("goes back in time when the frames do, from the same start", () => {
    const seeker = new AnimationSeeker();
    const animation = new FakeAnimation();
    seeker.seek([animation], 1000, DOCUMENT_TIMELINE);
    seeker.seek([animation], 3000, DOCUMENT_TIMELINE);
    seeker.seek([animation], 1200, DOCUMENT_TIMELINE);
    expect(animation.currentTime).toBe(200);
  });

  it("notes a change of phase or iteration, an animation it has not seen and one that went", () => {
    const seeker = new AnimationSeeker();
    // Before for 50 ms, two iterations of 100 ms, then after.
    const animation = new TimedAnimation(100, 2, 50);
    const changedAt = (filmMs: number, animations: SeekableAnimation[] = [animation]): boolean => {
      seeker.seek(animations, filmMs, DOCUMENT_TIMELINE);
      return seeker.takePhaseChange();
    };
    expect(changedAt(1000)).toBe(true); // first seen
    expect(changedAt(1040)).toBe(false); // still before
    expect(changedAt(1050)).toBe(true); // active, iteration 0
    expect(changedAt(1120)).toBe(false); // moved, same iteration
    expect(changedAt(1160)).toBe(true); // iteration 1: an animationiteration
    expect(changedAt(1250)).toBe(true); // after, exactly on the end: an animationend
    expect(changedAt(1300)).toBe(false); // still after
    expect(changedAt(1333, [])).toBe(false); // gone once finished: no event is owed
    // Gone while still running: an animationcancel.
    const running = new TimedAnimation(100, 1, 0);
    expect(changedAt(2000, [running])).toBe(true);
    expect(changedAt(2050, [])).toBe(true);
    expect(changedAt(2100, [])).toBe(false);
  });

  it("keeps a change until it is taken, whatever the seeks after it found", () => {
    const seeker = new AnimationSeeker();
    const animation = new TimedAnimation(100, 1, 0);
    seeker.seek([animation], 0, DOCUMENT_TIMELINE);
    seeker.seek([animation], 10, DOCUMENT_TIMELINE);
    seeker.seek([animation], 20, DOCUMENT_TIMELINE);
    expect(seeker.takePhaseChange()).toBe(true);
    expect(seeker.takePhaseChange()).toBe(false);
  });

  it("leaves an animation on any other timeline alone, a scroll timeline's included", () => {
    const seeker = new AnimationSeeker();
    const scrolled = new ScrollDrivenAnimation();
    const detached = new FakeAnimation(null);
    const timed = new FakeAnimation();
    expect(seeker.seek([scrolled, detached, timed], 1000, DOCUMENT_TIMELINE)).toBe(1);
    expect(scrolled.paused).toBe(false);
    expect(detached).toMatchObject({ paused: false, currentTime: 999 });
    expect(timed).toMatchObject({ paused: true, currentTime: 0 });
  });
});

describe("failure naming", () => {
  it("prefixes anything thrown with PAGE_ERROR", () => {
    expect(describeFailure(new Error("timings.json names no audio track"))).toBe(
      "PAGE_ERROR: timings.json names no audio track",
    );
    expect(describeFailure("a string")).toBe("PAGE_ERROR: a string");
    expect(describeFailure({ message: "an error-like object" })).toBe(
      "PAGE_ERROR: an error-like object",
    );
    expect(describeFailure(undefined)).toBe("PAGE_ERROR: undefined");
  });

  it("keeps a message that already starts with one of the codes", () => {
    for (const code of FAILURE_CODES) {
      expect(describeFailure(new Error(`${code}: detail`))).toBe(`${code}: detail`);
    }
    expect(describeFailure(new Error("NOT_SUPPORTED_IN_V1 without a colon"))).toBe(
      "PAGE_ERROR: NOT_SUPPORTED_IN_V1 without a colon",
    );
  });

  it("spells a failure as code, colon, detail", () => {
    expect(failure("IMAGE_BROKEN", "logo.png at frame 3")).toBe(
      "IMAGE_BROKEN: logo.png at frame 3",
    );
    expect(messageOf(new TypeError("x"))).toBe("x");
  });
});

describe("staticFile", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "__XPLAINER_PUBLIC_BASE__");
  });

  it("encodes each path segment and keeps the slashes", () => {
    expect(staticFile("timings.json")).toBe("timings.json");
    expect(staticFile("shots/step 1#a?.png")).toBe("shots/step%201%23a%3F.png");
    expect(staticFile("naïve.png")).toBe("na%C3%AFve.png");
    // A dot run that is not exactly ".." is a file name, not a step up.
    expect(staticFile("media/..logo.png")).toBe("media/..logo.png");
    expect(staticFile("media/.../x.png")).toBe("media/.../x.png");
  });

  it("refuses a name that would leave the video's public directory", () => {
    Reflect.set(globalThis, "__XPLAINER_PUBLIC_BASE__", "file:///tmp/job/public/demo/");
    for (const name of ["../other/timings.json", "media/../../secret.png", "..", "a/.."]) {
      expect(() => staticFile(name), name).toThrow(TypeError);
      expect(() => staticFile(name), name).toThrow(/a "\.\." segment would leave/);
    }
    for (const name of ["/narration.wav", "//host/a.png"]) {
      expect(() => staticFile(name), name).toThrow(/without a leading "\/"/);
    }
  });

  it("prefixes the public base the bundle sets", () => {
    Reflect.set(globalThis, "__XPLAINER_PUBLIC_BASE__", "file:///tmp/job/public/demo/");
    expect(staticFile("captions.json")).toBe("file:///tmp/job/public/demo/captions.json");
  });

  it("refuses a URL and an empty name", () => {
    expect(() => staticFile("https://example.com/a.png")).toThrow(/not a URL/);
    expect(() => staticFile("")).toThrow(/public directory/);
  });
});

describe("the static fetch lookup", () => {
  const page = "file:///tmp/job/out/demo/index.html";
  const toAbsolute = (url: string): string => new URL(url, page).href;
  const table = { "timings.json": '{"fps":30}', "captions.json": "[]" };

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "__XPLAINER_PUBLIC_BASE__");
  });

  it("answers a request for staticFile(name) from the table", () => {
    Reflect.set(globalThis, "__XPLAINER_PUBLIC_BASE__", "../../public/demo/");
    expect(findStaticText(staticFile("timings.json"), table, toAbsolute)).toEqual({
      name: "timings.json",
      text: '{"fps":30}',
    });
    expect(
      findStaticText("file:///tmp/job/public/demo/captions.json", table, toAbsolute)?.text,
    ).toBe("[]");
  });

  it("leaves everything else to the network", () => {
    Reflect.set(globalThis, "__XPLAINER_PUBLIC_BASE__", "../../public/demo/");
    expect(findStaticText("https://example.com/timings.json", table, toAbsolute)).toBeUndefined();
    expect(findStaticText(staticFile("other.json"), table, toAbsolute)).toBeUndefined();
    expect(findStaticText(staticFile("timings.json"), undefined, toAbsolute)).toBeUndefined();
  });

  it("reads the URL of a string, a URL and a Request", () => {
    expect(requestUrl("a.json")).toBe("a.json");
    expect(requestUrl(new URL("https://example.com/b.json"))).toBe("https://example.com/b.json");
    expect(requestUrl(new Request("https://example.com/c.json"))).toBe(
      "https://example.com/c.json",
    );
  });

  it("labels JSON as JSON", () => {
    expect(contentTypeFor("timings.json")).toBe("application/json");
    expect(contentTypeFor("notes.txt")).toBe("text/plain; charset=utf-8");
  });
});
