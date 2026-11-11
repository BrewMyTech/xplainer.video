/**
 * `xplainer config` — four verbs, `set`, `get`, `unset` and `list`, over the owner's speech settings.
 *
 * The settings are the four `config/keys.ts` declares, and they live in two files in the state
 * directory: `config.json` for everything that is not a secret, `credentials.json` (`0600`, owner-only
 * on Windows) for the ElevenLabs API key (spec D1, D2). This command is how a person changes them,
 * and the reason it exists at all is that a supervised daemon cannot be told anything through a
 * shell: launchd, systemd and Task Scheduler do not inherit one, so an `export` reaches the
 * commands typed in that terminal and never the narration worker. Settings take effect on the next
 * narration, because the worker reads both files per job — nothing needs restarting.
 *
 * **The secret never travels on argv, and never comes back out.** `set tts.elevenlabs.api_key
 * <value>` is refused, exit `1`, before anything is read or written: a value there is already in the
 * shell's history and in `ps`, and a command that accepted it would teach the habit. The key arrives
 * one of three ways instead — `--from-env` (this process's own `ELEVENLABS_API_KEY`), stdin when
 * stdin is not a terminal, or a prompt that does not echo when it is — and `get` and `list` say only
 * `set (<origin>)` or `unset`. No sentence this file prints contains the value, and the one failure
 * message that could carry a system error is passed through {@link redact} first.
 *
 * **The terminal is behind a seam.** {@link SecretInput} is the one piece of this command with no
 * precedent in `CliIo` — reading stdin and switching off echo — and it is injectable so that the
 * tests drive the piped, prompted and `--from-env` paths without ever needing a TTY.
 * {@link processSecretInput} is what ships.
 *
 * **What `list` calls `environment`.** `XPLAINER_TTS_PROVIDER` and `ELEVENLABS_API_KEY` override the
 * files for any process they are set in, so when either is set in the shell running this command,
 * `list` reports that origin rather than the file's — and says, once, that a supervised daemon does
 * not see it. That is the difference between "the setting I made" and "the setting the daemon has",
 * and it is otherwise invisible until a narration speaks with the wrong provider.
 *
 * The exit codes are the table's (`docs/ARCHITECTURE.md` §6) and none is invented here: `0`; `1`
 * for an unknown setting, an inadmissible or missing value, and a secret given on the command line;
 * `11` when `config.json` or `credentials.json` exists and cannot be read; `70` for anything else.
 */

import { statSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { Command } from "commander";
import {
  CREDENTIALS_FILE,
  credentialsPath,
  readCredential,
  removeCredential,
  writeCredential,
} from "../config/credentials.js";
import {
  CONFIG_KEYS,
  type ConfigKeySpec,
  ELEVENLABS_VERIFIED_MODELS,
  findConfigKey,
} from "../config/keys.js";
import {
  documentValue,
  readStateDocument,
  readUserConfigValue,
  StateDocumentUnreadableError,
  USER_CONFIG_FILE,
  unsetUserConfigValue,
  userConfigPath,
  writeUserConfigValue,
} from "../config/user-config.js";
import { DAEMON_INTERNAL_EXIT_CODE, USAGE_EXIT_CODE } from "../daemon/exit-codes.js";
import {
  resolveStateDirSetting,
  STATE_DIR_ENV,
  type StateDirEnvironment,
  settingFlag,
} from "../daemon/state-dir.js";
import type { CliIo } from "../io.js";

/**
 * Where a secret comes from when it is not on argv.
 *
 * Three members rather than one "read the secret" function, because the choice between them is the
 * command's — and the tests assert that choice — while the reading is the only part that needs a
 * real terminal.
 */
export type SecretInput = {
  /** Whether stdin is a terminal a person is typing at, rather than a pipe or a file. */
  isInteractive(): boolean;
  /** Everything on stdin, up to its end. */
  readPiped(): Promise<string>;
  /** One line from the terminal with echo off. The caller has already written the prompt. */
  readHidden(): Promise<string>;
};

/** Ctrl-C or end-of-input at the hidden prompt, before a line was entered. */
class SecretEntryCancelled extends Error {
  constructor() {
    super("the prompt was closed before anything was entered");
    this.name = "SecretEntryCancelled";
  }
}

/** The real stdin. */
export const processSecretInput: SecretInput = {
  isInteractive(): boolean {
    return process.stdin.isTTY === true;
  },

  async readPiped(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
  },

  /**
   * `readline` in terminal mode puts the TTY in raw mode — so the terminal itself echoes nothing —
   * and keeps line editing, and its own echo goes to a stream that discards it. That is the whole
   * of "input hidden": no character of the key reaches the screen or the scrollback.
   */
  async readHidden(): Promise<string> {
    const discard = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const prompt = createInterface({ input: process.stdin, output: discard, terminal: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        prompt.once("SIGINT", () => reject(new SecretEntryCancelled()));
        prompt.once("close", () => reject(new SecretEntryCancelled()));
        prompt.question("", resolve);
      });
    } finally {
      prompt.close();
    }
  },
};

