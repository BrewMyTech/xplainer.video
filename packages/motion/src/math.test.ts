/**
 * The numerical table (AC-P1-1): `interpolate`, every `Easing` member, `spring` and
 * `measureSpring`, sampled deterministically and each compared at 1e-9 against a derivation
 * written here, independently of the implementation:
 *
 * - `interpolate` against a re-derivation that finds the segment by a linear scan and wraps with
 *   `floor` rather than a double modulus, with every easing evaluated from this file's own forms;
 * - each easing against its closed form, written out again below; `bezier` against a bisection
 *   solve of the Bernstein form, run until the bracket stops shrinking;
 * - `spring` against a fourth-order Runge–Kutta integration of m·x″ + c·x′ + k·x = k from rest,
 *   with a step of at most 5e-5 s — small enough that the integrator's own error stays three
 *   orders under the tolerance for every configuration below, the stiffest included;
 * - `overshootClamping` against that integration's first arrival at the target, found by stepping
 *   until x ≥ 1 and bisecting inside the last step, and held at the target from there on;
 * - `measureSpring` against a frame-by-frame scan of that same integration out to 60 s.
 *
 * The inputs come from a seeded mulberry32 stream, so the table is the same on every run, and the
 * last test asserts it holds at least 200 comparisons.
 */

import { describe, expect, it } from "vitest";
import { Easing, type EasingFunction } from "./easing.js";
import { type ExtrapolateType, interpolate } from "./interpolate.js";
import { measureSpring, type SpringConfig, spring } from "./spring.js";

const TOLERANCE = 1e-9;
const MINIMUM_SAMPLES = 200;

let samples = 0;
let worst = 0;

function compare(actual: number, expected: number, label: string): void {
  samples += 1;
  const error = Math.abs(actual - expected);
  worst = Math.max(worst, error);
  if (!(error <= TOLERANCE)) {
    expect.fail(`${label}: got ${actual}, expected ${expected} (error ${error})`);
  }
}

/** A seeded stream in [0, 1); the test's own copy, not the package's `random`. */
function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------- easing forms

function bounceReference(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) {
    return n1 * x * x;
  }
  if (x < 2 / d1) {
    const shifted = x - 1.5 / d1;
    return n1 * shifted * shifted + 0.75;
  }
  if (x < 2.5 / d1) {
    const shifted = x - 2.25 / d1;
    return n1 * shifted * shifted + 0.9375;
  }
  const shifted = x - 2.625 / d1;
  return n1 * shifted * shifted + 0.984375;
}

