/**
 * One video's sources, bundled into a page, and the loopback server Chrome opens it from.
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
 * **And nothing a video imports by path may leave the workspace.** Every resolution — relative,
 * absolute, or a provided package's own dependency — must land inside the workspace root or inside
 * the install directories this program's provided packages come from, or the bundle fails
 * `BUNDLE_FAILED` naming the file. Otherwise `import secret from "/home/me/.aws/credentials.txt"`
 * would be embedded in the bundle, and for a daemon serving a remote client (R-SEC-9) whoever writes
 * scene source need not be whoever owns the machine. Tailwind's `@import` is held to the same rule.
 *
 * **The page is served, never opened from `file://`** ({@link servePage}). A `file:` page can show
 * any image, font or media file the daemon's user can read through `<img src="file:///…">`; an
 * `http://127.0.0.1` page cannot load `file:` at all, so the only files a scene can reach are the
 * two directories the server answers for — the bundle at `/` and the video's public directory at
 * `/public/`.
 *
 * **The JSON travels as a script, not as a fetch.** `static-data.js` carries the two documents and
 * the harness answers the composition's `fetch(staticFile(…))` calls from it, so the scaffold's
 * metadata step never waits on the network.
 *
 * **Tailwind is compiled, not scanned.** `tailwindcss`'s own `compile()` builds the stylesheet from
 * a candidate list this module extracts — an over-inclusive split of every bundled source file that
 * is not under `node_modules` — so no native scanner, no `lightningcss` and no platform binary is
 * involved. A token that is not a class costs nothing: Tailwind ignores what it cannot parse.
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CAPTIONS_FILE, isEngineOwned, TIMINGS_FILE, videoPaths } from "@xplainer/render-core";
import {
  build,
  formatMessages,
  type Message,
  type OnResolveArgs,
  type OnResolveResult,
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
const OWN_RESOLVE = Symbol("xplainer-own-resolve");

/** Where {@link servePage} serves the video's public directory, and so where `staticFile()` points. */
export const PUBLIC_ROUTE = "/public/";

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
  /**
   * The URL `staticFile()` prefixes, ending in `/`: the worker passes its {@link PageServer}'s
   * `publicBase`. Left out, it is {@link PUBLIC_ROUTE}, which resolves to the same place against
   * whatever origin serves the page — and to nothing on disk when nothing does.
   */
  publicBase?: string;
};

/** What one bundle produced. */
export type BundleResult = {
  /** `<outDir>/index.html`. */
  indexHtml: string;
  /**
   * Its `file:` URL. The worker never opens it — it serves the directory with {@link servePage},
   * because a `file:` page can reach every file the daemon's user can read — and it is here for a
   * test that only needs the page.
   */
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

/** Whether a path — relative to the workspace root, never absolute — has a `node_modules` in it. */
function insideNodeModules(path: string): boolean {
  return path.split(/[\\/]/).includes("node_modules");
}

/** Whether `path` is `root` or something inside it. Both are expected to be real paths. */
function isWithin(root: string, path: string): boolean {
  const inside = relative(root, path);
  return (
    inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
  );
}

/** `path` with every symlink resolved, or `path` itself when it cannot be (it does not exist). */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The directory holding `name`'s `package.json`, found from the file `name` resolves to. */
function packageDirectory(name: string): string {
  let directory = dirname(cliRequire.resolve(name));
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const declared: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      if (
        typeof declared === "object" &&
        declared !== null &&
        (declared as { name?: unknown }).name === name
      ) {
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`${name} resolved to ${cliRequire.resolve(name)}, which has no package.json`);
    }
    directory = parent;
  }
}

let installRoots: readonly string[] | null = null;

/**
 * The directories this program's own packages are installed in: for each provided package and for
 * Tailwind, the **outermost** `node_modules` that holds it, or its own directory when none does (a
 * workspace link, in this repository). Outermost, because a package's dependencies can sit anywhere
 * in the tree that installed it — pnpm keeps them in `.pnpm/`, npm hoists `scheduler` above a
 * nested `react-dom` — but never outside it.
 */
function programInstallRoots(): readonly string[] {
  if (installRoots === null) {
    const roots = new Set<string>();
    for (const name of [...PROVIDED_PACKAGES, "tailwindcss"]) {
      const directory = realpathSync(packageDirectory(name));
      const parts = directory.split(sep);
      const outermost = parts.indexOf("node_modules");
      roots.add(outermost === -1 ? directory : parts.slice(0, outermost + 1).join(sep));
    }
    installRoots = [...roots];
  }
  return installRoots;
}

/** The sentence a resolution outside the allowed directories is refused with. */
function outsideTheWorkspace(specifier: string, path: string, root: string): string {
  return (
    `"${specifier}" resolves to ${path}, which is outside the workspace (${root}) and outside ` +
    "xplainer's own install. A video may only import files inside the workspace."
  );
}

/**
 * Read a stylesheet Tailwind's `@import` asks for: Tailwind's own, or one relative to the importer
 * that stays inside the workspace root `root` (a real path).
 */
