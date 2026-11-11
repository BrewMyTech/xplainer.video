/**
 * `Easing` — the curves a scene hands to `interpolate()` to shape a transition.
 *
 * **Every curve here is a documented formula, written from the formula.** The set and the
 * names follow React Native's `Easing` module, because that is the vocabulary explainer scenes
 * are already written in; the bodies are the textbook closed forms (Penner's equations and the
 * CSS cubic-Bézier definition), not a port of anybody's source. `packages/motion/src/math.test.ts`
 * holds each one against a separate evaluation of the same formula, so a curve that drifts is a
 * red test rather than a scene that looks slightly wrong.
 *
 * **The domain is not clamped.** `interpolate()` with `extrapolate*: "extend"` feeds a curve
 * positions below 0 and above 1, and every polynomial curve here simply continues. The one curve
 * that cannot continue on its own is `bezier`, whose parametric form is not a function outside
 * `[0, 1]`; it extends along the tangent at the nearer endpoint, which is what the CSS Easing
 * specification prescribes for the same situation.
 */

/** A curve over normalised time: 0 at the start of a segment, 1 at its end. */
export type EasingFunction = (t: number) => number;

/** Newton steps tried before falling back to bisection. Newton converges in 3–5 when it converges. */
const NEWTON_ITERATIONS = 8;

/** |B_x(t) − x| below this is a solved `t`. Near the double-precision floor on purpose. */
const SOLVE_EPSILON = 1e-14;

/** A slope this flat makes a Newton step jump out of the curve; bisect instead. */
const MIN_SLOPE = 1e-12;

/** Enough halvings to exhaust a double's mantissa on `[0, 1]`. */
const BISECTION_ITERATIONS = 64;

function linear(t: number): number {
  return t;
}

/**
 * The cubic Bézier through (0,0), (x1,y1), (x2,y2), (1,1), as a function of x.
 *
 * Each axis is the polynomial `((a·t + b)·t + c)·t`, with `c = 3·p1`, `b = 3·(p2 − p1) − c` and
 * `a = 1 − c − b` — the Bernstein form multiplied out. `x` is mapped back to `t` by Newton's
 * method from `t = x`, and by bisection whenever Newton stalls on a flat slope or leaves `[0, 1]`;
 * `x1` and `x2` are required to lie in `[0, 1]`, which is exactly the condition under which
 * `B_x` is monotone and that inversion has one answer.
 */
function bezier(x1: number, y1: number, x2: number, y2: number): EasingFunction {
  for (const [name, value] of [
    ["x1", x1],
    ["y1", y1],
    ["x2", x2],
    ["y2", y2],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`Easing.bezier: ${name} must be a finite number, got ${String(value)}.`);
    }
  }
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new RangeError(
      `Easing.bezier: x1 and x2 must lie within [0, 1] so the curve is a function of time; got x1=${x1}, x2=${x2}.`,
    );
  }
  if (x1 === y1 && x2 === y2) {
    return linear;
  }

  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number): number => {
    let t = x;
    for (let index = 0; index < NEWTON_ITERATIONS; index += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < SOLVE_EPSILON) {
        return t;
      }
      const slope = slopeX(t);
      if (Math.abs(slope) < MIN_SLOPE) {
        break;
      }
      t -= error / slope;
      if (t < 0 || t > 1) {
        break;
      }
    }
    let low = 0;
    let high = 1;
    t = x;
    for (let index = 0; index < BISECTION_ITERATIONS; index += 1) {
      t = (low + high) / 2;
      const value = sampleX(t);
      if (Math.abs(value - x) < SOLVE_EPSILON) {
        return t;
      }
      if (value < x) {
        low = t;
      } else {
        high = t;
      }
    }
    return t;
  };

  // Tangents at the two endpoints, for positions outside [0, 1] (CSS Easing, "cubic Bézier"): the
  // line to the nearest control point that is not vertically above the endpoint, else horizontal.
  const startSlope = x1 > 0 ? y1 / x1 : x2 > 0 ? y2 / x2 : 0;
  const endSlope = x2 < 1 ? (y2 - 1) / (x2 - 1) : x1 < 1 ? (y1 - 1) / (x1 - 1) : 0;

  return (x: number): number => {
    if (x <= 0) {
      return x === 0 ? 0 : startSlope * x;
    }
    if (x >= 1) {
      return x === 1 ? 1 : 1 + endSlope * (x - 1);
    }
    return sampleY(solveT(x));
  };
}

