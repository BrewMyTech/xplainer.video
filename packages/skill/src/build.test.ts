import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "@xplainer/protocol";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What these tests guard.
 *
 * The two bundles are published artefacts: once a marketplace has fetched one,
 * a broken manifest is a broken install for everybody who has it, and there is
 * no runtime that would have caught it first. So every assertion below is about
 * the bytes the build actually emits — the build is run into a temporary
 * directory and the output is read back — rather than about the sources it was
 * given.
 *
 * The subset assertion at the bottom is the one that catches the failure nobody
 * would notice: a SKILL.md that tells the agent to call a tool the protocol
 * does not define. The agent would follow the instruction, the call would fail,
 * and the skill would look broken for a reason no test in the MCP server or the
 * protocol package can see.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "build.mjs");

/** Every file AC-10a requires the build to write, relative to the output root. */
const EXPECTED_FILES = [
  "claude-plugin/.claude-plugin/plugin.json",
  "claude-plugin/.claude-plugin/marketplace.json",
  "claude-plugin/.mcp.json",
  "claude-plugin/skills/xplainer/SKILL.md",
  "codex-plugin/.codex-plugin/plugin.json",
  "codex-plugin/.mcp.json",
  "codex-plugin/skills/xplainer/SKILL.md",
];

/**
 * The one server declaration both bundles exist to carry.
 *
 * It is a LOCAL stdio server, not a URL. The bundles used to declare
 * `{"type":"http","url":"https://mcp.xplainer.video/mcp"}`; that endpoint was
 * served by the hosted tier, which has been relocated to the private
 * BrewMyTech/xplainer-hosted repository, so publishing it here would ship an
 * install that silently does nothing. A marketplace fetch is not retractable,
 * which is why this is asserted against the emitted bytes.
 */
const MCP_SERVER = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@xplainer/cli", "mcp"],
};

/** Keys that only a remote, OAuth-protected resource server would need. */
const HOSTED_ONLY_KEYS = ["url", "oauth_resource"];

/** `explainer_create`, `explainer_put_source`, and so on — anywhere in the prose. */
const TOOL_MENTION = /\bexplainer_[a-z0-9_]+/g;

type JsonObject = Record<string, unknown>;

let outRoot: string;

/** Run the real build entry point, exactly as the `build` script does. */
function runBuild(target: string): string {
  return execFileSync(process.execPath, [BUILD_SCRIPT, target], { encoding: "utf8" });
}

function readText(relative: string): string {
  return readFileSync(path.join(outRoot, relative), "utf8");
}

function readBytes(relative: string): Buffer {
  return readFileSync(path.join(outRoot, relative));
}

function readJson(relative: string): JsonObject {
  return JSON.parse(readText(relative)) as JsonObject;
}

function readSourceBytes(relative: string): Buffer {
  return readFileSync(path.join(PACKAGE_ROOT, relative));
}

/** The version every emitted manifest must agree on. */
const packageVersion = (
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;

/**
 * One Ajv instance holding both vendored schemas.
 *
 * `format: "uri"` and `format: "email"` come from ajv-formats; without it the
 * URL fields would be checked for being strings and nothing else.
 */
function buildAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const name of ["claude-plugin", "codex-plugin"]) {
    ajv.addSchema(
      JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "schemas", `${name}.schema.json`), "utf8")),
      name,
    );
  }
  return ajv;
}

/** Validate `document` against the named vendored schema, reporting why if it fails. */
function validate(schemaName: string, document: unknown): { valid: boolean; errors: string } {
  const ajv = buildAjv();
  const compiled = ajv.getSchema(schemaName);
  if (compiled === undefined) {
    throw new Error(`${schemaName} is not a registered schema`);
  }
  // `=== true` rather than a cast: Ajv types a validator as possibly async, and
  // an async one returns a promise, which is truthy whatever the document says.
  const valid = compiled(document) === true;
  return { valid, errors: ajv.errorsText(compiled.errors) };
}

beforeAll(() => {
  outRoot = mkdtempSync(path.join(tmpdir(), "xplainer-skill-"));
  runBuild(outRoot);
});

afterAll(() => {
  rmSync(outRoot, { recursive: true, force: true });
});

describe("the built bundles", () => {
  it("writes every file a Claude bundle and a Codex bundle need to load", () => {
    for (const relative of EXPECTED_FILES) {
      expect(() => readBytes(relative), `${relative} was not written`).not.toThrow();
    }
  });

  it("clears the previous build, so a manifest deleted from source stops shipping", () => {
    const stale = path.join(outRoot, "claude-plugin", "skills", "xplainer", "REMOVED.md");
    mkdirSync(path.dirname(stale), { recursive: true });
    writeFileSync(stale, "left over from an older build\n");

    runBuild(outRoot);

    expect(() => readFileSync(stale)).toThrow();
    for (const relative of EXPECTED_FILES) {
      expect(() => readBytes(relative), `${relative} vanished on rebuild`).not.toThrow();
    }
  });

  it("stamps both plugin manifests with the package version, so npm and the marketplaces agree", () => {
    expect(readJson("claude-plugin/.claude-plugin/plugin.json").version).toBe(packageVersion);
    expect(readJson("codex-plugin/.codex-plugin/plugin.json").version).toBe(packageVersion);
  });

  it("ships one SKILL.md, byte for byte, in both bundles", () => {
    const source = readSourceBytes("SKILL.md");
    expect(Buffer.compare(readBytes("claude-plugin/skills/xplainer/SKILL.md"), source)).toBe(0);
    expect(Buffer.compare(readBytes("codex-plugin/skills/xplainer/SKILL.md"), source)).toBe(0);
  });
});

