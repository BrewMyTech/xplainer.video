/**
 * `@xplainer/motion/harness` — the page-side half of the renderer. Browser only; side effects on
 * import.
 *
 * The renderer's generated bundle entry imports this module **before** the video's `index.ts`, so
 * everything below is installed before any scene module runs. It does five things:
 *
 * 1. **Freezes the clock.** `Date` (no-argument construction, `Date()` and `Date.now`) and
 *    `performance.now` read film time — `frame / fps · 1000` ms, from 2020-01-01 for `Date` — which
 *    moves only when the renderer calls `setFrame`. `setTimeout`/`setInterval` run on film time,
 *    and `requestAnimationFrame` callbacks are queued until the next frame (`clock.ts`). React and
 *    its scheduler keep the native timers: `react-dom` is imported above the patches, and both
 *    capture the timer functions when their modules evaluate.
 * 2. **Answers `fetch` for the static files** the bundle carries in `window.__XPLAINER_STATIC__`
 *    (`static-fetch.ts`), because Chrome refuses `fetch` on `file://`.
 * 3. **Mounts the registered video** once `calculateMetadata` has run, into `#root` sized to the
 *    video and clipped to it.
 * 4. **Drives frames.** `setFrame(n)` sets film time and, inside one `flushSync`, fires the timers
 *    due by then (in due order; those they create wait for the next frame), drains the queued
 *    animation-frame callbacks with the film timestamp and commits the new frame — so everything a
 *    timer sets lands in the same commit as the frame it belongs to. Then every Web Animation is
 *    paused and seeked to film time (`animations.ts`), and the frame settles.
 * 5. **Settles before a capture**, in passes. A pass waits for render holds, then images, then
 *    fonts, then forces a layout — or, once the page has made a `ResizeObserver` or an
 *    `IntersectionObserver`, waits one native animation frame, which is where those report — and
 *    yields two `MessageChannel` tasks, which is one React effect → setState hop (`settleTick`).
 *    Another pass follows while the one before it changed the DOM (a `MutationObserver` over the
 *    whole document), left a font loading, or left a hold or an image outstanding, up to
 *    `MAX_SETTLE_PASSES`.
 *
 * **Render holds, timers and animation frames — the one place film time yields to the wall
 * clock.** A scene that writes `const h = delayRender(); setTimeout(() => continueRender(h), 100)`
 * deadlocks on a pure film clock: the timer waits for the next frame and the frame waits for the
 * timer. So while any hold is outstanding, the timers created **since the previous frame was
 * released** run on the wall clock instead: such a timer due Δ ms after the current film time
 * fires Δ wall-clock ms after the wait began, and a timer created during the wait is scheduled from
 * that same advancing point. `requestAnimationFrame(() => continueRender(h))` deadlocks the same
 * way, so the animation-frame callbacks requested since the previous release are drained too, on
 * every poll of the wait, inside `flushSync` and with the frame's film timestamp. Film time itself,
 * `Date` and `performance.now` stay frozen throughout.
 *
 * **When the hold is released, the wall clock is taken back out.** Every timer the wait created
 * that is still pending is rebased onto the frame's film instant (`TimerQueue.rebase`): a timeout
 * becomes due its own delay after the frame, and an interval keeps its period and the ticks it has
 * already made, so it stays in film phase. `img.onload = () => { setTimeout(show, 100);
 * continueRender(h); }` therefore shows 100 ms of film after the frame whether the image took
 * 20 ms or two seconds: how long a release took never reaches the video.
 *
 * Timers and animation-frame callbacks from earlier frames — a scene's animation interval — stay
 * on film time even during a hold. Letting them run on the wall clock too would fire them early by
 * however long the hold happened to last, which differs from run to run: measured in Chrome, a
 * 100 ms interval created at frame 0 ticked a frame early on the one frame that took a 100 ms hold.
 * A release timer is created in the same frame as its hold (or between frames, by whatever async
 * work took the hold), so the narrower set still releases every hold the deadlock caught. "Since
 * the previous release" includes this frame's own drain, so a timeout chain the drain re-armed and
 * a `requestAnimationFrame` loop do run during a hold — the loop once per poll, every time with the
 * same film timestamp, which a loop that draws from its timestamp cannot tell apart from one call.
 *
 * **Images: what is waited for, and why there is no late-image failure.** Every `<img>` in the
 * document must be complete and decoded before a frame is released — the frame waits, up to the
 * image budget, and fails `IMAGE_TIMEOUT` past it — and the settle passes again while the DOM is
 * still changing. So an image the frame's own work mounts is in the frame: in the commit, after
 * effect → setState hops that each change the DOM, or behind a render hold. What the settle cannot
 * see is work that changes nothing it watches until later — a `fetch` with no `delayRender`, a run
 * of React renders that touch no node, a chain longer than `MAX_SETTLE_PASSES`. An image that work
 * mounts can arrive after its frame was captured, and no check on a later frame could tell that
 * frame was meant to have it; holding the frame with `delayRender` is how a scene says so. CSS
 * `background-image` is not an `<img>` and is not waited for; a scene that needs a picture to be
 * present uses `<Img>`.
 *
 * Every failure is an `Error` whose message begins with its code (`failures.ts`):
 * `PAGE_ERROR`, `DELAY_RENDER_TIMEOUT`, `IMAGE_BROKEN`, `IMAGE_TIMEOUT`, and `NOT_SUPPORTED_IN_V1`
 * for `<Video>`/`<OffthreadVideo>` and a second `<Audio>`, which keeps its own code rather than
 * nesting under `PAGE_ERROR`. Once one is recorded, every later `setFrame` rejects with the first.
 */

