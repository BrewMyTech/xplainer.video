/**
 * Render a component at one frame, in Node, with no page.
 *
 * Uses the same `VideoProvider` the harness mounts, so what a test asserts is the timing the page
 * would show. Test-only: `tsconfig.build.json` excludes `src/**\/testing/**`, so nothing here ships.
 */

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VideoConfig } from "../context.js";
import { VideoProvider } from "../provider.js";

export const TEST_VIDEO: VideoConfig = {
  id: "Test",
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 300,
  defaultProps: {},
  props: {},
};

export function renderAtFrame(
  element: ReactElement,
  frame: number,
  config: Partial<VideoConfig> = {},
): string {
  return renderToStaticMarkup(
    <VideoProvider config={{ ...TEST_VIDEO, ...config }} frame={frame}>
      {element}
    </VideoProvider>,
  );
}