/** What a test may substitute. Production passes nothing and gets the process's own. */
export type ConfigSeams = {
  /** The environment the state directory and the two overriding variables are read from. */
  env?: StateDirEnvironment;
  secretInput?: SecretInput;
};

/** What every verb parses. */
type VerbOptions = { stateDir?: string };

/** What `set` parses. */
type SetOptions = VerbOptions & { fromEnv?: boolean };

/** Where a value `get` and `list` report came from. */
type Origin = "environment" | typeof USER_CONFIG_FILE | typeof CREDENTIALS_FILE | "default";

/** One setting as it stands for this process: its value, or `null` for an unset secret. */
type Resolved = { spec: ConfigKeySpec; value: string | null; origin: Origin | null };

/**
 * Build the `config` command group.
 *
 * The group **and** every verb carry their own output routing, for the reason `commands/token.ts`
 * gives: commander's `addCommand()` copies neither `configureOutput()` nor `exitOverride()`, and
 * every verb here has a usage error a caller has to be able to observe.
 */
export function createConfigCommand(io: CliIo, seams: ConfigSeams = {}): Command {
  const env = seams.env ?? process.env;
  const secretInput = seams.secretInput ?? processSecretInput;
  const config = route(
    new Command("config")
      .description("Read and change this machine's speech settings and the ElevenLabs API key")
      .helpCommand(false),
    io,
  );
  config.addCommand(createSetCommand(io, env, secretInput));
  config.addCommand(createGetCommand(io, env));
  config.addCommand(createUnsetCommand(io, env));
  config.addCommand(createListCommand(io, env));
  return config;
}

/** Send this command's output and its exits through `io` rather than through the process. */
function route(command: Command, io: CliIo): Command {
  return command
    .configureOutput({
      writeOut: (text) => {
        io.writeOut(text);
      },
      writeErr: (text) => {
        io.writeErr(text);
      },
    })
    .exitOverride((error) => io.exit(error.exitCode));
}

/** A verb with the one option all four share, routed through `io`. */
function verb(name: string, io: CliIo): Command {
  return route(new Command(name), io).option(
    "--state-dir <path>",
    `the state directory whose settings are used; overrides ${STATE_DIR_ENV}, then the platform default`,
  );
}

function createSetCommand(io: CliIo, env: StateDirEnvironment, secretInput: SecretInput): Command {
  return verb("set", io)
    .description(
      "Store a setting. A secret is read from a hidden prompt, from stdin or with --from-env, " +
        "never from the command line",
    )
    .argument("<key>", "the setting, such as tts.provider")
    .argument("[value]", "the value; refused for a secret")
    .option("--from-env", "read tts.elevenlabs.api_key from ELEVENLABS_API_KEY in this shell")
    .action(async (name: string, value: string | undefined, options: SetOptions) => {
      const spec = knownKey(io, name);
      const stateDir = resolveStateDirSetting({ flag: options.stateDir, env }).path;
      if (spec.secret) {
        await setSecret(io, env, secretInput, spec, stateDir, value, options.fromEnv === true);
      } else {
        setSetting(io, env, spec, stateDir, value, options.fromEnv === true);
      }
    });
}

function createGetCommand(io: CliIo, env: StateDirEnvironment): Command {
  return verb("get", io)
    .description("Print a setting and where it came from; a secret only as set or unset")
    .argument("<key>", "the setting, such as tts.provider")
    .action((name: string, options: VerbOptions) => {
      const spec = knownKey(io, name);
      const stateDir = resolveStateDirSetting({ flag: options.stateDir, env }).path;
      let resolved: Resolved;
      try {
        resolved = resolveOne(env, spec, stateDir);
      } catch (error) {
        return fail(io, error);
      }
      io.writeOut(`${describeValue(resolved)}\n`);
    });
}