import {
  type ComponentType,
  createElement,
  type ReactElement,
  type ReactNode,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AnimationSeeker } from "./animations.js";
import { createFrozenDate, FrameCallbackQueue, frameToFilmMs, TimerQueue } from "./clock.js";
import {
  CompositionCollectorContext,
  type ResolvedVideo,
  type VideoConfig,
  type VideoRegistration,
} from "./context.js";
import { describeFailure, failure } from "./failures.js";
import { VideoProvider } from "./provider.js";
import {
  onRegistration,
  type RegisteredEntry,
  recordedFailures,
  recordFailure,
  renderHolds,
} from "./runtime.js";
import { contentTypeFor, findStaticText, requestUrl } from "./static-fetch.js";

/** What `window.__xplainer.metadata()` resolves to. */
export type XplainerMetadata = {
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
};

/** What `window.__xplainer.readiness()` returns. */
export type XplainerReadiness = {
  /** True once mounted and settled, with nothing pending and nothing failed. */
  ready: boolean;
  /** `metadata`, `first-settle`, `delayRender:<label>`, `img:<src>`, `fonts`. */
  pending: string[];
  /** Every failure so far, each beginning with its code. */
  failed: string[];
};

/** The driver the renderer calls over CDP. */
export type XplainerHarness = {
  /** Resolves once `calculateMetadata` has run; rejects with the failure if mounting failed. */
  metadata(): Promise<XplainerMetadata>;
  /** Show frame `n` and resolve once it has settled and may be captured. */
  setFrame(frame: number): Promise<void>;
  readiness(): XplainerReadiness;
  /** The frame most recently set. */
  readonly frame: number;
};

/** Budgets the renderer may set on `window.__XPLAINER_RENDER__` before the bundle runs. */
export type XplainerRenderOptions = {
  /** How long a `delayRender` hold may stay outstanding. Default 30 000. */
  delayRenderTimeoutMs?: number;
  /** How long a frame waits for its images. Default 30 000. */
  imageTimeoutMs?: number;
};

declare global {
  interface Window {
    __xplainer: XplainerHarness;
    /** Static file name → text, set by the bundle's `static-data.js`. */
    __XPLAINER_STATIC__?: Readonly<Record<string, string>>;
    /** The URL `staticFile()` prefixes, ending in `/`; set by the bundle's `static-data.js`. */
    __XPLAINER_PUBLIC_BASE__?: string;
    __XPLAINER_RENDER__?: XplainerRenderOptions;
  }
}

const DEFAULT_DELAY_RENDER_TIMEOUT_MS = 30_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 30_000;
const HOLD_POLL_MS = 2;
const IMAGE_POLL_MS = 5;

/**
 * A settle that keeps finding work stops after this many passes: it fails if a hold or an image is
 * still outstanding, and otherwise releases the frame as it stands.
 */
const MAX_SETTLE_PASSES = 10;

