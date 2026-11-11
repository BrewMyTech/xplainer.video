/**
 * `random(seed)` — a deterministic number in `[0, 1)` per seed.
 *
 * A scene that scatters particles with `Math.random()` draws a different picture on every frame
 * and on every render, so a still never matches the video it was meant to preview. Keyed by a
 * seed, the same particle lands in the same place on every frame, in every process.
 *
 * The seed is hashed with 32-bit FNV-1a over its UTF-16 code units (a number seed is hashed as
 * its decimal string, so `random(7)` equals `random("7")`) and the hash seeds one step of
 * mulberry32. Both are public-domain, well-studied and a few lines long. The values are stable
 * across releases of this package but are **not** the values any other library returns for the
 * same seed: a scene ported from elsewhere gets a different, equally deterministic, scatter.
 *
 * `null` opts out and returns `Math.random()` — explicitly non-deterministic, for the rare case
 * that wants it.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function mulberry32(state: number): number {
  let t = (state + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function random(seed: number | string | null): number {
  if (seed === null) {
    return Math.random();
  }
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) {
      throw new TypeError(`random: a number seed must be finite, got ${String(seed)}.`);
    }
    return mulberry32(fnv1a(String(seed)));
  }
  if (typeof seed === "string") {
    return mulberry32(fnv1a(seed));
  }
  throw new TypeError(
    `random: the seed must be a number, a string or null, got ${typeof seed}. Pass null to opt out of determinism explicitly.`,
  );
}
