/**
 * The layout and timing components a scene is built from.
 *
 * Timing is one rule applied at every level (see `context.ts`): a component reads the frame its
 * parent sees, decides whether its children exist at that frame, and re-provides the frame
 * relative to itself. Children outside their window are **not mounted**, rather than hidden, so a
 * scene's effects and `delayRender` calls run only while it is on screen.
 *
 * Media is deliberately narrow in this version. `<Img>` is a plain `<img>` and the harness waits
 * for every image in the document before a frame is captured. `<Audio>` is a marker: the renderer
 * muxes the narration track itself, so the element only exists to keep the engine-owned
 * `Video.tsx` declarative about it. `<Video>` and `<OffthreadVideo>` throw `NOT_SUPPORTED_IN_V1`
 * the moment they render, because a frame-accurate video decoder is not part of this renderer and
 * a silently blank rectangle would be worse than a named refusal.
 */

import {
  Children,
  type ComponentProps,
  type CSSProperties,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
} from "react";
import { type Timeline, TimelineContext } from "./context.js";
import { useTimeline } from "./hooks.js";
import { mountAudio } from "./runtime.js";

const FILL: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
};

export type AbsoluteFillProps = ComponentProps<"div">;

/** A `<div>` covering its positioned parent, laid out as a flex column. `style` wins over the fill. */
export function AbsoluteFill({ style, ...rest }: AbsoluteFillProps): ReactElement {
  return <div {...rest} style={{ ...FILL, ...style }} />;
}

/** `absolute-fill` wraps the children in an `AbsoluteFill`; `none` renders them as they are. */
export type SequenceLayout = "absolute-fill" | "none";

export type SequenceProps = {
  /** The frame, in the parent's timeline, at which this sequence's frame 0 falls. Default 0. */
  from?: number;
  /** How many frames the children stay mounted. Default `Infinity`. */
  durationInFrames?: number;
  /** A label for people reading the tree. The renderer ignores it. */
  name?: string;
  layout?: SequenceLayout;
  /** Applied to the `AbsoluteFill` wrapper; ignored with `layout="none"`. */
  style?: CSSProperties;
  /** Applied to the `AbsoluteFill` wrapper; ignored with `layout="none"`. */
  className?: string;
  children?: ReactNode;
};

function assertFrom(from: number, caller: string): void {
  if (typeof from !== "number" || !Number.isFinite(from)) {
    throw new TypeError(`${caller}: from must be a finite number, got ${String(from)}.`);
  }
}

function assertDuration(duration: number, caller: string): void {
  if (typeof duration !== "number" || Number.isNaN(duration) || duration <= 0) {
    throw new RangeError(
      `${caller}: durationInFrames must be a positive number or Infinity, got ${String(duration)}.`,
    );
  }
}

function Layout({
  layout,
  style,
  className,
  children,
}: {
  layout: SequenceLayout;
  style: CSSProperties | undefined;
  className: string | undefined;
  children: ReactNode;
}): ReactElement {
  if (layout === "none") {
    return <>{children}</>;
  }
  return (
    <AbsoluteFill style={style} className={className}>
      {children}
    </AbsoluteFill>
  );
}

/**
 * Mount the children for frames `from ≤ f < from + durationInFrames` of the parent's timeline,
 * and show them their own frame, `f − from`.
 */
export function Sequence({
  from = 0,
  durationInFrames = Number.POSITIVE_INFINITY,
  layout = "absolute-fill",
  style,
  className,
  children,
}: SequenceProps): ReactElement | null {
  const parent = useTimeline("<Sequence>");
  assertFrom(from, "<Sequence>");
  assertDuration(durationInFrames, "<Sequence>");
  const frame = parent.frame - from;
  if (frame < 0 || frame >= durationInFrames) {
    return null;
  }
  const timeline: Timeline = {
    frame,
    durationInFrames: Number.isFinite(durationInFrames)
      ? durationInFrames
      : parent.durationInFrames,
  };
  return (
    <TimelineContext.Provider value={timeline}>
      <Layout layout={layout} style={style} className={className}>
        {children}
      </Layout>
    </TimelineContext.Provider>
  );
}

export type SeriesSequenceProps = Omit<SequenceProps, "from" | "durationInFrames"> & {
  /** Required: the series places the next sequence where this one ends. */
  durationInFrames: number;
  /** Shift this sequence, and every one after it, by this many frames. Default 0. */
  offset?: number;
};

export type SeriesProps = {
  children?: ReactNode;
};

function SeriesSequence(_props: SeriesSequenceProps): never {
  throw new Error(
    "<Series.Sequence> was rendered on its own. It only has a meaning as a direct child of <Series>.",
  );
}

