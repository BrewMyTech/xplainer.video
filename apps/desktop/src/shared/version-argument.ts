/**
 * How the application version crosses from the main process to the renderer.
 *
 * The window has exactly one thing to show that the main process knows and the
 * renderer does not: `app.getVersion()`. Carrying it as an extra renderer
 * process argument keeps the seam a one-way, read-only value — no IPC channel,
 * no handler, nothing the renderer can call back into. The main process formats
 * the argument in `buildWindowOptions` and the preload script reads it back
 * here, so the flag spelling is written down once and shared by both sides
 * rather than duplicated as two string literals that can drift apart.
 */

/** The `--flag=` prefix carrying the version on the renderer's argv. */
export const VERSION_ARGUMENT_PREFIX = "--xplainer-app-version=";

/** What the renderer reports when no usable version argument was passed. */
export const UNKNOWN_VERSION = "unknown";

/** Render `version` as the single argv entry the renderer process receives. */
export function formatVersionArgument(version: string): string {
  return `${VERSION_ARGUMENT_PREFIX}${version}`;
}

/**
 * Recover the version from a renderer process argv.
 *
 * Falls back to {@link UNKNOWN_VERSION} when the flag is absent or carries an
 * empty value, so the renderer always has a string to display and never has to
 * branch on `undefined`.
 */
export function parseVersionArgument(argv: readonly string[]): string {
  const entry = argv.find((argument) => argument.startsWith(VERSION_ARGUMENT_PREFIX));
  if (entry === undefined) {
    return UNKNOWN_VERSION;
  }
  const version = entry.slice(VERSION_ARGUMENT_PREFIX.length);
  return version.length > 0 ? version : UNKNOWN_VERSION;
}
