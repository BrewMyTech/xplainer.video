/**
 * `spring()` and `measureSpring()` — physical motion as a pure function of the frame.
 *
 * **The curve is the closed-form solution of a damped harmonic oscillator**, not a step-by-step
 * simulation. A mass `m` on a spring of stiffness `k` with damping `c` starts at rest at 0 and is
 * released towards 1:
 *
 *     m·x″ + c·x′ + k·(x − 1) = 0,   x(0) = 0,   x′(0) = 0
 *
 * With `ω₀ = √(k/m)` and `ζ = c / (2·√(k·m))` the textbook solution has three regimes —
 * under-damped (`ζ < 1`, it overshoots and rings), critically damped (`ζ = 1`) and over-damped
 * (`ζ > 1`, it creeps in without overshooting) — and each is evaluated directly at the frame's
 * time. Two consequences matter for a renderer that captures frames in any order: the value at
 * frame 90 does not depend on frames 0–89 having been computed first, and it is identical whether
 * the video is rendered or a single still is taken. `math.test.ts` holds the curve against an
 * independent RK4 integration of the equation above at 1e-9.
 *
 * The curve is normalised (0 → 1) and then scaled onto `from → to`, so `overshootClamping`, the
 * rest threshold and the duration stretch all mean the same thing whatever the two ends are.
 *
 * The values follow the equation, not any other library's numerical scheme, so a scene ported
 * from elsewhere can differ in the last few hundredths of its overshoot.
 */

export type SpringConfig = {
  /** Default 1. */
  mass: number;
  /** Default 10. 0 never settles; `measureSpring` refuses it. */
  damping: number;
  /** Default 100. */
  stiffness: number;
  /** Default false. When true the value never passes `to`. */
  overshootClamping: boolean;
};

export type SpringOptions = {
  /** The frame to evaluate, usually `useCurrentFrame()`. */
  frame: number;
  /** Frames per second, usually `useVideoConfig().fps`. */
  fps: number;
  config?: Partial<SpringConfig>;
  /** Default 0. */
  from?: number;
  /** Default 1. */
  to?: number;
  /** Stretch time so the spring's natural settle (`measureSpring`) lands on this many frames. */
  durationInFrames?: number;
  /** Frames to hold at the start value before the spring is released. Default 0. */
  delay?: number;
  /** Run the motion backwards in time: settled at the start, back at `from` at the end. */
  reverse?: boolean;
  /** The threshold `durationInFrames` and `reverse` measure the natural settle with. Default 0.005. */
  durationRestThreshold?: number;
};

export type MeasureSpringOptions = {
  fps: number;
  config?: Partial<SpringConfig>;
  /** How close to the target, in normalised units (0 → 1), counts as settled. Default 0.005. */
  threshold?: number;
};

const DEFAULT_CONFIG: SpringConfig = {
  mass: 1,
  damping: 10,
  stiffness: 100,
  overshootClamping: false,
};

const DEFAULT_THRESHOLD = 0.005;

function resolveConfig(config: Partial<SpringConfig> | undefined): SpringConfig {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  const { mass, damping, stiffness } = resolved;
  if (!(Number.isFinite(mass) && mass > 0)) {
    throw new RangeError(`spring: config.mass must be a positive number, got ${String(mass)}.`);
  }
  if (!(Number.isFinite(stiffness) && stiffness > 0)) {
    throw new RangeError(
      `spring: config.stiffness must be a positive number, got ${String(stiffness)}.`,
    );
  }
  if (!(Number.isFinite(damping) && damping >= 0)) {
    throw new RangeError(
      `spring: config.damping must be zero or a positive number, got ${String(damping)}.`,
    );
  }
  return resolved;
}

function assertFps(fps: number, caller: string): void {
  if (!(Number.isFinite(fps) && fps > 0)) {
    throw new RangeError(`${caller}: fps must be a positive number, got ${String(fps)}.`);
  }
}

/**
 * The normalised position at `seconds` after release, from rest at 0 towards 1.
 *
 * The over-damped branch is written with the two real roots `r₁, r₂ = −ω₀(ζ ∓ √(ζ² − 1))` rather
 * than `cosh`/`sinh` of the envelope, because those two overflow long before their product with
 * the decaying exponential would have.
 */