function SeriesRoot({ children }: SeriesProps): ReactElement {
  const items = Children.toArray(children);
  let cursor = 0;
  const sequences = items.map((child, index) => {
    if (!isValidElement<SeriesSequenceProps>(child) || child.type !== SeriesSequence) {
      throw new TypeError("<Series> accepts only <Series.Sequence> elements as its children.");
    }
    const { durationInFrames, offset = 0, ...rest } = child.props;
    assertFrom(offset, "<Series.Sequence> offset");
    assertDuration(durationInFrames, "<Series.Sequence>");
    if (!Number.isFinite(durationInFrames) && index !== items.length - 1) {
      throw new RangeError(
        "<Series.Sequence>: only the last sequence of a <Series> may have an infinite durationInFrames.",
      );
    }
    const from = cursor + offset;
    cursor = from + durationInFrames;
    return (
      <Sequence
        key={child.key ?? index}
        {...rest}
        from={from}
        durationInFrames={durationInFrames}
      />
    );
  });
  return <>{sequences}</>;
}

/** The sequences placed back to back. `Series.Sequence` is the only child it accepts. */
export const Series: ((props: SeriesProps) => ReactElement) & {
  Sequence: (props: SeriesSequenceProps) => never;
} = Object.assign(SeriesRoot, { Sequence: SeriesSequence });

export type LoopProps = {
  /** The length of one iteration. */
  durationInFrames: number;
  /** How many iterations to play before unmounting. Default `Infinity`. */
  times?: number;
  name?: string;
  layout?: SequenceLayout;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
};

/** Replay the children every `durationInFrames`; they see `frame mod durationInFrames`. */
export function Loop({
  durationInFrames,
  times = Number.POSITIVE_INFINITY,
  layout = "absolute-fill",
  style,
  className,
  children,
}: LoopProps): ReactElement | null {
  const parent = useTimeline("<Loop>");
  if (!(Number.isFinite(durationInFrames) && durationInFrames > 0)) {
    throw new RangeError(
      `<Loop>: durationInFrames must be a positive finite number, got ${String(durationInFrames)}.`,
    );
  }
  if (typeof times !== "number" || Number.isNaN(times) || times < 0) {
    throw new RangeError(`<Loop>: times must be zero or a positive number, got ${String(times)}.`);
  }
  if (parent.frame < 0) {
    return null;
  }
  const iteration = Math.floor(parent.frame / durationInFrames);
  if (iteration >= times) {
    return null;
  }
  const timeline: Timeline = {
    frame: parent.frame - iteration * durationInFrames,
    durationInFrames,
  };
  return (
    <TimelineContext.Provider value={timeline}>
      <Layout layout={layout} style={style} className={className}>
        {children}
      </Layout>
    </TimelineContext.Provider>
  );
}

export type FreezeProps = {
  /** The frame the children see while frozen. */
  frame: number;
  /** Whether the freeze applies, or a test of the parent's frame. Default `true`. */
  active?: boolean | ((frame: number) => boolean);
  children?: ReactNode;
};

/** Show the children a fixed frame. Adds no wrapper element. */
export function Freeze({ frame, active = true, children }: FreezeProps): ReactElement {
  const parent = useTimeline("<Freeze>");
  if (typeof frame !== "number" || Number.isNaN(frame)) {
    throw new TypeError(`<Freeze>: frame must be a number, got ${String(frame)}.`);
  }
  const frozen = typeof active === "function" ? active(parent.frame) : active;
  if (!frozen) {
    return <>{children}</>;
  }
  const timeline: Timeline = { frame, durationInFrames: parent.durationInFrames };
  return <TimelineContext.Provider value={timeline}>{children}</TimelineContext.Provider>;
}

export type ImgProps = ComponentProps<"img">;

/** An `<img>`. The harness holds every frame until each image in the document has loaded. */
export function Img(props: ImgProps): ReactElement {
  return <img alt="" {...props} />;
}

export type AudioProps = {
  src: string;
  volume?: number | ((frame: number) => number);
  muted?: boolean;
  loop?: boolean;
  name?: string;
};

/**
 * A marker for the narration track. Renders nothing; the renderer muxes the narration itself.
 * A second concurrently mounted `<Audio>` warns once, because it will be silent in the output.
 */
export function Audio(_props: AudioProps): null {
  useEffect(() => mountAudio(), []);
  return null;
}

export type VideoProps = {
  src: string;
  [prop: string]: unknown;
};

const VIDEO_NOT_SUPPORTED =
  "NOT_SUPPORTED_IN_V1: video assets are not supported by the xplainer renderer; use <Img> stills instead";

/** Refused in this version: throws `NOT_SUPPORTED_IN_V1` when rendered. */
export function Video(_props: VideoProps): never {
  throw new Error(VIDEO_NOT_SUPPORTED);
}

/** Refused in this version: throws `NOT_SUPPORTED_IN_V1` when rendered. */
export function OffthreadVideo(_props: VideoProps): never {
  throw new Error(VIDEO_NOT_SUPPORTED);
}
