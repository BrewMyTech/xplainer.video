/**
 * The star prompt, and the three properties that keep it from being the thing this CLI avoids.
 *
 * `connect/vendor-cli.ts` states the standing position — nothing here is interactive, because a CLI
 * that decided to prompt would hang a caller for ever. This is the one exception, so the cases that
 * matter most are not the happy path but the ones where it must stay silent: no terminal, and a
 * question already answered. `xplainer update` spawns `setup` as a child on every upgrade and every
 * `scripts/e2e/*.mjs` runs it with no terminal at all, so a regression in either of those two is a
 * hung release rather than a cosmetic bug.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isInteractive, NO_ANSWER, offerStar, readStarRecord, starMarkerPath } from "./star.js";

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-star-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A recording logger, so a case can assert what the user was told. */
function logger(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), lines };
}

const never = (): boolean => {
  throw new Error("this route must not be reached");
};

describe("offerStar", () => {
  it("asks nothing at all when there is no terminal", async () => {
    const dir = stateDir();
    const { log, lines } = logger();
    let asked = false;

    const record = await offerStar({
      stateDir: dir,
      log,
      interactive: false,
      ask: async () => {
        asked = true;
        return true;
      },
      gh: never,
    });

    // Silence, and no marker: a machine with no terminal has not answered, it was never asked.
    expect(asked).toBe(false);
    expect(record).toBeNull();
    expect(lines).toEqual([]);
    expect(readStarRecord(dir)).toBeNull();
  });

  it("never asks twice, whatever the first answer was", async () => {
    for (const first of ["starred", "declined", "failed"] as const) {
      const dir = stateDir();
      writeFileSync(
        starMarkerPath(dir),
        JSON.stringify({ decision: first, via: "gh", at: "2026-01-01T00:00:00.000Z" }),
      );
      const { log, lines } = logger();
      let asked = false;

      const record = await offerStar({
        stateDir: dir,
        log,
        interactive: true,
        alreadyStarred: () => false,
        ask: async () => {
          asked = true;
          return true;
        },
        gh: never,
      });

      expect(asked, `already answered "${first}"`).toBe(false);
      expect(record).toBeNull();
      expect(lines).toEqual([]);
    }
  });

  it("records a no without touching GitHub", async () => {
    const dir = stateDir();
    const { log, lines } = logger();

    const record = await offerStar({
      stateDir: dir,
      log,
      interactive: true,
      alreadyStarred: () => false,
      ask: async () => false,
      gh: never,
      token: never as unknown as (token: string) => Promise<boolean>,
      browser: never,
    });

    expect(record).toMatchObject({ decision: "declined", via: "declined" });
    // Declining is recorded, which is the whole reason it is never asked again.
    expect(readStarRecord(dir)).toMatchObject({ decision: "declined" });
    // And nothing is said: a no does not deserve a paragraph.
    expect(lines).toEqual([]);
  });

  it("prefers the GitHub CLI, and does not reach for a token when it works", async () => {
    const dir = stateDir();
    const { log, lines } = logger();

    const record = await offerStar({
      stateDir: dir,
      log,
      interactive: true,
      alreadyStarred: () => false,
      ask: async () => true,
      env: { GITHUB_TOKEN: "should-not-be-used" },
      gh: () => true,
      token: never as unknown as (token: string) => Promise<boolean>,
      browser: never,
    });

    expect(record).toMatchObject({ decision: "starred", via: "gh" });
    expect(lines.join(" ")).toContain("GitHub CLI");
  });

  it("falls back to a token when the GitHub CLI cannot do it", async () => {
    const dir = stateDir();
    const { log, lines } = logger();
    let sawToken: string | null = null;

    const record = await offerStar({
      stateDir: dir,
      log,
      interactive: true,
      alreadyStarred: () => false,
      ask: async () => true,
      env: { GH_TOKEN: "t0ken" },
      gh: () => false,
      token: async (value) => {
        sawToken = value;
        return true;
      },
      browser: never,
    });

    expect(sawToken).toBe("t0ken");
    expect(record).toMatchObject({ decision: "starred", via: "token" });
    expect(lines.join(" ")).toContain("token");
  });

  it("opens a browser when nothing on this machine can star for you", async () => {
    const dir = stateDir();
    const { log, lines } = logger();
    let opened: string | null = null;

    const record = await offerStar({
      stateDir: dir,
      log,
      interactive: true,
      alreadyStarred: () => false,
      ask: async () => true,
      env: {},
      gh: () => false,
      browser: (url) => {
        opened = url;
        return true;
      },
    });

    expect(opened).toBe("https://github.com/BrewMyTech/xplainer.video");
    expect(record).toMatchObject({ decision: "starred", via: "browser" });
    // The person is told where they were sent, because a window opening unannounced is worse than
    // one that was explained.
    expect(lines.join(" ")).toContain("open in your browser");
  });

  it("prints the URL rather than failing when there is no browser either", async () => {
    const dir = stateDir();
    const { log, lines } = logger();

    const record = await offerStar({
      stateDir: dir,
      log,
      interactive: true,
      alreadyStarred: () => false,
      ask: async () => true,
      env: {},
      gh: () => false,
      browser: () => false,
    });

    // Still recorded, so the question is not re-asked on a machine that simply cannot answer it.
    expect(record).toMatchObject({ decision: "failed", via: "browser" });
    expect(lines.join(" ")).toContain("https://github.com/BrewMyTech/xplainer.video");
  });

  it("asks again after an unreadable marker, rather than going silent for ever", async () => {
    const dir = stateDir();
    writeFileSync(starMarkerPath(dir), "{ this is not json");
    const { log } = logger();

    const record = await offerStar({
      stateDir: dir,
      log,
      interactive: true,
      alreadyStarred: () => false,
      ask: async () => false,
      gh: never,
    });

    expect(record).toMatchObject({ decision: "declined" });
    expect(JSON.parse(readFileSync(starMarkerPath(dir), "utf8")).decision).toBe("declined");
  });

  it("says nothing at all when the repository is already starred", async () => {
    const dir = stateDir();
    const { log, lines } = logger();
    let asked = false;

    const record = await offerStar({
      stateDir: dir,
      log,
      interactive: true,
      alreadyStarred: () => true,
      ask: async () => {
        asked = true;
        return true;
      },
      gh: never,
    });

    // The people most likely to resent the question are the ones who already said yes, and a local
    // marker cannot know about a star added from the web or on another machine.
    expect(asked).toBe(false);
    expect(record).toBeNull();
    expect(lines).toEqual([]);
    // Nothing recorded either: the answer is on GitHub, which outlives this state directory.
    expect(readStarRecord(dir)).toBeNull();
  });

  it("gives up after the timeout without recording anything", async () => {
    const dir = stateDir();
    const { log, lines } = logger();

    const record = await offerStar({
      stateDir: dir,
      log,
      interactive: true,
      alreadyStarred: () => false,
      ask: async () => NO_ANSWER,
      gh: never,
      browser: never,
    });

    expect(record).toBeNull();
    // **Not recorded, on purpose.** A recorded answer is never revisited, so treating silence as a
    // no would retire the question on a machine whose owner simply was not looking at it.
    expect(readStarRecord(dir)).toBeNull();
    expect(lines.join(" ")).toContain("ask again");
  });
});

describe("isInteractive", () => {
  it("treats a CI runner as nobody watching, whatever it did with the terminal", () => {
    // A runner can allocate a TTY and still have no one able to answer, so `CI` wins over `isTTY`.
    expect(isInteractive({ CI: "true" })).toBe(false);
    expect(isInteractive({ CI: "1" })).toBe(false);
  });

  it("ignores the variable when it is set to a value that means unset", () => {
    // Only the presence of a real value counts; `CI=false` is how some shells spell "not CI".
    const answer = isInteractive({ CI: "false" });
    expect(answer).toBe(process.stdin.isTTY === true && process.stdout.isTTY === true);
  });
});