describe("the manifests", () => {
  it("emits a Claude plugin manifest that satisfies the vendored schema", () => {
    const result = validate("claude-plugin", readJson("claude-plugin/.claude-plugin/plugin.json"));
    expect(result.errors).toBe("No errors");
    expect(result.valid).toBe(true);
  });

  it("emits a Codex plugin manifest that satisfies the vendored schema", () => {
    const result = validate("codex-plugin", readJson("codex-plugin/.codex-plugin/plugin.json"));
    expect(result.errors).toBe("No errors");
    expect(result.valid).toBe(true);
  });

  it("rejects a manifest that lost a required field, so neither schema is vacuous", () => {
    const claude = readJson("claude-plugin/.claude-plugin/plugin.json");
    const codex = readJson("codex-plugin/.codex-plugin/plugin.json");
    const without = (document: JsonObject, key: string): JsonObject => {
      const copy = { ...document };
      delete copy[key];
      return copy;
    };

    expect(validate("claude-plugin", without(claude, "name")).valid).toBe(false);
    expect(validate("claude-plugin", without(claude, "version")).valid).toBe(false);
    expect(validate("codex-plugin", without(codex, "mcpServers")).valid).toBe(false);
    expect(validate("codex-plugin", without(codex, "interface")).valid).toBe(false);
    expect(validate("codex-plugin", { ...codex, version: "not-a-version" }).valid).toBe(false);
  });

  it("points the Codex manifest at the sibling .mcp.json and the skills directory it ships", () => {
    const codex = readJson("codex-plugin/.codex-plugin/plugin.json");
    expect(codex.mcpServers).toBe("./.mcp.json");
    expect(codex.skills).toBe("./skills/");
  });

  it("lists the plugin in the Claude marketplace under the same name and version", () => {
    const plugin = readJson("claude-plugin/.claude-plugin/plugin.json");
    const marketplace = readJson("claude-plugin/.claude-plugin/marketplace.json") as {
      plugins: JsonObject[];
    };
    expect(marketplace.plugins).toHaveLength(1);
    const [listed] = marketplace.plugins;
    if (listed === undefined) {
      throw new Error("marketplace.json lists no plugins");
    }
    expect(listed.name).toBe(plugin.name);
    expect(listed.version).toBe(packageVersion);
    expect(listed.source).toBe("./");
  });
});

describe("the MCP declaration", () => {
  it("points both bundles at the local daemon over stdio", () => {
    for (const relative of ["claude-plugin/.mcp.json", "codex-plugin/.mcp.json"]) {
      const servers = readJson(relative).mcpServers as Record<string, JsonObject>;
      expect(Object.keys(servers), `${relative} declares more than one server`).toEqual([
        "xplainer",
      ]);
      const { xplainer } = servers;
      if (xplainer === undefined) {
        throw new Error(`${relative} declares no xplainer server`);
      }
      expect(xplainer.type, `${relative} transport`).toBe(MCP_SERVER.type);
      expect(xplainer.command, `${relative} command`).toBe(MCP_SERVER.command);
      expect(xplainer.args, `${relative} args`).toEqual(MCP_SERVER.args);
    }
  });

  it("declares nothing that would send a client at a remote endpoint", () => {
    for (const relative of ["claude-plugin/.mcp.json", "codex-plugin/.mcp.json"]) {
      const servers = readJson(relative).mcpServers as Record<string, JsonObject>;
      const { xplainer } = servers;
      if (xplainer === undefined) {
        throw new Error(`${relative} declares no xplainer server`);
      }
      for (const key of HOSTED_ONLY_KEYS) {
        expect(Object.keys(xplainer), `${relative} still declares ${key}`).not.toContain(key);
      }
    }
  });

  it("copies each .mcp.json verbatim, so the reviewed file is the published one", () => {
    expect(
      Buffer.compare(
        readBytes("claude-plugin/.mcp.json"),
        readSourceBytes("claude-plugin/.mcp.json"),
      ),
    ).toBe(0);
    expect(
      Buffer.compare(
        readBytes("codex-plugin/.mcp.json"),
        readSourceBytes("codex-plugin/.mcp.json"),
      ),
    ).toBe(0);
  });
});

describe("SKILL.md against the protocol", () => {
  const mentioned = (): string[] => {
    const text = readSourceBytes("SKILL.md").toString("utf8");
    return [...new Set(text.match(TOOL_MENTION) ?? [])].sort();
  };

  it("names only tools the protocol defines", () => {
    const names = mentioned();
    expect(names.length, "SKILL.md mentions no tools at all").toBeGreaterThan(0);
    const contract = new Set<string>(TOOL_NAMES);
    expect(names.filter((name) => !contract.has(name))).toEqual([]);
  });

  it("documents every tool the protocol defines, so no tool ships undescribed", () => {
    expect(mentioned()).toEqual([...TOOL_NAMES].sort());
  });

  it("tells the agent to prefer a local backend when one is present", () => {
    const text = readSourceBytes("SKILL.md").toString("utf8");
    expect(text).toContain("Prefer the local tools when they are present");
  });
});