function createUnsetCommand(io: CliIo, env: StateDirEnvironment): Command {
  return verb("unset", io)
    .description("Remove a stored setting, returning it to its default")
    .argument("<key>", "the setting, such as tts.provider")
    .action((name: string, options: VerbOptions) => {
      const spec = knownKey(io, name);
      const stateDir = resolveStateDirSetting({ flag: options.stateDir, env }).path;
      const path = spec.secret ? credentialsPath(stateDir) : userConfigPath(stateDir);
      let removed: boolean;
      try {
        removed = spec.secret
          ? removeCredential(stateDir, spec.key)
          : unsetUserConfigValue(stateDir, spec.key);
      } catch (error) {
        return fail(io, error);
      }

      const lines: string[] = [];
      if (!removed) {
        lines.push(`${spec.key} was not set in ${path}; nothing changed.`);
      } else if (spec.secret) {
        lines.push(`removed ${spec.key} from ${path}.`);
      } else {
        lines.push(
          `removed ${spec.key} from ${path}; it is now ${String(spec.defaultValue)} (default).`,
        );
      }
      io.writeOut(`${lines.join("\n")}\n`);
      overriddenNote(io, env, spec);
    });
}

function createListCommand(io: CliIo, env: StateDirEnvironment): Command {
  return verb("list", io)
    .description("Print every setting, its value and where it came from")
    .action((options: VerbOptions) => {
      const stateDir = resolveStateDirSetting({ flag: options.stateDir, env }).path;
      const configFile = userConfigPath(stateDir);
      const credentialsFile = credentialsPath(stateDir);
      let rows: Resolved[];
      let configState: string;
      let credentialsState: string;
      try {
        const configDocument = readStateDocument(configFile, false);
        const credentialsDocument = readStateDocument(credentialsFile, true);
        configState = configDocument === null ? " (not written yet)" : "";
        credentialsState =
          credentialsDocument === null ? " (not written yet)" : fileMode(credentialsFile);
        rows = CONFIG_KEYS.map((spec) =>
          resolveFrom(
            env,
            spec,
            spec.secret
              ? documentValue(credentialsDocument, credentialsFile, spec.key)
              : documentValue(configDocument, configFile, spec.key),
          ),
        );
      } catch (error) {
        return fail(io, error);
      }

      const lines = [
        `config:       ${configFile}${configState}`,
        `credentials:  ${credentialsFile}${credentialsState}`,
        "",
      ];
      const shown = rows.map((row) => ({
        key: row.spec.key,
        value: row.spec.secret ? (row.value === null ? "unset" : "set") : String(row.value),
        origin: `${row.origin ?? ""}${invalidNote(row)}`,
      }));
      const keyWidth = Math.max(...shown.map((row) => row.key.length)) + 2;
      const valueWidth = Math.max(...shown.map((row) => row.value.length)) + 3;
      for (const row of shown) {
        lines.push(
          `${row.key.padEnd(keyWidth)}${row.value.padEnd(valueWidth)}${row.origin}`.trimEnd(),
        );
      }
      const overridden = rows.filter((row) => row.origin === "environment");
      if (overridden.length > 0) {
        lines.push("");
        for (const row of overridden) {
          lines.push(environmentSentence(row.spec));
        }
      }
      io.writeOut(`${lines.join("\n")}\n`);
    });
}

/** A name shaped like a setting — dotted lowercase segments — and so safe to quote back. */
const SETTING_SHAPED = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/**
 * The declaration for `name`, or a refusal naming the settings there are.
 *
 * The refusal quotes `name` only when it is shaped like a setting. What arrives here is whatever
 * was typed first, and the two commonest slips both put a key there: `api_key=sk_…`, the
 * `key=value` habit, and a key pasted where the setting's name belongs. Neither has a dotted
 * lowercase shape, so neither is echoed into the scrollback the secret-on-argv refusal exists to
 * keep it out of.
 */
function knownKey(io: CliIo, name: string): ConfigKeySpec {
  const spec = findConfigKey(name);
  if (spec === undefined) {
    const settings = CONFIG_KEYS.map((entry) => entry.key).join(", ");
    const named = SETTING_SHAPED.test(name) && name.length <= 64;
    io.writeErr(
      named
        ? `xplainer config: "${name}" is not a setting this build knows. Settings: ${settings}.\n`
        : "xplainer config: the first argument is not a setting this build knows, and is not " +
            "repeated here in case it holds a value. Give the setting and its value as separate " +
            "arguments; an API key is never given on the command line — `config set " +
            `tts.elevenlabs.api_key\` asks for it. Settings: ${settings}.\n`,
    );
    return io.exit(USAGE_EXIT_CODE);
  }
  return spec;
}

