/**
 * `~/Library/LaunchAgents/video.xplainer.daemon.plist`, rendered from the launch contract.
 *
 * **`ProcessType=Interactive` is set deliberately, and round 1 of the plan had the argument
 * backwards.** `man 5 launchd.plist`: "If left unspecified, the system will apply **light resource
 * limits** to the job, throttling its CPU usage and I/O bandwidth", while `Interactive` jobs "run
 * with the same resource limitations as apps, that is to say, none". For a daemon whose whole job
 * is to drive Chrome and ffmpeg, *unspecified* is the throttled case — so the key is present and
 * its value is the unthrottled one.
 *
 * **`ExitTimeOut=45` is the macOS counterpart of `TimeoutStopSec=45s`**, and ADR 0024's note of
 * 2026-09-08 is what makes it load-bearing rather than decorative:
 *
 * ```
 * launchctl kickstart -k gui/501/<label>   returned after 1211 ms      (a 1200 ms drain)
 * ExitTimeOut=3 against an 8000 ms drain   returned after 3012 ms, the record stops at drain_started
 * ```
 *
 * `kickstart -k` sends `SIGTERM`, waits for the drain, and blocks until the process is gone; what
 * bounds that wait is this key, so it has to exceed ADR 0024's 20 s drain cap. `KeepAlive` with
 * `SuccessfulExit: false` is the same measurement's other half: an exit `0` is left alone — which
 * is what the circuit breaker's deliberate exit `0` depends on — and an exit `7` was restarted
 * 1096 ms later.
 *
 * **`Umask` is emitted as `<integer>63</integer>`.** launchd's `Umask` is decimal and `0o077` is
 * `63`; the manual permits a string too, so "must be an integer" would overstate it, but the
 * integer form is what this renderer emits and what the golden test asserts.
 *
 * **launchd expands no `~`.** A `~` that reaches a plist is a directory called `~` in the job's
 * working directory, so a path that still carries one is refused here rather than written into a
 * job that starts in the wrong place. That is also why {@link SupervisorEnvironment.home} is
 * documented as already expanded: this renderer cannot expand it, because a plist rendered on one
 * machine for another user's home would expand to the wrong one.
 *
 * The document's shape — the `PLIST 1.0` doctype, the `<dict>` of key/value pairs — is the one the
 * P2-S5 spike loaded on macOS 26.5, so the format is measured rather than transcribed.
 */

import { posix } from "node:path";
import type { SupervisorKind } from "../../daemon/daemon-state.js";
import { emitSettings, type LaunchSpec } from "../../runtime/launch-spec.js";
import {
  escapeXml,
  requireRenderableSpec,
  requireValue,
  type SupervisorArtefact,
  SupervisorArtefactError,
  type SupervisorEnvironment,
} from "./artefact.js";
import type { SupervisorAdapter } from "./index.js";

/** The supervisor this module renders for. */
export const LAUNCHD_KIND: SupervisorKind = "launchd";

/** The job's label, which is also `launchctl`'s name for it inside `gui/<uid>/`. */
export const LAUNCH_AGENT_LABEL = "video.xplainer.daemon";

/** `0600`: the file is ours, launchd reads it as us, and nobody else has any business in it. */
export const LAUNCH_AGENT_MODE = 0o600;

/** The drain budget, in seconds. Above ADR 0024's 20 s cap, because it bounds it. */
export const LAUNCHD_EXIT_TIMEOUT = 45;

/** The minimum spacing launchd will restart the job at, in seconds. */
export const LAUNCHD_THROTTLE_INTERVAL = 30;

/** `0o077` as the decimal integer launchd wants. */
export const LAUNCHD_UMASK = 0o077;

/** `~/Library/LaunchAgents/video.xplainer.daemon.plist`, with the home already expanded. */
export function launchAgentPath(environment: SupervisorEnvironment): string {
  return posix.join(
    expandedHome(environment),
    "Library",
    "LaunchAgents",
    `${LAUNCH_AGENT_LABEL}.plist`,
  );
}

