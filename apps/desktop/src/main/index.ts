/**
 * The Electron main process.
 *
 * This app is an optional client of the xplainer CLI daemon (amendment A1): `@xplainer/cli` owns
 * every runtime concern, and this process supervises and displays. It is the **edge**, and it is
 * deliberately thin — every decision it acts on is a function in `discovery.ts` or `bridge.ts`,
 * where it can be tested against a real daemon; what is left here is the Electron API calls that
 * cannot be.
 *
 * Three things it does, in the order they matter:
 *
 *   1. **It asks before it starts anything.** `discovery.ts` shells out to the CLI's own
 *      `status --json`, through the packaged payload (`<resources>/xplainer-runtime/bin/node …`)
 *      until an install has written the stable launcher — decision D10 — and answers one of seven
 *      outcomes. Only `absent` leads to a daemon of this app's own.
 *   2. **It holds the token, and the renderer never does.** `bridge.ts` reads the token file the
 *      daemon recorded and attaches the `Authorization`; the window asks over IPC for documents,
 *      streams and media, and the `xplainer-media://` protocol handler below is how a `<video>`
 *      element gets bytes without a credential ever reaching the page.
 *   3. **It cleans up after itself.** A daemon this app spawned is supervised by nothing else, so
 *      it is stopped before this process exits.
 *
 * `ELECTRON_RUN_AS_NODE` is not set here or anywhere else in this app.
 */

