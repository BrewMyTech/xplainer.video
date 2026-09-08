/**
 * `Range`, which is the difference between a player and a download.
 *
 * The unit half asserts {@link parseRange} against RFC 9110 §14.1.1's four forms and §14.1.2's
 * definition of unsatisfiable; the wire half asserts that a real response carries the bytes those
 * ranges name — not merely the right *number* of bytes, which a slice off the wrong offset would
 * also satisfy. The artefact is written with a non-repeating pattern for exactly that reason.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artefactResponse, parseRange } from "./media.js";
import {
  type ApiHarness,
  pretendNarrated,
  send,
  startApiHarness,
  stopHarnesses,
  writeRenderedMp4,
  writeStill,
} from "./testing/harness.js";

afterEach(stopHarnesses);

const SIZE = 4_096;

/** A video with one MP4 of {@link SIZE} known bytes, and the bytes themselves. */
async function withFilm(): Promise<{ harness: ApiHarness; film: Buffer }> {
  const harness = await startApiHarness();
  await harness.backend.explainer_create({ slug: "film" });
  const path = writeRenderedMp4(harness, "film", SIZE);
  return { harness, film: readFileSync(path) };
}

function get(harness: ApiHarness, path: string, range?: string) {
  return send(
    { port: harness.server.port },
    path,
    range === undefined ? {} : { headers: { range } },
  );
}

describe("parseRange", () => {
  it("reads the three forms a client sends", () => {
    expect(parseRange("bytes=0-99", 1_000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1_000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1_000)).toEqual({ start: 900, end: 999 });
  });

  it("clamps a last-byte position past the end, which is what a player sends when seeking", () => {
    expect(parseRange("bytes=990-9999", 1_000)).toEqual({ start: 990, end: 999 });
    expect(parseRange("bytes=-9999", 1_000)).toEqual({ start: 0, end: 999 });
  });

  it("calls unsatisfiable exactly what RFC 9110 §14.1.2 does", () => {
    expect(parseRange("bytes=1000-", 1_000)).toBe("unsatisfiable");
    expect(parseRange("bytes=1000-1200", 1_000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1_000)).toBe("unsatisfiable");
    // Every range against a file with no bytes.
    expect(parseRange("bytes=0-0", 0)).toBe("unsatisfiable");
  });

  it("has no opinion about a header it does not understand, so the whole file is answered", () => {
    for (const header of [undefined, "bytes=0-1,5-6", "items=0-1", "bytes=x-y", "bytes=-", ""]) {
      expect([header, parseRange(header, 1_000)]).toEqual([header, null]);
    }
  });
});