/** `~/Library/Logs/xplainer/daemon.log`, where both of the job's streams go. */
export function launchAgentLogPath(environment: SupervisorEnvironment): string {
  return posix.join(expandedHome(environment), "Library", "Logs", "xplainer", "daemon.log");
}

/**
 * The plist, complete, with every value taken from the launch contract.
 *
 * `EnvironmentVariables` comes from `emitSettings` — the state directory and the token file, both
 * as paths and neither as a token value — while all three settings also travel in
 * `ProgramArguments`, because that is the one emission that works on all three platforms.
 */
export function renderLaunchAgentPlist(
  spec: LaunchSpec,
  environment: SupervisorEnvironment,
): SupervisorArtefact {
  requireRenderableSpec(spec, LAUNCHD_KIND);
  const emission = emitSettings(spec, "darwin");
  if (emission.form !== "launchd") {
    throw new SupervisorArtefactError(
      `the launch contract answered with the ${emission.form} form for darwin. The renderers take ` +
        `their environment from \`emitSettings\` rather than from \`spec.settings\`, so a ` +
        `contract that changed which form a platform gets is a rendering failure rather than ` +
        `something to work around here.`,
    );
  }

  const programArguments = [spec.executable, ...spec.argv].map((word, index) =>
    requireExpanded(word, index === 0 ? "executable" : `argv[${index - 1}]`),
  );
  const log = launchAgentLogPath(environment);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${escapeXml(LAUNCH_AGENT_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArguments.map((word) => `    <string>${escapeXml(word)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(emission.environment).flatMap(([name, value]) => [
      `    <key>${escapeXml(name)}</key>`,
      `    <string>${escapeXml(requireExpanded(value, `settings.${name}`))}</string>`,
    ]),
    "  </dict>",
    `  <key>WorkingDirectory</key><string>${escapeXml(requireExpanded(spec.cwd, "cwd"))}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    `  <key>ThrottleInterval</key><integer>${LAUNCHD_THROTTLE_INTERVAL}</integer>`,
    `  <key>ExitTimeOut</key><integer>${LAUNCHD_EXIT_TIMEOUT}</integer>`,
    "  <key>ProcessType</key><string>Interactive</string>",
    `  <key>StandardOutPath</key><string>${escapeXml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>`,
    `  <key>Umask</key><integer>${LAUNCHD_UMASK}</integer>`,
    "</dict>",
    "</plist>",
    "",
  ];

  return {
    kind: LAUNCHD_KIND,
    path: launchAgentPath(environment),
    mode: LAUNCH_AGENT_MODE,
    identity: LAUNCH_AGENT_LABEL,
    contents: lines.join("\n"),
  };
}

/** The launchd adapter: one kind, one label, one artefact. */
export const launchdAdapter: SupervisorAdapter = {
  kind: LAUNCHD_KIND,
  platform: "darwin",
  identity: () => LAUNCH_AGENT_LABEL,
  artefactPath: launchAgentPath,
  render: renderLaunchAgentPlist,
};

/** The home directory, present and already expanded. */
function expandedHome(environment: SupervisorEnvironment): string {
  return requireExpanded(
    requireValue(environment.home, "environment.home", LAUNCHD_KIND),
    "environment.home",
  );
}

/** A path launchd can use as it stands, or a refusal naming the `~` it would take literally. */
function requireExpanded(value: string, field: string): string {
  requireValue(value, field, LAUNCHD_KIND);
  if (value === "~" || value.startsWith("~/")) {
    throw new SupervisorArtefactError(
      `the launchd artefact's ${field} is ${JSON.stringify(value)}, and launchd expands no ` +
        `\`~\`: it would be a directory of that name relative to the job's working directory. ` +
        `The path is expanded before it reaches the renderer, because a plist rendered for one ` +
        `home cannot be expanded against another.`,
    );
  }
  return value;
}
