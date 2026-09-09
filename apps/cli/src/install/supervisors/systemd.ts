/**
 * `~/.config/systemd/user/xplainer.service`, rendered from the launch contract and nothing else.
 *
 * **`Type=exec`, and no `NotifyAccess=` line at all.** ADR 0025's note of 2026-09-08 settled
 * P2-S4: `Type=notify` is rejected and ADR 0020's `Type=exec` stands. The measurement behind the
 * missing second line is the reason this renderer emits neither key as an option — the spike ran a
 * `Type=notify` unit whose only writer was a child and whose `NotifyAccess=` was the default:
 *
 * ```
 * systemctl --user start → rc=1 after 8234 ms, ActiveState=failed, Result=timeout
 * journal: Got notification message from PID 293, but reception only permitted for main PID 285
 * ```
 *
 * A template that lets `Type=` and `NotifyAccess=` be chosen independently is a template that can
 * render a daemon which never starts, so this one renders a fixed pair: `Type=exec`, nothing else.
 *
 * **`KillMode=mixed` is not a preference.** ADR 0024's note of 2026-09-08 measured the default:
 *
 * ```
 * KillMode=mixed           daemon: bound → SIGTERM → drain → child killed → exit 0
 *                          child:  started                      (no signal, ever)
 * KillMode=control-group   daemon SIGTERM at 1788811452701
 *                          child  SIGTERM at 1788811452701      (skew 0 ms)
 * ```
 *
 * Under the default the drain is not a drain: Chrome and ffmpeg are already dying when it starts.
 * `TimeoutStopSec=45s` is escalation rather than a drain — the same note measured a 2 s budget
 * against an 8 s drain returning `Result=timeout` with the drain unfinished — so it has to exceed
 * ADR 0024's 20 s cap rather than implement it.
 *
 * **`StartLimitIntervalSec` and `StartLimitBurst` are `[Unit]` keys** on every systemd since v230.
 * They are in the section this file puts them in and a golden test asserts the section, not merely
 * the line, because a start limit in `[Service]` is silently the wrong file's rule.
 *
 * **`RuntimeDirectory=` creates a directory and relocates nothing.** It gives the daemon
 * `$XDG_RUNTIME_DIR/xplainer` at `0700`; what points the socket *into* it is `--socket`, which
 * travels in the argv like every other setting.
 *
 * **Two escaping rules, both of them systemd's own.** `ExecStart=` is split on whitespace and
 * understands double quotes, so its words are quoted when they need it; every other value here is
 * a path setting that systemd reads to the end of the line, so quoting one would make the quotes
 * part of the path. And `%` starts a specifier in every one of these settings — `%t` is the
 * runtime directory — so a `%` in a real path is doubled rather than expanded into somebody else's
 * directory.
 */

import { posix } from "node:path";
import type { SupervisorKind } from "../../daemon/daemon-state.js";
import { emitSettings, type LaunchSpec } from "../../runtime/launch-spec.js";
import {
  requireRenderableSpec,
  requireValue,
  type SupervisorArtefact,
  SupervisorArtefactError,
  type SupervisorEnvironment,
} from "./artefact.js";
import type { SupervisorAdapter } from "./index.js";

/** The supervisor this module renders for. */
export const SYSTEMD_KIND: SupervisorKind = "systemd";

/** The unit's file name, which is also the name `systemctl --user` addresses it by. */
export const SYSTEMD_UNIT_NAME = "xplainer.service";

/** `0644`: systemd reads it as the user, and nothing needs to write it but us. */
export const SYSTEMD_UNIT_MODE = 0o644;

/** The runtime directory systemd creates, under `$XDG_RUNTIME_DIR`. */
export const SYSTEMD_RUNTIME_DIRECTORY = "xplainer";

/** `~/.config/systemd/user/xplainer.service`, or the same path under `$XDG_CONFIG_HOME`. */
export function systemdUnitPath(environment: SupervisorEnvironment): string {
  const home = requireValue(environment.home, "environment.home", SYSTEMD_KIND);
  const configHome =
    environment.configHome !== undefined && environment.configHome.trim() !== ""
      ? environment.configHome
      : posix.join(home, ".config");
  return posix.join(configHome, "systemd", "user", SYSTEMD_UNIT_NAME);
}

/**
 * The unit file, complete, with every value taken from the launch contract.
 *
 * The environment lines come from `emitSettings` rather than from `spec.settings` directly: that
 * seam is what makes a setting dropped from the contract a **test failure here** instead of a
 * daemon that quietly took the platform default.
 */
export function renderSystemdUnit(
  spec: LaunchSpec,
  environment: SupervisorEnvironment,
): SupervisorArtefact {
  requireRenderableSpec(spec, SYSTEMD_KIND);
  const emission = emitSettings(spec, "linux");
  if (emission.form !== "systemd") {
    throw new SupervisorArtefactError(
      `the launch contract answered with the ${emission.form} form for linux. The renderers take ` +
        `their environment from \`emitSettings\` rather than from \`spec.settings\`, so a ` +
        `contract that changed which form a platform gets is a rendering failure rather than ` +
        `something to work around here.`,
    );
  }

  const execStart = [spec.executable, ...spec.argv].map(quoteExecWord).join(" ");
  const lines = [
    "[Unit]",
    "Description=xplainer local daemon",
    "Documentation=https://xplainer.video",
    "After=network.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=exec",
    `ExecStart=${execStart}`,
    `WorkingDirectory=${escapeSpecifiers(spec.cwd)}`,
    ...emission.environment.map((entry) => `Environment=${quoteExecWord(entry)}`),
    `RuntimeDirectory=${SYSTEMD_RUNTIME_DIRECTORY}`,
    "RuntimeDirectoryMode=0700",
    "KillMode=mixed",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=45s",
    "Restart=on-failure",
    "RestartSec=2",
    "SyslogIdentifier=xplainer",
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];

  return {
    kind: SYSTEMD_KIND,
    path: systemdUnitPath(environment),
    mode: SYSTEMD_UNIT_MODE,
    identity: SYSTEMD_UNIT_NAME,
    contents: lines.join("\n"),
  };
}

/** The systemd adapter: one kind, one identity, one artefact. */
export const systemdAdapter: SupervisorAdapter = {
  kind: SYSTEMD_KIND,
  platform: "linux",
  identity: () => SYSTEMD_UNIT_NAME,
  artefactPath: systemdUnitPath,
  render: renderSystemdUnit,
};

/**
 * One word of `ExecStart=`, or of an `Environment=` assignment, in the form systemd parses back.
 *
 * systemd splits these on whitespace and accepts double-quoted words with C-style escapes, so a
 * word carrying a space, a quote or a backslash is quoted and the two characters that would end
 * the quoting are escaped. `Environment="NAME=value with spaces"` is the documented form of the
 * same rule, which is why one function serves both.
 */
function quoteExecWord(word: string): string {
  const escaped = escapeSpecifiers(word);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped)) {
    return escaped;
  }
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** `%` doubled, because every setting rendered here is one systemd expands specifiers in. */
function escapeSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}
