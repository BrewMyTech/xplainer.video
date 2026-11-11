/**
 * The provider every video renders under: the resolved config, and the absolute frame as the
 * root timeline.
 *
 * The harness mounts it around the registered component, and `src/testing/` mounts the same one
 * around a component under test — so the tests exercise the provider the page uses, not a copy.
 */

import type { ReactElement, ReactNode } from "react";
import { type Timeline, TimelineContext, type VideoConfig, VideoConfigContext } from "./context.js";

export type VideoProviderProps = {
  config: VideoConfig;
  frame: number;
  children?: ReactNode;
};

export function VideoProvider({ config, frame, children }: VideoProviderProps): ReactElement {
  const timeline: Timeline = { frame, durationInFrames: config.durationInFrames };
  return (
    <VideoConfigContext.Provider value={config}>
      <TimelineContext.Provider value={timeline}>{children}</TimelineContext.Provider>
    </VideoConfigContext.Provider>
  );
}