// The window as the DOM declares it. Node's typings widen the timer globals on `typeof
// globalThis`; this file only ever runs in a page, so it patches through the DOM's own interface.
const host: Window = window;

const native = {
  setTimeout: host.setTimeout.bind(host),
  requestAnimationFrame: host.requestAnimationFrame.bind(host),
  fetch: host.fetch.bind(host),
  now: performance.now.bind(performance),
};

// ------------------------------------------------------------------------------------ film clock

let filmMs = 0;
let holdWaitStartedAt: number | undefined;

/** Timers with an id at least this large were created after the previous frame was released. */
let releasedAtTimerId = 1;

/** The same mark for animation-frame callbacks. */
let releasedAtFrameCallbackId = 1;

/** A frame was released: what is created from here on is what the next frame's holds may run. */
function markReleased(): void {
  releasedAtTimerId = timers.nextId;
  releasedAtFrameCallbackId = frameCallbacks.nextId;
}

/** Where a new timer is scheduled from: film time, advanced by the wall clock during a hold. */
function scheduleBase(): number {
  return holdWaitStartedAt === undefined ? filmMs : filmMs + (native.now() - holdWaitStartedAt);
}

/** Call a page callback; a throw becomes a recorded `PAGE_ERROR` instead of aborting the drain. */
function run(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    recordFailure(describeFailure(error));
  }
}

const timers = new TimerQueue();
const frameCallbacks = new FrameCallbackQueue();
const seeker = new AnimationSeeker();

function timerCallback(handler: TimerHandler, args: unknown[]): () => void {
  if (typeof handler === "function") {
    return () => {
      handler(...args);
    };
  }
  return () => {
    recordFailure(
      failure("PAGE_ERROR", "setTimeout/setInterval with a string of code is not supported"),
    );
  };
}

globalThis.Date = createFrozenDate(Date, () => filmMs);
Object.defineProperty(performance, "now", {
  configurable: true,
  writable: true,
  value: () => filmMs,
});
host.setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]): number =>
  timers.add(timerCallback(handler, args), timeout ?? 0, false, scheduleBase());
host.setInterval = (handler: TimerHandler, timeout?: number, ...args: unknown[]): number =>
  timers.add(timerCallback(handler, args), timeout ?? 0, true, scheduleBase());
host.clearTimeout = (id?: number): void => timers.clear(id);
host.clearInterval = (id?: number): void => timers.clear(id);
host.requestAnimationFrame = (callback: FrameRequestCallback): number =>
  frameCallbacks.request(callback);
host.cancelAnimationFrame = (id: number): void => frameCallbacks.cancel(id);

// --------------------------------------------------------------------------- frame observers

/** Whether the page has made an observer that reports only inside a frame (`settleTick`). */
let observersInUse = false;

const NativeResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = class extends NativeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    super(callback);
    observersInUse = true;
  }
};
const NativeIntersectionObserver = globalThis.IntersectionObserver;
globalThis.IntersectionObserver = class extends NativeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    super(callback, options);
    observersInUse = true;
  }
};

// ----------------------------------------------------------------------------------- DOM changes

/** Set by any change to the document; how a settle pass knows the page has not stopped moving. */
let domChanged = false;
const domWatcher = new MutationObserver(() => {
  domChanged = true;
});
domWatcher.observe(document, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
});

/** Forget every change so far, at the start of a settle pass. */
function forgetDomChanges(): void {
  domWatcher.takeRecords();
  domChanged = false;
}

/** Whether the document changed since `forgetDomChanges()`, delivered to the observer or not. */
function domChangedSinceForget(): boolean {
  const queued = domWatcher.takeRecords().length > 0;
  return queued || domChanged;
}

// -------------------------------------------------------------------------------- static fetch

host.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const hit = findStaticText(
    requestUrl(input),
    host.__XPLAINER_STATIC__,
    (url) => new URL(url, host.location.href).href,
  );
  if (hit === undefined) {
    return native.fetch(input, init);
  }
  return Promise.resolve(
    new Response(hit.text, { status: 200, headers: { "content-type": contentTypeFor(hit.name) } }),
  );
};

// -------------------------------------------------------------------------------------- failures

host.addEventListener("error", (event) => {
  recordFailure(describeFailure(event.error ?? event.message));
});
host.addEventListener("unhandledrejection", (event) => {
  recordFailure(describeFailure(event.reason));
});

