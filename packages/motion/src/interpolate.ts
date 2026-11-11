/**
 * `interpolate()` — map a frame (or any number) through a piecewise-linear table.
 *
 * The one function nearly every scene calls, so its edges are decided here rather than left to
 * whatever the arithmetic happens to do:
 *
 * - **The table is validated, loudly.** `inputRange` must be strictly increasing and finite, and
 *   the two ranges must be the same length, at least two. A scene with `[0, 30, 30, 60]` gets an
 *   `Error` naming the problem on its first frame, instead of a `NaN` that renders as an element
 *   silently missing from the picture.
 * - **The easing applies per segment, to the normalised position inside that segment.** A
 *   three-point table with `Easing.quad` eases into each of its two breakpoints, not once across
 *   the whole range.
 * - **Each side extrapolates independently.** `extend` (the default) continues the outer segment's
 *   formula, easing included; `clamp` holds the endpoint value; `identity` returns the input
 *   unchanged; `wrap` folds the input back into the whole input range, so a three-segment table
 *   loops as a unit.
 *
 * **`wrap`, precisely.** With `first = inputRange[0]`, `last` the final entry and
 * `span = last − first`, an input beyond the end whose side says `wrap` is replaced by
 * `first + ((input − first) mod span)`, the modulus taken non-negative, and the table is then read
 * at that point, easing and all. The period is the **whole** table, not the outer segment, and the
 * fold is a sawtooth, not a mirror: the result lies in `[first, last)`, so the input runs forward
 * through the table again on every period. An input exactly at `first` or `last` is inside the
 * range and is not folded — `last` reads the last output — while one a hair past `last` folds to a
 * hair past `first` and reads close to the **first** output. So unless the first and last outputs
 * are equal, a wrapped table jumps at each period boundary rather than looping smoothly; a loop
 * that must be continuous ends its table on the value it starts with. A whole number of periods
 * past either end (`last + span`, `first − span`, …) folds onto `first` and reads the first output.
 */

import type { EasingFunction } from "./easing.js";

/** What happens to an input beyond one end of `inputRange`. */
export type ExtrapolateType = "extend" | "clamp" | "identity" | "wrap";

export type InterpolateOptions = {
  /** Applied to the normalised position within each segment. Defaults to linear. */
  easing?: EasingFunction;
  /** Below `inputRange[0]`. Defaults to `"extend"`. */
  extrapolateLeft?: ExtrapolateType;
  /** Above the last `inputRange` entry. Defaults to `"extend"`. */
  extrapolateRight?: ExtrapolateType;
};

const EXTRAPOLATIONS: ReadonlySet<string> = new Set(["extend", "clamp", "identity", "wrap"]);

function assertRanges(inputRange: readonly number[], outputRange: readonly number[]): void {
  if (!Array.isArray(inputRange) || !Array.isArray(outputRange)) {
    throw new TypeError("interpolate: inputRange and outputRange must be arrays of numbers.");
  }
  if (inputRange.length < 2) {
    throw new RangeError(
      `interpolate: inputRange needs at least 2 entries, got ${inputRange.length}.`,
    );
  }
  if (inputRange.length !== outputRange.length) {
    throw new RangeError(
      `interpolate: inputRange has ${inputRange.length} entries and outputRange has ${outputRange.length}; they must be the same length.`,
    );
  }
  for (const [name, range] of [
    ["inputRange", inputRange],
    ["outputRange", outputRange],
  ] as const) {
    for (const [index, value] of range.entries()) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(
          `interpolate: ${name}[${index}] must be a finite number, got ${String(value)}.`,
        );
      }
    }
  }
  for (let index = 1; index < inputRange.length; index += 1) {
    const previous = inputRange[index - 1] ?? 0;
    const current = inputRange[index] ?? 0;
    if (current <= previous) {
      throw new RangeError(
        `interpolate: inputRange must be strictly increasing, but [${index - 1}]=${previous} and [${index}]=${current}.`,
      );
    }
  }
}

function assertExtrapolation(side: string, value: string): void {
  if (!EXTRAPOLATIONS.has(value)) {
    throw new RangeError(
      `interpolate: ${side} must be "extend", "clamp", "identity" or "wrap", got ${JSON.stringify(value)}.`,
    );
  }
}

/** `value` folded into `[low, high)` by the span's modulus, for `wrap`. */
function wrapInto(value: number, low: number, high: number): number {
  const span = high - low;
  return low + ((((value - low) % span) + span) % span);
}

export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options: InterpolateOptions = {},
): number {
  if (typeof input !== "number" || Number.isNaN(input)) {
    throw new TypeError(`interpolate: input must be a number, got ${String(input)}.`);
  }
  assertRanges(inputRange, outputRange);
  const {
    easing = (t: number): number => t,
    extrapolateLeft = "extend",
    extrapolateRight = "extend",
  } = options;
  assertExtrapolation("extrapolateLeft", extrapolateLeft);
  assertExtrapolation("extrapolateRight", extrapolateRight);

  const last = inputRange.length - 1;
  const first = inputRange[0] ?? 0;
  const end = inputRange[last] ?? 0;

  let x = input;
  if (x < first) {
    if (extrapolateLeft === "identity") {
      return x;
    }
    if (extrapolateLeft === "clamp") {
      return outputRange[0] ?? 0;
    }
    if (extrapolateLeft === "wrap") {
      x = wrapInto(x, first, end);
    }
  } else if (x > end) {
    if (extrapolateRight === "identity") {
      return x;
    }
    if (extrapolateRight === "clamp") {
      return outputRange[last] ?? 0;
    }
    if (extrapolateRight === "wrap") {
      x = wrapInto(x, first, end);
    }
  }

  // The segment whose start is the last breakpoint at or below x, held inside [0, last − 1] so an
  // extended input uses the outer segment's formula.
  let segment = 0;
  while (segment < last - 1 && x >= (inputRange[segment + 1] ?? 0)) {
    segment += 1;
  }
  const inMin = inputRange[segment] ?? 0;
  const inMax = inputRange[segment + 1] ?? 0;
  const outMin = outputRange[segment] ?? 0;
  const outMax = outputRange[segment + 1] ?? 0;
  if (outMin === outMax) {
    return outMin;
  }
  const t = (x - inMin) / (inMax - inMin);
  return outMin + easing(t) * (outMax - outMin);
}
