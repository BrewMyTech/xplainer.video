/**
 * One bundled video, open in a page, captured one frame at a time.
 *
 * The page does the hard part: `@xplainer/motion/harness` exposes `window.__xplainer`, whose
 * `setFrame(n)` moves film time to frame `n`, commits the React tree for it and resolves only once
 * every `delayRender` handle, image and font the frame needs has settled. This module drives that
 * contract over CDP and turns what the page reports into named failures:
 *
 * - **readiness** — polled every 100 ms for up to 30 s, with the pending list logged once a second
 *   after the first ten, and `READINESS_TIMEOUT` naming what never arrived;
 * - **a frame** — `setFrame(n)` then `Page.captureScreenshot`, PNG, from the surface, clipped to
 *   the composition. `optimizeForSpeed` is on: on an opaque frame it changed no pixel in the Phase 0
 *   spike and roughly doubled capture speed on busy content;
 * - **the page itself** — an uncaught exception, a `console.error` and a renderer crash are each
 *   `PAGE_ERROR` with the frame they happened on. A `console.warn` is logged and never fatal.
 *
 * A rejection from `setFrame` keeps the code the harness gave it (`DELAY_RENDER_TIMEOUT`,
 * `IMAGE_BROKEN`, `IMAGE_TIMEOUT`, …) and gains the frame index.
 */

import type { CdpSession, Chrome } from "./cdp.js";
import { leadingCode, RenderError } from "./render-error.js";

/** How often readiness is asked for. */
export const READINESS_POLL_MS = 100;

/** How long a page may take to become ready before the render is refused. */
export const READINESS_TIMEOUT_MS = 30_000;

/** After this long, the pending list is logged once a second, so a slow page says what it waits on. */
export const READINESS_DIAGNOSTIC_AFTER_MS = 10_000;

/** What the page says the composition is. */
export type PageMetadata = {
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
};

/** A page with a video in it, ready to be stepped. */
export type VideoPage = {
  metadata: PageMetadata;
  /** Move to frame `n` and return its PNG. */
  capture: (frame: number) => Promise<Buffer>;
};

/** What {@link openVideoPage} needs. */
export type OpenVideoPageOptions = {
  chrome: Chrome;
  /** The bundle's `index.html`, as a `file:` URL. */
  url: string;
  /**
   * The device scale factor. `1` for a render; a still's `scale` otherwise, so `0.5` captures a
   * 960×540 PNG of a 1920×1080 composition without resampling it afterwards.
   */
  deviceScaleFactor?: number;
  /** Where page warnings and the readiness diagnostic go. */
  log: (line: string) => void;
  readinessTimeoutMs?: number;
};

type PageProblem = { frame: number; kind: string; text: string };

