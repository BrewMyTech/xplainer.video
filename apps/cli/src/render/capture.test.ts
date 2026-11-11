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
 *   releases, a `cancelRender`, a scene that throws and a second `<Audio>` each reach the worker as
 *   their own code with the frame they happened on — and the `delayRender`-released-by-`setTimeout`
 *   pattern, which deadlocked on a pure film clock in the Phase 0 spike, renders, as does its
 *   `requestAnimationFrame` twin.
 * - **A settled frame.** Whatever the frame's own work puts in the page — an image three
 *   effect→setState hops after the commit, a font whose load the frame's layout starts — is in the
 *   picture of that frame, and a timer a render hold's release creates fires on the same frame
 *   however long the hold took.
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
import { crc32, deflateSync } from "node:zlib";
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

/** A 1×1 opaque white PNG, written out here so the image server owes nothing to a fixture file. */
function whitePixelPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    // One scanline: filter type 0, then R, G, B.
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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

/** Two dozen boxes scattered with `Math.random()` on every render, so every frame draws new values. */
const SCATTERED = `import { AbsoluteFill, useCurrentFrame } from "@xplainer/motion";

const Scattered = () => {
  useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0c10" }}>
      {Array.from({ length: 24 }, (_, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            left: Math.random() * 1800,
            top: Math.random() * 960,
            width: 80,
            height: 80,
            background: "#f43f5e",
          }}
        />
      ))}
    </AbsoluteFill>
  );
};

export const scenes = { hook: Scattered };
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
   * `Math.random` in the page is mulberry32 from a fixed seed, reset when the video mounts: two
   * page loads in two processes draw the same sequence, so a scene that scatters boxes with it on
   * every render captures as the same bytes — and differently on each frame, because each render
   * takes the next values rather than starting the sequence again.
   */
  it("draws the same Math.random() sequence in two separate Chrome processes", async () => {
    const url = await bundled(fixture(SCATTERED, 3));

    const first = await captureAll(url);
    const second = await captureAll(url);

    expect(first).toHaveLength(3);
    for (const [frame, png] of first.entries()) {
      expect(
        png.equals(second[frame] ?? Buffer.alloc(0)),
        `frame ${frame} differs between processes`,
      ).toBe(true);
    }
    expect(first[0]?.equals(first[1] ?? Buffer.alloc(0))).toBe(false);
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
  /** Long enough for a timer 90 ms after frame 1 to land inside the video (frame 4 at 30 fps). */
  const FRAMES = 8;
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
    // `/slow.png?ms=N` answers a white pixel after N ms, `/slow.woff2?ms=N` answers bytes that are
    // not a font after N ms (the load fails and the fallback face draws), and anything else is
    // accepted and never answered, for IMAGE_TIMEOUT.
    const pixel = whitePixelPng();
    server = createServer((request, response) => {
      const asked = new URL(request.url ?? "/", "http://127.0.0.1");
      const delay = Number(asked.searchParams.get("ms") ?? "0");
      const answer = (type: string, body: Buffer): void => {
        setTimeout(() => {
          response.writeHead(200, {
            "content-type": type,
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          });
          response.end(body);
        }, delay);
      };
      if (asked.pathname === "/slow.png") {
        answer("image/png", pixel);
      } else if (asked.pathname === "/slow.woff2") {
        answer("font/woff2", Buffer.from("not a font"));
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;

    const root = fixture(
      `import { useEffect, useRef, useState } from "react";
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

const ObserverRelease = () => {
  const box = useRef<HTMLDivElement>(null);
  const [handle] = useState(() => delayRender("released by a ResizeObserver"));
  useEffect(() => {
    const observer = new ResizeObserver(() => continueRender(handle));
    if (box.current) {
      observer.observe(box.current);
    }
    return () => observer.disconnect();
  }, [handle]);
  return <div ref={box} className="h-10 w-10 bg-white" />;
};

