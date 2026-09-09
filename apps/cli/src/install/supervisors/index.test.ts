/**
 * The seam itself: one adapter per supervisor, and the rules all three of them share.
 *
 * The per-platform suites assert what each artefact says. This one asserts what a *caller* can
 * count on without knowing which platform it is on — that a kind read out of `daemon.json` selects
 * the adapter for it, that the adapter's own `kind`, `platform`, `identity` and `artefactPath`
 * agree with the artefact it renders, and that all three refuse an incomplete launch contract
 * rather than each refusing something different.
 */

import { describe, expect, it } from "vitest";
import { SUPERVISOR_KINDS } from "../../daemon/daemon-state.js";
import type { LaunchSpec } from "../../runtime/launch-spec.js";
import {
  SUPERVISOR_ADAPTERS,
  SupervisorArtefactError,
  type SupervisorEnvironment,
  supervisorAdapter,
  supervisorKindForPlatform,
} from "./index.js";

const environment: SupervisorEnvironment = {
  home: "/home/alice",
  account: "WORKGROUP\\alice",
  localAppData: "C:\\Users\\alice\\AppData\\Local",
};

const spec: LaunchSpec = {
  executable: "/home/alice/.local/state/xplainer/runtime/1.2.3-abc/bin/node",
  argv: [
    "/home/alice/.local/state/xplainer/runtime/1.2.3-abc/lib/node_modules/@xplainer/cli/dist/bin.js",
    "serve",
    "--port",
    "8787",
    "--state-dir",
    "/home/alice/.local/state/xplainer",
    "--token-file",
    "/home/alice/.local/state/xplainer/token",
    "--socket",
    "/run/user/1000/xplainer/xplainer.sock",
  ],
  settings: {
    stateDir: "/home/alice/.local/state/xplainer",
    tokenFile: "/home/alice/.local/state/xplainer/token",
    socket: "/run/user/1000/xplainer/xplainer.sock",
  },
  cwd: "/home/alice/.local/state/xplainer",
};

describe("the supervisor adapters", () => {
  it("answers for every kind daemon.json can record", () => {
    for (const kind of SUPERVISOR_KINDS) {
      expect(supervisorAdapter(kind).kind).toBe(kind);
    }
    expect(Object.keys(SUPERVISOR_ADAPTERS).sort()).toEqual([...SUPERVISOR_KINDS].sort());
  });

  it("maps the three platforms, and says nothing about a fourth", () => {
    expect(supervisorKindForPlatform("linux")).toBe("systemd");
    expect(supervisorKindForPlatform("darwin")).toBe("launchd");
    expect(supervisorKindForPlatform("win32")).toBe("task-scheduler");
    expect(supervisorKindForPlatform("freebsd")).toBeNull();
  });

  it("renders an artefact that agrees with the adapter that made it", () => {
    for (const kind of SUPERVISOR_KINDS) {
      const adapter = supervisorAdapter(kind);
      const artefact = adapter.render(spec, environment);

      expect(artefact.kind).toBe(kind);
      expect(artefact.identity).toBe(adapter.identity(environment));
      expect(artefact.path).toBe(adapter.artefactPath(environment));
      expect(artefact.contents.endsWith("\n")).toBe(true);
      // Whatever the mode is, nobody but the owner may write the file a supervisor obeys.
      expect(artefact.mode & 0o022).toBe(0);
    }
  });

  it("carries every setting into every artefact, whatever form that platform has", () => {
    for (const kind of SUPERVISOR_KINDS) {
      const contents = supervisorAdapter(kind).render(spec, environment).contents;

      for (const value of Object.values(spec.settings)) {
        expect(contents).toContain(value);
      }
      expect(contents).toContain(spec.cwd);
      expect(contents).toContain(spec.executable);
    }
  });

  it("refuses the same incomplete contracts, on all three", () => {
    for (const kind of SUPERVISOR_KINDS) {
      const adapter = supervisorAdapter(kind);

      expect(() =>
        adapter.render({ ...spec, settings: { ...spec.settings, socket: "" } }, environment),
      ).toThrow(SupervisorArtefactError);
      expect(() => adapter.render({ ...spec, executable: "" }, environment)).toThrow(/executable/);
      expect(() => adapter.render({ ...spec, cwd: "" }, environment)).toThrow(/cwd/);
      expect(() => adapter.render({ ...spec, argv: [] }, environment)).toThrow(/argv/);
      expect(() => adapter.render({ ...spec, argv: spec.argv.slice(0, 4) }, environment)).toThrow(
        /--state-dir/,
      );
    }
  });

  it("refuses a value carrying a newline, which every one of the three is line-oriented about", () => {
    for (const kind of SUPERVISOR_KINDS) {
      expect(() =>
        supervisorAdapter(kind).render(
          { ...spec, cwd: "/home/alice\nExecStart=/bin/sh" },
          environment,
        ),
      ).toThrow(/control character/);
    }
  });
});
