/**
 * `random(seed)` held bit for bit to an FNV-1a and a mulberry32 written again here, independently
 * of the implementation: in `BigInt` arithmetic reduced mod 2³², rather than `Math.imul` and the
 * int32 coercions the package uses. The hash is first checked against FNV's own published test
 * vectors, so the reference is not merely agreeing with itself.
 *
 * The golden table pins the values `random.ts` promises are stable across releases: a change that
 * moves one is a change to every scattered particle in every existing video.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { random } from "./random.js";

const MOD = 2n ** 32n;
const u32 = (value: bigint): bigint => ((value % MOD) + MOD) % MOD;

/** 32-bit FNV-1a over UTF-16 code units. */
function fnv1aReference(text: string): bigint {
  let hash = 0x811c9dc5n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = u32(hash * 0x01000193n);
  }
  return hash;
}

/** One mulberry32 step from `state`, as a number in [0, 1). */
function mulberry32Reference(state: bigint): number {
  let t = u32(state + 0x6d2b79f5n);
  t = u32((t ^ (t >> 15n)) * (t | 1n));
  t = u32(t ^ u32(t + u32((t ^ (t >> 7n)) * (t | 61n))));
  return Number(u32(t ^ (t >> 14n))) / 2 ** 32;
}

const reference = (seed: number | string): number =>
  mulberry32Reference(fnv1aReference(String(seed)));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the reference", () => {
  it("is FNV-1a: it reproduces the published 32-bit test vectors", () => {
    expect(fnv1aReference("")).toBe(0x811c9dc5n);
    expect(fnv1aReference("a")).toBe(0xe40c292cn);
    expect(fnv1aReference("foobar")).toBe(0xbf9cf968n);
  });
});

describe("random", () => {
  it("returns the golden values for a fixed set of seeds", () => {
    const golden: readonly [number | string, number][] = [
      [0, 0.49139764392748475],
      [1, 0.8317172497045249],
      [7, 0.5916928979568183],
      [-3.5, 0.1799638953525573],
      ["particle-12", 0.6851458889432251],
      ["", 0.6112444521859288],
      ["naïve", 0.09887394378893077],
      ["😀", 0.9194794553332031],
    ];
    for (const [seed, value] of golden) {
      expect(random(seed), `random(${JSON.stringify(seed)})`).toBe(value);
      expect(reference(seed), `reference(${JSON.stringify(seed)})`).toBe(value);
    }
  });

  it("matches the reference bit for bit over 1000 number and string seeds", () => {
    for (let index = 0; index < 500; index += 1) {
      const number = index % 2 === 0 ? index : -index / 7;
      expect(random(number), `random(${number})`).toBe(reference(number));
      const text = `seed-${index}-${String.fromCharCode(0x3b1 + (index % 24))}`;
      expect(random(text), `random(${text})`).toBe(reference(text));
    }
  });

  it("hashes a number seed as its decimal string", () => {
    expect(random(7)).toBe(random("7"));
    expect(random(-0)).toBe(random("0"));
    expect(random(0.1 + 0.2)).toBe(random("0.30000000000000004"));
    expect(random(1e21)).toBe(random("1e+21"));
  });

  it("is deterministic: the same seed gives the same value, in a fresh copy of the module too", async () => {
    const first = [1, 2, 3, "a", "b"].map((seed) => random(seed));
    expect([1, 2, 3, "a", "b"].map((seed) => random(seed))).toEqual(first);
    vi.resetModules();
    const fresh = await import("./random.js");
    expect([1, 2, 3, "a", "b"].map((seed) => fresh.random(seed))).toEqual(first);
  });

  it("stays in [0, 1) and spreads across it", () => {
    const buckets = new Array<number>(10).fill(0);
    let sum = 0;
    for (let seed = 0; seed < 10_000; seed += 1) {
      const value = random(seed);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      sum += value;
      const bucket = Math.floor(value * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    expect(sum / 10_000).toBeGreaterThan(0.48);
    expect(sum / 10_000).toBeLessThan(0.52);
    for (const count of buckets) {
      expect(count).toBeGreaterThan(900);
      expect(count).toBeLessThan(1100);
    }
  });

  it("returns Math.random() for a null seed, and refuses a seed it cannot hash", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    expect(random(null)).toBe(0.25);
    expect(() => random(Number.NaN)).toThrow(/must be finite/);
    expect(() => random(Number.POSITIVE_INFINITY)).toThrow(/must be finite/);
    expect(() => Reflect.apply(random, undefined, [{}])).toThrow(/a number, a string or null/);
  });
});
