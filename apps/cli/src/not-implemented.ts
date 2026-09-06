/**
 * The one wording, and the one exit code, for everything this phase defers.
 *
 * Spec §Non-Goals scoped `mcp`, `setup` and `connect` out of the scaffold, and
 * the plan (§4 S2.4b) turns that into behaviour rather than a placeholder: the
 * commands are registered, they appear in `--help`, they say what happened on
 * stderr, and they exit with a defined non-zero code.
 *
 * It is about **commands** and nothing else. The eight tools once reported the
 * same wording through the MCP error channel; they no longer do, because
 * `backend.ts` implements them against the local Remotion workspace. Adding a
 * tool back to this wording would be adding a tool that answers a poll with
 * prose instead of a job.
 *
 * `2` distinguishes "this command exists but does nothing yet" from commander's
 * own `1` for a usage error, so a caller can tell a deferred command apart from
 * a mistyped one.
 */

/** What every deferred surface reports. */
export const NOT_IMPLEMENTED_MESSAGE = "not implemented in this phase";

/** The exit code every deferred command terminates with. */
export const NOT_IMPLEMENTED_EXIT_CODE = 2;

/** The stderr line a deferred command writes, without its trailing newline. */
export function notImplementedLine(subject: string): string {
  return `xplainer ${subject}: ${NOT_IMPLEMENTED_MESSAGE}`;
}