function setSetting(
  io: CliIo,
  env: StateDirEnvironment,
  spec: ConfigKeySpec,
  stateDir: string,
  value: string | undefined,
  fromEnv: boolean,
): void {
  if (fromEnv) {
    io.writeErr(
      `xplainer config: --from-env reads a secret, and ${spec.key} is not one; ` +
        "give its value on the command line.\n",
    );
    io.exit(USAGE_EXIT_CODE);
  }
  if (value === undefined) {
    io.writeErr(
      `xplainer config: ${spec.key} needs a value, such as ` +
        `\`xplainer config set ${spec.key} ${String(spec.defaultValue)}\`.\n`,
    );
    io.exit(USAGE_EXIT_CODE);
  }
  const problem = spec.validate(value);
  if (problem !== null) {
    io.writeErr(`xplainer config: ${problem}\n`);
    io.exit(USAGE_EXIT_CODE);
  }

  const choosesElevenLabs = spec.key === "tts.provider" && value === "elevenlabs";
  let keyStored = false;
  try {
    // Read before the write, so a `credentials.json` that cannot be read refuses with nothing
    // written rather than after `config.json` has already changed.
    if (choosesElevenLabs) {
      keyStored = readCredential(stateDir, "tts.elevenlabs.api_key") !== null;
    }
    writeUserConfigValue(stateDir, spec.key, value);
  } catch (error) {
    fail(io, error);
  }

  const lines = [`${spec.key} = ${value} (${userConfigPath(stateDir)})`];
  if (choosesElevenLabs) {
    lines.push(
      "The next narration is spoken by ElevenLabs and billed per character to the account whose key is stored.",
      "Narration text is sent to api.elevenlabs.io.",
    );
    if (!keyStored) {
      lines.push(
        "No API key is stored yet, so narration is refused until you run " +
          "`xplainer config set tts.elevenlabs.api_key`.",
      );
    }
  }
  io.writeOut(`${lines.join("\n")}\n`);

  if (spec.key === "tts.elevenlabs.model" && !ELEVENLABS_VERIFIED_MODELS.includes(value)) {
    io.writeErr(
      `warning: ${value} is not one of the models measured to return character timestamps ` +
        `(${ELEVENLABS_VERIFIED_MODELS.join(", ")}). It is stored; a narration that comes back ` +
        "without timestamps is refused by name, and nothing is written.\n",
    );
  }
  overriddenNote(io, env, spec);
}

async function setSecret(
  io: CliIo,
  env: StateDirEnvironment,
  secretInput: SecretInput,
  spec: ConfigKeySpec,
  stateDir: string,
  value: string | undefined,
  fromEnv: boolean,
): Promise<void> {
  if (value !== undefined) {
    // Refused before anything else, and without echoing it: the value is already in the shell's
    // history, and the one useful thing left to do is not to repeat it into the scrollback.
    io.writeErr(
      `xplainer config: ${spec.key} is a secret and is not accepted on the command line, where it ` +
        "would be kept in your shell history. Run the command without a value and paste it at the " +
        "prompt, pipe it on stdin, or pass --from-env.\n",
    );
    io.exit(USAGE_EXIT_CODE);
  }

  let raw: string;
  if (fromEnv) {
    const variable = spec.environment ?? "";
    const exported = settingFlag(env[variable]);
    if (exported === undefined) {
      io.writeErr(
        `xplainer config: --from-env reads ${variable}, and it is not set in this shell; ` +
          "nothing was written.\n",
      );
      io.exit(USAGE_EXIT_CODE);
    }
    raw = exported;
  } else {
    try {
      if (secretInput.isInteractive()) {
        io.writeErr(`${spec.label} (input hidden): `);
        raw = await secretInput.readHidden();
        io.writeErr("\n");
      } else {
        raw = await secretInput.readPiped();
      }
    } catch (error) {
      if (error instanceof SecretEntryCancelled) {
        io.writeErr(`\nxplainer config: ${error.message}; nothing was written.\n`);
        io.exit(USAGE_EXIT_CODE);
      }
      fail(io, error);
    }
  }

  // A trailing newline from `echo`, or a space a paste picked up, is never part of a key.
  const secret = raw.trim();
  const problem = spec.validate(secret);
  if (problem !== null) {
    io.writeErr(`xplainer config: ${problem} Nothing was written.\n`);
    io.exit(USAGE_EXIT_CODE);
  }

  let stored: { path: string; protection: string };
  try {
    stored = writeCredential(stateDir, spec.key, secret);
  } catch (error) {
    fail(io, error, secret);
  }
  io.writeOut(`stored ${spec.key} in ${stored.path} (${stored.protection})\n`);
  if (!fromEnv) {
    overriddenNote(io, env, spec);
  }
}

