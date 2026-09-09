/**
 * Running a payload, and refusing to.
 *
 * Two rules shape these assertions.
 *
 * **No mocking.** Every payload below is a real directory on disk with a real manifest in it, and
 * every run is a real spawned child: the fixture's `bin/node` is this process's own interpreter,
 * linked (or copied, where the platform will not link) into the payload's own layout, so
 * {@link runPayload} and {@link probePayloadStatus} exercise the same `spawn` the packaged app
 * makes rather than a stand-in for it.
 *
 * **Both incompatible hosts are asserted from a compatible one.** The wrong-platform and
 * wrong-architecture branches are the ones that matter — a mismatched interpreter cannot diagnose
 * itself — so the host is an argument, and a macOS arm64 machine can assert what a Windows x64 one
 * would have refused.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "vitest";
import {
  PACKAGED_PAYLOAD_DIRECTORY,
  PAYLOAD_CLI_ENTRY,
  payloadInterpreterEntry,
  RUNTIME_MANIFEST_FILE,
} from "./paths";
import {
  checkPayloadHost,
  currentHost,
  isWindowsBatchFile,
  type PayloadHost,
  type PayloadManifestFacts,
  PayloadRefusal,
  parseRuntimeManifest,
  probePayloadStatus,
  resolvePayloadCommand,
  runPayload,
  spawnPlan,
  startProgram,
} from "./spawn";

/** Every temporary tree these tests made, removed once. */
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A manifest that matches this machine, so a test can change exactly one field away from it. */
function manifestFor(host: PayloadHost): PayloadManifestFacts {
  return {
    platform: host.platform,
    arch: host.arch,
    launch: { interpreter: payloadInterpreterEntry(host.platform), entry: PAYLOAD_CLI_ENTRY },
  };
}

/** What {@link makePayload} may leave out or change. */
type PayloadFixture = {
  /** Overrides merged into the manifest document before it is written. */
  manifest?: Record<string, unknown> | undefined;
  /** Skip the manifest file entirely. */
  omitManifest?: boolean | undefined;
  /** Skip linking the interpreter into `bin/`. */
  omitInterpreter?: boolean | undefined;
  /** Write this text as `bin/node` instead of linking a real interpreter there. */
  interpreterSource?: string | undefined;
  /** Skip writing the CLI entry. */
  omitEntry?: boolean | undefined;
  /** The body of the fixture CLI entry. Runs under this process's own interpreter. */
  entrySource?: string | undefined;
};

/**
 * Build a packaged `Resources` directory holding one payload, and answer its resources path.
 *
 * The interpreter is symlinked where the platform allows it and copied where it does not: Windows
 * grants `CreateSymbolicLink` only to a developer-mode or elevated process, and a test that skipped
 * itself there would leave the branch this app spawns through unproven on the platform whose
 * interpreter has a different name.
 */
function makePayload(fixture: PayloadFixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), "xplainer-desktop-payload-"));
  roots.push(root);
  const resources = join(root, "Resources");
  const payload = join(resources, PACKAGED_PAYLOAD_DIRECTORY);

  if (fixture.omitInterpreter !== true) {
    const interpreter = join(payload, ...payloadInterpreterEntry().split("/"));
    mkdirSync(dirname(interpreter), { recursive: true });
    if (fixture.interpreterSource !== undefined) {
      writeFileSync(interpreter, fixture.interpreterSource);
    } else {
      try {
        symlinkSync(process.execPath, interpreter);
      } catch {
        copyFileSync(process.execPath, interpreter);
      }
    }
  }

  if (fixture.omitEntry !== true) {
    const entry = join(payload, ...PAYLOAD_CLI_ENTRY.split("/"));
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, fixture.entrySource ?? "process.stdout.write('{}');\n");
  }

  if (fixture.omitManifest !== true) {
    mkdirSync(payload, { recursive: true });
    const host = currentHost();
    writeFileSync(
      join(payload, RUNTIME_MANIFEST_FILE),
      JSON.stringify(
        {
          kind: "runtime",
          manifest_version: 1,
          created_at: new Date().toISOString(),
          platform: host.platform,
          arch: host.arch,
          node_version: process.version,
          npm_version: "11.0.0",
          host: "node",
          launch: {
            interpreter: payloadInterpreterEntry(host.platform),
            entry: PAYLOAD_CLI_ENTRY,
            npm_cli: "lib/node_modules/npm/bin/npm-cli.js",
            argv: [payloadInterpreterEntry(host.platform), PAYLOAD_CLI_ENTRY],
          },
          packages: [],
          files: [],
          links: [],
          ...fixture.manifest,
        },
        null,
        2,
      ),
    );
  }

  return resources;
}

