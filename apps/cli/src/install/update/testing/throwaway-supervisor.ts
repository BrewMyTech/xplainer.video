/**
 * Driving this machine's **real** service manager without registering this product's real service.
 *
 * Both update proofs need the same two things, and neither may be improvised twice. A proof that
 * asks whether `launchd` accepts a rewritten plist has to hand `launchd` a plist — but a proof that
 * registered `video.xplainer.daemon` in a developer's own `launchd` would be installing the product
 * on the machine that is testing it. So on macOS every command is translated to a **throwaway
 * label**, the plist's own `Label` key is rewritten to match before it is handed over, and the
 * `finally` boots that label out again. That is `install/testing/supervisor-proof.ts`'s pattern,
 * and this module is it, factored so the two scripts cannot drift.
 *
 * **On Linux nothing is translated, and that is a decision rather than an omission.** systemd reads
 * `$XDG_CONFIG_HOME/systemd/user` or `~/.config/systemd/user` and nowhere else, so a unit written
 * under a scratch home is a unit the manager never sees. The Linux leg therefore installs the
 * product's real `xplainer.service` in the account's own config directory and removes it in the
 * `finally` — which is why it belongs on a runner or in `infra/e2e/Dockerfile.systemd` rather than
 * on a machine somebody is using.
 *
 * Nothing here ships: `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import {
  type ProbeCommand,
  type ProbeResult,
  type ProbeRunner,
  runProbe,
} from "../../preflight.js";
import { deregisterCommands } from "../../register.js";
import type { SupervisorEnvironment } from "../../supervisors/artefact.js";
import {
  LAUNCH_AGENT_LABEL,
  supervisorAdapter,
  supervisorKindForPlatform,
} from "../../supervisors/index.js";

/**
 * `runProbe`, with every mention of the product's label replaced by `label`.
 *
 * A plist argument is rewritten in place first: `launchd` takes the label from the **document**,
 * not from the file's name, so the one key has to agree with the service target the following
 * commands name. Everything else about the file is the renderer's own bytes, which is what keeps
 * the assertion "the artefact the supervisor loaded is the one this code writes" honest.
 */
export function throwawayProbe(label: string): ProbeRunner {
  return (command: ProbeCommand): ProbeResult => {
    if (process.platform !== "darwin") {
      return runProbe(command);
    }
    const argv = command.argv.map((word) => {
      if (word.endsWith(".plist") && existsSync(word)) {
        const plist = readFileSync(word, "utf8");
        writeFileSync(
          word,
          plist.replace(
            `<key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`,
            `<key>Label</key><string>${label}</string>`,
          ),
        );
        return word;
      }
      return word.split(LAUNCH_AGENT_LABEL).join(label);
    });
    return runProbe({ ...command, argv });
  };
}

/** What {@link deregisterThrowaway} needs to leave the machine holding nothing of ours. */
export type DeregisterRequest = {
  /** The label a macOS proof registered under. Ignored on the platforms that translate nothing. */
  label: string;
  /** The account and directories the artefact path is built from. */
  environment: SupervisorEnvironment;
  /** The uid whose `gui/<uid>` domain a LaunchAgent lives in. */
  uid: number;
};

/**
 * Undo the registration, whatever happened, and say what was undone.
 *
 * The `enable` record an install's `launchctl enable` created stays behind — `launchctl` offers no
 * verb that removes an entry from that store, only `enable` and `disable` — and it is inert with
 * nothing loaded. Saying so is part of the proof's transcript rather than a footnote somewhere else.
 */
export function deregisterThrowaway(request: DeregisterRequest): string {
  const kind = supervisorKindForPlatform(process.platform);
  if (kind === null) {
    return "no supervisor on this platform: nothing was registered and nothing was removed";
  }
  const identity =
    process.platform === "darwin"
      ? request.label
      : supervisorAdapter(kind).identity(request.environment);
  const artefact = supervisorAdapter(kind).artefactPath(request.environment);
  for (const entry of deregisterCommands({ kind, identity, artefact, uid: request.uid })) {
    spawnSync(entry.command.program, [...entry.command.argv], { encoding: "utf8" });
  }
  rmSync(artefact, { force: true });
  return `deregistered ${identity} and removed ${artefact}`;
}