/** The value an environment variable supplies for `spec`, when one is set and is not blank. */
function fromEnvironment(env: StateDirEnvironment, spec: ConfigKeySpec): string | undefined {
  return spec.environment === null ? undefined : settingFlag(env[spec.environment])?.trim();
}

/** `spec` as this process sees it, given what its file holds. */
function resolveFrom(
  env: StateDirEnvironment,
  spec: ConfigKeySpec,
  stored: string | null,
): Resolved {
  const exported = fromEnvironment(env, spec);
  if (exported !== undefined) {
    return { spec, value: exported, origin: "environment" };
  }
  if (stored !== null) {
    return { spec, value: stored, origin: spec.secret ? CREDENTIALS_FILE : USER_CONFIG_FILE };
  }
  if (spec.defaultValue !== null) {
    return { spec, value: spec.defaultValue, origin: "default" };
  }
  return { spec, value: null, origin: null };
}

function resolveOne(env: StateDirEnvironment, spec: ConfigKeySpec, stateDir: string): Resolved {
  const stored = spec.secret
    ? readCredential(stateDir, spec.key)
    : readUserConfigValue(stateDir, spec.key);
  return resolveFrom(env, spec, stored);
}

/** What `get` prints. A secret is `set (<origin>)` or `unset`, and never its value. */
function describeValue(resolved: Resolved): string {
  if (resolved.value === null || resolved.origin === null) {
    return "unset";
  }
  return `${resolved.spec.secret ? "set" : resolved.value} (${resolved.origin})${invalidNote(resolved)}`;
}

/**
 * ` — INVALID: <why>` for a value narration will refuse, or nothing.
 *
 * `config set` validates what it writes, but a file can be edited by hand and an environment
 * variable is never validated by anybody until a narration reads it. Reporting such a value as if
 * it were in force would have `get` and `list` disagree with `status` and with the job that fails
 * on it. A secret is never checked here: its refusal sentences are about the key, and this line is
 * printed.
 */
function invalidNote(resolved: Resolved): string {
  if (resolved.spec.secret || resolved.value === null) {
    return "";
  }
  const problem = resolved.spec.validate(resolved.value);
  return problem === null ? "" : ` — INVALID: ${problem}`;
}

/** The one sentence that explains an `environment` origin. */
function environmentSentence(spec: ConfigKeySpec): string {
  const file = spec.secret ? CREDENTIALS_FILE : USER_CONFIG_FILE;
  return (
    `${String(spec.environment)} is set in this shell and overrides ${file} for any xplainer ` +
    "process started from it; a supervised daemon does not inherit it."
  );
}

/** Said on stderr after a change the shell's own environment is still overriding. */
function overriddenNote(io: CliIo, env: StateDirEnvironment, spec: ConfigKeySpec): void {
  if (fromEnvironment(env, spec) !== undefined) {
    io.writeErr(`note: ${environmentSentence(spec)}\n`);
  }
}

/**
 * The file's real mode, as ` (mode 0600)`, where a mode means something.
 *
 * Read rather than assumed: a file somebody loosened by hand should not be reported at the mode this
 * command would have written. On Windows a mode is not protection, so nothing is claimed.
 */
function fileMode(path: string): string {
  if (process.platform === "win32") {
    return "";
  }
  const mode = statSync(path).mode & 0o777;
  const shown = ` (mode ${mode.toString(8).padStart(4, "0")})`;
  return (mode & 0o077) === 0
    ? shown
    : `${shown} — WARNING: readable by other accounts; run \`chmod 600 ${path}\`, or ` +
        "`xplainer config set tts.elevenlabs.api_key` to rewrite it owner-only";
}

/** Replace every occurrence of `secret` in `text` with `[redacted]`. */
function redact(text: string, secret: string | undefined): string {
  return secret === undefined || secret === "" ? text : text.split(secret).join("[redacted]");
}

/** Exit `11` for a file that cannot be read, `70` for anything else, saying which on stderr. */
function fail(io: CliIo, error: unknown, secret?: string): never {
  if (error instanceof StateDocumentUnreadableError) {
    io.writeErr(`xplainer config: ${error.message}\n`);
    return io.exit(error.exitCode);
  }
  const detail = error instanceof Error ? error.message : String(error);
  io.writeErr(`xplainer config: ${redact(detail, secret)}\n`);
  return io.exit(DAEMON_INTERNAL_EXIT_CODE);
}