async function loadStylesheet(
  id: string,
  base: string,
  root: string,
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
    if (!isWithin(root, realOrSelf(path))) {
      throw new Error(outsideTheWorkspace(id, path, root));
    }
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
  const realRoot = realpathSync(root);
  try {
    const compiler = await compile(css, {
      base: root,
      from: entry,
      loadStylesheet: (id, base) => loadStylesheet(id, base, realRoot),
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
function staticDataScript(
  publicDir: string,
  base: string,
  settings: PageRenderSettings | undefined,
): string {
  const documents: Record<string, string> = {};
  for (const name of STATIC_DOCUMENTS) {
    const path = join(publicDir, name);
    if (existsSync(path)) {
      documents[name] = readFileSync(path, "utf8");
    }
  }
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
  const workspace = realpathSync(options.root);
  const installed = programInstallRoots();
  const everywhere = [workspace, ...installed];
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

      /**
       * Resolve `specifier` from `resolveDir` with esbuild's own resolver, then refuse the result
       * unless it is inside one of `allowed` — every import this plugin passes on goes through here,
       * so no file outside the workspace and this program's install reaches the bundle.
       */
      const confined = async (
        specifier: string,
        args: OnResolveArgs,
        resolveDir: string,
        allowed: readonly string[],
      ): Promise<OnResolveResult> => {
        const resolved = await context.resolve(specifier, {
          kind: args.kind,
          importer: args.importer,
          resolveDir,
          pluginData: OWN_RESOLVE,
        });
        if (resolved.errors.length > 0) {
          return { errors: resolved.errors };
        }
        if (
          resolved.namespace === "file" &&
          !resolved.external &&
          !allowed.some((root) => isWithin(root, realOrSelf(resolved.path)))
        ) {
          return { errors: [{ text: outsideTheWorkspace(specifier, resolved.path, workspace) }] };
        }
        return {
          path: resolved.path,
          namespace: resolved.namespace,
          external: resolved.external,
          sideEffects: resolved.sideEffects,
          suffix: resolved.suffix,
        };
      };

      context.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === OWN_RESOLVE) {
          return undefined;
        }
        const bare =
          !args.path.startsWith(".") && !args.path.startsWith("/") && !isAbsolute(args.path);
        if (!bare) {
          return confined(args.path, args, args.resolveDir, everywhere);
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
          return confined(aliased, args, CLI_DIR, installed);
        }
        if (PROVIDED_PACKAGES.has(packageName(args.path))) {
          return confined(args.path, args, CLI_DIR, installed);
        }
        // Relative to the workspace, so a workspace that itself sits under a `node_modules` does
        // not make every one of the video's own files look like a package's.
        if (insideNodeModules(relative(workspace, args.importer))) {
          // A provided package's own dependency (react-dom's `scheduler`), found where it lives —
          // which must be this program's install, never the workspace's.
          return confined(args.path, args, args.resolveDir, installed);
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
    staticDataScript(video.publicDir, options.publicBase ?? PUBLIC_ROUTE, options.renderSettings),
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

/** `Content-Type` by extension, for the files a bundle or a video's public directory holds. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/** The two directories {@link servePage} answers for. */
export type ServePageOptions = {
  /** The bundle's directory, served at `/`. */
  pageDir: string;
  /** The video's `public/<slug>/`, served at {@link PUBLIC_ROUTE}. */
  publicDir: string;
};

/** A running page server. */
export type PageServer = {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** `<origin>/index.html`: what the browser is pointed at. */
  url: string;
  /** `<origin>/public/`: what `staticFile()` prefixes. */
  publicBase: string;
  /** Stop listening and drop every open connection. Safe to call more than once. */
  close: () => Promise<void>;
};

/**
 * The file a request path names, or `null` for anything that is not a regular file inside the
 * directory its route serves — after decoding, after `..`, and after every symlink.
 */
function servedFile(
  requestUrl: string,
  options: ServePageOptions,
): { path: string; size: number } | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) {
    return null;
  }
  const [root, rest] = pathname.startsWith(PUBLIC_ROUTE)
    ? [options.publicDir, pathname.slice(PUBLIC_ROUTE.length)]
    : [options.pageDir, pathname.slice(1)];
  try {
    const path = realpathSync(resolve(root, rest));
    if (!isWithin(realpathSync(root), path)) {
      return null;
    }
    const stats = statSync(path);
    return stats.isFile() ? { path, size: stats.size } : null;
  } catch {
    return null;
  }
}

/**
 * Serve one bundle and its video's public directory on `127.0.0.1`, on a port the OS picks.
 *
 * The bundle is at `/` and the public directory at {@link PUBLIC_ROUTE}; every other path — a
 * directory, a file outside either root, a `..` or a symlink that leads out — is `404`, and only
 * `GET` and `HEAD` are answered. A request whose `Host` is not this server's own address is `404`
 * too, so a page elsewhere that rebinds a name to `127.0.0.1` cannot read through it while a render
 * runs. Nothing is cached and nothing is listed.
 */
export async function servePage(options: ServePageOptions): Promise<PageServer> {
  let host = "";
  const server = createServer((request, response) => {
    const method = request.method ?? "";
    const file =
      request.headers.host === host && (method === "GET" || method === "HEAD")
        ? servedFile(request.url ?? "", options)
        : null;
    if (file === null) {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("not found\n");
      return;
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream",
      "content-length": file.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file.path)
      .on("error", () => {
        response.destroy();
      })
      .pipe(response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new RenderError("PAGE_ERROR", "the page server did not get a TCP port on 127.0.0.1.");
  }
  host = `127.0.0.1:${address.port}`;
  const origin = `http://${host}`;
  let closing: Promise<void> | null = null;
  return {
    origin,
    url: `${origin}/${BUNDLE_FILES.html}`,
    publicBase: `${origin}${PUBLIC_ROUTE}`,
    close: () => {
      closing ??= new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
