/**
 * The timing components and hooks, rendered with `react-dom/server` at chosen frames.
 *
 * Each `Probe` prints what `useCurrentFrame()` and `useVideoConfig()` returned where it was
 * mounted, so an assertion reads the timeline a scene would see rather than the implementation's
 * internals. A probe that is absent from the markup was not mounted at that frame.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AbsoluteFill,
  Audio,
  Freeze,
  Img,
  Loop,
  OffthreadVideo,
  Sequence,
  Series,
  Video,
} from "./components.js";
import { useCurrentFrame, useVideoConfig } from "./hooks.js";
import { staticFile } from "./static-file.js";
import { renderAtFrame } from "./testing/render.js";

function Probe({ name }: { name: string }): React.ReactElement {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  return <i>{`${name}:${frame}/${durationInFrames}@${fps}`}</i>;
}

/** The probes present in `markup`, as `name:frame/duration@fps`. */
function probes(markup: string): string[] {
  return [...markup.matchAll(/<i>([^<]*)<\/i>/g)].map((match) => match[1] ?? "");
}

describe("Sequence", () => {
  const tree = (
    <Sequence from={10} durationInFrames={20}>
      <Probe name="a" />
    </Sequence>
  );

  it("mounts its children only for from ≤ frame < from + durationInFrames", () => {
    expect(probes(renderAtFrame(tree, 9))).toEqual([]);
    expect(probes(renderAtFrame(tree, 10))).toEqual(["a:0/20@30"]);
    expect(probes(renderAtFrame(tree, 29))).toEqual(["a:19/20@30"]);
    expect(probes(renderAtFrame(tree, 30))).toEqual([]);
  });

  it("adds nested offsets, and a nested window is clipped by its parent's", () => {
    const nested = (
      <Sequence from={10} durationInFrames={20}>
        <Sequence from={5}>
          <Probe name="inner" />
        </Sequence>
      </Sequence>
    );
    expect(probes(renderAtFrame(nested, 14))).toEqual([]);
    expect(probes(renderAtFrame(nested, 15))).toEqual(["inner:0/20@30"]);
    expect(probes(renderAtFrame(nested, 29))).toEqual(["inner:14/20@30"]);
    expect(probes(renderAtFrame(nested, 30))).toEqual([]);
  });

  it("leaves the video's duration in useVideoConfig when its own is infinite", () => {
    const open = (
      <Sequence from={100}>
        <Probe name="open" />
      </Sequence>
    );
    expect(probes(renderAtFrame(open, 250))).toEqual(["open:150/300@30"]);
  });

  it("wraps in an AbsoluteFill by default and adds no element with layout='none'", () => {
    expect(
      renderAtFrame(
        <Sequence style={{ opacity: 0.5 }} className="scene">
          <b />
        </Sequence>,
        0,
      ),
    ).toBe(
      '<div class="scene" style="position:absolute;top:0;left:0;right:0;bottom:0;width:100%;height:100%;display:flex;flex-direction:column;opacity:0.5"><b></b></div>',
    );
    expect(
      renderAtFrame(
        <Sequence layout="none" style={{ opacity: 0.5 }}>
          <b />
        </Sequence>,
        0,
      ),
    ).toBe("<b></b>");
  });

  it("refuses a duration that is not positive", () => {
    expect(() => renderAtFrame(<Sequence durationInFrames={0} />, 0)).toThrow(
      /durationInFrames must be a positive number/,
    );
  });
});

describe("Series", () => {
  const series = (
    <Series>
      <Series.Sequence durationInFrames={10}>
        <Probe name="first" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={20} offset={5}>
        <Probe name="second" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={10} offset={-3}>
        <Probe name="third" />
      </Series.Sequence>
    </Series>
  );

  it("places each sequence where the previous one ends, shifted by its offset", () => {
    // first [0, 10) · second [15, 35) · third [32, 42): the negative offset overlaps the second.
    expect(probes(renderAtFrame(series, 0))).toEqual(["first:0/10@30"]);
    expect(probes(renderAtFrame(series, 12))).toEqual([]);
    expect(probes(renderAtFrame(series, 15))).toEqual(["second:0/20@30"]);
    expect(probes(renderAtFrame(series, 33))).toEqual(["second:18/20@30", "third:1/10@30"]);
    expect(probes(renderAtFrame(series, 41))).toEqual(["third:9/10@30"]);
    expect(probes(renderAtFrame(series, 42))).toEqual([]);
  });

  it("accepts only Series.Sequence children, and an infinite one only last", () => {
    expect(() =>
      renderAtFrame(
        <Series>
          <b />
        </Series>,
        0,
      ),
    ).toThrow(/only <Series.Sequence>/);
    expect(() =>
      renderAtFrame(
        <Series>
          <Series.Sequence durationInFrames={Number.POSITIVE_INFINITY} />
          <Series.Sequence durationInFrames={5} />
        </Series>,
        0,
      ),
    ).toThrow(/only the last sequence/);
    expect(() => renderAtFrame(<Series.Sequence durationInFrames={5} />, 0)).toThrow(
      /direct child of <Series>/,
    );
  });
});