/** Penner's bounce: four parabolic arcs of decreasing height, the 7.5625 / 2.75 constants. */
function bounce(t: number): number {
  if (t < 1 / 2.75) {
    return 7.5625 * t * t;
  }
  if (t < 2 / 2.75) {
    const u = t - 1.5 / 2.75;
    return 7.5625 * u * u + 0.75;
  }
  if (t < 2.5 / 2.75) {
    const u = t - 2.25 / 2.75;
    return 7.5625 * u * u + 0.9375;
  }
  const u = t - 2.625 / 2.75;
  return 7.5625 * u * u + 0.984375;
}

/** The shape of `Easing`, written out because a const this public carries its type explicitly. */
export type EasingModule = {
  /** `t`. */
  readonly linear: EasingFunction;
  /** `bezier(0.42, 0, 1, 1)` — a gentle start. */
  readonly ease: EasingFunction;
  /** `t²`. */
  readonly quad: EasingFunction;
  /** `t³`. */
  readonly cubic: EasingFunction;
  /** `tⁿ`. */
  readonly poly: (n: number) => EasingFunction;
  /** `1 − cos(t·π/2)`. */
  readonly sin: EasingFunction;
  /** `1 − √(1 − t²)`. */
  readonly circle: EasingFunction;
  /** `2^(10·(t − 1))`. */
  readonly exp: EasingFunction;
  /** `1 − cos(t·π/2)³ · cos(t·bounciness·π)`; `bounciness` defaults to 1. */
  readonly elastic: (bounciness?: number) => EasingFunction;
  /** `t²·((s + 1)·t − s)`; `s` defaults to 1.70158, a 10 % overshoot. */
  readonly back: (s?: number) => EasingFunction;
  /** Penner's four-arc bounce. */
  readonly bounce: EasingFunction;
  /** The CSS `cubic-bezier(x1, y1, x2, y2)` curve. */
  readonly bezier: (x1: number, y1: number, x2: number, y2: number) => EasingFunction;
  /** The curve as given: the "in" half is the curve itself. */
  readonly in: (easing: EasingFunction) => EasingFunction;
  /** The curve mirrored in time and value: `1 − f(1 − t)`. */
  readonly out: (easing: EasingFunction) => EasingFunction;
  /** "in" for the first half, "out" for the second, meeting at (0.5, 0.5). */
  readonly inOut: (easing: EasingFunction) => EasingFunction;
  /** 0 at `t ≤ 0`, then 1. */
  readonly step0: EasingFunction;
  /** 0 until `t ≥ 1`, then 1. */
  readonly step1: EasingFunction;
};

export const Easing: EasingModule = {
  linear,
  ease: bezier(0.42, 0, 1, 1),
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  poly: (n) => (t) => t ** n,
  sin: (t) => 1 - Math.cos((t * Math.PI) / 2),
  circle: (t) => 1 - Math.sqrt(1 - t * t),
  exp: (t) => 2 ** (10 * (t - 1)),
  elastic: (bounciness = 1) => {
    const p = bounciness * Math.PI;
    return (t) => 1 - Math.cos((t * Math.PI) / 2) ** 3 * Math.cos(t * p);
  },
  back:
    (s = 1.70158) =>
    (t) =>
      t * t * ((s + 1) * t - s),
  bounce,
  bezier,
  in: (easing) => easing,
  out: (easing) => (t) => 1 - easing(1 - t),
  inOut: (easing) => (t) => (t < 0.5 ? easing(t * 2) / 2 : 1 - easing((1 - t) * 2) / 2),
  step0: (t) => (t > 0 ? 1 : 0),
  step1: (t) => (t >= 1 ? 1 : 0),
};
