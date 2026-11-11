/**
 * The harness's pure helpers: Web Animation seeking, failure naming, the static `fetch` lookup and
 * `staticFile`. Each is what the page-side harness calls; none needs a page.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AnimationSeeker, type SeekableAnimation } from "./animations.js";
import { describeFailure, FAILURE_CODES, failure, messageOf } from "./failures.js";
import { contentTypeFor, findStaticText, requestUrl } from "./static-fetch.js";
import { staticFile } from "./static-file.js";

class FakeAnimation implements SeekableAnimation {
  currentTime: number | null = 999;
  paused = false;
  pause(): void {
    this.paused = true;
  }
}

describe("AnimationSeeker", () => {
  it("pauses each animation and seeks it to film time since it was first seen", () => {
    const seeker = new AnimationSeeker();
    const early = new FakeAnimation();
    expect(seeker.seek([early], 1000)).toBe(1);
    expect(early).toMatchObject({ paused: true, currentTime: 0 });

    const late = new FakeAnimation();
    seeker.seek([early, late], 1500);
    expect(early.currentTime).toBe(500);
    expect(late.currentTime).toBe(0);

    seeker.seek([early, late], 2500);
    expect(early.currentTime).toBe(1500);
    expect(late.currentTime).toBe(1000);
  });

  it("goes back in time when the frames do, from the same start", () => {
    const seeker = new AnimationSeeker();
    const animation = new FakeAnimation();
    seeker.seek([animation], 1000);
    seeker.seek([animation], 3000);
    seeker.seek([animation], 1200);
    expect(animation.currentTime).toBe(200);
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
    expect(staticFile("/narration.wav")).toBe("narration.wav");
    expect(staticFile("naïve.png")).toBe("na%C3%AFve.png");
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
