/**
 * The renderer entry point.
 *
 * `window.xplainer` is the preload bridge; it is always present because the
 * preload script runs before this module, and its `version` is always a string
 * because the parser substitutes a fallback (see `shared/version-argument`).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("The renderer cannot mount: index.html has no #root element.");
}

createRoot(container).render(
  <StrictMode>
    <App version={window.xplainer.version} />
  </StrictMode>,
);
