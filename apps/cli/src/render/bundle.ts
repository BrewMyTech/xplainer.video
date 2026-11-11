/**
 * One video's sources, bundled into a page Chrome can open from `file://`.
 *
 * The bundler is **esbuild-wasm**: the same esbuild, compiled to WebAssembly, so it has no
 * platform binary and no install script that fetches one. It builds a generated entry that imports
 * `@xplainer/motion/harness` first and the video's own `index.ts` second — first, so the frozen
 * clock and the film-time timers are installed before any scene module runs — into one classic
 * script, beside a stylesheet, a data script and an `index.html`:
 *
 *   index.html       `<div id="root">`, then `static-data.js`, then `app.js`
 *   static-data.js   `timings.json` and `captions.json` as strings, and the public directory's URL
 *   app.js           the bundle: React, `@xplainer/motion`, the harness, the video
 *   app.css          Tailwind, built for the classes the video's own files mention
 *
 * **Everything a video imports by package name comes from this program's own install.** React,
 * React DOM and `@xplainer/motion` are resolved from beside this module, never from the
 * workspace: the workspace's `node_modules` is not read at all, so there is exactly one React in
 * the bundle and it is the one this build was tested with. Any other bare import from a video's
 * own files is refused by name rather than found somewhere and trusted.
 *
 * **The JSON travels as a script, not as a fetch.** Chrome refuses `fetch()` on a `file:` URL, so
 * `static-data.js` carries the two documents and the harness serves the composition's
 * `fetch(staticFile(…))` calls from it.
 *
 * **Tailwind is compiled, not scanned.** `tailwindcss`'s own `compile()` builds the stylesheet from
 * a candidate list this module extracts — an over-inclusive split of every bundled source file that
 * is not under `node_modules` — so no native scanner, no `lightningcss` and no platform binary is
 * involved. A token that is not a class costs nothing: Tailwind ignores what it cannot parse.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CAPTIONS_FILE, isEngineOwned, TIMINGS_FILE, videoPaths } from "@xplainer/render-core";
import {
  build,
  formatMessages,
  type ImportKind,
  type Message,
  type Plugin,
  stop,
} from "esbuild-wasm";
import { compile } from "tailwindcss";
import { RenderError } from "./render-error.js";

/** The package every video's animation API comes from. */
export const MOTION_PACKAGE = "@xplainer/motion";

/** The page-side half of it: the frozen clock and `window.__xplainer`. Imported first. */
export const MOTION_HARNESS = "@xplainer/motion/harness";

/**
 * **The alias table.** Import names a video written for the previous renderer still uses, each
 * mapped to the package that replaces it. One release of grace: an agent-owned file that imports
 * one of these renders, and its job log says which file and what to import instead.
 */
export const LEGACY_IMPORT_ALIASES: Readonly<Record<string, string>> = {
  remotion: MOTION_PACKAGE,
  "@remotion/media": MOTION_PACKAGE,
  "@remotion/captions": MOTION_PACKAGE,
};

/** Packages a video may import by name, all resolved from this program's own install. */
const PROVIDED_PACKAGES: ReadonlySet<string> = new Set(["react", "react-dom", MOTION_PACKAGE]);

/** The bundle's file names inside the job's directory. */
export const BUNDLE_FILES = {
  html: "index.html",
  script: "app.js",
  styles: "app.css",
  staticData: "static-data.js",
} as const;

/** The JSON documents `static-data.js` carries, by the name `staticFile()` asks for them with. */
const STATIC_DOCUMENTS: readonly string[] = [TIMINGS_FILE, CAPTIONS_FILE];

/** Where this module is: the directory every provided package is resolved from. */
const CLI_DIR = fileURLToPath(new URL(".", import.meta.url));

const cliRequire = createRequire(import.meta.url);

/** The esbuild namespace an empty module lives in. */
const EMPTY_NAMESPACE = "xplainer-empty";

/** Marks a resolve this plugin asked for itself, so it does not intercept its own question. */
const FROM_CLI = Symbol("xplainer-resolve-from-cli");

/** Timeouts the page harness reads, for a test that needs a failure to arrive quickly. */
export type PageRenderSettings = {
  delayRenderTimeoutMs?: number;
  imageTimeoutMs?: number;
};

