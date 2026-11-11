/**
 * What the bundler writes for one video, read back from disk.
 *
 * Every case bundles a real scaffolded workspace with the real esbuild-wasm and the real Tailwind
 * compiler. The workspace also carries a **decoy** `node_modules` — a React that throws the moment
 * it is evaluated, and a package under the legacy import name — so "nothing is read from the
 * workspace's own install" is a property of the bundle on disk rather than of a code path.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import process from "node:process";
import {
  CAPTIONS_FILE,
  materialiseWorkspace,
  scaffoldVideo,
  TIMINGS_FILE,
  videoPaths,
} from "@xplainer/render-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLE_FILES,
  bundleVideo,
  LEGACY_IMPORT_ALIASES,
  type PageServer,
  PUBLIC_ROUTE,
  servePage,
  tailwindCandidates,
  withInterpreterOnPath,
} from "./bundle.js";

const DECOY = "the workspace's own React was bundled";

const directories: string[] = [];
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xplainer-bundle-"));
  directories.push(root);
  materialiseWorkspace(root);
  const video = videoPaths(root, "demo");
  scaffoldVideo(video.source);
  mkdirSync(video.publicDir, { recursive: true });
  writeFileSync(
    video.timings,
    `${JSON.stringify({
      fps: 30,
      durationInFrames: 3,
      totalMs: 100,
      audio: "narration.wav",
      segments: [{ id: "hook", index: 0, startMs: 0, endMs: 100, from: 0, durationInFrames: 3 }],
    })}\n`,
  );
  writeFileSync(
    video.captions,
    `${JSON.stringify([{ text: "Hello", startMs: 0, endMs: 90, timestampMs: 45, confidence: null }])}\n`,
  );
  for (const name of ["react", Object.keys(LEGACY_IMPORT_ALIASES)[0] ?? ""]) {
    const decoy = join(root, "node_modules", name);
    mkdirSync(decoy, { recursive: true });
    writeFileSync(
      join(decoy, "package.json"),
      JSON.stringify({ name, version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(decoy, "index.js"), `throw new Error(${JSON.stringify(DECOY)});\n`);
  }
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Write the agent's file. */
function scenes(source: string): void {
  writeFileSync(join(videoPaths(root, "demo").source, "Scenes.tsx"), source);
}

async function bundle(
  lines: string[] = [],
): Promise<{ dir: string; read: (name: string) => string }> {
  const dir = join(videoPaths(root, "demo").out, ".render-1");
  await bundleVideo({ root, slug: "demo", outDir: dir, log: (line) => lines.push(line) });
  return { dir, read: (name) => readFileSync(join(dir, name), "utf8") };
}

const [legacyCore, legacyMedia] = Object.keys(LEGACY_IMPORT_ALIASES);