function throwIfFailed(): void {
  const first = recordedFailures()[0];
  if (first !== undefined) {
    throw new Error(first);
  }
}

/** Record `message` and return the `Error` the caller should reject with: the first failure. */
function failWith(message: string): Error {
  recordFailure(message);
  return new Error(recordedFailures()[0] ?? message);
}

// ------------------------------------------------------------------------------------ the frame

let currentFrame = 0;
const frameListeners = new Set<() => void>();

const frameStore = {
  subscribe(listener: () => void): () => void {
    frameListeners.add(listener);
    return () => {
      frameListeners.delete(listener);
    };
  },
  read(): number {
    return currentFrame;
  },
};

function publishFrame(frame: number): void {
  currentFrame = frame;
  for (const listener of frameListeners) {
    listener();
  }
}

function HarnessApp({
  config,
  children,
}: {
  config: VideoConfig;
  children?: ReactNode;
}): ReactElement {
  const frame = useSyncExternalStore(frameStore.subscribe, frameStore.read, frameStore.read);
  return createElement(VideoProvider, { config, frame }, children);
}

function seekAnimations(): void {
  seeker.seek(document.getAnimations(), filmMs);
}

// ---------------------------------------------------------------------------------------- settle

function budget(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nativeSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    native.setTimeout(resolve, ms);
  });
}

/**
 * Let the committed frame's consequences run before it is captured, without waiting for a frame.
 *
 * Reading layout forces style and layout synchronously, which is what starts the font and image
 * loads the new DOM needs; then two `MessageChannel` tasks, one after the other, let the tasks
 * already queued run, and the tasks *those* queue. Two, because that is one React update: after a
 * default-lane commit React yields before running its passive effects, so an effect that calls
 * `setState` runs in a task of its own, and the render it asks for is queued from a microtask
 * behind that — measured in the headless shell with React 19.2, where a pass that waited one task
 * saw the effect run and released the frame before the render it asked for. Each settle pass
 * therefore carries one effect → setState hop from its effect to its commit, and the pass loop in
 * `settle` carries a chain of them.
 *
 * Waiting for a native animation frame as well buys no pixel: `Page.captureScreenshot` draws a
 * fresh frame of its own. On the Phase 1 fps gate's animated scene the MP4 was byte-identical with
 * and without that wait, and the wait alone held the render at 18.2 fps against 22.4 without it —
 * one vsync on every frame (`apps/cli/spikes/p1-render-fps.mjs`, ADR 0030).
 *
 * The one thing a frame delivers that a layout read does not is observer notifications:
 * `ResizeObserver` and `IntersectionObserver` report in a frame's rendering steps. So once the page
 * has made either, every settle waits one native frame first, as it always did before this rule,
 * and then the same two tasks. The observers report *after* the frame's own callbacks, so the first
 * task was posted before any report ran; a `setState` inside a report queues React's render behind
 * it, and the second task comes after that render.
 */
function settleTick(): Promise<void> {
  return new Promise((resolve) => {
    const task = (then: () => void): void => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        then();
      };
      channel.port2.postMessage(0);
    };
    const twoTasks = (): void => {
      task(() => {
        task(resolve);
      });
    };
    if (observersInUse) {
      native.requestAnimationFrame(twoTasks);
      return;
    }
    void document.documentElement.getBoundingClientRect();
    twoTasks();
  });
}

const holdSeenAt = new Map<number, number>();

async function settleHolds(): Promise<void> {
  if (renderHolds().size === 0) {
    return;
  }
  const startedAt = native.now();
  const createdDuringWait = timers.nextId;
  holdWaitStartedAt = startedAt;
  try {
    for (;;) {
      const holds = renderHolds();
      if (holds.size === 0) {
        holdSeenAt.clear();
        return;
      }
      const now = native.now();
      const fallback = budget(
        host.__XPLAINER_RENDER__?.delayRenderTimeoutMs,
        DEFAULT_DELAY_RENDER_TIMEOUT_MS,
      );
      for (const [handle, hold] of holds) {
        const seen = holdSeenAt.get(handle) ?? now;
        holdSeenAt.set(handle, seen);
        if (now - seen > (hold.timeoutMs ?? fallback)) {
          const labels = [...holds.values()].map((held) => held.label).join(", ");
          throw failWith(failure("DELAY_RENDER_TIMEOUT", `still held: ${labels}`));
        }
      }
      const waitedTo = filmMs + (now - startedAt);
      const due = timers.nextDue(releasedAtTimerId);
      const timersDue = due !== undefined && due <= waitedTo;
      if (timersDue || frameCallbacks.pending(releasedAtFrameCallbackId) > 0) {
        flushSync(() => {
          timers.runDue(waitedTo, run, releasedAtTimerId);
          frameCallbacks.drain(filmMs, run, releasedAtFrameCallbackId);
        });
      }
      throwIfFailed();
      await nativeSleep(HOLD_POLL_MS);
    }
  } finally {
    holdWaitStartedAt = undefined;
    timers.rebase(createdDuringWait, filmMs);
  }
}

