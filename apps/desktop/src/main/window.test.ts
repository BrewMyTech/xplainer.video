/**
 * What the one window this app opens is actually configured to be.
 *
 * `buildWindowOptions` is pure, so every assertion below reads the real value
 * the main process would hand to `new BrowserWindow(...)` — no Electron
 * runtime, no display, no mock of the thing under test.
 */

import { describe, expect, it } from "vitest";
import { parseVersionArgument, UNKNOWN_VERSION } from "../shared/version-argument";
import { buildWindowOptions } from "./window";

describe("buildWindowOptions", () => {
  it("titles the window exactly Xplainer", () => {
    expect(buildWindowOptions().title).toBe("Xplainer");
  });

  it("isolates the renderer: context isolation on, Node integration off", () => {
    const webPreferences = buildWindowOptions("1.4.2").webPreferences;

    expect(webPreferences?.contextIsolation).toBe(true);
    expect(webPreferences?.nodeIntegration).toBe(false);
  });

  it("keeps the sandbox off so the preload script can read the version argument", () => {
    expect(buildWindowOptions("1.4.2").webPreferences?.sandbox).toBe(false);
  });

  it("opens at 1280x800 and stays hidden until the first paint is ready", () => {
    const options = buildWindowOptions("1.4.2");

    expect(options.width).toBe(1280);
    expect(options.height).toBe(800);
    expect(options.show).toBe(false);
  });

  it("passes the application version to the renderer as a process argument", () => {
    const additionalArguments =
      buildWindowOptions("1.4.2").webPreferences?.additionalArguments ?? [];

    expect(parseVersionArgument(additionalArguments)).toBe("1.4.2");
  });

  it("passes an unknown version when the caller has none", () => {
    const additionalArguments = buildWindowOptions().webPreferences?.additionalArguments ?? [];

    expect(parseVersionArgument(additionalArguments)).toBe(UNKNOWN_VERSION);
  });
});
