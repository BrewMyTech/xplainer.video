/**
 * Build configuration for the three Electron bundles.
 *
 * Every entry point is left at the electron-vite default — `src/main/index.ts`,
 * `src/preload/index.ts` and `src/renderer/index.html` — so the layout on disk
 * is the only place the entry points are stated. `externalizeDepsPlugin()`
 * keeps everything in `dependencies` (`@xplainer/cli`, `electron-updater`) out
 * of the bundles and resolved from `node_modules` at run time, which is what
 * lets electron-builder pack them as real files instead of inlining a copy.
 */

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
