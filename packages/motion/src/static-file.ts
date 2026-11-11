/**
 * `staticFile(name)` — the URL of a file the narration step wrote beside the video.
 *
 * A scene never knows where its bundle will be opened from: the renderer writes it to a per-job
 * directory and loads it over `file://`. So the base is not baked into the scene; the bundle's
 * classic `static-data.js` sets `globalThis.__XPLAINER_PUBLIC_BASE__` (a URL ending in `/`, pointing
 * at `public/<slug>/`) before any module runs, and this function appends the name to it. In Node,
 * where nothing sets it, the base is empty and the result is the encoded name alone — which is
 * what makes this function testable without a page.
 *
 * Each path segment is `encodeURIComponent`-encoded and the slashes between them are kept, so
 * `staticFile("shots/step 1.png")` is `<base>shots/step%201.png`. A name that is already encoded is
 * encoded again; pass the name as it is on disk.
 *
 * **The name stays inside `public/<slug>/`, or it is refused.** A URL is refused rather than
 * mangled, and so are the two spellings of a path that would resolve somewhere else: one starting
 * with `/`, and one with a `..` segment, which the browser resolves against the base and walks out
 * of the video's own directory. Each is a `TypeError` naming the name and the rule.
 */

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function publicBase(): string {
  const value: unknown = Reflect.get(globalThis, "__XPLAINER_PUBLIC_BASE__");
  return typeof value === "string" ? value : "";
}

export function staticFile(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(
      'staticFile: pass the name of a file in this video\'s public directory, such as "logo.png".',
    );
  }
  if (URL_SCHEME.test(name)) {
    throw new TypeError(
      `staticFile(${JSON.stringify(name)}): pass a file name inside this video's public directory, not a URL.`,
    );
  }
  if (name.startsWith("/")) {
    throw new TypeError(
      `staticFile(${JSON.stringify(name)}): pass the name relative to this video's public directory, without a leading "/".`,
    );
  }
  const segments = name.split("/");
  if (segments.includes("..")) {
    throw new TypeError(
      `staticFile(${JSON.stringify(name)}): a ".." segment would leave this video's public directory; pass a file inside it.`,
    );
  }
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `${publicBase()}${path}`;
}