describe("parseRuntimeManifest", () => {
  const file = "/payload/runtime.manifest.json";

  it("reads the platform, the architecture and the launch contract", () => {
    const facts = parseRuntimeManifest(
      JSON.stringify({
        kind: "runtime",
        platform: "win32",
        arch: "x64",
        launch: { interpreter: "bin/node.exe", entry: PAYLOAD_CLI_ENTRY, npm_cli: "x", argv: [] },
      }),
      file,
    );

    expect(facts).toEqual({
      platform: "win32",
      arch: "x64",
      launch: { interpreter: "bin/node.exe", entry: PAYLOAD_CLI_ENTRY },
    });
  });

  it("refuses text that is not JSON, an array, or a document of another kind", () => {
    expect(() => parseRuntimeManifest("not json", file)).toThrow(/is not JSON/);
    expect(() => parseRuntimeManifest("[]", file)).toThrow(/is not a JSON object/);
    expect(() => parseRuntimeManifest('{"kind":"workspace"}', file)).toThrow(
      /records kind "workspace"/,
    );
  });

  it("names the field that is missing rather than throwing a TypeError later", () => {
    expect(() => parseRuntimeManifest('{"kind":"runtime","arch":"arm64"}', file)).toThrow(
      /no string `platform`/,
    );
    expect(() =>
      parseRuntimeManifest('{"kind":"runtime","platform":"darwin","arch":"arm64"}', file),
    ).toThrow(/no `launch` object/);
    expect(() =>
      parseRuntimeManifest(
        '{"kind":"runtime","platform":"darwin","arch":"arm64","launch":{"entry":"x"}}',
        file,
      ),
    ).toThrow(/no string `launch.interpreter`/);
  });

  it("carries the named reason on the refusal it throws", () => {
    try {
      parseRuntimeManifest("not json", file);
      expect.unreachable("an unparseable manifest must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadRefusal);
      expect((error as PayloadRefusal).reason).toBe("manifest-unreadable");
    }
  });
});

describe("checkPayloadHost", () => {
  it("accepts a payload assembled for this machine", () => {
    const host = currentHost();
    expect(checkPayloadHost(manifestFor(host), host)).toBeNull();
  });

  it("refuses another operating system by name", () => {
    const host: PayloadHost = { platform: "darwin", arch: "arm64" };
    const refusal = checkPayloadHost(manifestFor({ platform: "win32", arch: "arm64" }), host);

    expect(refusal?.reason).toBe("wrong-platform");
    expect(refusal?.message).toMatch(/assembled on win32 and this machine is darwin/);
  });

  it("refuses another architecture by name, which is the check an interpreter cannot self-serve", () => {
    const host: PayloadHost = { platform: "darwin", arch: "x64" };
    const refusal = checkPayloadHost(manifestFor({ platform: "darwin", arch: "arm64" }), host);

    expect(refusal?.reason).toBe("wrong-arch");
    expect(refusal?.message).toMatch(/carries a arm64 interpreter and this machine is x64/);
  });

  it("refuses a launch contract that does not name the files this app spawns", () => {
    const host: PayloadHost = { platform: "linux", arch: "x64" };
    const moved = manifestFor(host);

    expect(
      checkPayloadHost({ ...moved, launch: { ...moved.launch, interpreter: "bin/nodejs" } }, host)
        ?.reason,
    ).toBe("layout-mismatch");
    expect(
      checkPayloadHost({ ...moved, launch: { ...moved.launch, entry: "lib/bin.js" } }, host)
        ?.reason,
    ).toBe("layout-mismatch");
  });

  it("expects node.exe from a Windows payload and node from a POSIX one", () => {
    const windows: PayloadHost = { platform: "win32", arch: "x64" };
    const posix: PayloadHost = { platform: "linux", arch: "x64" };

    expect(checkPayloadHost(manifestFor(windows), windows)).toBeNull();
    expect(checkPayloadHost(manifestFor(posix), posix)).toBeNull();
    expect(checkPayloadHost({ ...manifestFor(windows), platform: "win32" }, posix)?.reason).toBe(
      "wrong-platform",
    );
  });
});

describe("resolvePayloadCommand", () => {
  it("answers the payload's own interpreter and entry", () => {
    const resources = makePayload();
    const command = resolvePayloadCommand(resources);

    expect(command.root).toBe(join(resources, PACKAGED_PAYLOAD_DIRECTORY));
    expect(command.executable).toBe(join(command.root, ...payloadInterpreterEntry().split("/")));
    expect(command.entry).toBe(join(command.root, ...PAYLOAD_CLI_ENTRY.split("/")));
    expect(existsSync(command.executable)).toBe(true);
  });

  it("reports an unpackaged build as an absent payload rather than as a crash", () => {
    const resources = makePayload({ omitManifest: true });

    try {
      resolvePayloadCommand(resources);
      expect.unreachable("a payload with no manifest must be refused");
    } catch (error) {
      expect((error as PayloadRefusal).reason).toBe("payload-absent");
      expect((error as PayloadRefusal).message).toMatch(/carries no runtime\.manifest\.json/);
    }
  });

  it("refuses a wrong-architecture payload before it spawns anything", () => {
    const other = currentHost().arch === "arm64" ? "x64" : "arm64";
    const resources = makePayload({ manifest: { arch: other } });

    try {
      resolvePayloadCommand(resources);
      expect.unreachable("a payload for another architecture must be refused");
    } catch (error) {
      expect((error as PayloadRefusal).reason).toBe("wrong-arch");
      expect((error as PayloadRefusal).message).toContain(other);
    }
  });

  it("names a manifest that describes files the payload does not carry", () => {
    const missingInterpreter = makePayload({ omitInterpreter: true });
    const missingEntry = makePayload({ omitEntry: true });

    try {
      resolvePayloadCommand(missingInterpreter);
      expect.unreachable("a payload with no interpreter must be refused");
    } catch (error) {
      expect((error as PayloadRefusal).reason).toBe("interpreter-missing");
    }
    try {
      resolvePayloadCommand(missingEntry);
      expect.unreachable("a payload with no entry must be refused");
    } catch (error) {
      expect((error as PayloadRefusal).reason).toBe("entry-missing");
    }
  });
});

/**
 * The one program on any platform that cannot be executed without an interpreter.
 *
 * `daemon install` writes the stable launcher as `<state>\\bin\\xplainer.cmd`, and since the fix
 * for CVE-2024-27980 Node refuses to `spawn` a `.cmd` without a shell. Measured on
 * `windows-latest`, 2026-09-08: three one-click controls and one discovery answered
 * `command-failed` — "`…\\bin\\xplainer.cmd` would not run: spawn EINVAL" — so the app worked
 * with nothing installed and stopped the moment an install had happened. The branch is asserted
 * from macOS the way every other Windows branch in this file is: by naming the platform.
 */
describe("spawnPlan", () => {
  const LAUNCHER = "C:\\Users\\Ada Lovelace\\AppData\\Local\\xplainer\\state\\bin\\xplainer.cmd";

  it("runs a Windows .cmd through cmd.exe, quoting every token itself", () => {
    const plan = spawnPlan(LAUNCHER, ["connect", "claude"], "win32", { ComSpec: "C:\\W\\cmd.exe" });

    expect(plan.executable).toBe("C:\\W\\cmd.exe");
    // `/d` skips any AutoRun the registry carries; `/s` makes "strip the outer quotes, take the
    // rest verbatim" the parsing rule, which is what lets the launcher's own path hold a space.
    expect(plan.argv).toEqual(["/d", "/s", "/c", `""${LAUNCHER}" "connect" "claude""`]);
    // Node's own escaping would quote these quotes, so the command line goes through untouched.
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it("falls back to cmd.exe by name when the environment names no interpreter", () => {
    expect(spawnPlan(LAUNCHER, [], "win32", {}).executable).toBe("cmd.exe");
  });

  it("is the identity for every program that is not a Windows batch file", () => {
    for (const [executable, platform] of [
      ["C:\\app\\xplainer-runtime\\bin\\node.exe", "win32"],
      ["/Applications/Xplainer.app/Contents/Resources/xplainer-runtime/bin/node", "darwin"],
      ["/home/ada/.local/state/xplainer/bin/xplainer", "linux"],
      // A POSIX file that merely ends in `.cmd` is not a batch file, and nothing here pretends it.
      ["/home/ada/xplainer.cmd", "linux"],
    ] as const) {
      const plan = spawnPlan(executable, ["status", "--json"], platform);

      expect(plan).toEqual({
        executable,
        argv: ["status", "--json"],
        windowsVerbatimArguments: false,
      });
      expect(isWindowsBatchFile(executable, platform)).toBe(false);
    }
    expect(isWindowsBatchFile(LAUNCHER, "win32")).toBe(true);
    expect(isWindowsBatchFile("C:\\x\\install.BAT", "win32")).toBe(true);
  });

  /**
   * `cmd.exe` expands `%NAME%` in a command line before the batch file sees it and there is no
   * escape for that from outside a batch file, so the path is refused by name rather than run as a
   * different path than the one this app resolved.
   */
  it("refuses a token cmd.exe would re-parse or expand", () => {
    for (const argument of ["C:\\x\\50%off\\xplainer.cmd", 'C:\\x\\"q".cmd']) {
      expect(() => spawnPlan(argument, [], "win32")).toThrow(RangeError);
    }
    expect(() => spawnPlan(LAUNCHER, ["%PATH%"], "win32")).toThrow(/percent sign/);
  });

  /**
   * And `startProgram` — the app's only `spawn` — actually uses it. The child cannot start on any
   * machine, which is the point: what is asserted is the image and the command line Node was given,
   * which `spawnfile` and `spawnargs` carry whether or not the process ever existed.
   *
   * **The interpreter is named as a path no machine has, and that is load-bearing rather than
   * incidental.** This test used to name `C:\\Windows\\System32\\cmd.exe` and wait for the `error`
   * that a missing image raises. On a POSIX host that path is missing and the event arrives at
   * once; on `windows-latest` it is the real `cmd.exe`, so the child *started*, printed "The system
   * cannot find the path specified." for a launcher this fixture never wrote, exited — and raised
   * no `error` at all, leaving the promise below unresolved. Measured on `windows-latest`,
   * 2026-09-08, `desktop.yml` run 34304160979: "Test timed out in 5000ms". `ComSpec` is therefore
   * an absent path everywhere, which makes `ENOENT` a property of the argument rather than of the
   * host running the suite.
   */
  it("is what startProgram spawns, rather than the batch file itself", async () => {
    const absentInterpreter = "C:\\xplainer-no-such-directory\\cmd.exe";
    const child = startProgram(LAUNCHER, ["daemon", "install"], {
      platform: "win32",
      env: { ComSpec: absentInterpreter },
    });
    const failure = await new Promise<NodeJS.ErrnoException>((resolve) => {
      child.on("error", resolve);
    });

    expect(child.spawnfile).toBe(absentInterpreter);
    expect(child.spawnargs.slice(1)).toEqual([
      "/d",
      "/s",
      "/c",
      `""${LAUNCHER}" "daemon" "install""`,
    ]);
    // There is no such interpreter on any machine, and that is the only reason it failed.
    expect(failure.code).toBe("ENOENT");
  });
});

describe("runPayload", () => {
  it("spawns the payload's interpreter with the entry as its first argument", async () => {
    const resources = makePayload({
      entrySource:
        "process.stdout.write(JSON.stringify({ argv0: process.argv0, execPath: process.execPath, argv: process.argv.slice(1) }));\n",
    });
    const command = resolvePayloadCommand(resources);

    const run = await runPayload(command, ["status", "--json"]);

    expect(run.code).toBe(0);
    const observed: { argv0: string; execPath: string; argv: string[] } = JSON.parse(run.stdout);
    expect(observed.argv).toEqual([command.entry, "status", "--json"]);
    // **`argv0`, because that is what D10 is a claim about**: the path the parent named when it
    // spawned. It is the payload's own `bin/node` on every platform, whether this fixture linked
    // the interpreter there or copied it.
    expect(observed.argv0).toBe(command.executable);
    // And the file behind that path is the interpreter itself rather than something beside it.
    // `realpathSync` on **both** sides, which is the correction of 2026-09-08: comparing the
    // child's `execPath` with `realpathSync(command.executable)` was a POSIX-only identity. There a
    // symlinked `bin/node` makes the child report the link's target; on Windows the fixture hard
    // links instead, the child reports the path it was spawned as, and `GetFinalPathNameByHandle`
    // answers `realpath` with the *other* name of the same file — so the two sides were two
    // different true statements about one binary. Measured on `windows-latest`, 2026-09-08:
    // `C:\Users\RUNNER~1\…\xplainer-runtime\bin\node.exe` against
    // `C:\hostedtoolcache\windows\node\24.20.0\x64\node.exe`.
    expect(realpathSync(observed.execPath)).toBe(realpathSync(command.executable));
  });

  it("returns a non-zero exit code and stderr as data rather than throwing", async () => {
    const resources = makePayload({
      entrySource: "process.stderr.write('refused\\n');\nprocess.exit(3);\n",
    });

    const run = await runPayload(resolvePayloadCommand(resources), []);

    expect(run.code).toBe(3);
    expect(run.stderr).toBe("refused\n");
  });

  it("kills a child that never exits, instead of hanging the caller", async () => {
    const resources = makePayload({
      entrySource: "setInterval(() => {}, 1000);\n",
    });

    const run = await runPayload(resolvePayloadCommand(resources), [], { timeoutMs: 250 });

    expect(run.code).toBe(null);
    expect(run.signal).toBe("SIGKILL");
  });

  it("does not put ELECTRON_RUN_AS_NODE into the child's environment", async () => {
    const resources = makePayload({
      entrySource: "process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE ?? 'unset'));\n",
    });

    const run = await runPayload(resolvePayloadCommand(resources), []);

    expect(run.stdout).toBe("unset");
  });
});

describe("probePayloadStatus", () => {
  it("reports the interpreter it spawned and the condition status --json answered with", async () => {
    const resources = makePayload({
      entrySource:
        "process.stdout.write(JSON.stringify({ schema_version: 1, condition: 'absent' }));\nprocess.exit(4);\n",
    });

    const probe = await probePayloadStatus(resources);

    expect(probe).toEqual({
      event: "payload_probe",
      interpreter: join(
        resources,
        PACKAGED_PAYLOAD_DIRECTORY,
        ...payloadInterpreterEntry().split("/"),
      ),
      entry: join(resources, PACKAGED_PAYLOAD_DIRECTORY, ...PAYLOAD_CLI_ENTRY.split("/")),
      argv: ["status", "--json"],
      exit_code: 4,
      condition: "absent",
    });
  });

  it("reports a null condition when the command wrote something that is not one JSON object", async () => {
    const resources = makePayload({ entrySource: "process.stdout.write('not json at all');\n" });

    const probe = await probePayloadStatus(resources);

    expect(probe).toMatchObject({ event: "payload_probe", exit_code: 0, condition: null });
  });

  it("names an interpreter the operating system refused to start, rather than rejecting", async () => {
    // What a packaging step that dropped the execute bit leaves behind: every path the checks
    // look at is present, and `execve` still says no.
    const probe = await probePayloadStatus(makePayload({ interpreterSource: "not a binary\n" }));

    expect(probe.event).toBe("payload_unavailable");
    expect(probe).toMatchObject({ reason: "spawn-failed" });
  });

  it("turns a refusal into a line the app can print instead of a thrown error", async () => {
    const probe = await probePayloadStatus(makePayload({ omitManifest: true }));

    expect(probe.event).toBe("payload_unavailable");
    expect(probe).toMatchObject({ reason: "payload-absent" });
  });
});
