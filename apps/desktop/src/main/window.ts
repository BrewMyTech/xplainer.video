/**
 * The shape of the one window this app opens.
 *
 * Kept as a pure function with no Electron import at run time — only the option
 * type is imported, and `import type` erases it — so the window contract can be
 * asserted by a plain Vitest run with no Electron binary, no display and no
 * app lifecycle. `src/main/index.ts` is the only caller and the only place a
 * `BrowserWindow` is actually constructed.
 */

import type { BrowserWindowConstructorOptions } from "electron";
import { formatVersionArgument, UNKNOWN_VERSION } from "../shared/version-argument";

/** The exact window title. AC-6a asserts this string and nothing else. */
export const WINDOW_TITLE = "Xplainer";

/** The window size, chosen once here so dev and packaged builds agree. */
export const WINDOW_WIDTH = 1280;
export const WINDOW_HEIGHT = 800;

/**
 * Build the options for the main window.
 *
 * `version` is what `app.getVersion()` reported; it reaches the renderer as an
 * extra process argument (see `../shared/version-argument`) and is the only
 * dynamic value in the window. It defaults to {@link UNKNOWN_VERSION} so the
 * function can be called with no arguments when the caller has no version to
 * offer — which is how the acceptance criterion states the title check.
 */
export function buildWindowOptions(
  version: string = UNKNOWN_VERSION,
): BrowserWindowConstructorOptions {
  return {
    title: WINDOW_TITLE,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    // The window is created hidden and shown on `ready-to-show`, so the first
    // paint is the app rather than a white rectangle.
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // Non-negotiable: the renderer never gets a Node context, and the preload
      // script runs in its own isolated world.
      contextIsolation: true,
      nodeIntegration: false,
      // The preload script reads `process.argv` to recover the version above,
      // and a sandboxed preload has no `process.argv`. Context isolation, not
      // the sandbox, is what keeps the renderer away from Node here.
      sandbox: false,
      additionalArguments: [formatVersionArgument(version)],
    },
  };
}
