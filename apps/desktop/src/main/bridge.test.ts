/**
 * The authenticated bridge, against a real daemon with its real `/api/*` surface.
 *
 * Every request below is a real HTTP request to a real `xplainer serve`, authenticated with the
 * token that daemon read from its own file. Nothing is mocked: the library listing comes from a
 * video on disk, the media response is the daemon's own `Range` handling over real bytes, and the
 * event stream is a real job going through the queue.
 *
 * Two of these are the security assertions rather than the functional ones — that the token never
 * appears in anything a renderer would receive, and that a path outside the client surface is
 * refused before it is sent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { videosPath } from "@xplainer/cli";
import { afterAll, describe, expect, it } from "vitest";
import { API_PREFIX, mediaPath, mediaUrl, VIDEOS_PATH } from "../shared/daemon-api";
import { BridgeRefusal, DaemonBridge, type JobStreamEvent } from "./bridge";
import {
  cleanUpFixtures,
  type LiveDaemon,
  payloadResources,
  startDaemon,
  temporaryDirectory,
} from "./testing/live-daemon";

/** A daemon start, a queued job and its stream all fit inside this. */
const CASE_TIMEOUT_MS = 60_000;

/** The bytes the media assertions are about: short, and recognisable a byte at a time. */
const MP4_BYTES = Buffer.from("0123456789abcdef", "utf8");

afterAll(async () => {
  await cleanUpFixtures();
}, CASE_TIMEOUT_MS);

/** A daemon with one video on disk, which is all `/api/videos` needs to have something to list. */
async function daemonWithVideo(slug: string): Promise<{ live: LiveDaemon; bridge: DaemonBridge }> {
  const resources = payloadResources();
  const stateDir = temporaryDirectory();
  const live = await startDaemon({ resources, stateDir });
  const workspace = join(stateDir, "workspace");
  mkdirSync(join(workspace, "videos", slug), { recursive: true });
  mkdirSync(join(workspace, "out", slug), { recursive: true });
  writeFileSync(join(workspace, "out", slug, "explainer.mp4"), MP4_BYTES);
  return {
    live,
    bridge: new DaemonBridge({ url: live.url, tokenFile: live.tokenFile }),
  };
}

