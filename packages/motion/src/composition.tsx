/**
 * How a bundle names the one video it renders: `registerRoot(Root)` with a `<Composition>` inside,
 * or `registerVideo({...})` directly.
 *
 * **Why `<Composition>` survives at all.** The engine-owned `Root.tsx` is a byte-identity fixture,
 * and it declares its video as `<Composition id component durationInFrames fps width height
 * defaultProps calculateMetadata />` inside a `Root` passed to `registerRoot`. Keeping that shape
 * means the scaffold changes by its import line and nothing else. `registerVideo` is the same
 * thing without the indirection, for a bundle that has no `Root.tsx`.
 *
 * **`<Composition>` renders nothing, ever.** It is a declaration. The harness renders `Root` once,
 * off-screen, under a collector context, and each `<Composition>` hands its props to that
 * collector during render. Outside that probe — in a test, say — the context is empty and the
 * component is inert.
 *
 * **Metadata is resolved before the first frame.** `calculateMetadata` runs once, with the default
 * props as both `defaultProps` and `props` (the renderer passes no input props), and whatever it
 * returns overrides the declared `width`, `height`, `fps`, `durationInFrames` and `props`. The
 * scaffold uses it to read `timings.json` and `captions.json`, so no component ever has to hold a
 * frame open to load them.
 */

import { type ComponentType, createElement, type ReactElement, useContext } from "react";
import {
  CompositionCollectorContext,
  type VideoConfig,
  type VideoRegistration,
} from "./context.js";
import { registerEntry } from "./runtime.js";

export type CalculateMetadataResult<Props> = {
  durationInFrames?: number;
  fps?: number;
  width?: number;
  height?: number;
  props?: Props;
};

export type CalculateMetadataOptions<Props> = {
  defaultProps: Props;
  props: Props;
  abortSignal: AbortSignal;
  compositionId: string;
};

/** Resolve the video's real metadata — typically its duration — before the first frame. */
export type CalculateMetadataFunction<Props> = (
  options: CalculateMetadataOptions<Props>,
) => Promise<CalculateMetadataResult<Props>> | CalculateMetadataResult<Props>;

export type CompositionProps<Props extends Record<string, unknown>> = {
  id: string;
  component: ComponentType<Props>;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  defaultProps: Props;
  calculateMetadata?: CalculateMetadataFunction<Props> | null | undefined;
};

export type RegisterVideoOptions<Props extends Record<string, unknown>> = Omit<
  CompositionProps<Props>,
  "id"
> & {
  /** Default `"Explainer"`, the id the scaffold's `Root.tsx` uses. */
  id?: string;
};

function assertDimension(name: string, value: unknown, id: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `video "${id}": ${name} must be a positive whole number, got ${String(value)}.`,
    );
  }
  return value;
}

function assertFps(value: unknown, id: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`video "${id}": fps must be a positive number, got ${String(value)}.`);
  }
  return value;
}

/**
 * Erase `Props` behind a closure, so the runtime can hold any video in one slot.
 * Exported for the harness and the tests; not part of the package's public surface.
 */
export function toRegistration<Props extends Record<string, unknown>>(
  declared: CompositionProps<Props>,
): VideoRegistration {
  const { id, component, defaultProps, calculateMetadata } = declared;
  return {
    id,
    resolve: async (abortSignal: AbortSignal) => {
      const computed =
        calculateMetadata === null || calculateMetadata === undefined
          ? {}
          : await calculateMetadata({
              defaultProps,
              props: defaultProps,
              abortSignal,
              compositionId: id,
            });
      const props = computed.props ?? defaultProps;
      const config: VideoConfig = {
        id,
        width: assertDimension("width", computed.width ?? declared.width, id),
        height: assertDimension("height", computed.height ?? declared.height, id),
        fps: assertFps(computed.fps ?? declared.fps, id),
        durationInFrames: assertDimension(
          "durationInFrames",
          computed.durationInFrames ?? declared.durationInFrames,
          id,
        ),
        defaultProps,
        props,
      };
      return { config, render: (): ReactElement => createElement(component, props) };
    },
  };
}

/** Declare the video. Renders nothing; the harness collects the props. */
export function Composition<Props extends Record<string, unknown>>(
  props: CompositionProps<Props>,
): null {
  const collect = useContext(CompositionCollectorContext);
  if (collect !== null) {
    collect(toRegistration(props));
  }
  return null;
}

/** Name the component whose `<Composition>` declares this bundle's video. Call once, from `index.ts`. */
export function registerRoot(Root: ComponentType): void {
  registerEntry({ kind: "root", Root });
}

/** Register the video directly, without a `Root` component. Call once, from `index.ts`. */
export function registerVideo<Props extends Record<string, unknown>>(
  options: RegisterVideoOptions<Props>,
): void {
  registerEntry({
    kind: "video",
    registration: toRegistration({ ...options, id: options.id ?? "Explainer" }),
  });
}
