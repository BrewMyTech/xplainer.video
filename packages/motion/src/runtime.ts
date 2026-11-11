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

/** What a second concurrently mounted `<Audio>` throws. */
const SECOND_AUDIO_NOT_SUPPORTED =
  "NOT_SUPPORTED_IN_V1: a second <Audio> is mounted, and the narration is the only audio track the xplainer renderer puts in the video; any other <Audio> would be silently missing from the MP4, so remove it";

/**
 * Count one mounted `<Audio>` and return its unmount. A second concurrent mount throws
 * `NOT_SUPPORTED_IN_V1`, and is not counted.
 *
 * The renderer muxes exactly one track — the narration the engine's own `Video.tsx` mounts — so any
 * further `<Audio>` would be absent from the output with nothing to say so. That is refused by
 * name, the way `<Video>` is, rather than warned about in a job log nobody reads.
 */
export function mountAudio(): () => void {
  if (audioMounts > 0) {
    throw new Error(SECOND_AUDIO_NOT_SUPPORTED);
  }
  audioMounts += 1;
  return () => {
    audioMounts -= 1;
  };
}