// esbuild-wasm compiles its WebAssembly on the first build of each test file, which under a full
// parallel suite takes longer than Vitest's five-second default.
describe("bundleVideo", { timeout: 60_000 }, () => {
  it("writes a page that loads the static data before the bundle", async () => {
    const { read } = await bundle();
    const html = read(BUNDLE_FILES.html);

    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<link rel="stylesheet" href="app.css">');
    expect(html).toContain("html,body{margin:0;background:#000}");
    expect(html.indexOf('<script src="static-data.js">')).toBeGreaterThan(0);
    expect(html.indexOf('<script src="static-data.js">')).toBeLessThan(
      html.indexOf('<script src="app.js">'),
    );
  });

  /**
   * The base is a URL the page server answers for, never the directory's `file:` URL: a page that
   * resolves `staticFile()` against the filesystem is a page that can be pointed anywhere on it.
   */
  it("carries timings.json and captions.json verbatim, and the server's public route as the base", async () => {
    const { read } = await bundle();
    const video = videoPaths(root, "demo");
    const page: Record<string, unknown> = {};
    new Function("window", read(BUNDLE_FILES.staticData))(page);

    expect(page.__XPLAINER_STATIC__).toEqual({
      [TIMINGS_FILE]: readFileSync(video.timings, "utf8"),
      [CAPTIONS_FILE]: readFileSync(video.captions, "utf8"),
    });
    expect(page.__XPLAINER_PUBLIC_BASE__).toBe(PUBLIC_ROUTE);
    expect(page.__XPLAINER_RENDER__).toBeUndefined();

    const dir = join(videoPaths(root, "demo").out, ".render-3");
    await bundleVideo({
      root,
      slug: "demo",
      outDir: dir,
      log: () => {},
      publicBase: "http://127.0.0.1:4321/public/",
    });
    const served: Record<string, unknown> = {};
    new Function("window", readFileSync(join(dir, BUNDLE_FILES.staticData), "utf8"))(served);
    expect(served.__XPLAINER_PUBLIC_BASE__).toBe("http://127.0.0.1:4321/public/");
  });

  it("writes the page's render budgets only when it is given them", async () => {
    const dir = join(videoPaths(root, "demo").out, ".render-2");
    await bundleVideo({
      root,
      slug: "demo",
      outDir: dir,
      log: () => {},
      renderSettings: { delayRenderTimeoutMs: 500, imageTimeoutMs: 250 },
    });
    const page: Record<string, unknown> = {};
    new Function("window", readFileSync(join(dir, BUNDLE_FILES.staticData), "utf8"))(page);

    expect(page.__XPLAINER_RENDER__).toEqual({ delayRenderTimeoutMs: 500, imageTimeoutMs: 250 });
  });

  /**
   * Exactly one React, and it is this program's: the decoy in the workspace throws on evaluation,
   * so its text appearing anywhere in the bundle means it was resolved — and esbuild's
   * `// <path>` module comments say how many copies of React's own entry made it in.
   */
  it("bundles one React, from this program's install, and nothing from the workspace's", async () => {
    scenes(
      `import { AbsoluteFill } from "${legacyCore}";\nexport const scenes = { hook: () => <AbsoluteFill /> };\n`,
    );
    const { read } = await bundle();
    const script = read(BUNDLE_FILES.script);

    expect(script).not.toContain(DECOY);
    const reactEntries =
      script.match(/^\s*\/\/ .*node_modules\/react\/cjs\/react\.production\.js$/gm) ?? [];
    expect(reactEntries).toHaveLength(1);
    // Paths in those comments are relative to the workspace root, so the workspace's own copy
    // would read `// node_modules/react/…`.
    expect(reactEntries[0]?.trim().startsWith("// node_modules/")).toBe(false);
  });

  /**
   * The alias table's grace period, said once per agent file and never about the engine's own:
   * the scaffold's shell files are restored from the template, so a line about them would be a
   * line the agent can do nothing about.
   */
  it("logs one deprecation line per agent file that imports a legacy name, and none for the engine's", async () => {
    scenes(
      `import { AbsoluteFill } from "${legacyCore}";\n` +
        `import { Audio } from "${legacyMedia}";\n` +
        `import { Extra } from "./Extra";\n` +
        "export const scenes = { hook: () => <AbsoluteFill><Audio /><Extra /></AbsoluteFill> };\n",
    );
    writeFileSync(
      join(videoPaths(root, "demo").source, "Extra.tsx"),
      `import { AbsoluteFill } from "${legacyCore}";\nexport const Extra = () => <AbsoluteFill />;\n`,
    );
    const lines: string[] = [];
    await bundle(lines);
    const deprecations = lines.filter((line) => line.includes("deprecated"));

    expect(deprecations).toHaveLength(2);
    expect(deprecations[0]).toBe(
      `[xplainer] deprecated: videos/demo/Extra.tsx imports "${legacyCore}"; import ` +
        '"@xplainer/motion" instead. The old names are accepted for one more release.',
    );
    expect(deprecations[1]).toContain(
      `videos/demo/Scenes.tsx imports "${legacyCore}", "${legacyMedia}"`,
    );
    expect(deprecations.join("\n")).not.toMatch(/Video\.tsx|Root\.tsx|Captions\.tsx|index\.ts\b/);
  });

  it("builds Tailwind for the arbitrary-value and variant classes the video's files use", async () => {
    scenes(
      'import { AbsoluteFill } from "@xplainer/motion";\n' +
        "export const scenes = {\n" +
        '  hook: () => <AbsoluteFill className="bg-[#0a0c10] md:hover:text-sky-400">\n' +
        '    <div className={["w-[calc(100%-2rem)]", "p-6"].join(" ")} />\n' +
        "  </AbsoluteFill>,\n" +
        "};\n",
    );
    const { read } = await bundle();
    const css = read(BUNDLE_FILES.styles);

    expect(css).toContain(".bg-\\[\\#0a0c10\\]");
    expect(css).toContain("background-color: #0a0c10");
    expect(css).toContain(".md\\:hover\\:text-sky-400");
    expect(css).toContain("width: calc(100% - 2rem)");
    expect(css).toContain(".p-6");
    // A class nobody wrote is not in it: the candidates came from the sources, not from a scan of
    // everything Tailwind knows.
    expect(css).not.toContain(".bg-amber-900");
  });

  /**
   * The supervised daemon's case: launchd, and D1, leave the worker no `node` on `PATH`, and
   * esbuild-wasm spawns its service as a bare `node`. An empty directory as the whole `PATH` is
   * that machine, made certain — `/usr/bin` has a `node` on some Linux hosts.
   */
  it("bundles with no node on PATH, and leaves PATH as it found it", async () => {
    const empty = mkdtempSync(join(tmpdir(), "xplainer-no-node-"));
    directories.push(empty);
    const previous = process.env.PATH;
    process.env.PATH = empty;
    try {
      const { read } = await bundle();
      expect(read(BUNDLE_FILES.script)).toContain("__xplainer");
      expect(process.env.PATH).toBe(empty);
    } finally {
      process.env.PATH = previous;
    }
  });

  it("fails as BUNDLE_FAILED with esbuild's own diagnostic for a syntax error", async () => {
    scenes("export const scenes = { hook: () => <div> };\n");
    const failure = bundle();

    await expect(failure).rejects.toMatchObject({ code: "BUNDLE_FAILED" });
    await expect(failure).rejects.toThrow(/\[ERROR\][\s\S]*videos\/demo\/Scenes\.tsx:1:\d+:/);
  });

  it("refuses an import this program does not provide, by name", async () => {
    scenes('import confetti from "canvas-confetti";\nexport const scenes = { hook: confetti };\n');

    await expect(bundle()).rejects.toThrow(
      /BUNDLE_FAILED[\s\S]*"canvas-confetti" is not available to a video/,
    );
  });

  /**
   * Whoever writes scene source may not own the machine (a remote daemon, R-SEC-9), and esbuild
   * embeds a `.txt`, `.json`, `.js` or `.css` it can resolve. A file outside the workspace — by
   * absolute path, the `/etc/hosts` shape, and by a relative path that climbs out — is refused by
   * name, and its contents are nowhere in what was written.
   */
  it("refuses a file outside the workspace, by an absolute path and by one that climbs out", async () => {
    const outside = mkdtempSync(join(tmpdir(), "xplainer-outside-"));
    directories.push(outside);
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "the daemon user's secret\n");
    const dir = join(videoPaths(root, "demo").out, ".render-1");

    scenes(
      `import secret from ${JSON.stringify(secret)};\nexport const scenes = { hook: () => secret };\n`,
    );
    await expect(bundle()).rejects.toMatchObject({
      code: "BUNDLE_FAILED",
      message: expect.stringMatching(/secret\.txt, which is outside the workspace/),
    });
    expect(existsSync(join(dir, BUNDLE_FILES.script))).toBe(false);

    const climb = relative(videoPaths(root, "demo").source, secret).split("\\").join("/");
    expect(climb.startsWith("../")).toBe(true);
    scenes(
      `import secret from ${JSON.stringify(climb)};\nexport const scenes = { hook: () => secret };\n`,
    );
    await expect(bundle()).rejects.toMatchObject({
      code: "BUNDLE_FAILED",
      message: expect.stringContaining("which is outside the workspace"),
    });
    expect(existsSync(join(dir, BUNDLE_FILES.script))).toBe(false);
  });

  it("bundles a file elsewhere in the workspace", async () => {
    writeFileSync(join(root, "shared.json"), JSON.stringify({ marker: "shared-across-videos" }));
    scenes(
      'import shared from "../../shared.json";\n' +
        "export const scenes = { hook: () => shared.marker };\n",
    );
    const { read } = await bundle();

    expect(read(BUNDLE_FILES.script)).toContain("shared-across-videos");
  });

  it("refuses a Tailwind @import of a stylesheet outside the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "xplainer-outside-"));
    directories.push(outside);
    const sheet = join(outside, "theirs.css");
    writeFileSync(sheet, ".theirs { color: red; }\n");
    writeFileSync(
      join(root, "tailwind.css"),
      `@import "tailwindcss";\n@import ${JSON.stringify(sheet)};\n`,
    );

    await expect(bundle()).rejects.toMatchObject({
      code: "BUNDLE_FAILED",
      message: expect.stringContaining("theirs.css, which is outside the workspace"),
    });
  });
});