const FrameRelease = () => {
  useState(() => {
    const handle = delayRender("released by requestAnimationFrame");
    requestAnimationFrame(() => continueRender(handle));
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

const BOX = { position: "absolute", left: 100, top: 100, width: 300, height: 300 } as const;

/** Three effect → setState hops, each changing the DOM, and an image only on the third. */
const Hops = () => {
  const [hop, setHop] = useState(0);
  useEffect(() => {
    if (hop < 3) {
      setHop(hop + 1);
    }
  }, [hop]);
  return (
    <div data-hop={hop}>
      {hop === 3 ? <Img src="http://127.0.0.1:${port}/slow.png?ms=400" style={BOX} /> : null}
    </div>
  );
};

/** A hold an image's onload releases, after arming a 90 ms timer that shows a second box. */
const LateTimer = ({ latency }: { latency: number }) => {
  const [handle] = useState(() => delayRender("the slow image"));
  const [shown, setShown] = useState(false);
  return (
    <>
      <Img
        src={"http://127.0.0.1:${port}/slow.png?ms=" + latency}
        style={BOX}
        onLoad={() => {
          setTimeout(() => setShown(true), 90);
          continueRender(handle);
        }}
      />
      {shown ? <div style={{ ...BOX, left: 500, background: "#22d3ee" }} /> : null}
    </>
  );
};

/**
 * Text whose web font arrives by a stylesheet adopted in a task of the scene's own — so after the
 * settle's first await of document.fonts.ready, and without changing a node of the DOM.
 */
const LateFont = () => {
  useEffect(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(".late-font { font-family: Slow, sans-serif; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    };
    channel.port2.postMessage(0);
  }, []);
  return (
    <>
      <style>{"@font-face { font-family: Slow; src: url(http://127.0.0.1:${port}/slow.woff2?ms=400); }"}</style>
      <div className="late-font" style={{ position: "absolute", left: 100, top: 500, fontSize: 120, color: "#ffffff" }}>
        Slow font
      </div>
    </>
  );
};

/** A broken image two effect hops after the commit: it fails fast, so it is complete when seen. */
const LateBrokenImage = () => {
  const [hop, setHop] = useState(0);
  useEffect(() => {
    if (hop < 2) {
      setHop(hop + 1);
    }
  }, [hop]);
  return <div data-hop={hop}>{hop === 2 ? <Img src={staticFile("media/missing.png")} /> : null}</div>;
};

/** An animation on a scroll timeline, whose time is a percentage and refuses milliseconds. */
const ScrollDriven = () => (
  <>
    <style>{"@keyframes widen { from { width: 10px; } to { width: 400px; } } .scroll-driven { animation: widen linear both; animation-timeline: scroll(root); }"}</style>
    <div className="scroll-driven" style={{ position: "absolute", left: 100, top: 100, height: 40, background: "#f59e0b" }} />
  </>
);

/**
 * Changes the DOM in every task of its own until it unmounts, so no settle pass ever finds the page
 * still: one message in flight at a time, always queued ahead of the settle's own.
 */
const Restless = () => {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stopped = false;
    let ticks = 0;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (stopped) {
        channel.port1.close();
        return;
      }
      ticks += 1;
      box.current?.setAttribute("data-tick", String(ticks));
      channel.port2.postMessage(0);
    };
    channel.port2.postMessage(0);
    return () => {
      stopped = true;
    };
  }, []);
  return <div ref={box} />;
};

/** Throws, so the frame fails, unless a date's constructor is the Date the scene sees. */
const DateConstructor = () => {
  const date = new Date();
  if (date.constructor !== Date || Date.prototype.constructor !== Date) {
    throw new Error("new Date().constructor is not Date");
  }
  return <div className="text-white">{date.getUTCFullYear()}</div>;
};

