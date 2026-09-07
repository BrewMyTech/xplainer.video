/**
 * The one shape the three supervisors are reached through.
 *
 * `install` (T11), the four lifecycle verbs (T12) and the restart adapters (T13) all have the same
 * job on three platforms whose vocabularies share nothing: a unit addressed as `xplainer.service`,
 * a job addressed as `gui/<uid>/video.xplainer.daemon`, and a task addressed as
 * `\xplainer\<user>-daemon`. {@link SupervisorAdapter} is where that difference stops: a caller
 * picks one adapter, and everything above it is written once.
 *
 * **This story fills in only the rendering half**, because that is the half that is pure. Each
 * adapter answers with the file's path, its mode, the name its own tooling uses, and its exact
 * bytes; nothing here registers, starts or writes anything, which is why all three platforms are
 * verified on one machine. The verbs that do need the platform arrive with the stories that can
 * measure them.
 *
 * The three `kind` values are `daemon.json`'s own `supervisor_kind` spellings, so a record read off
 * disk selects an adapter with no mapping table in between.
 */

import type { SupervisorKind } from "../../daemon/daemon-state.js";
import type { LaunchSpec, SupervisorPlatform } from "../../runtime/launch-spec.js";
import type { SupervisorArtefact, SupervisorEnvironment } from "./artefact.js";
import { launchdAdapter } from "./launchd.js";
import { taskSchedulerAdapter } from "./schtasks.js";
import { systemdAdapter } from "./systemd.js";

export {
  escapeXml,
  requireRenderableSpec,
  requireValue,
  SETTING_KEYS,
  type SupervisorArtefact,
  SupervisorArtefactError,
  type SupervisorEnvironment,
} from "./artefact.js";
export {
  LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_MODE,
  launchAgentLogPath,
  launchAgentPath,
  launchdAdapter,
  renderLaunchAgentPlist,
} from "./launchd.js";
export {
  renderScheduledTask,
  TASK_FOLDER,
  TASK_XML_MODE,
  taskName,
  taskSchedulerAdapter,
  taskXmlPath,
} from "./schtasks.js";
export {
  renderSystemdUnit,
  SYSTEMD_UNIT_MODE,
  SYSTEMD_UNIT_NAME,
  systemdAdapter,
  systemdUnitPath,
} from "./systemd.js";

/** One platform's supervisor, as everything above it sees it. */
export type SupervisorAdapter = {
  /** The spelling `daemon.json` records in `supervisor_kind`. */
  readonly kind: SupervisorKind;
  /** The `process.platform` value this adapter is the supervisor for. */
  readonly platform: SupervisorPlatform;
  /** The name this supervisor's own tooling addresses the daemon by. */
  identity(environment: SupervisorEnvironment): string;
  /** Where its artefact belongs, for a caller that has no launch spec to render. */
  artefactPath(environment: SupervisorEnvironment): string;
  /** The artefact itself: path, mode, identity and exact bytes. Writes nothing. */
  render(spec: LaunchSpec, environment: SupervisorEnvironment): SupervisorArtefact;
};

/**
 * Every adapter, by kind.
 *
 * The annotation is the conformance check: an adapter that stopped matching the interface fails to
 * compile here rather than at the one call site that happened to use the missing member.
 */
export const SUPERVISOR_ADAPTERS: Readonly<Record<SupervisorKind, SupervisorAdapter>> = {
  systemd: systemdAdapter,
  launchd: launchdAdapter,
  "task-scheduler": taskSchedulerAdapter,
};

/** The adapter for a kind read off disk. */
export function supervisorAdapter(kind: SupervisorKind): SupervisorAdapter {
  return SUPERVISOR_ADAPTERS[kind];
}

/**
 * Which supervisor a platform has, or `null` on one this project renders nothing for.
 *
 * `null` rather than a throw, because "this machine has no supervisor we can install into" is a
 * documented degraded path with its own exit code and its own message (T10), and a renderer's
 * exception is not the place to say it.
 */
export function supervisorKindForPlatform(platform: NodeJS.Platform): SupervisorKind | null {
  switch (platform) {
    case "linux":
      return "systemd";
    case "darwin":
      return "launchd";
    case "win32":
      return "task-scheduler";
    default:
      return null;
  }
}
