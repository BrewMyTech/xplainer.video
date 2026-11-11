/**
 * The page, driven: what a real headless shell captures, and how each page failure is named.
 *
 * Every case bundles a scaffolded video with the real bundler and the real `@xplainer/motion`
 * harness, opens it in a real headless shell over the pipe, and steps it. Nothing between the
 * test and the pixels is replaced, because the two properties under test only exist in a browser:
 *
 * - **Determinism.** The same three frames captured by two separate Chrome processes are the same
 *   bytes. That is what makes a render reproducible on one machine and its toolchain, and what
 *   lets a re-render be compared with the last one.
 * - **Named failures.** A broken image, an image that never arrives, a `delayRender` nobody
 *   releases, a `cancelRender`, and a scene that throws each reach the worker as their own code
 *   with the frame they happened on — and the `delayRender`-released-by-`setTimeout` pattern,
 *   which deadlocked on a pure film clock in the Phase 0 spike, renders.
 *
 * The browser is `XPLAINER_TEST_CHROME`, or the committed manifest's headless shell acquired by the
 * product's own provider (`render/testing/chrome.ts`). `XPLAINER_SKIP_RENDER_TEST=1` skips the
 * file, the same switch as the render test's; CI never sets it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { materialiseWorkspace, scaffoldVideo, videoPaths } from "@xplainer/render-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleVideo, type PageRenderSettings } from "./bundle.js";
import { openVideoPage } from "./capture.js";
import { type Chrome, launchChrome } from "./cdp.js";
import { testChrome } from "./testing/chrome.js";

const directories: string[] = [];

/** A scaffolded workspace whose one video is `frames` long and whose scenes are `scenes`. */
function fixture(scenesSource: string, frames: number): string {
  const root = mkdtempSync(join(tmpdir(), "xplainer-capture-"));
  directories.push(root);
  materialiseWorkspace(root);
  const video = videoPaths(root, "demo");
  scaffoldVideo(video.source);
  mkdirSync(video.publicDir, { recursive: true });
  const totalMs = Math.round((frames * 1000) / 30);
  writeFileSync(
    video.timings,
    JSON.stringify({
      fps: 30,
      durationInFrames: frames,
      totalMs,
      audio: "narration.wav",
      segments: [
        { id: "hook", index: 0, startMs: 0, endMs: totalMs, from: 0, durationInFrames: frames },
      ],
    }),
  );
  writeFileSync(
    video.captions,
    JSON.stringify([
      { text: "Frames", startMs: 0, endMs: totalMs, timestampMs: 0, confidence: null },
    ]),
  );
  writeFileSync(join(video.source, "Scenes.tsx"), scenesSource);
  return root;
}

async function bundled(root: string, settings?: PageRenderSettings): Promise<string> {
  const bundle = await bundleVideo({
    root,
    slug: "demo",
    outDir: join(videoPaths(root, "demo").out, ".render-test"),
    log: () => {},
    ...(settings === undefined ? {} : { renderSettings: settings }),
  });
  return bundle.url;
}

/** Every frame of `url`, captured in a Chrome process of its own. */
async function captureAll(url: string, extraFlags: readonly string[] = []): Promise<Buffer[]> {
  const chrome = await launchChrome({
    executable: (await testChrome()).path,
    log: () => {},
    extraFlags,
  });
  try {
    const page = await openVideoPage({ chrome, url, log: () => {}, readinessTimeoutMs: 15_000 });
    const frames: Buffer[] = [];
    for (let frame = 0; frame < page.metadata.durationInFrames; frame += 1) {
      frames.push(await page.capture(frame));
    }
    return frames;
  } finally {
    await chrome.close();
  }
}

afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const MOVING = `import { AbsoluteFill, interpolate, useCurrentFrame } from "@xplainer/motion";

const Moving = () => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 2], [0, 640]);
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 200 + x,
          top: 260,
          width: 360,
          height: 220,
          borderRadius: 28,
          background: "linear-gradient(90deg, #f43f5e, #6366f1)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
          transform: \`rotate(\${frame * 7}deg)\`,
        }}
      />
      <div className="absolute left-[200px] top-[620px] text-6xl font-bold text-white">frame {frame}</div>
    </AbsoluteFill>
  );
};

export const scenes = { hook: Moving };
`;

