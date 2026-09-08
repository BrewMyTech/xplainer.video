/**
 * What a supervisor artefact is, and the rules every renderer obeys before it composes a line.
 *
 * The three renderers have nothing in common at the surface — an INI file, a plist and a Task
 * Scheduler document — and one thing in common underneath: **each of them is the last place a
 * dropped setting is still visible.** A unit that lost `--socket` installs cleanly, starts
 * cleanly, and puts the daemon's socket somewhere `status` is not looking; there is no later step
 * that notices. So the checks live here, once, and every renderer runs them against the
 * {@link LaunchSpec} before composing anything.
 *
 * **The strongest of them is that the argv is checked, not just the settings record.**
 * `runtime/launch-spec.ts` puts all three settings into `argv` and keeps the same values in
 * `settings` so that a renderer and a checker have something to compare; a spec whose `settings`
 * are complete but whose `argv` lost a flag would render an artefact that satisfies every value
 * assertion and launches a daemon that receives none of them. {@link requireRenderableSpec}
 * therefore requires each setting to appear in `argv` as its flag **immediately followed by its
 * value**, which is the shape `buildLaunchSpec` emits and the shape all three artefacts copy
 * verbatim.
 *
 * **Nothing here writes.** A renderer answers with the path, the mode and the exact bytes, and
 * `install` (T11) is what puts them on disk — which is what makes all three renderers verifiable on
 * one machine and is why this story's whole verification is `local`.
 */

import type { SupervisorKind } from "../../daemon/daemon-state.js";
import { type LaunchSettings, type LaunchSpec, SETTING_FLAGS } from "../../runtime/launch-spec.js";

/** The three settings, in the order the launch contract emits them. */
export const SETTING_KEYS: readonly (keyof LaunchSettings)[] = ["stateDir", "tokenFile", "socket"];

/** A file a supervisor reads, described completely enough for `install` to write it. */
export type SupervisorArtefact = {
  /** Which supervisor reads it. The same spelling `daemon.json` records. */
  kind: SupervisorKind;
  /** The absolute path it belongs at, with no `~` left in it. */
  path: string;
  /** The mode it is created with. */
  mode: number;
  /** The name this supervisor's own tooling addresses the daemon by. */
  identity: string;
  /** The exact bytes, ending in a newline. */
  contents: string;
};

/**
 * The account and directories a renderer needs, and nothing about the daemon itself.
 *
 * Every field is a parameter rather than a read of `process` or `os` for the reason
 * `daemon/state-dir.ts` gives for the same choice: it is the only way one machine can render — and
 * assert — all three platforms' artefacts, which is what makes this story `local`.
 */
export type SupervisorEnvironment = {
  /** The user's home directory, already expanded: launchd expands no `~` of its own. */
  home: string;
  /** The account the daemon runs as. On Windows the qualified `DOMAIN\user` form. */
  account: string;
  /**
   * `$XDG_CONFIG_HOME`, when the machine sets one.
   *
   * systemd's user-unit search path is `$XDG_CONFIG_HOME/systemd/user` and falls back to
   * `~/.config/systemd/user` only when the variable is unset, so a unit written to the fallback on
   * a machine that sets the variable is a unit systemd never reads.
   */
  configHome?: string | undefined;
  /** `%LOCALAPPDATA%`, where the Windows task XML is mirrored. Unused on the other two. */
  localAppData?: string | undefined;
  /**
   * `%SystemRoot%`, under which Task Scheduler keeps its own copy of a registered task.
   *
   * No renderer reads it: the artefact this project writes is the one under `%LOCALAPPDATA%`. It is
   * here because a refusal check has to hash the place a *registration* would appear, which on
   * Windows is `%SystemRoot%\System32\Tasks\xplainer` and is not a path any renderer produces.
   */
  systemRoot?: string | undefined;
};

/** A launch spec or an environment a supervisor artefact cannot be rendered from. */
export class SupervisorArtefactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorArtefactError";
  }
}

/**
 * Every rule a spec must satisfy before any of the three renderers composes a line.
 *
 * The failures name the field and say what the installed daemon would have done instead, because
 * this is the only moment at which "the setting I meant was not the setting that arrived" is
 * cheap to see.
 */
export function requireRenderableSpec(spec: LaunchSpec, kind: SupervisorKind): void {
  requireValue(spec.executable, "executable", kind);
  requireValue(spec.cwd, "cwd", kind);
  if (spec.argv.length === 0) {
    throw new SupervisorArtefactError(
      `the ${kind} artefact needs a launch contract with an argv, and this one is empty. The ` +
        `first entry is the entry file the interpreter runs, so an empty vector would start a ` +
        `REPL rather than the daemon.`,
    );
  }
  for (const [index, word] of spec.argv.entries()) {
    requireValue(word, `argv[${index}]`, kind);
  }
  for (const key of SETTING_KEYS) {
    const value = requireValue(spec.settings[key], `settings.${key}`, kind);
    const flag = SETTING_FLAGS[key];
    const at = spec.argv.indexOf(flag);
    if (at < 0 || spec.argv[at + 1] !== value) {
      throw new SupervisorArtefactError(
        `the ${kind} artefact carries the launch contract's argv verbatim, and that argv does ` +
          `not carry ${flag} ${JSON.stringify(value)} — it is ` +
          `${JSON.stringify(Array.from(spec.argv))}. A setting that is in \`settings\` and not ` +
          `in \`argv\` is a setting the installed daemon never receives, and the artefact would ` +
          `look complete to every value it records.`,
      );
    }
  }
}

/**
 * A value that is present, is not blank, and can survive being written into a line-oriented file.
 *
 * A newline in a path would end the unit's line and start a directive of the user's choosing, and
 * a NUL cannot be passed to `execve` at all, so both are refused here rather than escaped into
 * something a reader of the artefact would have to decode.
 */
export function requireValue(value: string, field: string, kind: SupervisorKind): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SupervisorArtefactError(
      `the ${kind} artefact needs ${field}, and it is ${JSON.stringify(value)}. Every value in a ` +
        `launch spec is emitted, so an absent one would install a daemon running on the platform ` +
        `default while the artefact said otherwise.`,
    );
  }
  if (hasControlCharacter(value)) {
    throw new SupervisorArtefactError(
      `the ${kind} artefact's ${field} contains a control character: ${JSON.stringify(value)}. ` +
        `A supervisor artefact is a line-oriented file on every platform, so a value carrying a ` +
        `newline is refused rather than written into one.`,
    );
  }
  return value;
}

/** XML text with the five entities the plist and the task document both need. */
export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Whether a value carries a character a supervisor artefact cannot hold.
 *
 * Character by character rather than by regular expression, because the class this looks for is
 * exactly the class a control-character regular expression is linted against, and the loop says
 * what it means without an exception to a rule that is right everywhere else.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
