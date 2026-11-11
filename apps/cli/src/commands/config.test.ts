/**
 * `xplainer config`, driven through commander with a recording `CliIo` over a real state directory.
 *
 * What a user sees is an exit code, two streams and what is on disk afterwards, so that is what is
 * asserted — the shape `token.test.ts` set. Two things are substituted, and both are inputs rather
 * than the behaviour under test: the **environment**, so that `XPLAINER_TTS_PROVIDER` and
 * `ELEVENLABS_API_KEY` can be set for one invocation without touching this process's own, and the
 * **terminal**, through `SecretInput`, so that the piped, prompted and `--from-env` paths all run
 * without a TTY. The files, their modes and the commander program are real.
 *
 * One rule is asserted across every verb rather than once: **no output contains the key**. It is the
 * property the whole command is shaped around (spec D2), and a single `get` that echoed it would
 * undo the protection `credentials.json` has on disk.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsPath, writeCredential } from "../config/credentials.js";
import { userConfigPath } from "../config/user-config.js";
import type { CliIo } from "../io.js";
import { createProgram } from "../program.js";
import { createConfigCommand, type SecretInput } from "./config.js";

const KEY = "sk_9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d";

/** Thrown in place of `process.exit`, carrying the code the command asked for. */
class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "ExitSignal";
    this.code = code;
  }
}

/** What one invocation produced. */
type Invocation = { exitCode: number | undefined; stdout: string; stderr: string };

/** A terminal-less stand-in for stdin, counting what was asked of it. */
type FakeInput = SecretInput & { reads: number };

/** stdin is a pipe carrying `text`. */
function piped(text: string): FakeInput {
  const input: FakeInput = {
    reads: 0,
    isInteractive: () => false,
    async readPiped() {
      input.reads += 1;
      return text;
    },
    async readHidden() {
      throw new Error("a piped stdin was asked for a hidden line");
    },
  };
  return input;
}

/** stdin is a terminal, and the person at it types `text` at the hidden prompt. */
function prompted(text: string): FakeInput {
  const input: FakeInput = {
    reads: 0,
    isInteractive: () => true,
    async readPiped() {
      throw new Error("a terminal was read as a pipe");
    },
    async readHidden() {
      input.reads += 1;
      return text;
    },
  };
  return input;
}

/** Every output any test in this file produced, for the sweep at the end. */
const everything: string[] = [];

/** Run `xplainer config <argv…>` and collect what a user would have seen. */
async function run(
  argv: string[],
  options: { env?: Record<string, string>; input?: FakeInput } = {},
): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    writeOut(text) {
      out.push(text);
    },
    writeErr(text) {
      err.push(text);
    },
    exit(code): never {
      throw new ExitSignal(code);
    },
  };
  const command = createConfigCommand(io, {
    env: options.env ?? {},
    secretInput: options.input ?? piped(""),
  });

  let exitCode: number | undefined;
  try {
    await command.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
    exitCode = error.code;
  }
  const invocation = { exitCode, stdout: out.join(""), stderr: err.join("") };
  everything.push(invocation.stdout, invocation.stderr);
  return invocation;
}

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-config-cmd-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function configOnDisk(): unknown {
  return JSON.parse(readFileSync(userConfigPath(scratch), "utf8"));
}

const MODE = process.platform === "win32" ? "" : " (mode 0600)";

