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
import { PACKAGED_PAYLOAD_DIRECTORY, PAYLOAD_CLI_ENTRY, payloadInterpreterEntry } from "./paths";
import {
  checkPayloadHost,
  currentHost,
  type PayloadHost,
  type PayloadManifestFacts,
  PayloadRefusal,
  parseRuntimeManifest,
  probePayloadStatus,
  resolvePayloadCommand,
  runPayload,
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
      join(payload, "runtime.manifest.json"),
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

describe("runPayload", () => {
  it("spawns the payload's interpreter with the entry as its first argument", async () => {
    const resources = makePayload({
      entrySource:
        "process.stdout.write(JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(1) }));\n",
    });
    const command = resolvePayloadCommand(resources);

    const run = await runPayload(command, ["status", "--json"]);

    expect(run.code).toBe(0);
    const observed: { execPath: string; argv: string[] } = JSON.parse(run.stdout);
    expect(observed.argv).toEqual([command.entry, "status", "--json"]);
    // Through `realpathSync`, because this fixture's `bin/node` is a link to the interpreter
    // running the test and a child reports the file it actually executed. A shipped payload copies
    // its interpreter, so there the two paths are the same string.
    expect(observed.execPath).toBe(realpathSync(command.executable));
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