/** One raw request to a page server: a path exactly as given, and any `Host`. */
function get(
  server: PageServer,
  path: string,
  options: { method?: string; host?: string } = {},
): Promise<{ status: number; type: string; body: string }> {
  const { port, host } = new URL(server.origin);
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: options.host ?? host },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            type: String(response.headers["content-type"]),
            body,
          });
        });
      },
    );
    sent.on("error", reject);
    sent.end();
  });
}

describe("servePage", () => {
  let server: PageServer;
  let base = "";
  let outside = "";
  /** `/<token>`: the path segment every route the server answers is under. */
  let prefix = "";

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "xplainer-serve-"));
    outside = mkdtempSync(join(tmpdir(), "xplainer-outside-"));
    directories.push(base, outside);
    const pageDir = join(base, "out", ".render-1");
    const publicDir = join(base, "public", "demo");
    mkdirSync(pageDir, { recursive: true });
    mkdirSync(join(publicDir, "media"), { recursive: true });
    writeFileSync(join(pageDir, "index.html"), "<!doctype html>page");
    writeFileSync(join(pageDir, "app.js"), "window.app = 1;");
    writeFileSync(join(publicDir, "media", "logo.png"), "png bytes");
    writeFileSync(join(publicDir, "timings.json"), "{}");
    writeFileSync(join(base, "public", "secret.txt"), "beside the public directory");
    writeFileSync(join(outside, "secret.txt"), "elsewhere on the machine");
    if (process.platform !== "win32") {
      symlinkSync(join(outside, "secret.txt"), join(publicDir, "link.txt"));
    }
    server = await servePage({ pageDir, publicDir });
    prefix = new URL(server.url).pathname.slice(0, -"/index.html".length);
  });

  afterEach(async () => {
    await server.close();
  });

  it("listens on 127.0.0.1 and names the page and the public base under a random prefix", async () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(prefix).toMatch(/^\/[0-9a-f]{32}$/);
    expect(server.url).toBe(`${server.origin}${prefix}/index.html`);
    expect(server.publicBase).toBe(`${server.origin}${prefix}${PUBLIC_ROUTE}`);
    const other = await servePage({ pageDir: base, publicDir: base });
    try {
      expect(new URL(other.url).pathname).not.toBe(new URL(server.url).pathname);
    } finally {
      await other.close();
    }
  });

  it("serves the bundle at /<token>/ and the video's public directory at /<token>/public/, typed", async () => {
    await expect(get(server, `${prefix}/index.html`)).resolves.toEqual({
      status: 200,
      type: "text/html; charset=utf-8",
      body: "<!doctype html>page",
    });
    await expect(get(server, `${prefix}/app.js`)).resolves.toMatchObject({
      status: 200,
      type: "text/javascript; charset=utf-8",
    });
    await expect(get(server, `${prefix}/public/media/logo.png`)).resolves.toEqual({
      status: 200,
      type: "image/png",
      body: "png bytes",
    });
    await expect(get(server, `${prefix}/public/timings.json`)).resolves.toMatchObject({
      status: 200,
      type: "application/json",
    });
    await expect(
      get(server, `${prefix}/public/media/logo.png`, { method: "HEAD" }),
    ).resolves.toEqual({
      status: 200,
      type: "image/png",
      body: "",
    });
  });

  /** Any user on the machine can connect to a loopback port; only the browser has the token. */
  it("answers 404 for every path without its token, and for a wrong token of the same length", async () => {
    const wrong = `/${"0".repeat(32)}`;
    for (const path of [
      "/index.html",
      "/app.js",
      "/public/media/logo.png",
      prefix,
      `${prefix}index.html`,
      `${wrong}/index.html`,
      `${wrong}/public/media/logo.png`,
      `${prefix.slice(0, -1)}/index.html`,
      `/x${prefix}/index.html`,
    ]) {
      const answer = await get(server, path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain("page");
      expect(answer.body, path).not.toContain("png bytes");
    }
  });

  it("answers 404 for anything that leaves its root, however it is spelled", async () => {
    for (const path of [
      `${prefix}/../public/secret.txt`,
      `${prefix}/../index.html`,
      `${prefix}/public/../../public/secret.txt`,
      `${prefix}/public/%2e%2e/secret.txt`,
      `${prefix}/public/..%2fsecret.txt`,
      `${prefix}/public/..%5csecret.txt`,
      `${prefix}/public/${encodeURIComponent(join(outside, "secret.txt"))}`,
      `${prefix}/${join(outside, "secret.txt")}`,
      `${prefix}/public/%00`,
      `${prefix}/public/%E0%A4%A`,
    ]) {
      const answer = await get(server, path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain("secret");
      expect(answer.body, path).not.toContain("beside");
      expect(answer.body, path).not.toContain("elsewhere");
      expect(answer.body, path).not.toContain("page");
    }
    if (process.platform !== "win32") {
      await expect(get(server, `${prefix}/public/link.txt`)).resolves.toMatchObject({
        status: 404,
      });
    }
  });

  it("lists no directory, answers only GET and HEAD, and only to its own Host", async () => {
    for (const path of ["/", "/public/", "/public/media", "/public/media/", "/missing.js"]) {
      await expect(get(server, `${prefix}${path}`), path).resolves.toMatchObject({ status: 404 });
    }
    await expect(get(server, `${prefix}/index.html`, { method: "POST" })).resolves.toMatchObject({
      status: 404,
    });
    // A name rebound to 127.0.0.1 by a page elsewhere arrives with that name as its Host.
    await expect(
      get(server, `${prefix}/index.html`, {
        host: `attacker.example:${new URL(server.origin).port}`,
      }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(get(server, `${prefix}/index.html`, { host: "localhost" })).resolves.toMatchObject(
      {
        status: 404,
      },
    );
  });

  it("stops answering once closed, and closes twice without complaint", async () => {
    await server.close();
    await server.close();
    await expect(get(server, `${prefix}/index.html`)).rejects.toThrow();
  });
});

describe("withInterpreterOnPath", () => {
  it("puts this interpreter's directory first only while the callback runs", () => {
    const previous = process.env.PATH;
    const seen = withInterpreterOnPath(() => process.env.PATH);
    expect(seen?.split(delimiter)[0]).toBe(dirname(process.execPath));
    expect(process.env.PATH).toBe(previous);
  });

  it("restores PATH when the callback throws", () => {
    const previous = process.env.PATH;
    expect(() =>
      withInterpreterOnPath(() => {
        throw new Error("spawn failed");
      }),
    ).toThrow("spawn failed");
    expect(process.env.PATH).toBe(previous);
  });
});

describe("tailwindCandidates", () => {
  it("keeps arbitrary values whole and still finds the classes inside a call", () => {
    const found = tailwindCandidates(
      'className={cx("p-4", active && `grid-cols-[repeat(3,minmax(0,1fr))]`)} md:hover:text-white',
    );
    expect(found).toEqual(
      expect.arrayContaining(["p-4", "grid-cols-[repeat(3,minmax(0,1fr))]", "md:hover:text-white"]),
    );
  });
});