function imageSource(image: HTMLImageElement): string {
  return image.currentSrc || image.src || "(an <img> with no src)";
}

function pendingImages(): string[] {
  return Array.from(document.images)
    .filter((image) => !image.complete)
    .map(imageSource);
}

const decodedSources = new Map<string, Promise<boolean>>();

async function settleImages(frame: number): Promise<void> {
  const startedAt = native.now();
  const limit = budget(host.__XPLAINER_RENDER__?.imageTimeoutMs, DEFAULT_IMAGE_TIMEOUT_MS);
  for (const image of Array.from(document.images)) {
    while (!image.complete) {
      if (native.now() - startedAt > limit) {
        throw failWith(failure("IMAGE_TIMEOUT", `${imageSource(image)} at frame ${frame}`));
      }
      await nativeSleep(IMAGE_POLL_MS);
    }
    const source = imageSource(image);
    if (image.naturalWidth === 0) {
      throw failWith(failure("IMAGE_BROKEN", `${source} at frame ${frame}`));
    }
    let decoded = decodedSources.get(source);
    if (decoded === undefined) {
      decoded = image.decode().then(
        () => true,
        () => false,
      );
      decodedSources.set(source, decoded);
    }
    if (!(await decoded)) {
      throw failWith(failure("IMAGE_BROKEN", `${source} at frame ${frame}`));
    }
  }
}

/**
 * Settle the committed frame in passes (see the docblock, item 5). A pass is over when its tick
 * is; the frame is released after the first pass that changed no node, left no font loading and
 * left no hold or image outstanding. The DOM check is what reaches an `<img>` or a hold that
 * appears two or more effect → setState hops after the commit: each hop is a React task of its own,
 * and each pass lets one more of them run.
 */
async function settle(frame: number): Promise<void> {
  for (let pass = 1; ; pass += 1) {
    forgetDomChanges();
    await settleHolds();
    await settleImages(frame);
    await document.fonts.ready;
    await settleTick();
    seekAnimations();
    throwIfFailed();
    const holds = renderHolds();
    const images = pendingImages();
    const changed = domChangedSinceForget();
    if (holds.size === 0 && images.length === 0 && !changed && document.fonts.status === "loaded") {
      return;
    }
    if (pass === MAX_SETTLE_PASSES) {
      if (holds.size > 0) {
        throw failWith(
          failure(
            "DELAY_RENDER_TIMEOUT",
            `still held: ${[...holds.values()].map((hold) => hold.label).join(", ")} (taken again on each of ${MAX_SETTLE_PASSES} settle passes)`,
          ),
        );
      }
      if (images.length > 0) {
        throw failWith(failure("IMAGE_TIMEOUT", `${images[0] ?? ""} at frame ${frame}`));
      }
      return;
    }
  }
}

// ------------------------------------------------------------------------------------- mounting

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void = () => {};
  reject: (error: Error) => void = () => {};

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Observed here so a rejection nobody has asked about yet is not itself an unhandled
    // rejection — which this file's own listener would record as a second, misleading failure.
    this.promise.catch(() => {});
  }
}

const metadataReady = new Deferred<XplainerMetadata>();
const mounted = new Deferred<void>();
let video: VideoConfig | undefined;
let metadataDone = false;
let firstSettleDone = false;
let busy = false;

function rootContainer(): HTMLElement {
  const existing = document.getElementById("root");
  if (existing !== null) {
    return existing;
  }
  const created = document.createElement("div");
  created.id = "root";
  document.body.append(created);
  return created;
}

function onReactError(error: unknown): void {
  recordFailure(describeFailure(error));
}

