/**
 * The preload bridge.
 *
 * Context isolation is on, so the renderer sees exactly what is exposed here
 * and nothing else. What it needs is one read-only string: the version the main
 * process read from `app.getVersion()` and passed down as a renderer process
 * argument. No IPC channel is opened, because there is nothing yet for the
 * renderer to ask for.
 */

import { contextBridge } from "electron";
import { parseVersionArgument } from "../shared/version-argument";

/** Everything the renderer is allowed to see from the main process. */
export type XplainerBridge = {
  /** The application version, or `"unknown"` if it did not reach the renderer. */
  readonly version: string;
};

declare global {
  interface Window {
    readonly xplainer: XplainerBridge;
  }
}

const bridge: XplainerBridge = {
  version: parseVersionArgument(process.argv),
};

contextBridge.exposeInMainWorld("xplainer", bridge);
