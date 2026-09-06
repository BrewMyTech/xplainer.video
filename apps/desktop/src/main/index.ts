/**
 * The Electron main process.
 *
 * This app is an optional client of the xplainer CLI daemon (amendment A1):
 * `@xplainer/cli` owns every runtime concern, and this process supervises and
 * displays. In this phase it does neither yet — it opens one window that shows
 * the application name and version, which is the whole of the placeholder the
 * spec asks for. The client seam it will eventually supervise through lives in
 * `./daemon`; no child process is started here, by design.
 */

import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { buildWindowOptions } from "./window";

/** Where electron-vite writes the preload bundle, relative to the app root. */
const PRELOAD_ENTRY = join("out", "preload", "index.js");

/** Where electron-vite writes the renderer bundle, relative to the app root. */
const RENDERER_ENTRY = join("out", "renderer", "index.html");

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

void app.whenReady().then(() => {
  app.setAppUserModelId("video.xplainer.desktop");
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