/** Render `Root` once, off-screen, and keep what its `<Composition>` declared. */
function collectComposition(Root: ComponentType): VideoRegistration {
  const found = new Map<string, VideoRegistration>();
  const collect = (registration: VideoRegistration): void => {
    found.set(registration.id, registration);
  };
  const probe = createRoot(document.createElement("div"), {
    onUncaughtError: onReactError,
    onCaughtError: onReactError,
  });
  flushSync(() => {
    probe.render(
      createElement(CompositionCollectorContext.Provider, { value: collect }, createElement(Root)),
    );
  });
  probe.unmount();
  throwIfFailed();
  const registrations = [...found.values()];
  const [only] = registrations;
  if (only === undefined) {
    throw new Error(
      "registerRoot(): the root component rendered no <Composition>, so there is no video to render.",
    );
  }
  if (registrations.length > 1) {
    throw new Error(
      `registerRoot(): the root declares ${registrations.length} compositions (${[...found.keys()].join(", ")}); the xplainer renderer renders exactly one.`,
    );
  }
  return only;
}

function mount(resolved: ResolvedVideo): void {
  const { width, height } = resolved.config;
  const container = rootContainer();
  container.style.cssText = `position:relative;width:${width}px;height:${height}px;overflow:hidden;`;
  const root = createRoot(container, {
    onUncaughtError: onReactError,
    onCaughtError: onReactError,
  });
  flushSync(() => {
    root.render(createElement(HarnessApp, { config: resolved.config }, resolved.render()));
  });
  seekAnimations();
}

async function boot(entry: RegisteredEntry): Promise<void> {
  // Let the scene's index.ts finish evaluating before anything renders.
  await Promise.resolve();
  try {
    const registration =
      entry.kind === "video" ? entry.registration : collectComposition(entry.Root);
    const resolved = await registration.resolve(new AbortController().signal);
    video = resolved.config;
    metadataDone = true;
    metadataReady.resolve({
      fps: video.fps,
      durationInFrames: video.durationInFrames,
      width: video.width,
      height: video.height,
    });
    mount(resolved);
    throwIfFailed();
    await settle(0);
    markReleased();
    firstSettleDone = true;
    mounted.resolve();
  } catch (error) {
    const reason = failWith(describeFailure(error));
    metadataReady.reject(reason);
    mounted.reject(reason);
  }
}

onRegistration((entry) => {
  void boot(entry);
});

// ---------------------------------------------------------------------------------- the driver

async function setFrame(frame: number): Promise<void> {
  await mounted.promise;
  throwIfFailed();
  const config = video;
  if (config === undefined) {
    throw new Error("setFrame: the video has not mounted.");
  }
  if (!Number.isInteger(frame) || frame < 0 || frame >= config.durationInFrames) {
    throw new RangeError(
      `setFrame(${String(frame)}): the frame must be a whole number from 0 to ${config.durationInFrames - 1}.`,
    );
  }
  if (busy) {
    throw new Error(
      `setFrame(${frame}) was called while frame ${currentFrame} was still settling; await each setFrame before the next.`,
    );
  }
  busy = true;
  try {
    filmMs = frameToFilmMs(frame, config.fps);
    flushSync(() => {
      timers.runDue(filmMs, run);
      frameCallbacks.drain(filmMs, run);
      publishFrame(frame);
    });
    seekAnimations();
    throwIfFailed();
    await settle(frame);
    throwIfFailed();
    markReleased();
  } catch (error) {
    throw failWith(describeFailure(error));
  } finally {
    busy = false;
  }
}

function readiness(): XplainerReadiness {
  const pending: string[] = [];
  if (!metadataDone) {
    pending.push("metadata");
  }
  if (!firstSettleDone) {
    pending.push("first-settle");
  }
  for (const hold of renderHolds().values()) {
    pending.push(`delayRender:${hold.label}`);
  }
  for (const source of pendingImages()) {
    pending.push(`img:${source}`);
  }
  if (document.fonts.status !== "loaded") {
    pending.push("fonts");
  }
  const failed = [...recordedFailures()];
  return { ready: pending.length === 0 && failed.length === 0, pending, failed };
}

host.__xplainer = {
  metadata: () => metadataReady.promise,
  setFrame,
  readiness,
  get frame(): number {
    return currentFrame;
  },
};
