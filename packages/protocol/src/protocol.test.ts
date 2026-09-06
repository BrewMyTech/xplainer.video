import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ENGINE_OWNED_FILES, TOOL_NAMES } from "./index.js";

/**
 * These tests guard the contract itself, not the code that reads it.
 *
 * `schemas/` is the source of truth for every surface that speaks the protocol,
 * and the two generated bindings are only as good as the schemas they came
 * from. So the assertions here are about the schemas: that they compile, that
 * the manifest and the generated tuple agree, that the eight names are the eight
 * names the spec fixed, and that the two places where this contract deliberately
 * diverges from max stay diverged.
 */

const SCHEMAS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");

/** The eight tools, spelled out once. Spec §Constraints/Contract, plan AC-9b. */
const CONTRACT_TOOL_NAMES = [
  "explainer_create",
  "explainer_put_source",
  "explainer_put_media",
  "explainer_narrate",
  "explainer_still",
  "explainer_render",
  "explainer_job",
  "explainer_list",
];

/** The three tools that queue work and answer with the same job envelope. */
const QUEUEING_TOOLS = ["explainer_narrate", "explainer_still", "explainer_render"];

/**
 * The five scaffold files the engine owns, spelled out once. ADR 0018.
 *
 * They mount the narration audio, the caption track and the per-segment
 * sequencing, so an agent that rewrote one could ship a video that renders
 * successfully and is silent. Written out here rather than read from the
 * manifest for the same reason CONTRACT_TOOL_NAMES is: a test that derives its
 * expectation from the file under test proves nothing.
 */
const ENGINE_OWNED = ["index.ts", "types.ts", "Root.tsx", "Captions.tsx", "Video.tsx"];

type JsonObject = Record<string, unknown>;

type ManifestTool = {
  name: string;
  title: string;
  description: string;
  input: { $ref: string };
  output: { $ref: string };
};

type Manifest = {
  name: string;
  version: string;
  engine_owned_files: string[];
  tools: ManifestTool[];
};

function readJson(relative: string): JsonObject {
  return JSON.parse(readFileSync(path.join(SCHEMAS_DIR, relative), "utf8")) as JsonObject;
}