describe("Loop", () => {
  it("shows its children frame mod durationInFrames, and one iteration's duration", () => {
    const loop = (
      <Loop durationInFrames={12}>
        <Probe name="loop" />
      </Loop>
    );
    expect(probes(renderAtFrame(loop, 0))).toEqual(["loop:0/12@30"]);
    expect(probes(renderAtFrame(loop, 11))).toEqual(["loop:11/12@30"]);
    expect(probes(renderAtFrame(loop, 12))).toEqual(["loop:0/12@30"]);
    expect(probes(renderAtFrame(loop, 29))).toEqual(["loop:5/12@30"]);
  });

  it("unmounts after `times` iterations", () => {
    const twice = (
      <Loop durationInFrames={10} times={2}>
        <Probe name="twice" />
      </Loop>
    );
    expect(probes(renderAtFrame(twice, 19))).toEqual(["twice:9/10@30"]);
    expect(probes(renderAtFrame(twice, 20))).toEqual([]);
  });

  it("loops relative to an enclosing Sequence", () => {
    const inside = (
      <Sequence from={100}>
        <Loop durationInFrames={10}>
          <Probe name="inside" />
        </Loop>
      </Sequence>
    );
    expect(probes(renderAtFrame(inside, 99))).toEqual([]);
    expect(probes(renderAtFrame(inside, 123))).toEqual(["inside:3/10@30"]);
  });
});

describe("Freeze", () => {
  it("pins the frame its children see while active, and adds no element", () => {
    const frozen = (
      <Sequence from={10} layout="none">
        <Freeze frame={4}>
          <Probe name="frozen" />
        </Freeze>
      </Sequence>
    );
    expect(renderAtFrame(frozen, 50)).toBe("<i>frozen:4/300@30</i>");
  });

  it("passes the frame through when inactive, or when its test of the frame is false", () => {
    expect(
      probes(
        renderAtFrame(
          <Freeze frame={4} active={false}>
            <Probe name="thawed" />
          </Freeze>,
          50,
        ),
      ),
    ).toEqual(["thawed:50/300@30"]);
    const late = (
      <Freeze frame={0} active={(frame) => frame >= 60}>
        <Probe name="late" />
      </Freeze>
    );
    expect(probes(renderAtFrame(late, 59))).toEqual(["late:59/300@30"]);
    expect(probes(renderAtFrame(late, 60))).toEqual(["late:0/300@30"]);
  });
});

describe("hooks", () => {
  it("read the video's own values at the root", () => {
    expect(
      probes(renderAtFrame(<Probe name="root" />, 7, { fps: 25, durationInFrames: 90 })),
    ).toEqual(["root:7/90@25"]);
  });

  it("throw a named error outside a video", () => {
    expect(() => renderToStaticMarkup(<Probe name="lost" />)).toThrow(
      /useCurrentFrame\(\) was called outside a video/,
    );
  });
});

describe("AbsoluteFill, Img, Audio and the refused media", () => {
  it("AbsoluteFill merges its style over the fill and passes other props through", () => {
    expect(renderToStaticMarkup(<AbsoluteFill id="x" style={{ flexDirection: "row" }} />)).toBe(
      '<div id="x" style="position:absolute;top:0;left:0;right:0;bottom:0;width:100%;height:100%;display:flex;flex-direction:row"></div>',
    );
  });

  // React's server renderer also emits a <link rel="preload"> for each image; only the <img> is ours.
  it("Img is an <img> with an empty alt unless one is given", () => {
    expect(renderToStaticMarkup(<Img src={staticFile("logo.png")} />)).toContain(
      '<img alt="" src="logo.png"/>',
    );
    expect(renderToStaticMarkup(<Img src="a.png" alt="A diagram" />)).toContain(
      '<img alt="A diagram" src="a.png"/>',
    );
  });

  it("Audio renders nothing", () => {
    expect(renderAtFrame(<Audio src="narration.wav" />, 0)).toBe("");
  });

  it("Video and OffthreadVideo throw NOT_SUPPORTED_IN_V1 when rendered", () => {
    expect(() => renderAtFrame(<Video src="clip.mp4" />, 0)).toThrow(
      /^NOT_SUPPORTED_IN_V1: video assets are not supported by the xplainer renderer; use <Img> stills instead$/,
    );
    expect(() => renderAtFrame(<OffthreadVideo src="clip.mp4" />, 0)).toThrow(
      /^NOT_SUPPORTED_IN_V1: /,
    );
  });
});