/** The fields of a `Runtime.RemoteObject` this module reads. */
type RemoteObject = { value?: unknown; description?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function remoteText(object: unknown): string {
  if (!isRecord(object)) {
    return String(object);
  }
  const { value, description } = object as RemoteObject;
  if (typeof value === "string") {
    return value;
  }
  if (typeof description === "string") {
    return description;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/** The first line of a thrown value's description, without the `Error: ` an exception prints. */
function exceptionText(details: unknown): string {
  if (!isRecord(details)) {
    return String(details);
  }
  const exception = details.exception;
  const text =
    isRecord(exception) && typeof exception.description === "string"
      ? exception.description
      : typeof details.text === "string"
        ? details.text
        : JSON.stringify(details);
  return (text.split("\n")[0] ?? text).replace(/^Uncaught\s+/, "");
}

/** Evaluate an expression in the page and return its value, or throw the page's own message. */
async function evaluate(
  page: CdpSession,
  expression: string,
  timeoutMs?: number,
): Promise<unknown> {
  const answer = await page.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  if (!isRecord(answer)) {
    throw new Error(`Runtime.evaluate answered ${JSON.stringify(answer)}`);
  }
  if (answer.exceptionDetails !== undefined) {
    throw new Error(exceptionText(answer.exceptionDetails));
  }
  return isRecord(answer.result) ? answer.result.value : undefined;
}

/** A page message as a `RenderError`, keeping the harness's code when it gave one. */
function pageFailure(message: string, where: string): RenderError {
  const code = leadingCode(message);
  if (code !== null) {
    return new RenderError(code, `${where}: ${message.slice(code.length + 1).trim()}`);
  }
  return new RenderError("PAGE_ERROR", `${where}: ${message}`);
}

function describeFrame(frame: number): string {
  return frame < 0 ? "while loading" : `frame ${frame}`;
}

function isMetadata(value: unknown): value is PageMetadata {
  return (
    isRecord(value) &&
    ["fps", "durationInFrames", "width", "height"].every(
      (key) =>
        typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) > 0,
    )
  );
}

/**
 * Open `url` in a new page, wait for the video to be ready, and read its metadata.
 *
 * Fails with `PAGE_ERROR` when the page throws while loading, the harness's own code when it
 * reports a failure through `readiness()`, and `READINESS_TIMEOUT` when it never becomes ready.
 */
export async function openVideoPage(options: OpenVideoPageOptions): Promise<VideoPage> {
  const { chrome, log } = options;
  const page = await chrome.connection.newPage();

  let currentFrame = -1;
  const problems: PageProblem[] = [];
  let crashed: (error: RenderError) => void = () => {};
  const crash = new Promise<never>((_, reject) => {
    crashed = reject;
  });
  // Observed so an unawaited rejection is never reported; every page call races against it.
  crash.catch(() => undefined);

  page.on("Runtime.exceptionThrown", (params) => {
    const details = isRecord(params) ? params.exceptionDetails : params;
    problems.push({
      frame: currentFrame,
      kind: "uncaught exception",
      text: exceptionText(details),
    });
  });
  page.on("Runtime.consoleAPICalled", (params) => {
    if (!isRecord(params)) {
      return;
    }
    const args = Array.isArray(params.args) ? params.args : [];
    const text = args.map(remoteText).join(" ");
    if (params.type === "error" || params.type === "assert") {
      problems.push({ frame: currentFrame, kind: `console.${String(params.type)}`, text });
    } else if (params.type === "warning") {
      log(`[xplainer] page warning at ${describeFrame(currentFrame)}: ${text}`);
    }
  });
  page.on("Log.entryAdded", (params) => {
    const entry = isRecord(params) && isRecord(params.entry) ? params.entry : null;
    if (entry !== null && (entry.level === "error" || entry.level === "warning")) {
      const url = typeof entry.url === "string" && entry.url !== "" ? ` (${entry.url})` : "";
      log(
        `[xplainer] page ${String(entry.level)} at ${describeFrame(currentFrame)}: ${String(entry.text)}${url}`,
      );
    }
  });
  page.on("Inspector.targetCrashed", () => {
    crashed(
      new RenderError("PAGE_ERROR", `${describeFrame(currentFrame)}: the page's renderer crashed`),
    );
  });

  const guarded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, crash]);
  const throwIfProblem = (): void => {
    const [first] = problems;
    if (first !== undefined) {
      throw new RenderError(
        "PAGE_ERROR",
        `${describeFrame(first.frame)}: ${first.kind}: ${first.text}`,
      );
    }
  };

  await guarded(
    Promise.all([
      page.send("Page.enable"),
      page.send("Runtime.enable"),
      page.send("Log.enable"),
      page.send("Inspector.enable"),
    ]),
  );
  const deviceScaleFactor = options.deviceScaleFactor ?? 1;
  const setViewport = (width: number, height: number): Promise<unknown> =>
    page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
  await guarded(setViewport(1920, 1080));

  const loaded = new Promise<void>((resolve) => {
    const off = page.on("Page.loadEventFired", () => {
      off();
      resolve();
    });
  });
  const navigation = await guarded(page.send("Page.navigate", { url: options.url }));
  if (isRecord(navigation) && typeof navigation.errorText === "string") {
    throw new RenderError("PAGE_ERROR", `${options.url} did not load: ${navigation.errorText}`);
  }
  const readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
  await guarded(
    Promise.race([
      loaded,
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new RenderError("READINESS_TIMEOUT", `${options.url} never finished loading`));
        }, readinessTimeoutMs).unref();
      }),
    ]),
  );
  throwIfProblem();

  const started = performance.now();
  let lastDiagnostic = 0;
  for (;;) {
    const state = await guarded(
      evaluate(page, "window.__xplainer ? window.__xplainer.readiness() : null"),
    );
    throwIfProblem();
    const ready = isRecord(state) && state.ready === true;
    const pending =
      isRecord(state) && Array.isArray(state.pending) ? state.pending.map(String) : [];
    const failed = isRecord(state) && Array.isArray(state.failed) ? state.failed.map(String) : [];
    if (failed[0] !== undefined) {
      throw pageFailure(failed[0], "while loading");
    }
    if (ready) {
      break;
    }
    const waited = performance.now() - started;
    const list =
      state === null ? "window.__xplainer (the harness never started)" : pending.join(", ");
    if (waited > readinessTimeoutMs) {
      throw new RenderError(
        "READINESS_TIMEOUT",
        `the page was not ready after ${Math.round(waited / 1000)} s; pending: ${list || "nothing named"}`,
      );
    }
    if (waited > READINESS_DIAGNOSTIC_AFTER_MS && waited - lastDiagnostic >= 1_000) {
      lastDiagnostic = waited;
      log(`[xplainer] waiting for the page (${Math.round(waited / 1000)} s); pending: ${list}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, READINESS_POLL_MS);
    });
  }

  const metadata = await guarded(evaluate(page, "window.__xplainer.metadata()"));
  if (!isMetadata(metadata)) {
    throw new RenderError(
      "PAGE_ERROR",
      `window.__xplainer.metadata() answered ${JSON.stringify(metadata)}, not fps, ` +
        "durationInFrames, width and height.",
    );
  }
  if (metadata.width !== 1920 || metadata.height !== 1080) {
    await guarded(setViewport(metadata.width, metadata.height));
  }

  const clip = { x: 0, y: 0, width: metadata.width, height: metadata.height, scale: 1 };
  return {
    metadata,
    async capture(frame: number): Promise<Buffer> {
      currentFrame = frame;
      // The rejection is caught in the page and returned as a value: its message is the harness's
      // own `CODE: …`, and an exception would arrive as a description with a stack attached.
      const failure = await guarded(
        evaluate(
          page,
          `window.__xplainer.setFrame(${frame}).then(() => null, (error) => ` +
            "String(error && error.message !== undefined ? error.message : error))",
        ),
      );
      if (typeof failure === "string") {
        throw pageFailure(failure, `frame ${frame}`);
      }
      throwIfProblem();
      const shot = await guarded(
        page.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          optimizeForSpeed: true,
          clip,
        }),
      );
      throwIfProblem();
      if (!isRecord(shot) || typeof shot.data !== "string") {
        throw new RenderError("PAGE_ERROR", `frame ${frame}: the screenshot came back empty`);
      }
      return Buffer.from(shot.data, "base64");
    },
  };
}
