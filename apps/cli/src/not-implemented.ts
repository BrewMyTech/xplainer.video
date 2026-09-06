/**
 * The one wording, and the one exit code, for everything this phase defers.
 *
 * Spec §Non-Goals scopes `mcp`, `setup` and `connect` out of the scaffold, and
 * the plan (§4 S2.4b) turns that into behaviour rather than a placeholder: the
 * commands are registered, they appear in `--help`, they say what happened on
 * stderr, and they exit with a defined non-zero code. The stub `RenderBackend`
 * in `backend.ts` reports the same thing through the MCP error channel, so an
 * agent that calls a tool and a human who runs a command are told the same
 * thing in the same words.
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