function position(seconds: number, config: SpringConfig): number {
  const omega = Math.sqrt(config.stiffness / config.mass);
  const zeta = config.damping / (2 * Math.sqrt(config.stiffness * config.mass));
  if (zeta < 1) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * omega * seconds);
    return (
      1 -
      envelope *
        (Math.cos(omegaD * seconds) + ((zeta * omega) / omegaD) * Math.sin(omegaD * seconds))
    );
  }
  if (zeta === 1) {
    return 1 - Math.exp(-omega * seconds) * (1 + omega * seconds);
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - root);
  const r2 = -omega * (zeta + root);
  return 1 + (r2 * Math.exp(r1 * seconds) - r1 * Math.exp(r2 * seconds)) / (r1 - r2);
}

const settleCache = new Map<string, number>();

function settleFrames(fps: number, config: SpringConfig, threshold: number): number {
  const key = `${fps}|${config.mass}|${config.damping}|${config.stiffness}|${config.overshootClamping}|${threshold}`;
  const cached = settleCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const distance = (frame: number): number => {
    const value = position(frame / fps, config);
    return Math.abs((config.overshootClamping ? Math.min(value, 1) : value) - 1);
  };

  const omega = Math.sqrt(config.stiffness / config.mass);
  const zeta = config.damping / (2 * Math.sqrt(config.stiffness * config.mass));
  let frames = 0;
  if (zeta < 1) {
    // |x − 1| ≤ e^(−ζω₀t) / √(1 − ζ²) for every t, so past the frame where that envelope drops
    // under the threshold nothing can leave it again. Every frame before it is checked.
    const amplitude = 1 / Math.sqrt(1 - zeta * zeta);
    const horizon =
      amplitude <= threshold
        ? 0
        : Math.ceil((Math.log(amplitude / threshold) / (zeta * omega)) * fps);
    for (let frame = 0; frame <= horizon; frame += 1) {
      if (distance(frame) >= threshold) {
        frames = frame + 1;
      }
    }
  } else {
    // Critically and over-damped motion approaches 1 monotonically: the first frame inside is
    // the frame it stays inside from.
    while (distance(frames) >= threshold) {
      frames += 1;
    }
  }
  settleCache.set(key, frames);
  return frames;
}

/**
 * The number of frames until the spring stays within `threshold` of its target for good: the
 * first frame `F` such that every frame from `F` on is inside. A spring with no damping never
 * settles, and is refused rather than looped over.
 */
export function measureSpring(options: MeasureSpringOptions): number {
  const { fps, threshold = DEFAULT_THRESHOLD } = options;
  assertFps(fps, "measureSpring");
  const config = resolveConfig(options.config);
  if (config.damping === 0) {
    throw new RangeError(
      "measureSpring: a spring with damping 0 oscillates forever and never settles; give config.damping a positive value.",
    );
  }
  if (!(Number.isFinite(threshold) && threshold > 0)) {
    throw new RangeError(
      `measureSpring: threshold must be a positive number, got ${String(threshold)}.`,
    );
  }
  return settleFrames(fps, config, threshold);
}

export function spring(options: SpringOptions): number {
  const {
    frame,
    fps,
    from = 0,
    to = 1,
    delay = 0,
    reverse = false,
    durationInFrames,
    durationRestThreshold = DEFAULT_THRESHOLD,
  } = options;
  if (typeof frame !== "number" || Number.isNaN(frame)) {
    throw new TypeError(`spring: frame must be a number, got ${String(frame)}.`);
  }
  assertFps(fps, "spring");
  const config = resolveConfig(options.config);
  if (!Number.isFinite(delay)) {
    throw new RangeError(`spring: delay must be a finite number, got ${String(delay)}.`);
  }
  if (
    durationInFrames !== undefined &&
    !(Number.isFinite(durationInFrames) && durationInFrames > 0)
  ) {
    throw new RangeError(
      `spring: durationInFrames must be a positive number, got ${String(durationInFrames)}.`,
    );
  }

  let local = frame - delay;
  if (durationInFrames !== undefined || reverse) {
    const natural = measureSpring({ fps, config, threshold: durationRestThreshold });
    if (durationInFrames !== undefined) {
      local = (local * natural) / durationInFrames;
    }
    if (reverse) {
      local = natural - local;
    }
  }

  let progress = local <= 0 ? 0 : position(local / fps, config);
  if (config.overshootClamping && progress > 1) {
    progress = 1;
  }
  return from + (to - from) * progress;
}