// The same switch as the render test: a real browser, so a developer without one can opt out.
describe.skipIf(process.env.XPLAINER_SKIP_RENDER_TEST === "1")("capturing a real page", () => {
  it("captures the same three frames as the same bytes in two separate Chrome processes", async () => {
    const url = await bundled(fixture(MOVING, 3));

    const first = await captureAll(url);
    const second = await captureAll(url);

    expect(first).toHaveLength(3);
    for (const [frame, png] of first.entries()) {
      expect(png.subarray(1, 4).toString("latin1"), `frame ${frame} is not a PNG`).toBe("PNG");
      expect(
        png.equals(second[frame] ?? Buffer.alloc(0)),
        `frame ${frame} differs between processes`,
      ).toBe(true);
    }
    // And the frames are frames: a capture that ignored setFrame would also be "deterministic".
    expect(first[0]?.equals(first[1] ?? Buffer.alloc(0))).toBe(false);
    expect(first[1]?.equals(first[2] ?? Buffer.alloc(0))).toBe(false);
  }, 120_000);

  /**
   * CSS animations and transitions run on the compositor unless something stops them, which is
   * what `--disable-threaded-animation` is for. The harness pauses every Web Animation and seeks it
   * to film time on each frame instead, and this is the evidence that it is enough: an infinite
   * keyframe animation and a transition started part-way through capture identically in two
   * processes **without** the flag, so the launch set does not carry it.
   */
  it("captures a CSS animation and a CSS transition identically twice, without the threaded-animation flag", async () => {
    const url = await bundled(
      fixture(
        `import { AbsoluteFill, useCurrentFrame } from "@xplainer/motion";

const css = \`
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spin { animation: spin 0.8s linear infinite; }
.slide { transition: transform 0.4s ease-in-out; }
.slide.moved { transform: translateX(720px); }
\`;

const Animated = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0c10" }}>
      <style>{css}</style>
      <div className="spin" style={{ position: "absolute", left: 300, top: 200, width: 240, height: 240, background: "#22d3ee" }} />
      <div className={frame >= 2 ? "slide moved" : "slide"} style={{ position: "absolute", left: 300, top: 640, width: 200, height: 120, background: "#f59e0b" }} />
    </AbsoluteFill>
  );
};

export const scenes = { hook: Animated };
`,
        8,
      ),
    );

    const first = await captureAll(url);
    const second = await captureAll(url);

    for (const [frame, png] of first.entries()) {
      expect(
        png.equals(second[frame] ?? Buffer.alloc(0)),
        `frame ${frame} differs between processes`,
      ).toBe(true);
    }
    // The animation is captured moving, not frozen at its first keyframe.
    expect(first[0]?.equals(first[3] ?? Buffer.alloc(0))).toBe(false);
  }, 120_000);
});