describe("xplainer config set", () => {
  it("stores the provider and says what choosing ElevenLabs costs, and that no key is stored", async () => {
    const { stdout, stderr, exitCode } = await run([
      "set",
      "tts.provider",
      "elevenlabs",
      "--state-dir",
      scratch,
    ]);

    expect(exitCode).toBeUndefined();
    expect(stderr).toBe("");
    expect(stdout).toBe(
      `tts.provider = elevenlabs (${userConfigPath(scratch)})\n` +
        "The next narration is spoken by ElevenLabs and billed per character to the account whose key is stored.\n" +
        "Narration text is sent to api.elevenlabs.io.\n" +
        "No API key is stored yet, so narration is refused until you run " +
        "`xplainer config set tts.elevenlabs.api_key`.\n",
    );
    expect(configOnDisk()).toEqual({ format_version: 1, tts: { provider: "elevenlabs" } });
  });

  it("leaves out the no-key line when a key is stored", async () => {
    writeCredential(scratch, "tts.elevenlabs.api_key", KEY);

    const { stdout } = await run(["set", "tts.provider", "elevenlabs", "--state-dir", scratch]);

    expect(stdout).toContain("Narration text is sent to api.elevenlabs.io.");
    expect(stdout).not.toContain("No API key is stored yet");
  });

  it("says one line, and nothing about billing, for kokoro", async () => {
    const { stdout } = await run(["set", "tts.provider", "kokoro", "--state-dir", scratch]);

    expect(stdout).toBe(`tts.provider = kokoro (${userConfigPath(scratch)})\n`);
  });

  it("refuses an unknown provider with the admissibility sentence, exit 1, writing nothing", async () => {
    const { stdout, stderr, exitCode } = await run([
      "set",
      "tts.provider",
      "openai",
      "--state-dir",
      scratch,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      'xplainer config: speech provider "openai" is not one this build knows. Admissible ' +
        "providers: kokoro, elevenlabs. A provider is admissible only if it returns word or " +
        "character timestamps with its audio.\n",
    );
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("refuses a setting that does not exist, naming the ones that do", async () => {
    const { stderr, exitCode } = await run(["set", "tts.speed", "1", "--state-dir", scratch]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('"tts.speed" is not a setting this build knows');
    expect(stderr).toContain(
      "tts.provider, tts.elevenlabs.voice, tts.elevenlabs.model, tts.elevenlabs.api_key",
    );
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("does not repeat a first argument that may hold a value: key=value, or a pasted key", async () => {
    const assigned = await run(["set", `tts.elevenlabs.api_key=${KEY}`, "--state-dir", scratch]);
    const pasted = await run(["set", KEY, "--state-dir", scratch]);

    for (const refused of [assigned, pasted]) {
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("is not repeated here in case it holds a value");
      expect(refused.stderr).toContain("tts.elevenlabs.api_key");
      expect(refused.stderr).not.toContain(KEY);
    }
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("does not repeat a key pasted under the voice or the model", async () => {
    const voice = await run(["set", "tts.elevenlabs.voice", KEY, "--state-dir", scratch]);
    const model = await run(["set", "tts.elevenlabs.model", KEY, "--state-dir", scratch]);

    for (const refused of [voice, model]) {
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("a value beginning sk_");
      expect(refused.stderr).not.toContain(KEY);
    }
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("refuses a non-secret setting with no value, and one given --from-env", async () => {
    const missing = await run(["set", "tts.elevenlabs.voice", "--state-dir", scratch]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("tts.elevenlabs.voice needs a value");

    const fromEnv = await run(["set", "tts.provider", "--from-env", "--state-dir", scratch], {
      env: { XPLAINER_TTS_PROVIDER: "elevenlabs" },
    });
    expect(fromEnv.exitCode).toBe(1);
    expect(fromEnv.stderr).toContain("--from-env reads a secret");
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("refuses a voice that is not an ElevenLabs voice id", async () => {
    const { stderr, exitCode } = await run([
      "set",
      "tts.elevenlabs.voice",
      "af_heart",
      "--state-dir",
      scratch,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('"af_heart" is not an ElevenLabs voice id');
  });

  /** §11 C5: any well-formed model is stored, and one outside the measured set is a warning. */
  it("stores a model outside the measured set with a warning, and exits 0", async () => {
    const { stdout, stderr, exitCode } = await run([
      "set",
      "tts.elevenlabs.model",
      "eleven_v3",
      "--state-dir",
      scratch,
    ]);

    expect(exitCode).toBeUndefined();
    expect(stdout).toBe(`tts.elevenlabs.model = eleven_v3 (${userConfigPath(scratch)})\n`);
    expect(stderr).toContain("warning: eleven_v3 is not one of the models measured");
    expect(stderr).toContain("eleven_multilingual_v2, eleven_flash_v2_5, eleven_v4");
    expect(configOnDisk()).toEqual({
      format_version: 1,
      tts: { elevenlabs: { model: "eleven_v3" } },
    });
  });

  it("stores a measured model without a warning", async () => {
    const { stderr, exitCode } = await run([
      "set",
      "tts.elevenlabs.model",
      "eleven_v4",
      "--state-dir",
      scratch,
    ]);

    expect(exitCode).toBeUndefined();
    expect(stderr).toBe("");
  });

  it("notes when the shell's own XPLAINER_TTS_PROVIDER still overrides what was stored", async () => {
    const { stderr, exitCode } = await run(
      ["set", "tts.provider", "kokoro", "--state-dir", scratch],
      { env: { XPLAINER_TTS_PROVIDER: "elevenlabs" } },
    );

    expect(exitCode).toBeUndefined();
    expect(stderr).toContain("note: XPLAINER_TTS_PROVIDER is set in this shell");
    expect(stderr).toContain("a supervised daemon does not inherit it");
  });

  /** Requirement 2 of the spec, and AC 6: the key on argv is refused and nothing is written. */
  it("refuses a secret on the command line, exit 1, reading nothing and writing nothing", async () => {
    const input = piped(KEY);

    const { stdout, stderr, exitCode } = await run(
      ["set", "tts.elevenlabs.api_key", KEY, "--state-dir", scratch],
      { input },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "xplainer config: tts.elevenlabs.api_key is a secret and is not accepted on the command " +
        "line, where it would be kept in your shell history. Run the command without a value and " +
        "paste it at the prompt, pipe it on stdin, or pass --from-env.\n",
    );
    expect(input.reads).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("stores a key piped on stdin, without its trailing newline, 0600", async () => {
    const { stdout, stderr, exitCode } = await run(
      ["set", "tts.elevenlabs.api_key", "--state-dir", scratch],
      { input: piped(`${KEY}\n`) },
    );

    expect(exitCode).toBeUndefined();
    expect(stderr).toBe("");
    expect(stdout).toBe(`stored tts.elevenlabs.api_key in ${credentialsPath(scratch)}${MODE}\n`);
    expect(JSON.parse(readFileSync(credentialsPath(scratch), "utf8"))).toEqual({
      format_version: 1,
      tts: { elevenlabs: { api_key: KEY } },
    });
    if (process.platform !== "win32") {
      expect(statSync(credentialsPath(scratch)).mode & 0o777).toBe(0o600);
    }
  });

  it("prompts on stderr with input hidden when stdin is a terminal", async () => {
    const input = prompted(KEY);

    const { stdout, stderr, exitCode } = await run(
      ["set", "tts.elevenlabs.api_key", "--state-dir", scratch],
      { input },
    );

    expect(exitCode).toBeUndefined();
    expect(input.reads).toBe(1);
    expect(stderr).toBe("ElevenLabs API key (input hidden): \n");
    expect(stdout).toBe(`stored tts.elevenlabs.api_key in ${credentialsPath(scratch)}${MODE}\n`);
    expect(readFileSync(credentialsPath(scratch), "utf8")).toContain(KEY);
  });

  it("stores ELEVENLABS_API_KEY from this shell with --from-env, and reads no stdin", async () => {
    const input = piped("not this");

    const { stdout, exitCode } = await run(
      ["set", "tts.elevenlabs.api_key", "--from-env", "--state-dir", scratch],
      { env: { ELEVENLABS_API_KEY: KEY }, input },
    );

    expect(exitCode).toBeUndefined();
    expect(input.reads).toBe(0);
    expect(stdout).toContain("stored tts.elevenlabs.api_key in");
    expect(readFileSync(credentialsPath(scratch), "utf8")).toContain(KEY);
  });

  it("refuses --from-env when ELEVENLABS_API_KEY is not set, writing nothing", async () => {
    const { stderr, exitCode } = await run(
      ["set", "tts.elevenlabs.api_key", "--from-env", "--state-dir", scratch],
      { env: { ELEVENLABS_API_KEY: "  " } },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--from-env reads ELEVENLABS_API_KEY, and it is not set");
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("refuses an empty stdin and a key with whitespace inside it, writing nothing", async () => {
    const empty = await run(["set", "tts.elevenlabs.api_key", "--state-dir", scratch], {
      input: piped("\n"),
    });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("the API key is empty. Nothing was written.");

    const pasted = await run(["set", "tts.elevenlabs.api_key", "--state-dir", scratch], {
      input: piped(`${KEY} ${KEY}`),
    });
    expect(pasted.exitCode).toBe(1);
    expect(pasted.stderr).toContain("contains whitespace");
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe("xplainer config get", () => {
  it("prints a default, a stored value and an environment value, each with its origin", async () => {
    expect((await run(["get", "tts.provider", "--state-dir", scratch])).stdout).toBe(
      "kokoro (default)\n",
    );

    await run(["set", "tts.provider", "elevenlabs", "--state-dir", scratch]);
    expect((await run(["get", "tts.provider", "--state-dir", scratch])).stdout).toBe(
      "elevenlabs (config.json)\n",
    );

    const overridden = await run(["get", "tts.provider", "--state-dir", scratch], {
      env: { XPLAINER_TTS_PROVIDER: "kokoro" },
    });
    expect(overridden.stdout).toBe("kokoro (environment)\n");
  });

  it("shows a secret only as set or unset", async () => {
    const before = await run(["get", "tts.elevenlabs.api_key", "--state-dir", scratch]);
    expect(before.stdout).toBe("unset\n");
    expect(before.exitCode).toBeUndefined();

    writeCredential(scratch, "tts.elevenlabs.api_key", KEY);
    expect((await run(["get", "tts.elevenlabs.api_key", "--state-dir", scratch])).stdout).toBe(
      "set (credentials.json)\n",
    );

    const fromShell = await run(["get", "tts.elevenlabs.api_key", "--state-dir", scratch], {
      env: { ELEVENLABS_API_KEY: "sk_from_the_shell" },
    });
    expect(fromShell.stdout).toBe("set (environment)\n");
    expect(fromShell.stdout).not.toContain("sk_from_the_shell");
  });

  it("marks a hand-edited or exported value narration would refuse as INVALID", async () => {
    writeFileSync(
      userConfigPath(scratch),
      `${JSON.stringify({ format_version: 1, tts: { provider: "elevenlab" } })}\n`,
    );
    const edited = await run(["get", "tts.provider", "--state-dir", scratch]);
    expect(edited.stdout).toBe(
      'elevenlab (config.json) — INVALID: speech provider "elevenlab" is not one this build ' +
        "knows. Admissible providers: kokoro, elevenlabs. A provider is admissible only if it " +
        "returns word or character timestamps with its audio.\n",
    );

    const listed = await run(["list", "--state-dir", scratch], {
      env: { XPLAINER_TTS_PROVIDER: "bogus" },
    });
    expect(listed.stdout).toContain('environment — INVALID: speech provider "bogus"');
  });

  it("refuses a setting that does not exist", async () => {
    const { exitCode, stdout } = await run(["get", "voice", "--state-dir", scratch]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
  });
});

describe("xplainer config unset", () => {
  it("removes a stored setting, says what it is now, and says when there was nothing", async () => {
    await run(["set", "tts.provider", "elevenlabs", "--state-dir", scratch]);

    const first = await run(["unset", "tts.provider", "--state-dir", scratch]);
    expect(first.exitCode).toBeUndefined();
    expect(first.stdout).toBe(
      `removed tts.provider from ${userConfigPath(scratch)}; it is now kokoro (default).\n`,
    );
    expect(configOnDisk()).toEqual({ format_version: 1 });

    const second = await run(["unset", "tts.provider", "--state-dir", scratch]);
    expect(second.exitCode).toBeUndefined();
    expect(second.stdout).toBe(
      `tts.provider was not set in ${userConfigPath(scratch)}; nothing changed.\n`,
    );
  });

  it("removes the key from credentials.json", async () => {
    writeCredential(scratch, "tts.elevenlabs.api_key", KEY);

    const { stdout, exitCode } = await run([
      "unset",
      "tts.elevenlabs.api_key",
      "--state-dir",
      scratch,
    ]);

    expect(exitCode).toBeUndefined();
    expect(stdout).toBe(`removed tts.elevenlabs.api_key from ${credentialsPath(scratch)}.\n`);
    expect(readFileSync(credentialsPath(scratch), "utf8")).not.toContain(KEY);
  });
});

describe("xplainer config list", () => {
  it("prints both files and every setting with its origin, in §6's layout", async () => {
    await run(["set", "tts.provider", "elevenlabs", "--state-dir", scratch]);
    await run(["set", "tts.elevenlabs.api_key", "--state-dir", scratch], { input: piped(KEY) });

    const { stdout, stderr, exitCode } = await run(["list", "--state-dir", scratch]);

    expect(exitCode).toBeUndefined();
    expect(stderr).toBe("");
    expect(stdout).toBe(
      [
        `config:       ${userConfigPath(scratch)}`,
        `credentials:  ${credentialsPath(scratch)}${MODE}`,
        "",
        "tts.provider            elevenlabs               config.json",
        "tts.elevenlabs.voice    JBFqnCBsd6RMkjVDRZzb     default",
        "tts.elevenlabs.model    eleven_multilingual_v2   default",
        "tts.elevenlabs.api_key  set                      credentials.json",
        "",
      ].join("\n"),
    );
  });

  it.skipIf(process.platform === "win32")(
    "warns when credentials.json has been loosened by hand",
    async () => {
      writeCredential(scratch, "tts.elevenlabs.api_key", KEY);
      chmodSync(credentialsPath(scratch), 0o644);

      const { stdout } = await run(["list", "--state-dir", scratch]);

      expect(stdout).toContain(
        `credentials:  ${credentialsPath(scratch)} (mode 0644) — WARNING: readable by other accounts`,
      );
    },
  );

  it("says when neither file has been written, and shows the key as unset", async () => {
    const { stdout } = await run(["list", "--state-dir", scratch]);

    expect(stdout).toContain(`config:       ${userConfigPath(scratch)} (not written yet)`);
    expect(stdout).toContain(`credentials:  ${credentialsPath(scratch)} (not written yet)`);
    expect(stdout).toContain("tts.provider            kokoro                   default\n");
    expect(stdout).toContain("tts.elevenlabs.api_key  unset\n");
  });

  /** The shell's own variables are what this process uses, and what a supervised daemon does not. */
  it("reports environment as the origin for either variable, and says the daemon does not see it", async () => {
    await run(["set", "tts.provider", "kokoro", "--state-dir", scratch]);

    const { stdout } = await run(["list", "--state-dir", scratch], {
      env: { XPLAINER_TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: KEY },
    });

    expect(stdout).toContain("tts.provider            elevenlabs               environment\n");
    expect(stdout).toContain("tts.elevenlabs.api_key  set                      environment\n");
    expect(stdout).toContain(
      "XPLAINER_TTS_PROVIDER is set in this shell and overrides config.json for any xplainer " +
        "process started from it; a supervised daemon does not inherit it.",
    );
    expect(stdout).toContain(
      "ELEVENLABS_API_KEY is set in this shell and overrides credentials.json",
    );
  });
});

describe("an unreadable file", () => {
  it("exits 11 from list and get, with nothing on stdout, and is never read as no config", async () => {
    writeFileSync(userConfigPath(scratch), "{ broken");

    const list = await run(["list", "--state-dir", scratch]);
    expect(list.exitCode).toBe(11);
    expect(list.stdout).toBe("");
    expect(list.stderr).toContain(`${userConfigPath(scratch)} exists and cannot be read`);

    const get = await run(["get", "tts.provider", "--state-dir", scratch]);
    expect(get.exitCode).toBe(11);
    expect(get.stdout).toBe("");
  });

  it("exits 11 from set, leaving the file as it was", async () => {
    writeFileSync(userConfigPath(scratch), JSON.stringify({ format_version: 2 }));

    const { exitCode } = await run(["set", "tts.provider", "kokoro", "--state-dir", scratch]);

    expect(exitCode).toBe(11);
    expect(configOnDisk()).toEqual({ format_version: 2 });
  });

  it("refuses `set tts.provider elevenlabs` over an unreadable credentials.json before writing config.json", async () => {
    writeFileSync(credentialsPath(scratch), `{"api_key":"${KEY}`);

    const { exitCode, stderr } = await run([
      "set",
      "tts.provider",
      "elevenlabs",
      "--state-dir",
      scratch,
    ]);

    expect(exitCode).toBe(11);
    expect(stderr).toContain(`${credentialsPath(scratch)} exists and cannot be read`);
    expect(stderr).not.toContain(KEY);
    expect(readdirSync(scratch)).toEqual(["credentials.json"]);
  });
});

describe("--state-dir", () => {
  it("is above XPLAINER_STATE_DIR, which is used when the flag is absent", async () => {
    const fromVariable = join(scratch, "from-variable");
    const fromFlag = join(scratch, "from-flag");
    mkdirSync(fromVariable);
    mkdirSync(fromFlag);
    const env = { XPLAINER_STATE_DIR: fromVariable };

    await run(["set", "tts.provider", "elevenlabs", "--state-dir", fromFlag], { env });
    await run(["set", "tts.provider", "kokoro"], { env });

    expect(JSON.parse(readFileSync(userConfigPath(fromFlag), "utf8")).tts.provider).toBe(
      "elevenlabs",
    );
    expect(JSON.parse(readFileSync(userConfigPath(fromVariable), "utf8")).tts.provider).toBe(
      "kokoro",
    );
  });
});

describe("the real program", () => {
  /** The registration itself: the group is reachable from `xplainer`, with its verbs routed. */
  it("reaches config get through createProgram", async () => {
    const out: string[] = [];
    const io: CliIo = {
      writeOut(text) {
        out.push(text);
      },
      writeErr() {},
      exit(code): never {
        throw new ExitSignal(code);
      },
    };

    await createProgram(io).parseAsync(
      ["config", "get", "tts.elevenlabs.voice", "--state-dir", scratch],
      { from: "user" },
    );

    expect(out.join("")).toBe("JBFqnCBsd6RMkjVDRZzb (default)\n");
  });
});

/**
 * AC 7's half that this command owns. Every invocation above — the argv refusal, the three ways in,
 * `get`, `list` with the key stored and with it in the environment, `unset`, the refusals of an
 * empty and a whitespace-laden key, and the unreadable `credentials.json` holding it — has been
 * recorded, and the key is in none of it. Declared last, so it reads what every other test wrote.
 */
describe("the key", () => {
  it("appears in no output of any verb", () => {
    expect(everything.length).toBeGreaterThan(40);
    for (const text of everything) {
      expect(text).not.toContain(KEY);
    }
  });
});