describe("GET an artefact", () => {
  it("answers the whole file with Accept-Ranges, so a player knows it may ask for less", async () => {
    const { harness, film } = await withFilm();

    const answer = await get(harness, "/api/videos/film/artefacts/explainer.mp4");

    expect(answer.status).toBe(200);
    expect(answer.headers["accept-ranges"]).toBe("bytes");
    expect(answer.headers["content-type"]).toBe("video/mp4");
    expect(answer.headers["content-length"]).toBe(String(SIZE));
    expect(answer.headers["content-range"]).toBeUndefined();
    // An artefact is overwritten in place by the next render of the same video, and this surface
    // offers no validator, so it must not be cached.
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["last-modified"]).toBeDefined();
    expect(answer.bytes.equals(film)).toBe(true);
  });

  it("answers a range with 206 and those bytes", async () => {
    const { harness, film } = await withFilm();

    const answer = await get(
      harness,
      "/api/videos/film/artefacts/explainer.mp4",
      "bytes=1000-1099",
    );

    expect(answer.status).toBe(206);
    expect(answer.headers["content-range"]).toBe(`bytes 1000-1099/${SIZE}`);
    expect(answer.headers["content-length"]).toBe("100");
    expect(answer.bytes.equals(film.subarray(1000, 1100))).toBe(true);
  });

  it("answers an open-ended range to the end of the file", async () => {
    const { harness, film } = await withFilm();

    const answer = await get(harness, "/api/videos/film/artefacts/explainer.mp4", "bytes=4000-");

    expect(answer.status).toBe(206);
    expect(answer.headers["content-range"]).toBe(`bytes 4000-${SIZE - 1}/${SIZE}`);
    expect(answer.bytes.equals(film.subarray(4000))).toBe(true);
  });

  it("answers a suffix range with the last bytes, which is how a container index is read", async () => {
    const { harness, film } = await withFilm();

    const answer = await get(harness, "/api/videos/film/artefacts/explainer.mp4", "bytes=-64");

    expect(answer.status).toBe(206);
    expect(answer.headers["content-range"]).toBe(`bytes ${SIZE - 64}-${SIZE - 1}/${SIZE}`);
    expect(answer.bytes.equals(film.subarray(SIZE - 64))).toBe(true);
  });

  it("answers 416 with the file's length for a range it cannot satisfy", async () => {
    const { harness } = await withFilm();

    const answer = await get(harness, "/api/videos/film/artefacts/explainer.mp4", "bytes=99999-");

    expect(answer.status).toBe(416);
    expect(answer.headers["content-range"]).toBe(`bytes */${SIZE}`);
    expect(JSON.parse(answer.body)).toMatchObject({
      error: { code: "RANGE_NOT_SATISFIABLE" },
    });
  });

  it("ignores a range it does not understand and answers the whole file", async () => {
    const { harness, film } = await withFilm();

    for (const header of ["bytes=0-1, 5-6", "items=0-1", "bytes=abc"]) {
      const answer = await get(harness, "/api/videos/film/artefacts/explainer.mp4", header);
      expect([header, answer.status]).toEqual([header, 200]);
      expect([header, answer.bytes.equals(film)]).toEqual([header, true]);
    }
  });

  it("answers HEAD with the headers and no body, which is how a player sizes a file", async () => {
    const { harness } = await withFilm();

    const answer = await send(
      { port: harness.server.port },
      "/api/videos/film/artefacts/explainer.mp4",
      {
        method: "HEAD",
      },
    );

    expect(answer.status).toBe(200);
    expect(answer.headers["content-length"]).toBe(String(SIZE));
    expect(answer.headers["accept-ranges"]).toBe("bytes");
    expect(answer.bytes).toHaveLength(0);
  });

  it("answers HEAD with a range, and never gives one a body", async () => {
    const { harness } = await withFilm();

    const ranged = await send(
      { port: harness.server.port },
      "/api/videos/film/artefacts/explainer.mp4",
      { method: "HEAD", headers: { range: "bytes=0-9" } },
    );
    const refused = await send(
      { port: harness.server.port },
      "/api/videos/film/artefacts/explainer.mp4",
      { method: "HEAD", headers: { range: "bytes=99999-" } },
    );

    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 0-9/${SIZE}`);
    expect(ranged.bytes).toHaveLength(0);
    expect(refused.status).toBe(416);
    expect(refused.headers["content-range"]).toBe(`bytes */${SIZE}`);
    expect(refused.bytes).toHaveLength(0);
  });

  it("serves each kind of artefact with its own content type", async () => {
    const harness = await startApiHarness();
    await harness.backend.explainer_create({ slug: "kinds" });
    pretendNarrated(harness, "kinds");
    writeStill(harness, "kinds", 90);

    const expected: [string, string][] = [
      ["frame-90.png", "image/png"],
      ["narration.wav", "audio/wav"],
      ["captions.json", "application/json"],
      ["timings.json", "application/json"],
    ];
    for (const [name, contentType] of expected) {
      const answer = await get(harness, `/api/videos/kinds/artefacts/${name}`);
      expect([name, answer.status]).toEqual([name, 200]);
      expect([name, answer.headers["content-type"]]).toEqual([name, contentType]);
    }
  });

  it("serves a still with Range too, which is what the layout view scrubs through", async () => {
    const harness = await startApiHarness();
    await harness.backend.explainer_create({ slug: "layout" });
    const path = writeStill(harness, "layout", 90, 512);
    const still = readFileSync(path);

    const whole = await get(harness, "/api/videos/layout/artefacts/frame-90.png");
    const part = await get(harness, "/api/videos/layout/artefacts/frame-90.png", "bytes=8-71");

    expect(whole.status).toBe(200);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.bytes.equals(still)).toBe(true);
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 8-71/512");
    expect(part.bytes.equals(still.subarray(8, 72))).toBe(true);
  });

  it("answers an empty artefact with a zero length, and refuses a range against it", async () => {
    const harness = await startApiHarness();
    await harness.backend.explainer_create({ slug: "empty" });
    writeRenderedMp4(harness, "empty", 0);

    const whole = await get(harness, "/api/videos/empty/artefacts/explainer.mp4");
    const ranged = await get(harness, "/api/videos/empty/artefacts/explainer.mp4", "bytes=0-10");

    expect(whole.status).toBe(200);
    expect(whole.headers["content-length"]).toBe("0");
    expect(whole.bytes).toHaveLength(0);
    expect(ranged.status).toBe(416);
    expect(ranged.headers["content-range"]).toBe("bytes */0");
  });

  it("answers 404 for a file this video does not have, and for a name that is not one", async () => {
    const { harness } = await withFilm();

    for (const name of ["frame-1.png", "explainer.mp5", "..%2f..%2fetc%2fpasswd", "package.json"]) {
      const answer = await get(harness, `/api/videos/film/artefacts/${name}`);
      expect([name, answer.status]).toEqual([name, 404]);
      expect([name, (JSON.parse(answer.body) as { error: { code: string } }).error.code]).toEqual([
        name,
        "NO_SUCH_ARTEFACT",
      ]);
    }
  });

  /**
   * The one race this route cannot close: the file is enumerated and stat'd, and only then opened.
   * A render that replaced it in between, or an `out/` a user emptied, must fail the *body* — the
   * daemon carries on serving everything else, which is what the next request in this test proves.
   */
  it("fails the body, not the daemon, when the file goes between the stat and the read", async () => {
    const { harness } = await withFilm();
    const missing = artefactResponse(
      {
        path: join(harness.root, "out", "film", "gone.mp4"),
        bytes: 10,
        contentType: "video/mp4",
        modifiedAt: new Date(),
      },
      { method: "GET" },
    );

    expect(missing.status).toBe(200);
    await expect(missing.arrayBuffer()).rejects.toThrow();
    expect((await get(harness, "/api/videos/film/artefacts/explainer.mp4")).status).toBe(200);
  });

  it("answers 404 for a video that does not exist at all", async () => {
    const { harness } = await withFilm();

    const answer = await get(harness, "/api/videos/absent/artefacts/explainer.mp4");

    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "NO_SUCH_ARTEFACT" } });
  });
});