describe.skipIf(process.env.XPLAINER_SKIP_RENDER_TEST === "1")("a page that fails", () => {
  let chrome: Chrome;
  let url = "";
  let server: Server;
  const warnings: string[] = [];

  /**
   * One bundle, one browser, one page per scenario: the scenario is the URL's fragment, read by
   * the scene, and every failure is triggered on frame 1 or 2 — never 0 — so the page becomes
   * ready first and the failure is the frame's, as it would be in a real video.
   */
  beforeAll(async () => {
    // An image server that accepts and never answers, for IMAGE_TIMEOUT.
    server = createServer(() => {});
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;

    const root = fixture(
      `import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  cancelRender,
  continueRender,
  delayRender,
  Img,
  staticFile,
  useCurrentFrame,
} from "@xplainer/motion";

const scenario = window.location.hash.slice(1);

const Hold = () => {
  useState(() => delayRender("never released"));
  return null;
};

const TimerRelease = () => {
  useState(() => {
    const handle = delayRender("released by a timer");
    setTimeout(() => continueRender(handle), 100);
    return handle;
  });
  return <div className="text-white">released</div>;
};

const Cancel = () => {
  useEffect(() => {
    cancelRender(new Error("the data never came"));
  }, []);
  return null;
};

const Scene = () => {
  const frame = useCurrentFrame();
  if (scenario === "throws" && frame === 2) {
    throw new Error("scene two is broken");
  }
  return (
    <AbsoluteFill>
      {scenario === "broken-image" && frame >= 1 ? <Img src={staticFile("media/missing.png")} /> : null}
      {scenario === "slow-image" && frame >= 1 ? <Img src="http://127.0.0.1:${port}/never.png" /> : null}
      {scenario === "hold" && frame >= 1 ? <Hold /> : null}
      {scenario === "timer-release" && frame >= 1 ? <TimerRelease /> : null}
      {scenario === "cancel" && frame >= 1 ? <Cancel /> : null}
      {scenario === "second-audio" ? <Audio src={staticFile("narration.wav")} /> : null}
    </AbsoluteFill>
  );
};

export const scenes = { hook: Scene };
`,
      3,
    );
    url = await bundled(root, { delayRenderTimeoutMs: 500, imageTimeoutMs: 500 });
    chrome = await launchChrome({ executable: (await testChrome()).path, log: () => {} });
  }, 120_000);

  afterAll(async () => {
    await chrome?.close();
    server?.closeAllConnections();
    server?.close();
  });

  /** Open the scenario and step it to the end, or to the frame that fails. */
  async function run(scenario: string): Promise<number> {
    const page = await openVideoPage({
      chrome,
      url: `${url}#${scenario}`,
      log: (line) => warnings.push(line),
      readinessTimeoutMs: 15_000,
    });
    for (let frame = 0; frame < page.metadata.durationInFrames; frame += 1) {
      await page.capture(frame);
    }
    return page.metadata.durationInFrames;
  }

  it("names a broken image IMAGE_BROKEN, on the frame that drew it", async () => {
    await expect(run("broken-image")).rejects.toMatchObject({
      code: "IMAGE_BROKEN",
      message: expect.stringMatching(/^IMAGE_BROKEN: frame 1: .*missing\.png/),
    });
  }, 60_000);

  it("names an image that never arrives IMAGE_TIMEOUT, within the page's image budget", async () => {
    const started = performance.now();
    await expect(run("slow-image")).rejects.toMatchObject({
      code: "IMAGE_TIMEOUT",
      message: expect.stringMatching(/^IMAGE_TIMEOUT: frame 1: .*never\.png/),
    });
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it("names a delayRender nobody releases DELAY_RENDER_TIMEOUT, with its label", async () => {
    await expect(run("hold")).rejects.toMatchObject({
      code: "DELAY_RENDER_TIMEOUT",
      message: expect.stringMatching(/^DELAY_RENDER_TIMEOUT: frame 1: .*never released/),
    });
  }, 60_000);

  it("reports cancelRender as PAGE_ERROR with the scene's own reason", async () => {
    await expect(run("cancel")).rejects.toMatchObject({
      code: "PAGE_ERROR",
      message: expect.stringMatching(/^PAGE_ERROR: frame 1: .*the data never came/),
    });
  }, 60_000);

  it("reports a scene that throws as PAGE_ERROR on the frame it threw", async () => {
    await expect(run("throws")).rejects.toMatchObject({
      code: "PAGE_ERROR",
      message: expect.stringMatching(/^PAGE_ERROR: frame 2: .*scene two is broken/),
    });
  }, 60_000);

  /** The deadlock the Phase 0 spike found on a pure film clock, fixed rather than documented. */
  it("renders a delayRender released from setTimeout(…, 100)", async () => {
    await expect(run("timer-release")).resolves.toBe(3);
  }, 60_000);

  /** Warnings are the job log's, never the render's: a second `<Audio>` is one, not a failure. */
  it("logs a second <Audio> as a page warning and renders anyway", async () => {
    await expect(run("second-audio")).resolves.toBe(3);
    expect(warnings.join("\n")).toMatch(/page warning at .*Audio/);
  }, 60_000);
});