const latency = scenario.startsWith("late-timer-") ? Number(scenario.slice("late-timer-".length)) : 0;

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
      {scenario === "frame-release" && frame >= 1 ? <FrameRelease /> : null}
      {scenario === "observer-release" && frame >= 1 ? <ObserverRelease /> : null}
      {scenario === "cancel" && frame >= 1 ? <Cancel /> : null}
      {scenario === "second-audio" && frame >= 1 ? <Audio src={staticFile("narration.wav")} /> : null}
      {scenario === "hops" && frame >= 1 ? <Hops /> : null}
      {latency > 0 && frame >= 1 ? <LateTimer latency={latency} /> : null}
      {scenario === "late-font" && frame >= 1 ? <LateFont /> : null}
      {scenario === "late-broken-image" && frame >= 1 ? <LateBrokenImage /> : null}
      {scenario === "scroll-timeline" && frame >= 1 ? <ScrollDriven /> : null}
      {scenario === "date-constructor" && frame >= 1 ? <DateConstructor /> : null}
      {scenario === "restless" && frame === 1 ? <Restless /> : null}
    </AbsoluteFill>
  );
};

export const scenes = { hook: Scene };
`,
      FRAMES,
    );
    // The image budget is above the slow server's 400 ms and well under the never-answering one's.
    url = await bundled(root, { delayRenderTimeoutMs: 1_500, imageTimeoutMs: 1_500 });
    chrome = await launchChrome({ executable: (await testChrome()).path, log: () => {} });
  }, 120_000);

  afterAll(async () => {
    await chrome?.close();
    server?.closeAllConnections();
    server?.close();
  });

  /** Open the scenario and capture every frame, or throw at the frame that fails. */
  async function frames(scenario: string): Promise<Buffer[]> {
    const page = await openVideoPage({
      chrome,
      url: `${url}#${scenario}`,
      log: (line) => warnings.push(line),
      readinessTimeoutMs: 15_000,
    });
    const captured: Buffer[] = [];
    for (let frame = 0; frame < page.metadata.durationInFrames; frame += 1) {
      captured.push(await page.capture(frame));
    }
    return captured;
  }

  /** Open the scenario and step it to the end, or to the frame that fails. */
  async function run(scenario: string): Promise<number> {
    return (await frames(scenario)).length;
  }

  const same = (a: Buffer | undefined, b: Buffer | undefined): boolean =>
    a !== undefined && b !== undefined && a.equals(b);

  it("names a broken image IMAGE_BROKEN, on the frame that drew it", async () => {
    await expect(run("broken-image")).rejects.toMatchObject({
      code: "IMAGE_BROKEN",
      message: expect.stringMatching(/^IMAGE_BROKEN: frame 1: .*missing\.png/),
    });
  }, 60_000);

  /** Mounted two effect hops after the commit; the failure is still frame 1's, not frame 2's. */
  it("names a broken image a later settle pass found IMAGE_BROKEN, on the frame that drew it", async () => {
    await expect(run("late-broken-image")).rejects.toMatchObject({
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
    await expect(run("timer-release")).resolves.toBe(FRAMES);
  }, 60_000);

  /** The same deadlock through the other queue the harness owns: the callback waited for a frame. */
  it("renders a delayRender released from requestAnimationFrame", async () => {
    await expect(run("frame-release")).resolves.toBe(FRAMES);
  }, 60_000);

  /**
   * An image three effect → setState hops after frame 1's commit, from a server that answers after
   * 400 ms. Each hop is a React task of its own, so a settle that checked once would release frame
   * 1 before the image existed and frame 2 would be the first to wait for it.
   */
  it("waits on the frame itself for an image three effect hops after the commit", async () => {
    const captured = await frames("hops");
    expect(same(captured[0], captured[1]), "frame 1 shows no image").toBe(false);
    expect(same(captured[1], captured[2]), "the image arrived only on frame 2").toBe(true);
  }, 60_000);

  /**
   * A font whose load starts after the settle has already awaited `document.fonts.ready` — here
   * through a stylesheet a task adopts, which no DOM observer sees — blocks the text it draws, so
   * frame 1 must wait for it (to fail, and fall back) rather than capture the invisible block
   * period and leave the text to frame 2.
   */
  it("waits on the frame itself for a font whose load starts after the first fonts.ready", async () => {
    const captured = await frames("late-font");
    expect(same(captured[0], captured[1]), "frame 1 shows no text").toBe(false);
    expect(same(captured[1], captured[2]), "the text settled only on frame 2").toBe(true);
  }, 60_000);

  /**
   * A timer armed by the image load that releases a hold fires 90 ms of **film** after the frame,
   * whatever the load took: at 30 fps that is frame 4, for a server answering after 20 ms and after
   * 600 ms alike. Scheduled from the wall clock it landed on frame 5 for the one and past the end
   * of the video for the other.
   */
  it("fires a timer the hold's release created at the same frame whatever the release took", async () => {
    const fast = await frames("late-timer-20");
    const slow = await frames("late-timer-600");
    expect(fast).toHaveLength(FRAMES);
    for (const [frame, png] of fast.entries()) {
      expect(same(png, slow[frame]), `frame ${frame} differs between latencies`).toBe(true);
    }
    expect(same(fast[3], fast[4]), "the timer fired on frame 4").toBe(false);
    expect(same(fast[4], fast[FRAMES - 1]), "nothing changed after frame 4").toBe(true);
  }, 60_000);

  /**
   * The harness replaces `ResizeObserver` with a subclass that records it was used (`settleTick`
   * then waits one native frame per settle). This proves the subclass is still a working observer:
   * it constructs, observes, and its first report — delivered only inside a native frame — releases
   * the hold. It does not prove the frame wait itself, which a hold released on the wall clock
   * would pass without.
   */
  it("renders a delayRender released by a ResizeObserver's first report", async () => {
    await expect(run("observer-release")).resolves.toBe(FRAMES);
  }, 60_000);

  /**
   * The harness seeks Web Animations to film time in milliseconds; an animation on a scroll timeline
   * measures its time as a percentage and throws on a number, so the seeker must leave it alone
   * rather than turn every frame that has one into a PAGE_ERROR.
   */
  it("renders a scroll-driven CSS animation, leaving it to its scroll timeline", async () => {
    await expect(run("scroll-timeline")).resolves.toBe(FRAMES);
  }, 60_000);

  /**
   * The settle gives up after its last pass rather than hold the render forever, and releases the
   * frame as it stands — the one frame the harness knowingly lets go unsettled — so it says so, once,
   * as a page warning that names the frame. Frame 2 unmounts the restless node and settles quietly.
   */
  it("releases a frame whose DOM never stops changing with one page warning naming it", async () => {
    const before = warnings.length;
    await expect(run("restless")).resolves.toBe(FRAMES);
    const unsettled = warnings.slice(before).filter((line) => line.includes("settle passes"));
    expect(unsettled).toEqual([
      expect.stringMatching(
        /^\[xplainer\] page warning at frame 1: frame 1 was still changing after 10 settle passes \(the DOM changed on the last pass\), so it is released as it stands\.$/,
      ),
    ]);
  }, 60_000);

  /** Under the film-time Date, a date's constructor is still the page's Date. */
  it("keeps new Date().constructor === Date under the film-time clock", async () => {
    await expect(run("date-constructor")).resolves.toBe(FRAMES);
  }, 60_000);

  /**
   * The encoder muxes the narration and nothing else, so a scene's own `<Audio>` would be silently
   * absent from the MP4. Refused by name instead, like `<Video>`, on the frame it mounted.
   */
  it("refuses a second <Audio> as NOT_SUPPORTED_IN_V1, on the frame that mounted it", async () => {
    await expect(run("second-audio")).rejects.toMatchObject({
      code: "NOT_SUPPORTED_IN_V1",
      message: expect.stringMatching(
        /^NOT_SUPPORTED_IN_V1: frame 1: .*narration is the only audio track/,
      ),
    });
  }, 60_000);
});