function exists(relative: string): boolean {
  try {
    readFileSync(path.join(SCHEMAS_DIR, relative), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Every schema file, keyed by its path relative to `schemas/`. `manifest.json` is data, not a schema. */
function schemaFiles(): string[] {
  const shared = readdirSync(SCHEMAS_DIR).filter(
    (name) => name.endsWith(".json") && name !== "manifest.json",
  );
  const tools = readdirSync(path.join(SCHEMAS_DIR, "tools"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.posix.join("tools", name));
  return [...shared, ...tools].sort();
}

const manifest = readJson("manifest.json") as unknown as Manifest;

/**
 * A base URI for the schema set.
 *
 * Ajv resolves a `$ref` against the id it was given, and relative ids do not
 * give `../slug.json` anything to resolve against. Registering each schema under
 * an absolute id whose path mirrors its path under `schemas/` makes the
 * cross-file references resolve exactly as they do on disk. Nothing is fetched:
 * every id is already in the instance.
 */
const SCHEMA_BASE = "https://schemas.xplainer.video/";

/** One Ajv instance holding every schema, so cross-file `$ref`s resolve. */
function buildAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const relative of schemaFiles()) {
    ajv.addSchema(readJson(relative), SCHEMA_BASE + relative);
  }
  return ajv;
}

/** The compiled validator for one schema, by its path relative to `schemas/`. */
function validator(relative: string) {
  const validate = buildAjv().getSchema(SCHEMA_BASE + relative);
  if (validate === undefined) {
    throw new Error(`${relative} is not a registered schema`);
  }
  return validate;
}

describe("the schema set", () => {
  it("compiles every schema under draft 2020-12, cross-file references included", () => {
    const ajv = buildAjv();
    for (const relative of schemaFiles()) {
      expect(ajv.getSchema(SCHEMA_BASE + relative), `${relative} failed to compile`).toBeTypeOf(
        "function",
      );
    }
  });

  it("holds an input and an output schema for each of the eight tools", () => {
    const toolSchemas = readdirSync(path.join(SCHEMAS_DIR, "tools")).sort();
    const expected = CONTRACT_TOOL_NAMES.flatMap((name) => [
      `${name}.input.json`,
      `${name}.output.json`,
    ]).sort();
    expect(toolSchemas).toEqual(expected);
  });

  it("gives every schema a unique title, because titles become type names in both languages", () => {
    const titles = schemaFiles().map((relative) => readJson(relative).title);
    expect(titles.every((title) => typeof title === "string")).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("the manifest", () => {
  it("declares exactly the eight tools the contract fixes, in contract order", () => {
    expect(manifest.tools.map((tool) => tool.name)).toEqual(CONTRACT_TOOL_NAMES);
  });

  it("points every input and output reference at a schema file that exists", () => {
    for (const tool of manifest.tools) {
      expect(tool.input.$ref, `${tool.name} input`).toBe(`tools/${tool.name}.input.json`);
      expect(tool.output.$ref, `${tool.name} output`).toBe(`tools/${tool.name}.output.json`);
      expect(exists(tool.input.$ref), `${tool.input.$ref} is missing`).toBe(true);
      expect(exists(tool.output.$ref), `${tool.output.$ref} is missing`).toBe(true);
    }
  });

  it("names exactly the five engine-owned scaffold files, in scaffold order", () => {
    expect(manifest.engine_owned_files).toEqual(ENGINE_OWNED);
  });

  it("gives every tool a title and a one-line description for the agent-facing surfaces", () => {
    for (const tool of manifest.tools) {
      expect(tool.title.length, `${tool.name} title`).toBeGreaterThan(0);
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(0);
      expect(tool.description.includes("\n"), `${tool.name} description is multi-line`).toBe(false);
    }
  });
});

describe("TOOL_NAMES", () => {
  it("repeats the manifest order exactly, so no surface can drift from the contract", () => {
    expect([...TOOL_NAMES]).toEqual(manifest.tools.map((tool) => tool.name));
  });

  it("is frozen, so a consumer cannot reorder or extend the contract at runtime", () => {
    expect(Object.isFrozen(TOOL_NAMES)).toBe(true);
  });
});

describe("ENGINE_OWNED_FILES", () => {
  it("repeats the manifest list exactly, so no surface can enforce a different one", () => {
    expect([...ENGINE_OWNED_FILES]).toEqual(manifest.engine_owned_files);
  });

  it("is frozen, so a consumer cannot widen or narrow what an agent may write", () => {
    expect(Object.isFrozen(ENGINE_OWNED_FILES)).toBe(true);
  });
});

describe("schema behaviour", () => {
  it("accepts a well-formed explainer_create input", () => {
    const validate = validator("tools/explainer_create.input.json");
    expect(validate({ slug: "how-dns-works" })).toBe(true);
  });

  it("rejects a slug with an uppercase letter, a leading hyphen, or an unknown extra field", () => {
    const validate = validator("tools/explainer_create.input.json");
    expect(validate({ slug: "How-DNS-Works" })).toBe(false);
    expect(validate({ slug: "-leading-hyphen" })).toBe(false);
    expect(validate({ slug: "ok", session_name: "sneaky" })).toBe(false);
  });

  it("requires at least one narration segment, because a narration with none produces no audio", () => {
    const validate = validator("tools/explainer_narrate.input.json");
    expect(validate({ slug: "ok", narration: { segments: [{ id: "hook", text: "Hi." }] } })).toBe(
      true,
    );
    expect(validate({ slug: "ok", narration: { segments: [] } })).toBe(false);
  });

  it("refuses a source path that escapes the video directory", () => {
    const validate = validator("tools/explainer_put_source.input.json");
    const write = (filePath: string) => ({
      slug: "ok",
      files: [{ path: filePath, content: "x" }],
    });
    expect(validate(write("scenes/Intro.tsx"))).toBe(true);
    expect(validate(write("../../etc/passwd"))).toBe(false);
    expect(validate(write("/etc/passwd"))).toBe(false);
  });

  it("refuses a write to an engine-owned path, and allows scenes/Root.tsx", () => {
    const validate = validator("tools/explainer_put_source.input.json");
    const write = (filePath: string) => ({
      slug: "ok",
      files: [{ path: filePath, content: "x" }],
    });
    for (const reserved of ENGINE_OWNED) {
      expect(validate(write(reserved)), `${reserved} should be refused`).toBe(false);
    }
    // Only the exact top-level names are reserved. A scene component that
    // happens to be called Root.tsx is the agent's file and stays writable.
    expect(validate(write("scenes/Root.tsx"))).toBe(true);
    expect(validate(write("scenes/Video.tsx"))).toBe(true);
    expect(validate(write("Scenes.tsx"))).toBe(true);
  });

  it("reserves exactly the manifest's engine-owned list, so the two cannot drift", () => {
    const defs = readJson("tools/explainer_put_source.input.json").$defs as JsonObject;
    const sourceFile = defs.SourceFile as JsonObject;
    const pathSchema = (sourceFile.properties as JsonObject).path as JsonObject;
    expect((pathSchema.not as JsonObject).enum).toEqual(manifest.engine_owned_files);
  });

  it("gives the three queueing tools one identical output envelope", () => {
    const envelopes = QUEUEING_TOOLS.map((name) => readJson(`tools/${name}.output.json`));
    const shapeOf = (schema: JsonObject) => ({
      required: schema.required,
      properties: schema.properties,
    });
    for (const envelope of envelopes.slice(1)) {
      expect(shapeOf(envelope)).toEqual(shapeOf(envelopes[0] as JsonObject));
    }
  });
});

describe("the deliberate divergences from max", () => {
  it("drops the `command` field from explainer_job's output, on both backends", () => {
    const properties = readJson("tools/explainer_job.output.json").properties as JsonObject;
    expect(Object.keys(properties)).not.toContain("command");
    expect(Object.keys(properties)).toEqual([
      "job_id",
      "job_type",
      "status",
      "exit_code",
      "error",
      "started_at",
      "finished_at",
      "output",
    ]);
  });

  it("drops the workspace path and the installed flag from explainer_list's output", () => {
    const properties = readJson("tools/explainer_list.output.json").properties as JsonObject;
    expect(Object.keys(properties)).toEqual(["videos"]);
  });

  it("keeps `write_source_to` optional, because only a local backend can offer one", () => {
    const schema = readJson("tools/explainer_create.output.json");
    expect(schema.required).not.toContain("write_source_to");
    expect(Object.keys(schema.properties as JsonObject)).toContain("write_source_to");
  });
});
