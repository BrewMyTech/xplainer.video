/**
 * The preload bridge.
 *
 * Context isolation is on, so the renderer sees exactly what is exposed here and nothing else —
 * and what is exposed is **verbs, never a secret**. The bearer token stays in the main process
 * (`src/main/bridge.ts`); a window asks for a document, a stream or a media URL, and the main
 * process is what authenticates. There is deliberately no `token`, no `headers` and no way to
 * reach an arbitrary origin: a renderer that could set its own `Authorization` would be a renderer
 * that has to be trusted with the daemon's authority.
 *
 * Everything imported here is types and strings. This file runs in a context with no Node built-ins
 * of its own, so it may import `src/shared/` and nothing from `src/main/` at run time.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { EnqueueVerb } from "../shared/daemon-api";
import { mediaUrl } from "../shared/daemon-api";
import {
  type ApiRequestMessage,
  type ApiResponseMessage,
  type ConnectVendor,
  type ControlMessage,
  type DiscoveryMessage,
  IPC_CHANNELS,
  JOB_EVENT_CHANNEL,
  type JobEventMessage,
  type JobSubscription,
} from "../shared/ipc";
import { parseVersionArgument } from "../shared/version-argument";

/** Everything the renderer is allowed to see from the main process. */
export type XplainerBridge = {
  /** The application version, or `"unknown"` if it did not reach the renderer. */
  readonly version: string;
  /** Where this machine's daemon is, as one of the seven discovery outcomes. */
  discover(): Promise<DiscoveryMessage>;
  /** One authenticated `/api/*` request. The path comes from what the daemon answered. */
  request(message: ApiRequestMessage): Promise<ApiResponseMessage>;
  /**
   * Follow one job's progress. Answers the stream's id and the call that stops following.
   *
   * The path is the `events` URL the enqueue call answered with, never one built in the window. The
   * id travels back because a window showing two renders at once has to tell their rows apart, and
   * every event carries the id of the stream it belongs to.
   */
  subscribe(
    eventsPath: string,
    listener: (event: JobEventMessage) => void,
  ): Promise<JobSubscription>;
  /**
   * Queue a still or a render for one video, and get the daemon's `202` back.
   *
   * The window names the video and the verb; the route is built where `/api/videos` already is.
   */
  enqueue(slug: string, verb: EnqueueVerb): Promise<ApiResponseMessage>;
  /**
   * Register this machine's daemon with one agent, by running `xplainer connect <vendor>`.
   *
   * The window never writes an agent configuration: it asks the CLI, through whichever of decision
   * D10's two stages the main process resolved.
   */
  connect(vendor: ConnectVendor): Promise<ControlMessage>;
  /**
   * Install the daemon so it starts at login, by running `xplainer daemon install`.
   *
   * The window never writes a `plist`, a unit or a scheduled task; `daemon install` is the only
   * thing in this project that does.
   */
  startAtLogin(): Promise<ControlMessage>;
  /** The URL a `<video>` or `<img>` loads one artefact's bytes from. */
  mediaUrl(apiPath: string): string;
};

declare global {
  interface Window {
    readonly xplainer: XplainerBridge;
  }
}

const bridge: XplainerBridge = {
  version: parseVersionArgument(process.argv),

  discover: () => ipcRenderer.invoke(IPC_CHANNELS.discover) as Promise<DiscoveryMessage>,

  request: (message) =>
    ipcRenderer.invoke(IPC_CHANNELS.request, message) as Promise<ApiResponseMessage>,

  subscribe: async (eventsPath, listener) => {
    const subscription = (await ipcRenderer.invoke(IPC_CHANNELS.subscribe, eventsPath)) as number;
    // The channel carries every stream, so each listener takes only its own subscription's events:
    // two windows watching two renders must not see each other's progress.
    const receive = (_event: unknown, message: JobEventMessage): void => {
      if (message.subscription === subscription) {
        listener(message);
      }
    };
    ipcRenderer.on(JOB_EVENT_CHANNEL, receive);
    return {
      subscription,
      stop: async () => {
        ipcRenderer.off(JOB_EVENT_CHANNEL, receive);
        await ipcRenderer.invoke(IPC_CHANNELS.unsubscribe, subscription);
      },
    };
  },

  enqueue: (slug, verb) =>
    ipcRenderer.invoke(IPC_CHANNELS.enqueue, { slug, verb }) as Promise<ApiResponseMessage>,

  connect: (vendor) => ipcRenderer.invoke(IPC_CHANNELS.connect, vendor) as Promise<ControlMessage>,

  startAtLogin: () => ipcRenderer.invoke(IPC_CHANNELS.install) as Promise<ControlMessage>,

  mediaUrl,
};

contextBridge.exposeInMainWorld("xplainer", bridge);