describe("DaemonBridge", () => {
  it(
    "reads the library over an authenticated request, at the one path this app knows",
    async () => {
      const { bridge } = await daemonWithVideo("bridge-library");

      // The one route this app spells out is the one the CLI publishes; everything else is followed
      // from what the daemon answered.
      expect(VIDEOS_PATH).toBe(videosPath());
      expect(VIDEOS_PATH.startsWith(`${API_PREFIX}/`)).toBe(true);

      const answer = await bridge.json({ path: VIDEOS_PATH });

      expect(answer.status).toBe(200);
      const videos = (answer.body as { videos: { slug: string }[] }).videos;
      expect(videos.map((video) => video.slug)).toContain("bridge-library");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "never lets the token into anything it answers with",
    async () => {
      const { live, bridge } = await daemonWithVideo("bridge-secret");
      const token = live.token();
      expect(token).not.toBe("");

      const answer = await bridge.json({ path: VIDEOS_PATH });
      const media = await bridge.media(`${VIDEOS_PATH}/bridge-secret/artefacts/explainer.mp4`);
      media.body.destroy();

      // Everything a renderer could ever be handed: the document, the headers, and the bridge's own
      // public surface. The token is in the file, and in the request this process made, and nowhere
      // else.
      expect(JSON.stringify(answer)).not.toContain(token);
      expect(JSON.stringify(media.headers)).not.toContain(token);
      expect(JSON.stringify(bridge.tokenFile)).not.toContain(token);
      expect(Object.values(bridge as unknown as Record<string, unknown>)).not.toContain(token);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "answers 401 once, then picks up a rotated token from the file and retries",
    async () => {
      const { live } = await daemonWithVideo("bridge-rotation");
      const stale = join(live.stateDir, "stale-token");
      writeFileSync(stale, "not-the-token\n", { mode: 0o600 });
      const bridge = new DaemonBridge({ url: live.url, tokenFile: stale });

      // A 401 against a token this bridge has just re-read is the answer, not a loop: the file
      // still says the same wrong thing.
      const refused = await bridge.json({ path: VIDEOS_PATH });
      expect(refused.status).toBe(401);

      // Rotation: the file now holds what the daemon accepts, and nothing restarted.
      writeFileSync(stale, `${live.token()}\n`, { mode: 0o600 });
      const accepted = await bridge.json({ path: VIDEOS_PATH });
      expect(accepted.status).toBe(200);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "serves an artefact's bytes with the player's Range intact",
    async () => {
      const { bridge } = await daemonWithVideo("bridge-media");
      const listing = await bridge.json({ path: `${VIDEOS_PATH}/bridge-media` });
      const artefacts = (listing.body as { artefacts: { kind: string; url: string }[] }).artefacts;
      const film = artefacts.find((artefact) => artefact.kind === "video");
      expect(film).toBeDefined();

      const whole = await bridge.media(film?.url ?? "");
      expect(whole.status).toBe(200);
      expect(await collect(whole)).toEqual(MP4_BYTES);

      const part = await bridge.media(film?.url ?? "", { range: "bytes=0-3" });
      expect(part.status).toBe(206);
      expect(part.headers["content-range"]).toMatch(/^bytes 0-3\//);
      expect((await collect(part)).toString("utf8")).toBe("0123");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "follows a queued job's progress to the end of its stream",
    async () => {
      const { bridge } = await daemonWithVideo("bridge-stream");
      const queued = await bridge.json({
        path: `${VIDEOS_PATH}/bridge-stream/narrate`,
        method: "POST",
        // A dry run: the estimate, rather than measured speech, so this job needs nothing acquired.
        body: JSON.stringify({
          dry_run: true,
          narration: { segments: [{ id: "one", text: "One short line." }] },
        }),
      });
      expect(queued.status).toBe(202);
      const events = (queued.body as { events: string }).events;
      expect(events).toMatch(/\/events$/);

      const seen: JobStreamEvent[] = [];
      await bridge.subscribe(events, (event) => {
        seen.push(event);
      });

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]?.name).toBe("job");
      expect(seen[seen.length - 1]?.name).toBe("end");
      const last = seen[seen.length - 1]?.data as { status: string };
      expect(["done", "error", "cancelled"]).toContain(last.status);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "reports the daemon's own account of itself, degraded reason included",
    async () => {
      const { bridge } = await daemonWithVideo("bridge-health");
      const health = await bridge.health();

      expect(health.status).toBe(200);
      const body = health.body as {
        status: string;
        reason: string | null;
        contract_version: string;
      };
      // Nothing was acquired for this daemon, so the reason is the one a degraded discovery shows.
      expect(body.status).toBe("degraded");
      expect(body.reason).not.toBeNull();
      expect(body.contract_version).not.toBe("");
    },
    CASE_TIMEOUT_MS,
  );

  it("refuses a path outside the client surface before it sends anything", async () => {
    const bridge = new DaemonBridge({ url: "http://127.0.0.1:1", tokenFile: null });

    // `/mcp` is an agent's endpoint: a window that could reach it could run every tool with the
    // daemon's own authority.
    await expect(bridge.json({ path: "/mcp" })).rejects.toBeInstanceOf(BridgeRefusal);
    await expect(bridge.json({ path: "/etc/passwd" })).rejects.toThrow(/client surface/);
  });
});

describe("mediaUrl", () => {
  it("carries the daemon path whole, and refuses a URL that asks for anything else", () => {
    const path = `${VIDEOS_PATH}/a-slug/artefacts/frame%201.png`;

    expect(mediaPath(mediaUrl(path))).toBe(path);
    expect(mediaPath("xplainer-media://artefact/etc/passwd")).toBeNull();
    expect(mediaPath("https://example.com/api/videos")).toBeNull();
    expect(mediaPath("not a url")).toBeNull();
  });
});

/** Read a media response's bytes. */
async function collect(response: { body: NodeJS.ReadableStream }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
