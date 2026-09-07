/**
 * Where this machine's shared Remotion workspace lives.
 *
 * One directory holds every video and one `node_modules/` (see
 * `@xplainer/render-core`'s `workspace.ts` for the layout inside it), so the question this module
 * answers is only *where the root is* — and it is asked from two places that must agree: the job
 * runner's worker registry, built in `daemon/start.ts`, and the backend the tools are served from,
 * built in `commands/serve.ts`. Both take it from {@link resolveWorkspaceRoot} over the same
 * resolved state directory, which is why the answer is a pure function of an environment and a
 * path rather than something either side reads for itself.
 *
 * The default sits **inside** the daemon's state directory. That directory is already created
 * `0700` and is already the thing `serve` takes exclusive ownership of, so a workspace under it
 * inherits both properties: no other local user can read a video's source, and no second daemon can
 * be writing into the same `videos/` while this one renders. `XPLAINER_VIDEOS_DIR` moves it — for a
 * user who wants their videos on a bigger disk, and for every test in this package, which points it
 * at a temporary directory so a suite never touches a developer's own work.
 */

import { join } from "node:path";
import process from "node:process";

/** The environment variable that relocates the Remotion workspace. */
export const VIDEOS_DIR_ENV = "XPLAINER_VIDEOS_DIR";

/** The workspace's directory name inside the state directory, when nothing overrides it. */
export const WORKSPACE_DIR_NAME = "workspace";

/** The environment this module reads, narrowed to what it uses. */
export type WorkspaceEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * `XPLAINER_VIDEOS_DIR` when it is set to something non-blank, otherwise
 * `<stateDir>/workspace`.
 *
 * @param stateDir the resolved daemon state directory
 * @param env the environment to read; defaults to this process's
 */
export function resolveWorkspaceRoot(
  stateDir: string,
  env: WorkspaceEnvironment = process.env,
): string {
  const override = env[VIDEOS_DIR_ENV];
  if (override !== undefined && override.trim() !== "") {
    return override;
  }
  return join(stateDir, WORKSPACE_DIR_NAME);
}