/** Bernstein form of one axis of the cubic through 0, p1, p2, 1. */
function bernstein(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/** Bisection on the Bernstein x-axis until the bracket cannot shrink further. */
function bezierReference(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0 || x >= 1) {
    if (x === 0) {
      return 0;
    }
    if (x === 1) {
      return 1;
    }
    if (x < 0) {
      const slope = x1 > 0 ? y1 / x1 : x2 > 0 ? y2 / x2 : 0;
      return slope * x;
    }
    const slope = x2 < 1 ? (y2 - 1) / (x2 - 1) : x1 < 1 ? (y1 - 1) / (x1 - 1) : 0;
    return 1 + slope * (x - 1);
  }
  let low = 0;
  let high = 1;
  for (;;) {
    const middle = (low + high) / 2;
    if (middle === low || middle === high) {
      break;
    }
    if (bernstein(middle, x1, x2) < x) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return bernstein((low + high) / 2, y1, y2);
}

const reference = {
  linear: (t: number): number => t,
  quad: (t: number): number => t ** 2,
  cubic: (t: number): number => t ** 3,
  poly: (n: number) => (t: number) => t ** n,
  sin: (t: number): number => 1 - Math.cos((Math.PI * t) / 2),
  circle: (t: number): number => 1 - Math.sqrt(1 - t ** 2),
  exp: (t: number): number => 2 ** (10 * t - 10),
  elastic:
    (b: number) =>
    (t: number): number =>
      1 - Math.cos((Math.PI * t) / 2) ** 3 * Math.cos(Math.PI * b * t),
  back:
    (s: number) =>
    (t: number): number =>
      (s + 1) * t ** 3 - s * t ** 2,
  bounce: bounceReference,
  bezier:
    (x1: number, y1: number, x2: number, y2: number) =>
    (t: number): number =>
      bezierReference(x1, y1, x2, y2, t),
  out:
    (f: (t: number) => number) =>
    (t: number): number =>
      1 - f(1 - t),
  inOut:
    (f: (t: number) => number) =>
    (t: number): number =>
      t < 0.5 ? f(2 * t) / 2 : 1 - f(2 - 2 * t) / 2,
};

type EasingCase = {
  name: string;
  actual: EasingFunction;
  expected: (t: number) => number;
  /** The domain sampled: [0, 1] unless the curve is defined, and extended, beyond it. */
  domain: readonly [number, number];
};

const UNIT = [0, 1] as const;
const EXTENDED = [-0.5, 1.5] as const;

const EASINGS: readonly EasingCase[] = [
  { name: "linear", actual: Easing.linear, expected: reference.linear, domain: EXTENDED },
  {
    name: "ease",
    actual: Easing.ease,
    expected: reference.bezier(0.42, 0, 1, 1),
    domain: EXTENDED,
  },
  { name: "quad", actual: Easing.quad, expected: reference.quad, domain: EXTENDED },
  { name: "cubic", actual: Easing.cubic, expected: reference.cubic, domain: EXTENDED },
  { name: "poly(2.5)", actual: Easing.poly(2.5), expected: reference.poly(2.5), domain: UNIT },
  { name: "poly(5)", actual: Easing.poly(5), expected: reference.poly(5), domain: EXTENDED },
  { name: "sin", actual: Easing.sin, expected: reference.sin, domain: EXTENDED },
  { name: "circle", actual: Easing.circle, expected: reference.circle, domain: UNIT },
  { name: "exp", actual: Easing.exp, expected: reference.exp, domain: EXTENDED },
  { name: "elastic()", actual: Easing.elastic(), expected: reference.elastic(1), domain: UNIT },
  {
    name: "elastic(2.5)",
    actual: Easing.elastic(2.5),
    expected: reference.elastic(2.5),
    domain: EXTENDED,
  },
  { name: "back()", actual: Easing.back(), expected: reference.back(1.70158), domain: EXTENDED },
  { name: "back(3)", actual: Easing.back(3), expected: reference.back(3), domain: UNIT },
  { name: "bounce", actual: Easing.bounce, expected: reference.bounce, domain: UNIT },
  {
    name: "bezier(0.25, 0.1, 0.25, 1)",
    actual: Easing.bezier(0.25, 0.1, 0.25, 1),
    expected: reference.bezier(0.25, 0.1, 0.25, 1),
    domain: EXTENDED,
  },
  {
    name: "bezier(0, 0, 0.58, 1)",
    actual: Easing.bezier(0, 0, 0.58, 1),
    expected: reference.bezier(0, 0, 0.58, 1),
    domain: EXTENDED,
  },
  {
    name: "bezier(0.68, -0.55, 0.265, 1.55)",
    actual: Easing.bezier(0.68, -0.55, 0.265, 1.55),
    expected: reference.bezier(0.68, -0.55, 0.265, 1.55),
    domain: EXTENDED,
  },
  {
    name: "bezier(0, 1, 1, 0)",
    actual: Easing.bezier(0, 1, 1, 0),
    expected: reference.bezier(0, 1, 1, 0),
    domain: UNIT,
  },
  {
    name: "bezier(0.9, 0.1, 0.1, 0.9)",
    actual: Easing.bezier(0.9, 0.1, 0.1, 0.9),
    expected: reference.bezier(0.9, 0.1, 0.1, 0.9),
    domain: UNIT,
  },
  { name: "in(quad)", actual: Easing.in(Easing.quad), expected: reference.quad, domain: EXTENDED },
  {
    name: "out(cubic)",
    actual: Easing.out(Easing.cubic),
    expected: reference.out(reference.cubic),
    domain: EXTENDED,
  },
  {
    name: "out(bounce)",
    actual: Easing.out(Easing.bounce),
    expected: reference.out(reference.bounce),
    domain: UNIT,
  },
  {
    name: "inOut(sin)",
    actual: Easing.inOut(Easing.sin),
    expected: reference.inOut(reference.sin),
    domain: EXTENDED,
  },
  {
    name: "inOut(back())",
    actual: Easing.inOut(Easing.back()),
    expected: reference.inOut(reference.back(1.70158)),
    domain: UNIT,
  },
  {
    name: "step0",
    actual: Easing.step0,
    expected: (t) => (t > 0 ? 1 : 0),
    domain: EXTENDED,
  },
  {
    name: "step1",
    actual: Easing.step1,
    expected: (t) => (t >= 1 ? 1 : 0),
    domain: EXTENDED,
  },
];

describe("Easing against its closed forms", () => {
  const next = stream(0xea51);
  for (const easing of EASINGS) {
    it(`${easing.name} matches its closed form at the endpoints and 8 seeded points`, () => {
      const [low, high] = easing.domain;
      const points = [0, 1, 0.5];
      for (let index = 0; index < 8; index += 1) {
        points.push(low + (high - low) * next());
      }
      for (const t of points) {
        compare(easing.actual(t), easing.expected(t), `${easing.name}(${t})`);
      }
    });
  }

  // Outside the 1e-9 table on purpose. bezier(1, 0, 0, 1) has dx/dt = 3(1 − 2t)², zero at
  // t = 0.5, so near x = 0.5 the inverse is t − 0.5 ≈ ∛((x − 0.5) / 4): a change in x at the last
  // representable digit (1e-16) moves t by ~3e-6, and no double-precision solver — this one or the
  // reference — can do better. Every curve whose x-axis is not stationary inside (0, 1) is held to
  // 1e-9 above.
  it("bezier stays within 1e-5 at an interior stationary point of x, where double precision ends", () => {
    const actual = Easing.bezier(1, 0, 0, 1);
    for (const x of [0.5, 0.5 + 1e-12, 0.5 - 1e-9, 0.49, 0.2, 0.8]) {
      expect(Math.abs(actual(x) - bezierReference(1, 0, 0, 1, x))).toBeLessThan(1e-5);
    }
  });

  it("bezier refuses a control point whose x leaves [0, 1]", () => {
    expect(() => Easing.bezier(1.2, 0, 0.5, 1)).toThrow(/x1 and x2 must lie within \[0, 1\]/);
    expect(() => Easing.bezier(0.2, 0, -0.1, 1)).toThrow(/x1 and x2 must lie within \[0, 1\]/);
  });
});

// ----------------------------------------------------------------------------------- interpolate

const INTERPOLATE_EASINGS: readonly {
  name: string;
  actual: EasingFunction | undefined;
  expected: (t: number) => number;
}[] = [
  { name: "default", actual: undefined, expected: reference.linear },
  { name: "quad", actual: Easing.quad, expected: reference.quad },
  { name: "cubic", actual: Easing.cubic, expected: reference.cubic },
  {
    name: "inOut(sin)",
    actual: Easing.inOut(Easing.sin),
    expected: reference.inOut(reference.sin),
  },
  { name: "back()", actual: Easing.back(), expected: reference.back(1.70158) },
  { name: "exp", actual: Easing.exp, expected: reference.exp },
  {
    name: "bezier(0.25, 0.1, 0.25, 1)",
    actual: Easing.bezier(0.25, 0.1, 0.25, 1),
    expected: reference.bezier(0.25, 0.1, 0.25, 1),
  },
];

const MODES: readonly ExtrapolateType[] = ["extend", "clamp", "identity", "wrap"];

function interpolateReference(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  ease: (t: number) => number,
  left: ExtrapolateType,
  right: ExtrapolateType,
): number {
  const n = inputRange.length;
  const first = inputRange[0] ?? 0;
  const last = inputRange[n - 1] ?? 0;
  const span = last - first;
  let x = input;
  const side = x < first ? left : x > last ? right : undefined;
  if (side === "identity") {
    return x;
  }
  if (side === "clamp") {
    return (x < first ? outputRange[0] : outputRange[n - 1]) ?? 0;
  }
  if (side === "wrap") {
    x -= span * Math.floor((x - first) / span);
  }
  let segment = 0;
  for (let index = 0; index <= n - 2; index += 1) {
    if ((inputRange[index] ?? 0) <= x) {
      segment = index;
    }
  }
  const a = inputRange[segment] ?? 0;
  const b = inputRange[segment + 1] ?? 0;
  const from = outputRange[segment] ?? 0;
  const to = outputRange[segment + 1] ?? 0;
  return from + (to - from) * ease((x - a) / (b - a));
}

describe("interpolate against a re-derivation", () => {
  const next = stream(0x1e7e);
  const modesSeen = new Map<string, number>();

  it("matches on 120 seeded tables, inputs and extrapolation pairs", () => {
    for (let index = 0; index < 120; index += 1) {
      const points = 2 + Math.floor(next() * 4);
      const inputRange: number[] = [];
      let cursor = -50 + next() * 100;
      for (let point = 0; point < points; point += 1) {
        inputRange.push(cursor);
        cursor += 1 + next() * 60;
      }
      const outputRange = inputRange.map(() => -500 + next() * 1000);
      const left = MODES[index % 4] ?? "extend";
      const right = MODES[Math.floor(index / 4) % 4] ?? "extend";
      const easing = INTERPOLATE_EASINGS[index % INTERPOLATE_EASINGS.length];
      if (easing === undefined) {
        throw new Error("no easing case");
      }
      const first = inputRange[0] ?? 0;
      const span = (inputRange[points - 1] ?? 0) - first;
      const input = first - span + next() * 3 * span;
      const side = input < first ? left : input > first + span ? right : "inside";
      modesSeen.set(side, (modesSeen.get(side) ?? 0) + 1);
      compare(
        interpolate(input, inputRange, outputRange, {
          ...(easing.actual === undefined ? {} : { easing: easing.actual }),
          extrapolateLeft: left,
          extrapolateRight: right,
        }),
        interpolateReference(input, inputRange, outputRange, easing.expected, left, right),
        `interpolate(${input}, [${inputRange.join(", ")}], [${outputRange.join(", ")}], ${easing.name}, ${left}/${right})`,
      );
    }
    for (const mode of ["inside", ...MODES]) {
      expect(modesSeen.get(mode) ?? 0, `samples exercising ${mode}`).toBeGreaterThan(5);
    }
  });

  it("is exact at every breakpoint, including an interior one", () => {
    const inputRange = [0, 10, 30, 60];
    const outputRange = [5, -5, 40, 0];
    for (const [index, x] of inputRange.entries()) {
      compare(
        interpolate(x, inputRange, outputRange, { easing: Easing.inOut(Easing.cubic) }),
        outputRange[index] ?? Number.NaN,
        `breakpoint ${x}`,
      );
    }
  });

  it("returns each breakpoint's own output to the last bit, whatever the easing does at its ends", () => {
    // exp starts at 2⁻¹⁰ and sin and back() end an ulp or two short of 1; the outputs are values
    // where `a + (b − a)` is not `b` in doubles.
    const inputRange = [0, 0.3, 1.1, 2, 7];
    const outputRange = [0.1, 0.7, -0.3, 1000 / 7, 0.30000000000000004];
    const easings: readonly [string, EasingFunction][] = [
      ["exp", Easing.exp],
      ["sin", Easing.sin],
      ["back()", Easing.back()],
      ["inOut(cubic)", Easing.inOut(Easing.cubic)],
      ["bounce", Easing.bounce],
      ["linear", Easing.linear],
    ];
    for (const [name, easing] of easings) {
      for (const [index, x] of inputRange.entries()) {
        const value = interpolate(x, inputRange, outputRange, { easing });
        if (value !== outputRange[index]) {
          expect.fail(`${name} at breakpoint ${x}: got ${value}, expected ${outputRange[index]}`);
        }
      }
    }
  });

  it("holds a flat segment flat whatever the easing does", () => {
    compare(interpolate(5, [0, 10], [7, 7], { easing: Easing.elastic(3) }), 7, "flat");
  });

  it("refuses a table it cannot read, naming the problem", () => {
    expect(() => interpolate(1, [0, 10, 10, 20], [0, 1, 2, 3])).toThrow(/strictly increasing/);
    expect(() => interpolate(1, [0, 10], [0, 1, 2])).toThrow(/same length/);
    expect(() => interpolate(1, [0], [0])).toThrow(/at least 2/);
    expect(() => interpolate(Number.NaN, [0, 10], [0, 1])).toThrow(/input must be a number/);
    expect(() => interpolate(1, [0, Number.POSITIVE_INFINITY], [0, 1])).toThrow(/finite/);
  });

  it("wraps as a sawtooth over the whole table, onto [first, last), as its docblock says", () => {
    const inputRange = [0, 10, 30];
    const outputRange = [0, 100, 50];
    const wrap = (x: number): number =>
      interpolate(x, inputRange, outputRange, {
        extrapolateLeft: "wrap",
        extrapolateRight: "wrap",
      });
    compare(wrap(30), 50, "wrap at last: inside, the last output");
    compare(wrap(30 + 1e-6), 1e-5, "wrap a hair past last: a hair past the first output");
    compare(wrap(60), 0, "wrap at last + span: the first output");
    compare(wrap(-30), 0, "wrap at first − span: the first output");
    compare(wrap(40), 100, "wrap past last reads the whole table again, not the outer segment");
    compare(wrap(-10), 75, "wrap before first, from the far end of the table");
  });

  it("defaults to extend on both sides", () => {
    expect(interpolate(-10, [0, 10], [0, 100])).toBe(-100);
    expect(interpolate(20, [0, 10], [0, 100])).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------- spring

type Config = Pick<SpringConfig, "mass" | "damping" | "stiffness">;

/** Integrate from rest at 0 to `seconds` with classic RK4, steps no longer than `step`. */
function rk4(config: Config, seconds: number, step = 5e-5): number {
  if (seconds <= 0) {
    return 0;
  }
  const { mass: m, damping: c, stiffness: k } = config;
  const acceleration = (x: number, v: number): number => (k * (1 - x) - c * v) / m;
  const n = Math.ceil(seconds / step);
  const h = seconds / n;
  let x = 0;
  let v = 0;
  for (let index = 0; index < n; index += 1) {
    const k1x = v;
    const k1v = acceleration(x, v);
    const k2x = v + (h / 2) * k1v;
    const k2v = acceleration(x + (h / 2) * k1x, v + (h / 2) * k1v);
    const k3x = v + (h / 2) * k2v;
    const k3v = acceleration(x + (h / 2) * k2x, v + (h / 2) * k2v);
    const k4x = v + h * k3v;
    const k4v = acceleration(x + h * k3x, v + h * k3v);
    x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
  }
  return x;
}

/**
 * Frame-by-frame scan of one integration out to 60 s: last frame outside, plus one. With `clamp`,
 * the motion is the target from the first integration step at which it reached it.
 */
function settleReference(config: Config, fps: number, threshold: number, clamp = false): number {
  const { mass: m, damping: c, stiffness: k } = config;
  const h = 1 / fps / Math.ceil(1 / fps / 5e-5);
  const stepsPerFrame = Math.round(1 / fps / h);
  let x = 0;
  let v = 0;
  let settled = 0;
  let arrived = false;
  const acceleration = (px: number, pv: number): number => (k * (1 - px) - c * pv) / m;
  for (let frame = 0; frame <= fps * 60; frame += 1) {
    const shown = arrived ? 1 : x;
    if (Math.abs(shown - 1) >= threshold) {
      settled = frame + 1;
    }
    for (let index = 0; index < stepsPerFrame; index += 1) {
      const k1x = v;
      const k1v = acceleration(x, v);
      const k2x = v + (h / 2) * k1v;
      const k2v = acceleration(x + (h / 2) * k1x, v + (h / 2) * k1v);
      const k3x = v + (h / 2) * k2v;
      const k3v = acceleration(x + (h / 2) * k2x, v + (h / 2) * k2v);
      const k4x = v + h * k3v;
      const k4v = acceleration(x + h * k3x, v + h * k3v);
      x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
      v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
      arrived ||= clamp && x >= 1;
    }
  }
  return settled;
}

/**
 * Seconds from release to the motion's first arrival at the target: classic RK4 steps of 5e-5 s
 * until x ≥ 1, then bisection inside that last step, each probe one RK4 step from the state at the
 * step's start, until the bracket stops shrinking. `Infinity` for a spring that does not oscillate
 * (ζ ≥ 1), which only reaches the target in the limit.
 */
function arrivalReference(config: Config): number {
  const { mass: m, damping: c, stiffness: k } = config;
  if (c >= 2 * Math.sqrt(k * m)) {
    return Number.POSITIVE_INFINITY;
  }
  const acceleration = (px: number, pv: number): number => (k * (1 - px) - c * pv) / m;
  const advance = (x: number, v: number, h: number): readonly [number, number] => {
    const k1x = v;
    const k1v = acceleration(x, v);
    const k2x = v + (h / 2) * k1v;
    const k2v = acceleration(x + (h / 2) * k1x, v + (h / 2) * k1v);
    const k3x = v + (h / 2) * k2v;
    const k3v = acceleration(x + (h / 2) * k2x, v + (h / 2) * k2v);
    const k4x = v + h * k3v;
    const k4v = acceleration(x + h * k3x, v + h * k3v);
    return [
      x + (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x),
      v + (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v),
    ];
  };
  const step = 5e-5;
  let x = 0;
  let v = 0;
  for (let index = 0; index * step < 60; index += 1) {
    const [nextX, nextV] = advance(x, v, step);
    if (nextX >= 1) {
      let low = 0;
      let high = step;
      for (;;) {
        const middle = (low + high) / 2;
        if (middle === low || middle === high) {
          break;
        }
        if (advance(x, v, middle)[0] >= 1) {
          high = middle;
        } else {
          low = middle;
        }
      }
      return index * step + high;
    }
    x = nextX;
    v = nextV;
  }
  throw new Error("an oscillating spring that did not reach its target in 60 s");
}

const SPRINGS: readonly { name: string; config: Config; fps: number }[] = [
  {
    name: "default (under-damped, ζ = 0.5)",
    config: { mass: 1, damping: 10, stiffness: 100 },
    fps: 30,
  },
  { name: "critically damped (ζ = 1)", config: { mass: 1, damping: 20, stiffness: 100 }, fps: 30 },
  { name: "over-damped (ζ = 1.5)", config: { mass: 1, damping: 30, stiffness: 100 }, fps: 60 },
  {
    name: "stiff over-damped (ζ ≈ 14)",
    config: { mass: 0.5, damping: 200, stiffness: 100 },
    fps: 30,
  },
  { name: "light, ringing (ζ ≈ 0.06)", config: { mass: 2, damping: 3, stiffness: 300 }, fps: 30 },
  { name: "heavy and soft (ζ ≈ 0.35)", config: { mass: 3, damping: 12, stiffness: 120 }, fps: 24 },
];

describe("spring against an RK4 integration of the oscillator", () => {
  const next = stream(0x5971);

  for (const { name, config, fps } of SPRINGS) {
    it(`${name}: plain, delayed, from/to, clamped, stretched and reversed`, () => {
      const natural = settleReference(config, fps, 0.005);
      const position = (frames: number): number => rk4(config, frames / fps);
      const arrival = arrivalReference(config);
      const clamped = (frames: number): number => (frames / fps >= arrival ? 1 : position(frames));

      for (let index = 0; index < 8; index += 1) {
        const frame = index < 2 ? index * 7 : next() * 3 * natural;
        compare(spring({ frame, fps, config }), position(frame), `${name} frame ${frame}`);
      }

      const delay = 4 + Math.floor(next() * 10);
      for (const frame of [0, delay - 1, delay + 3.5, delay + natural / 2]) {
        compare(
          spring({ frame, fps, config, delay }),
          frame <= delay ? 0 : position(frame - delay),
          `${name} delay ${delay} frame ${frame}`,
        );
      }

      const from = -200 + next() * 100;
      const to = 300 + next() * 100;
      for (let index = 0; index < 3; index += 1) {
        const frame = next() * natural;
        compare(
          spring({ frame, fps, config, from, to }),
          from + (to - from) * position(frame),
          `${name} ${from}→${to} frame ${frame}`,
        );
        compare(
          spring({ frame, fps, config: { ...config, overshootClamping: true } }),
          clamped(frame),
          `${name} clamped frame ${frame}`,
        );
      }

      const duration = 15 + Math.floor(next() * 60);
      for (let index = 0; index < 3; index += 1) {
        const frame = next() * duration;
        compare(
          spring({ frame, fps, config, durationInFrames: duration }),
          position((frame * natural) / duration),
          `${name} stretched to ${duration} frame ${frame}`,
        );
        compare(
          spring({ frame, fps, config, reverse: true }),
          position(natural - frame),
          `${name} reversed frame ${frame}`,
        );
      }
      compare(
        spring({ frame: duration, fps, config, durationInFrames: duration, reverse: true }),
        0,
        `${name} reversed and stretched, at its end`,
      );
    });

    it(`${name}: clamped, it climbs to its first arrival and rests at \`to\` from there on`, () => {
      const arrival = arrivalReference(config);
      const position = (frames: number): number => rk4(config, frames / fps);
      const clampedConfig = { ...config, overshootClamping: true };
      const from = 40;
      const to = -60;
      if (!Number.isFinite(arrival)) {
        // It never reaches the target, so there is nothing for the flag to clamp.
        for (const frame of [1, 6.5, 19, 47]) {
          compare(
            spring({ frame, fps, config: clampedConfig, from, to }),
            from + (to - from) * position(frame),
            `${name} clamped, never arriving, frame ${frame}`,
          );
        }
        return;
      }
      const first = Math.ceil(arrival * fps);
      for (const frame of [first - 1, arrival * fps - 0.25]) {
        compare(
          spring({ frame, fps, config: clampedConfig, from, to }),
          from + (to - from) * position(frame),
          `${name} clamped, before arrival, frame ${frame}`,
        );
      }
      // Every frame from the arrival on, across the stretch where the free motion swings back
      // below the target and returns: the clamped value is `to`, exactly.
      for (let frame = first; frame <= first + 3 * fps; frame += 1) {
        const value = spring({ frame, fps, config: clampedConfig, from, to });
        if (value !== to) {
          expect.fail(`${name} clamped frame ${frame}: got ${value}, expected exactly ${to}`);
        }
      }
      compare(
        spring({ frame: first + 0.25, fps, config: clampedConfig, from, to }),
        to,
        `${name} clamped, after arrival`,
      );
    });

    it(`${name}: measureSpring matches a frame-by-frame scan at three thresholds`, () => {
      for (const threshold of [0.005, 0.02, 0.0001]) {
        compare(
          measureSpring({ fps, config, threshold }),
          settleReference(config, fps, threshold),
          `${name} measureSpring threshold ${threshold}`,
        );
        compare(
          measureSpring({ fps, config: { ...config, overshootClamping: true }, threshold }),
          settleReference(config, fps, threshold, true),
          `${name} measureSpring clamped threshold ${threshold}`,
        );
      }
    });
  }

  /**
   * ζ = 1e8 (ω₀ = 10): the roots are r₁ ≈ −ω₀/2ζ = −5e-8 and r₂ ≈ −2ζω₀ = −2e9, and once r₂'s term
   * has died (a nanosecond) the motion is 1 − e^(r₁·t) — written here with `expm1` so it carries
   * every digit. Computing r₁ as −ω₀(ζ − √(ζ² − 1)) cancels it to 0 and holds the spring at 0.
   */
  it("moves a very heavy spring at its slow rate rather than cancelling it to a standstill", () => {
    const config = { mass: 1, stiffness: 100, damping: 2e9 };
    const slow = -10 / 2e8;
    for (const seconds of [1, 30, 600]) {
      const value = spring({ frame: seconds * 30, fps: 30, config });
      const expected = -Math.expm1(slow * seconds);
      expect(Math.abs(value / expected - 1), `${seconds} s`).toBeLessThan(1e-6);
    }
  });

  it("refuses, by name and quickly, a spring that would take more than an hour to settle", () => {
    const started = performance.now();
    expect(() => measureSpring({ fps: 30, config: { damping: 2e9 } })).toThrow(
      /^measureSpring: this spring takes more than 3600 s .*give it less damping or more stiffness/,
    );
    expect(() => measureSpring({ fps: 30, config: { damping: 2e-5 } })).toThrow(
      /^measureSpring: this spring takes more than 3600 s .*give it more damping/,
    );
    expect(() =>
      spring({ frame: 10, fps: 30, config: { damping: 2e9 }, durationInFrames: 60 }),
    ).toThrow(/more than 3600 s/);
    expect(performance.now() - started).toBeLessThan(5_000);
    // A slow but reasonable spring is still measured: ζ = 0.001 rings for about nine minutes.
    expect(measureSpring({ fps: 30, config: { damping: 0.02 } })).toBeGreaterThan(15_000);
  });

  it("is at `from` before release and refuses a spring that never settles", () => {
    expect(spring({ frame: -3, fps: 30, from: 5, to: 9 })).toBe(5);
    expect(() => measureSpring({ fps: 30, config: { damping: 0 } })).toThrow(/never settles/);
    expect(() => spring({ frame: 1, fps: 0 })).toThrow(/fps must be a positive number/);
    expect(() => spring({ frame: 1, fps: 30, config: { mass: -1 } })).toThrow(/mass/);
  });
});

describe("the numerical table", () => {
  it(`holds at least ${MINIMUM_SAMPLES} comparisons, every one within ${TOLERANCE}`, () => {
    expect(samples).toBeGreaterThanOrEqual(MINIMUM_SAMPLES);
    expect(worst).toBeLessThanOrEqual(TOLERANCE);
  });
});