/** What {@link bundleVideo} needs. */
export type BundleOptions = {
  /** The workspace root. */
  root: string;
  slug: string;
  /** The per-job directory the four files are written into; created if absent. */
  outDir: string;
  /** Where a deprecation or a bundler warning goes — the job log, in the worker. */
  log: (line: string) => void;
  /** Written into `static-data.js` as `window.__XPLAINER_RENDER__` when given. */
  renderSettings?: PageRenderSettings;
};

/** What one bundle produced. */
export type BundleResult = {
  /** `<outDir>/index.html`. */
  indexHtml: string;
  /** Its `file:` URL, which is what the browser is pointed at. */
  url: string;
  /** Agent-owned files that imported a legacy name, relative to the video's directory. */
  deprecated: string[];
  /** How many Tailwind candidates the sources yielded. */
  candidates: number;
  durationMs: number;
};

/**
 * Every token in `text` that could be a Tailwind class, and many that could not.
 *
 * Split on whitespace and quotes, then again on the punctuation JSX and JavaScript put around a
 * class list, keeping both the whole token and its pieces: `w-[calc(100%-2rem)]` survives whole
 * because nothing inside it is a separator, and `cx("a",` still yields `a`.
 */
export function tailwindCandidates(text: string): string[] {
  const found = new Set<string>();
  for (const token of text.split(/[\s"'`\\]+/)) {
    if (token === "" || token.length > 256) {
      continue;
    }
    found.add(token);
    for (const piece of token.split(/[{}()<>,;=]+/)) {
      if (piece !== "") {
        found.add(piece);
        const trimmed = piece.replace(/^[.]+|[.:]+$/g, "");
        if (trimmed !== "") {
          found.add(trimmed);
        }
      }
    }
  }
  return [...found];
}

/** The package a bare specifier names: `react` for `react/jsx-runtime`, `@a/b` for `@a/b/c`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function insideNodeModules(path: string): boolean {
  return path.split(/[\\/]/).includes("node_modules");
}

/** Read a stylesheet Tailwind's `@import` asks for: Tailwind's own, or one relative to the importer. */
async function loadStylesheet(
  id: string,
  base: string,
): Promise<{ path: string; base: string; content: string }> {
  const tailwindDir = dirname(cliRequire.resolve("tailwindcss/package.json"));
  let path: string;
  if (id === "tailwindcss") {
    path = join(tailwindDir, "index.css");
  } else if (id.startsWith("tailwindcss/")) {
    const sub = id.slice("tailwindcss/".length);
    path = join(tailwindDir, sub.endsWith(".css") ? sub : `${sub}.css`);
  } else if (id.startsWith(".") || isAbsolute(id)) {
    path = resolve(base, id);
  } else {
    throw new Error(
      `@import "${id}" is not available to a render: only tailwindcss and stylesheets relative ` +
        "to tailwind.css are.",
    );
  }
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

/** Build the stylesheet for `candidates` from the workspace's `tailwind.css`. */
async function buildTailwind(root: string, candidates: readonly string[]): Promise<string> {
  const entry = join(root, "tailwind.css");
  const css = existsSync(entry) ? readFileSync(entry, "utf8") : '@import "tailwindcss";\n';
  try {
    const compiler = await compile(css, {
      base: root,
      from: entry,
      loadStylesheet,
      loadModule: async (id) => {
        throw new Error(`Tailwind plugins and configs are not supported in a render (${id}).`);
      },
    });
    return compiler.build([...candidates]);
  } catch (error) {
    throw new RenderError(
      "BUNDLE_FAILED",
      `Tailwind could not build ${entry}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Format esbuild's diagnostics exactly as esbuild prints them, without colour. */
async function formatted(messages: Message[], kind: "error" | "warning"): Promise<string> {
  if (messages.length === 0) {
    return "";
  }
  return (await formatMessages(messages, { kind, color: false })).join("").trimEnd();
}

function isBuildFailure(
  error: unknown,
): error is Error & { errors: Message[]; warnings: Message[] } {
  return (
    error instanceof Error &&
    Array.isArray((error as { errors?: unknown }).errors) &&
    Array.isArray((error as { warnings?: unknown }).warnings)
  );
}

/** `static-data.js`: the two documents, the public directory's URL, and any test timeouts. */
function staticDataScript(publicDir: string, settings: PageRenderSettings | undefined): string {
  const documents: Record<string, string> = {};
  for (const name of STATIC_DOCUMENTS) {
    const path = join(publicDir, name);
    if (existsSync(path)) {
      documents[name] = readFileSync(path, "utf8");
    }
  }
  const base = pathToFileURL(publicDir).href.replace(/\/?$/, "/");
  const lines = [
    `window.__XPLAINER_STATIC__ = ${JSON.stringify(documents)};`,
    `window.__XPLAINER_PUBLIC_BASE__ = ${JSON.stringify(base)};`,
  ];
  if (settings !== undefined) {
    lines.push(`window.__XPLAINER_RENDER__ = ${JSON.stringify(settings)};`);
  }
  return `${lines.join("\n")}\n`;
}

const INDEX_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${BUNDLE_FILES.styles}">
<style>html,body{margin:0;background:#000}</style>
</head>
<body>
<div id="root"></div>
<script src="${BUNDLE_FILES.staticData}"></script>
<script src="${BUNDLE_FILES.script}"></script>
</body>
</html>
`;

/**
 * Run `start` with this process's own interpreter first on `PATH`, and only for as long as it runs.
 *
 * esbuild-wasm runs its WebAssembly in a child it spawns as a bare `node`, resolved through `PATH`
 * (`esbuild-wasm/lib/main.js`, `esbuildCommandAndArgs`), and it spawns that child synchronously
 * inside the first API call. A supervised daemon's worker has no `node` on its `PATH` by design —
 * D1 in `daemon/workers.ts`, and launchd hands a LaunchAgent `/usr/bin:/bin:/usr/sbin:/sbin` — so
 * without this every still and render ends `BUNDLE_FAILED: … spawn node ENOENT`, and where some
 * `node` is on `PATH` the bundler runs under that one rather than the daemon's. `process.execPath`
 * is `<runtime>/bin/node` (`node.exe` on Windows) out of a payload, so its directory is the one to
 * put first. The previous value is back before `start` returns, so Chrome and ffmpeg, spawned
 * later by the worker, never see it: that is the leak D1 refuses `WorkerSpec.env` for.
 */
export function withInterpreterOnPath<T>(start: () => T): T {
  const previous = process.env.PATH;
  const interpreterDir = dirname(process.execPath);
  process.env.PATH =
    previous === undefined || previous === ""
      ? interpreterDir
      : `${interpreterDir}${delimiter}${previous}`;
  try {
    return start();
  } finally {
    if (previous === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previous;
    }
  }
}

/**
 * Bundle one video into `outDir`, or fail with `BUNDLE_FAILED` and esbuild's own diagnostics.
 *
 * Stops the esbuild service before it returns either way: the service is a child the worker would
 * otherwise wait on, and a worker that never exits is a render that never finishes.
 */
export async function bundleVideo(options: BundleOptions): Promise<BundleResult> {
  const started = performance.now();
  const video = videoPaths(options.root, options.slug);
  const entry = join(video.source, "index.ts");
  if (!existsSync(entry)) {
    throw new RenderError(
      "BUNDLE_FAILED",
      `${entry} does not exist, so there is nothing to bundle.`,
    );
  }
  // The importer paths esbuild reports are real paths; a workspace under a symlink (macOS's /var)
  // would otherwise never match the video's own directory.
  const videoDir = realpathSync(video.source);
  const legacy = new Map<string, Set<string>>();

  const renderer: Plugin = {
    name: "xplainer-renderer",
    setup(context) {
      // The scaffold's `import "../../tailwind.css"`: Tailwind is built separately, below.
      context.onResolve({ filter: /(^|[\\/])tailwind\.css$/ }, (args) => ({
        path: args.path,
        namespace: EMPTY_NAMESPACE,
      }));
      context.onLoad({ filter: /.*/, namespace: EMPTY_NAMESPACE }, () => ({
        contents: "",
        loader: "js",
      }));

      const fromCli = async (specifier: string, kind: ImportKind) => {
        const resolved = await context.resolve(specifier, {
          kind,
          resolveDir: CLI_DIR,
          pluginData: FROM_CLI,
        });
        if (resolved.errors.length > 0) {
          return { errors: resolved.errors };
        }
        return { path: resolved.path, sideEffects: resolved.sideEffects };
      };

      context.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === FROM_CLI || isAbsolute(args.path)) {
          return undefined;
        }
        const aliased = LEGACY_IMPORT_ALIASES[args.path];
        if (aliased !== undefined) {
          const local = relative(videoDir, args.importer);
          if (!local.startsWith("..") && !isAbsolute(local)) {
            const name = local.split(sep).join("/");
            if (!isEngineOwned(name)) {
              const names = legacy.get(name) ?? new Set<string>();
              names.add(args.path);
              legacy.set(name, names);
            }
          }
          return fromCli(aliased, args.kind);
        }
        if (PROVIDED_PACKAGES.has(packageName(args.path))) {
          return fromCli(args.path, args.kind);
        }
        if (insideNodeModules(args.importer)) {
          // A provided package's own dependency (react-dom's `scheduler`), found where it lives.
          return undefined;
        }
        return {
          errors: [
            {
              text:
                `"${args.path}" is not available to a video. A render provides react, react-dom ` +
                `and ${MOTION_PACKAGE}, from xplainer's own install; anything else has to be part ` +
                "of the video's own files.",
            },
          ],
        };
      });
    },
  };

  mkdirSync(options.outDir, { recursive: true });
  let script: string;
  let bundledCss = "";
  const sources: string[] = [];
  try {
    const result = await withInterpreterOnPath(() =>
      build({
        stdin: {
          contents: `import ${JSON.stringify(MOTION_HARNESS)};\nimport ${JSON.stringify(entry)};\n`,
          resolveDir: video.source,
          sourcefile: "xplainer-entry.js",
          loader: "js",
        },
        absWorkingDir: options.root,
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "chrome149",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
        minify: false,
        metafile: true,
        write: false,
        outfile: join(options.outDir, BUNDLE_FILES.script),
        logLevel: "silent",
        plugins: [renderer],
      }),
    );
    const warnings = await formatted(result.warnings, "warning");
    if (warnings !== "") {
      options.log(`[xplainer] bundler warnings:\n${warnings}`);
    }
    script = "";
    for (const file of result.outputFiles) {
      if (file.path.endsWith(".css")) {
        bundledCss += file.text;
      } else if (file.path.endsWith(".js")) {
        script += file.text;
      }
    }
    for (const key of Object.keys(result.metafile.inputs)) {
      if (key.startsWith(`${EMPTY_NAMESPACE}:`) || insideNodeModules(key)) {
        continue;
      }
      const source = resolve(options.root, key);
      // The generated entry is listed under its `sourcefile` name and exists only in memory.
      if (existsSync(source)) {
        sources.push(source);
      }
    }
  } catch (error) {
    if (isBuildFailure(error)) {
      const diagnostics = await formatted(error.errors, "error");
      throw new RenderError(
        "BUNDLE_FAILED",
        `${options.slug} did not bundle:\n${diagnostics === "" ? error.message : diagnostics}`,
      );
    }
    throw new RenderError(
      "BUNDLE_FAILED",
      `${options.slug} did not bundle: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    stop();
  }

  for (const [file, names] of [...legacy].sort(([a], [b]) => a.localeCompare(b))) {
    const imports = [...names].map((name) => `"${name}"`).join(", ");
    options.log(
      `[xplainer] deprecated: videos/${options.slug}/${file} imports ${imports}; import ` +
        `"${MOTION_PACKAGE}" instead. The old names are accepted for one more release.`,
    );
  }

  const candidates = new Set<string>();
  for (const source of sources) {
    for (const candidate of tailwindCandidates(readFileSync(source, "utf8"))) {
      candidates.add(candidate);
    }
  }
  const tailwindCss = await buildTailwind(options.root, [...candidates]);

  writeFileSync(join(options.outDir, BUNDLE_FILES.script), script);
  writeFileSync(
    join(options.outDir, BUNDLE_FILES.styles),
    bundledCss === "" ? tailwindCss : `${tailwindCss}\n${bundledCss}`,
  );
  writeFileSync(
    join(options.outDir, BUNDLE_FILES.staticData),
    staticDataScript(video.publicDir, options.renderSettings),
  );
  const indexHtml = join(options.outDir, BUNDLE_FILES.html);
  writeFileSync(indexHtml, INDEX_HTML);

  return {
    indexHtml,
    url: pathToFileURL(indexHtml).href,
    deprecated: [...legacy.keys()],
    candidates: candidates.size,
    durationMs: performance.now() - started,
  };
}
