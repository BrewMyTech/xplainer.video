/**
 * The state a scene shares with the page harness: the registered video, the render holds, the
 * recorded failures and the mounted `<Audio>` count.
 *
 * **Why it lives here and not in the harness.** Scenes import `@xplainer/motion` and the bundle's
 * entry imports `@xplainer/motion/harness`; both resolve into this package's `dist/`, so this
 * module is evaluated once and both sides hold the same maps. The harness reads and drives it;
 * everything a scene calls (`delayRender`, `cancelRender`, `registerRoot`) only writes to it. That
 * split is what keeps `src/index.ts` free of side effects and importable in Node with no DOM: in a
 * test, `delayRender()` simply records a hold that nothing ever waits on.
 *
 * Nothing in this file is part of the public surface except the three render-hold functions, which
 * `src/index.ts` re-exports.
 */

import type { ComponentType } from "react";
import type { VideoRegistration } from "./context.js";

/** What `registerRoot()` or `registerVideo()` handed over. */
export type RegisteredEntry =
  | { kind: "root"; Root: ComponentType }
  | { kind: "video"; registration: VideoRegistration };

/** One outstanding `delayRender()`. */
export type RenderHold = {
  label: string;
  /** Per-hold override of the harness's budget, from `timeoutInMilliseconds`. */
  timeoutMs: number | undefined;
};

export type DelayRenderOptions = {
  /** How long the renderer waits for this hold before failing the frame. Default 30 000. */
  timeoutInMilliseconds?: number;
};

let registered: RegisteredEntry | undefined;
let registrationListener: ((entry: RegisteredEntry) => void) | undefined;

const holds = new Map<number, RenderHold>();
let nextHandle = 1;

const failures: string[] = [];

let audioMounts = 0;
let audioWarned = false;

/**
 * Record the one video this bundle renders, and hand it to the harness if one is listening.
 * A second call is refused: a bundle renders exactly one video, and silently keeping either would
 * render something other than what one of the two calls asked for.
 */
export function registerEntry(entry: RegisteredEntry): void {
  if (registered !== undefined) {
    throw new Error(
      "registerRoot()/registerVideo() was called twice. A bundle renders exactly one video, so call one of them once, from the video's index.ts.",
    );
  }
  registered = entry;
  registrationListener?.(entry);
}

/** The harness's subscription. Called at once if a video registered before it subscribed. */
export function onRegistration(listener: (entry: RegisteredEntry) => void): void {
  registrationListener = listener;
  if (registered !== undefined) {
    listener(registered);
  }
}

/** The registered entry, for tests and for a harness that subscribes late. */
export function registeredEntry(): RegisteredEntry | undefined {
  return registered;
}

/**
 * Hold the current frame open until `continueRender(handle)`.
 *
 * The renderer will not capture while any hold is outstanding, so a scene can wait for something
 * it fetched or decoded itself. The `label` is what a timeout names, so give one that says what
 * is being waited for.
 */
export function delayRender(label?: string, options?: DelayRenderOptions): number {
  const timeoutMs = options?.timeoutInMilliseconds;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new RangeError(
      `delayRender: timeoutInMilliseconds must be a positive number, got ${String(timeoutMs)}.`,
    );
  }
  const handle = nextHandle;
  nextHandle += 1;
  holds.set(handle, {
    label: label === undefined || label === "" ? `unlabelled #${handle}` : label,
    timeoutMs,
  });
  return handle;
}

/**
 * Release a hold. Releasing one that is no longer held is a no-op, so an effect cleanup and a
 * load handler may both release the same handle.
 */
export function continueRender(handle: number): void {
  if (typeof handle !== "number") {
    throw new TypeError(
      `continueRender: pass the number delayRender() returned, got ${typeof handle}.`,
    );
  }
  holds.delete(handle);
}

/** Fail the render on purpose. The renderer stops and reports `PAGE_ERROR: cancelRender: …`. */
export function cancelRender(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  recordFailure(`PAGE_ERROR: cancelRender: ${message}`);
}

/** The outstanding holds, keyed by handle. */
export function renderHolds(): ReadonlyMap<number, RenderHold> {
  return holds;
}

/** Record a failure, already prefixed with its code. A repeated message is kept once. */
export function recordFailure(message: string): string {
  if (!failures.includes(message)) {
    failures.push(message);
  }
  return message;
}

/** Every failure recorded so far, in order. */
export function recordedFailures(): readonly string[] {
  return failures;
}

/**
 * Count one mounted `<Audio>` and return its unmount. The second concurrent mount warns once.
 *
 * The renderer muxes exactly one track — the narration — so any further `<Audio>` is silent in the
 * output. That is worth saying, and saying once; it is not worth failing a render over, which is
 * why this is `console.warn` and never `console.error` (the renderer treats the latter as a page
 * error).
 */
export function mountAudio(): () => void {
  audioMounts += 1;
  if (audioMounts > 1 && !audioWarned) {
    audioWarned = true;
    console.warn(
      "xplainer: more than one <Audio> is mounted. The renderer muxes only the narration track, so every other <Audio> is silent in the output.",
    );
  }
  return () => {
    audioMounts -= 1;
  };
}
