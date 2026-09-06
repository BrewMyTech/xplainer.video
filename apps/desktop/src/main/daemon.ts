/**
 * Where this app expects to find the xplainer daemon.
 *
 * Amendment A1 makes the desktop app an optional *client*: `@xplainer/cli` owns
 * the runtime, and Electron only supervises and displays. Two deployments
 * follow from that, and this module is the seam between them.
 *
 *   * **Bundled.** The app ships `@xplainer/cli` as a production dependency and,
 *     in a later roadmap phase, spawns `xplainer serve` as a child process. The
 *     daemon then listens on loopback at the CLI's own default port.
 *   * **Remote.** The app is pointed at a daemon somebody else is running — a
 *     second machine on the LAN, or the hosted service — and spawns nothing.
 *
 * Deciding which URL applies is the whole of the seam, so it is a pure function
 * that resolves a string. It starts no process, opens no socket and reads no
 * environment: spawning and health-checking land in a later phase, against this
 * function.
 */

/**
 * The port a bundled daemon is expected on.
 *
 * Must equal `DEFAULT_PORT` in `apps/cli/src/server.ts`, which is what
 * `xplainer serve` binds when no `--port` is given.
 */
export const DEFAULT_DAEMON_PORT = 8787;

/** How a caller describes the daemon it wants to talk to. */
export type DaemonUrlOptions = {
  /** A daemon somebody else is running. Wins over `port` when set. */
  readonly remoteUrl?: string;
  /** The loopback port of the bundled daemon. Defaults to 8787. */
  readonly port?: number;
};

/**
 * Resolve the base URL of the daemon this app should talk to.
 *
 * @throws RangeError when a bundled port is not a usable TCP port number.
 */
export function resolveDaemonUrl(opts: DaemonUrlOptions = {}): string {
  const remoteUrl = opts.remoteUrl?.trim() ?? "";
  if (remoteUrl.length > 0) {
    // Trailing slashes are stripped so callers can join a path onto the result
    // without producing a double slash.
    return remoteUrl.replace(/\/+$/, "");
  }

  const port = opts.port ?? DEFAULT_DAEMON_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(
      `A bundled daemon port must be an integer between 1 and 65535; received ${port}.`,
    );
  }

  return `http://127.0.0.1:${port}`;
}