import { join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { app, BrowserWindow, ipcMain, protocol, shell } from "electron";
import { enqueuePath, isEnqueueVerb, MEDIA_SCHEME, mediaPath } from "../shared/daemon-api";
import {
  type ApiRequestMessage,
  type ApiResponseMessage,
  type ControlMessage,
  type DiscoveryMessage,
  type EnqueueMessage,
  IPC_CHANNELS,
  isConnectVendor,
  JOB_EVENT_CHANNEL,
  type JobEventMessage,
} from "../shared/ipc";
import { DaemonBridge } from "./bridge";
import { connectAgent, startAtLogin } from "./controls";
import {
  type Discovery,
  discover,
  handOffToInstall,
  mayStartDaemon,
  resolveCliProgram,
  type SpawnedDaemon,
  spawnDaemon,
} from "./discovery";
import { probePayloadStatus } from "./spawn";
import { buildWindowOptions } from "./window";

/** Where electron-vite writes the preload bundle, relative to the app root. */
const PRELOAD_ENTRY = join("out", "preload", "index.js");

/** Where electron-vite writes the renderer bundle, relative to the app root. */
const RENDERER_ENTRY = join("out", "renderer", "index.html");

/** The daemon this app is talking to, once discovery has found one. */
let bridge: DaemonBridge | null = null;

/** The state directory the CLI last reported — D10's second stage depends on it. */
let stateDir: string | null = null;

/** A daemon this app started, which it must stop before it exits. */
let spawned: SpawnedDaemon | null = null;

/** Every open job stream, so a window that goes away does not leave one running. */
const streams = new Map<number, AbortController>();

/** The next subscription id. Ids are per-process and mean nothing outside it. */
let nextSubscription = 1;

/**
 * The media scheme has to be declared before the app is ready.
 *
 * `stream: true` is what lets a `<video>` element issue `Range` requests against it, which is the
 * whole point: the bytes come from the daemon over an authenticated connection this process makes,
 * and the page never holds a credential. `standard` gives the scheme a parseable origin;
 * `supportFetchAPI` lets a renderer `fetch()` one for a thumbnail.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

function createMainWindow(): void {
  const options = buildWindowOptions(app.getVersion());
  const mainWindow = new BrowserWindow({
    ...options,
    webPreferences: {
      ...options.webPreferences,
      // Resolved here rather than in `buildWindowOptions` so that function stays
      // pure and testable without an Electron app instance.
      preload: join(app.getAppPath(), PRELOAD_ENTRY),
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  // Nothing in this app opens a second window; anything that tries is an
  // external link and belongs in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl !== undefined && devServerUrl.length > 0) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(join(app.getAppPath(), RENDERER_ENTRY));
  }
}

/**
 * Run `status --json` through the packaged payload and write one JSON line about it.
 *
 * Deliberately not awaited by the startup path: a window that waited on a child
 * process would be a window that a slow disk keeps blank. Every condition the
 * probe can meet is already a value it returns, so the rejection handler below
 * is for the one thing that is not — a programmer error inside it. Without it
 * that would be an unhandled rejection, which Node makes fatal, so a bug in the
 * probe would take the window down with it.
 */
async function reportPayload(): Promise<void> {
  const probe = await probePayloadStatus(process.resourcesPath);
  process.stdout.write(`${JSON.stringify(probe)}\n`);
}

/**
 * Ask where the daemon is, start one if nothing is answering, and point the bridge at it.
 *
 * The spawn is the discovery-first client's one exception to "ask, do not act" (plan §1.4): with
 * nothing installed and nothing answering, a user who has just opened this app has no other way to
 * get a daemon at all. It never spawns over an `occupied` port — a second `serve` would refuse with
 * exit `10` having written nothing — and a `reattach` result means one was already there, so the
 * answer is to ask again rather than to try harder.
 *
 * `absent` alone is not that exception: {@link mayStartDaemon} is, because two of the conditions
 * that land on `absent` are answers a `serve` of this app's own cannot improve — a latched breaker
 * exits `0` without binding, and an installed daemon that is stopped belongs to its supervisor.
 */
async function discoverDaemon(): Promise<DiscoveryMessage> {
  let discovery = await discover({ resourcesPath: process.resourcesPath, stateDir });
  if (mayStartDaemon(discovery) && spawned === null) {
    const started = await spawnDaemon({
      program: resolveCliProgram({ resourcesPath: process.resourcesPath, stateDir }),
    });
    if (started.kind === "spawned") {
      spawned = started.daemon;
    }
    discovery = await discover({ resourcesPath: process.resourcesPath, stateDir });
  }
  stateDir = discovery.stateDir;
  const target = { url: discovery.url, tokenFile: discovery.tokenFile };
  if (bridge === null) {
    bridge = new DaemonBridge(target);
  } else {
    bridge.retarget(target);
  }
  return asMessage(discovery);
}

/** The fields a window is given. The token file is a path; the token itself never crosses. */
function asMessage(discovery: Discovery): DiscoveryMessage {
  return {
    outcome: discovery.outcome,
    action: discovery.action,
    detail: discovery.detail,
    url: discovery.url,
    stateDir: discovery.stateDir,
    tokenFile: discovery.tokenFile,
    condition: discovery.report.condition,
    sentences: discovery.report.sentences,
  };
}

/** The bridge, or a refusal that says why there is not one yet. */
function requireBridge(): DaemonBridge {
  if (bridge === null) {
    throw new Error("no daemon has been discovered yet; call discover() before asking for one.");
  }
  return bridge;
}

/** The request D10's two stages are resolved from, as this process currently knows them. */
function controlRequest(): { resourcesPath: string; stateDir: string | null } {
  return { resourcesPath: process.resourcesPath, stateDir };
}

/** Wire the channels the preload exposes, and the media scheme a player loads from. */
function registerBridgeHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.discover, async () => discoverDaemon());

  ipcMain.handle(
    IPC_CHANNELS.request,
    async (_event, message: ApiRequestMessage): Promise<ApiResponseMessage> => {
      const answer = await requireBridge().json({
        path: message.path,
        ...(message.method === undefined ? {} : { method: message.method }),
        ...(message.body === undefined ? {} : { body: message.body }),
      });
      return { status: answer.status, body: answer.body };
    },
  );

  ipcMain.handle(IPC_CHANNELS.subscribe, (event, eventsPath: string): number => {
    const subscription = nextSubscription;
    nextSubscription += 1;
    const controller = new AbortController();
    streams.set(subscription, controller);
    const send = (message: JobEventMessage): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(JOB_EVENT_CHANNEL, message);
      }
    };
    void requireBridge()
      .subscribe(
        eventsPath,
        (streamed) => {
          send({
            subscription,
            kind: streamed.name === "end" ? "end" : "job",
            data: streamed.data,
          });
        },
        controller.signal,
      )
      .catch((error: unknown) => {
        send({
          subscription,
          kind: "error",
          data: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        streams.delete(subscription);
      });
    return subscription;
  });

  ipcMain.handle(IPC_CHANNELS.unsubscribe, (_event, subscription: number): void => {
    streams.get(subscription)?.abort();
    streams.delete(subscription);
  });

  ipcMain.handle(
    IPC_CHANNELS.enqueue,
    async (_event, message: EnqueueMessage): Promise<ApiResponseMessage> => {
      // Checked at the boundary for the same reason the vendor below is: this handler turns its
      // argument into a path, and a channel's callers are not a property of the channel.
      if (!isEnqueueVerb(message.verb)) {
        throw new Error(`${JSON.stringify(message.verb)} is not a verb this window may queue.`);
      }
      const answer = await requireBridge().json({
        path: enqueuePath(message.slug, message.verb),
        method: "POST",
      });
      return { status: answer.status, body: answer.body };
    },
  );

  // The vendor is checked rather than trusted: this handler turns its argument into a command
  // line, and "only our own page can send it" is a property of today's window, not of the channel.
  ipcMain.handle(IPC_CHANNELS.connect, async (_event, vendor: unknown): Promise<ControlMessage> => {
    if (!isConnectVendor(vendor)) {
      throw new Error(
        `${JSON.stringify(vendor)} is not an agent \`xplainer connect\` has a verb for.`,
      );
    }
    return connectAgent(vendor, controlRequest());
  });

  // `daemon install` writes the stable launcher, which is D10's second stage — so the discovery
  // after it is what repoints this app at the daemon the installer started, on the port and token
  // file that install recorded. The daemon this app spawned goes *first*: it holds `serve`'s
  // default port, which is the port `daemon install` probes, and an installer that finds it held
  // refuses with exit `7` over a conflict this app is itself the whole of.
  ipcMain.handle(
    IPC_CHANNELS.install,
    async (): Promise<ControlMessage> =>
      handOffToInstall({
        stopSpawned: stopSpawnedDaemon,
        install: () => startAtLogin(controlRequest()),
        rediscover: async () => {
          await discoverDaemon();
        },
      }),
  );

  protocol.handle(MEDIA_SCHEME, async (request) => {
    const path = mediaPath(request.url);
    if (path === null) {
      return new Response("not an artefact of this daemon", { status: 400 });
    }
    const forwarded: Record<string, string> = {};
    for (const [name, value] of request.headers.entries()) {
      forwarded[name.toLowerCase()] = value;
    }
    const response = await requireBridge().media(path, forwarded);
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        headers.set(name, value);
      }
    }
    return new Response(Readable.toWeb(response.body) as ReadableStream<Uint8Array>, {
      status: response.status,
      headers,
    });
  });
}

/**
 * Stop a daemon this app started, and wait for it to be gone.
 *
 * The **app-exit rule**: a spawned daemon is this process's child and nothing else supervises it,
 * so it must not outlive the window that started it. It is the same call as the spawn-to-install
 * handoff, because it is the same requirement — one daemon over one state directory, always.
 */
async function stopSpawnedDaemon(): Promise<void> {
  const daemon = spawned;
  spawned = null;
  if (daemon !== null) {
    await daemon.stop();
  }
}

void app.whenReady().then(() => {
  app.setAppUserModelId("video.xplainer.desktop");
  registerBridgeHandlers();
  createMainWindow();
  reportPayload().catch((error: unknown) => {
    process.stderr.write(
      `xplainer: the payload probe failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// The quit is held open exactly as long as the drain takes, and no longer: `stop()` sends the
// daemon's own drain signal and kills it if it will not go.
let quitting = false;
app.on("before-quit", (event) => {
  if (spawned === null || quitting) {
    return;
  }
  quitting = true;
  event.preventDefault();
  void stopSpawnedDaemon().finally(() => {
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
