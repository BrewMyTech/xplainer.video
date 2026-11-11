/**
 * `fetch(staticFile(name))` answered from memory.
 *
 * The scaffold's `Root.tsx` fetches `timings.json` and `captions.json` with `fetch(staticFile(…))`
 * at metadata time, and is a fixture that must not change. The renderer serves the page over
 * loopback HTTP, which would answer those requests too, but the two documents are what decides the
 * video's length, so they travel in the bundle instead and never depend on a request. The
 * bundle's classic `static-data.js` carries both files' text in `window.__XPLAINER_STATIC__`, and
 * the harness's `fetch` answers a request for one of those names before the network ever sees it.
 * A URL matches when it resolves to the same absolute URL as `staticFile(name)` does; anything else
 * goes to the real `fetch`.
 */

import { staticFile } from "./static-file.js";

/** The URL of whatever `fetch` was handed: a string, a `URL` or a `Request`. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/** The entry of `table` that `url` names, or `undefined`. `toAbsolute` resolves against the page. */
export function findStaticText(
  url: string,
  table: Readonly<Record<string, string>> | undefined,
  toAbsolute: (url: string) => string,
): { name: string; text: string } | undefined {
  if (table === undefined) {
    return undefined;
  }
  const target = toAbsolute(url);
  for (const [name, text] of Object.entries(table)) {
    if (toAbsolute(staticFile(name)) === target) {
      return { name, text };
    }
  }
  return undefined;
}

/** The `content-type` the answer carries: JSON for `.json`, plain text otherwise. */
export function contentTypeFor(name: string): string {
  return name.toLowerCase().endsWith(".json") ? "application/json" : "text/plain; charset=utf-8";
}
