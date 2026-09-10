/**
 * The four ONNX speech artefacts, small enough to serve from loopback.
 *
 * The real route fetches about 200 MB, so every suite that exercises it points its pins here
 * instead — four independent `setup/testing/artefact-server.ts` instances, one per artefact, so a
 * single one can be made to truncate, corrupt or 404 while the other three behave. Four servers and
 * not one because each server serves a single body across all of its routes, and the whole point of
 * the ONNX route is that it acquires four different things.
 *
 * The runtime is the **committed** `fixtures/npm-package-fixture.tgz` — `npm pack`'s own output,
 * three `bin/napi-v6` platform subtrees, and a `script/install.js` standing in for the postinstall
 * that must never be extracted — because the selection this route exists for cannot be proved
 * against an archive with one platform in it.
 *
 * Nothing here ships: `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Of } from "../archive.js";
import type { OnnxPins, PinnedArtefact } from "../providers/speech-onnx.js";
import {
  ARTEFACT_ROUTES,
  type ArtefactServer,
  startArtefactServer,
  tarballRoute,
} from "./artefact-server.js";
import { buildTarGz } from "./tar-builder.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `npm pack`'s own output, carrying three platform subtrees and a postinstall script. */
export const RUNTIME_FIXTURE: Buffer = readFileSync(
  join(HERE, "..", "fixtures", "npm-package-fixture.tgz"),
);

/** The subtree that fixture carries on every host, which is what makes selection testable. */
export const ONNX_FIXTURE_PLATFORM = "linux/x64";

/** A stand-in for `onnxruntime-common`: pure JavaScript, one CommonJS entry, npm's own layout. */
export const COMMON_FIXTURE: Buffer = buildTarGz([
  { name: "package/package.json", contents: '{"name":"common","main":"dist/cjs/index.js"}\n' },
  { name: "package/dist/cjs/package.json", contents: '{"type":"commonjs"}\n' },
  { name: "package/dist/cjs/index.js", contents: "module.exports = { Tensor: class {} };\n" },
  { name: "package/dist/esm/index.js", contents: "export const Tensor = class {};\n" },
  { name: "package/lib/index.ts", contents: "// sources, which are not extracted\n" },
]);

/** A stand-in for ninety-two megabytes of ONNX graph. */
export const MODEL_FIXTURE: Buffer = Buffer.from("a stand-in for the Kokoro-82M ONNX graph\n");

/** A stand-in for a `[510,1,256]` style tensor. */
export const VOICE_FIXTURE: Buffer = Buffer.alloc(1024, 7);

/** Which behaviour each artefact's server should answer with. Every one defaults to `good`. */
export type OnnxRouteChoice = {
  model?: string;
  voice?: string;
  runtime?: string;
  common?: string;
};

/** The four servers and the pins that address them. */
export type OnnxArtefacts = {
  pins: OnnxPins;
  model: ArtefactServer;
  voice: ArtefactServer;
  runtime: ArtefactServer;
  common: ArtefactServer;
  /** Every server, for a caller closing them all in one `afterEach`. */
  servers: readonly ArtefactServer[];
};

/**
 * Start all four, and answer with the pins that address them.
 *
 * The two plain files are served from the `.zip`-spelled routes without ceremony: `acquireFile` has
 * no extension rule at all, and a route name here describes a *behaviour* — the extension in it
 * exists only for the callers that refuse on one.
 */
export async function startOnnxArtefacts(routes: OnnxRouteChoice = {}): Promise<OnnxArtefacts> {
  const model = await startArtefactServer(MODEL_FIXTURE);
  const voice = await startArtefactServer(VOICE_FIXTURE);
  const runtime = await startArtefactServer(RUNTIME_FIXTURE);
  const common = await startArtefactServer(COMMON_FIXTURE);
  return {
    pins: {
      model: pin(model, MODEL_FIXTURE, routes.model ?? ARTEFACT_ROUTES.good),
      voices: { "af_heart.bin": pin(voice, VOICE_FIXTURE, routes.voice ?? ARTEFACT_ROUTES.good) },
      runtime: pin(runtime, RUNTIME_FIXTURE, tarballRoute(routes.runtime ?? ARTEFACT_ROUTES.good)),
      common: pin(common, COMMON_FIXTURE, tarballRoute(routes.common ?? ARTEFACT_ROUTES.good)),
      platform: ONNX_FIXTURE_PLATFORM,
    },
    model,
    voice,
    runtime,
    common,
    servers: [model, voice, runtime, common],
  };
}

/** One artefact's pin: the route it is served from, and what the bytes really hash to. */
function pin(server: ArtefactServer, body: Buffer, route: string): PinnedArtefact {
  return { url: server.url(route), sha256: sha256Of(body), size: body.length };
}
