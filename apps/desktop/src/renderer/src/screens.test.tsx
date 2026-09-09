/**
 * The three screens, rendered from documents a real daemon really produced.
 *
 * P2-3 asks for each screen to be exercised against T21's routes with a real started daemon and a
 * named assertion per screen, and that is what these are: an `xplainer serve` on an ephemeral port,
 * spawned through a real payload the way decision D10 spawns it; a real `/api/videos` fetched over
 * the real authenticated bridge; a real still queued over the real enqueue route; and the real
 * server-sent events that job emitted, reduced by the reducer the window uses.
 *
 * The components are rendered with `react-dom/server`, which needs no browser and no DOM
 * implementation: what is asserted is the markup each screen produces from that data — the slug in
 * the library, the `xplainer-media://` URL on the `<video>` element, the job's own status on the
 * progress row. The two things a static render cannot show — that a click reaches the main process,
 * and that the frames actually play — are the shell-out suite (`main/controls.test.ts`) and the
 * human end-to-end run respectively.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonBridge, type JobStreamEvent } from "../../main/bridge";
import { discover } from "../../main/discovery";
import {
  cleanUpFixtures,
  type LiveDaemon,
  payloadResources,
  recordToolchain,
  startDaemon,
  temporaryDirectory,
} from "../../main/testing/live-daemon";
import { mediaUrl, VIDEOS_PATH } from "../../shared/daemon-api";
import type { DiscoveryMessage } from "../../shared/ipc";
import { filmOf, type LibraryVideo, readLibrary, stillsOf } from "./library";
import { applyJobEvent, beginWatch, type JobWatch } from "./progress";
import { Library } from "./screens/Library";
import { Player } from "./screens/Player";
import { Progress } from "./screens/Progress";
import { Settings } from "./screens/Settings";

/** React escapes what it renders, so an asserted line has to be compared in the same form. */
function escapeMarkup(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A daemon start, a queued job and its whole stream fit inside this. */
const CASE_TIMEOUT_MS = 90_000;

/** The bytes the player's assertions are about. Short, and recognisable a byte at a time. */
const MP4_BYTES = Buffer.from("0123456789abcdef", "utf8");

/** A still the layout strip shows. Not a real PNG; nothing here decodes one. */
const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");

afterAll(async () => {
  await cleanUpFixtures();
}, CASE_TIMEOUT_MS);

/**
 * A real daemon with one rendered video and one still on disk.
 *
 * The toolchain marker is written by the CLI's own fixture writer, because a daemon without one is
 * `degraded` and says so — which is what the settings screen shows, and what the library screen is
 * asserted beside. What is *not* arranged here is the render workspace: it is a few hundred
 * megabytes of browser and packages, and no assertion on this page is about one. The job these
 * tests follow is a dry-run narration, which needs none of it and still produces a real queue, a
 * real child process and a real stream.
 */
async function daemonWithVideo(slug: string): Promise<{ live: LiveDaemon; bridge: DaemonBridge }> {
  const resources = payloadResources();
  const stateDir = temporaryDirectory();
  const live = await startDaemon({ resources, stateDir });
  const workspace = join(stateDir, "workspace");
  mkdirSync(join(workspace, "videos", slug), { recursive: true });
  mkdirSync(join(workspace, "out", slug), { recursive: true });
  mkdirSync(join(workspace, "public", slug), { recursive: true });
  writeFileSync(join(workspace, "out", slug, "explainer.mp4"), MP4_BYTES);
  writeFileSync(join(workspace, "out", slug, "frame-30.png"), PNG_BYTES);
  writeFileSync(join(workspace, "public", slug, "timings.json"), '{"scenes":[]}\n');
  recordToolchain(stateDir, workspace);
  return { live, bridge: new DaemonBridge({ url: live.url, tokenFile: live.tokenFile }) };
}

/** The library as the window holds it, read over the real bridge from the real route. */
async function libraryOf(bridge: DaemonBridge): Promise<LibraryVideo[]> {
  const answer = await bridge.json({ path: VIDEOS_PATH });
  expect(answer.status).toBe(200);
  return readLibrary(answer.body);
}

describe("the library screen", () => {
  it(
    "lists what the daemon answered, with each video's own state under its name",
    async () => {
      const { bridge } = await daemonWithVideo("screen-library");
      const videos = await libraryOf(bridge);

      const markup = renderToStaticMarkup(
        <Library
          videos={videos}
          selected={null}
          busy={false}
          onSelect={() => undefined}
          onQueue={() => undefined}
          onRefresh={() => undefined}
        />,
      );

      expect(markup).toContain('data-slug="screen-library"');
      expect(markup).toContain("screen-library");
      // The state line is the daemon's own facts, not a guess: this video has a render, a still and
      // a timings document on disk, and the daemon reported all three.
      expect(markup).toContain("narrated");
      expect(markup).toContain("rendered");
      expect(markup).toContain("1 still");
      // Two verbs, and no third: `explainer_narrate` needs a document a window cannot compose.
      expect(markup).toContain('data-action="render"');
      expect(markup).toContain('data-action="still"');
      expect(markup).not.toContain('data-action="narrate"');
      expect(markup).toContain(">Render<");
      expect(markup).toContain(">Still<");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "says so plainly when the daemon has nothing to list",
    async () => {
      const resources = payloadResources();
      const live = await startDaemon({ resources, stateDir: temporaryDirectory() });
      const bridge = new DaemonBridge({ url: live.url, tokenFile: live.tokenFile });

      const videos = await libraryOf(bridge);
      expect(videos).toEqual([]);

      const markup = renderToStaticMarkup(
        <Library
          videos={videos}
          selected={null}
          busy={false}
          onSelect={() => undefined}
          onQueue={() => undefined}
          onRefresh={() => undefined}
        />,
      );
      expect(markup).toContain("Nothing here yet");
    },
    CASE_TIMEOUT_MS,
  );
});

describe("the player screen", () => {
  it(
    "plays the artefact the daemon answered with, over the media scheme and nothing else",
    async () => {
      const { live, bridge } = await daemonWithVideo("screen-player");
      const [video] = await libraryOf(bridge);
      expect(video).toBeDefined();
      if (video === undefined) {
        return;
      }

      const film = filmOf(video);
      expect(film?.url).toBe(`${VIDEOS_PATH}/screen-player/artefacts/explainer.mp4`);

      const markup = renderToStaticMarkup(<Player video={video} mediaUrl={mediaUrl} />);

      // The `<video>` element's source is the daemon's own artefact path carried whole, behind the
      // scheme the main process authenticates. Neither the daemon's origin nor the token is in the
      // page — and the bytes are reachable, which the fetch below proves rather than assumes.
      expect(markup).toContain(
        `src="xplainer-media://artefact${VIDEOS_PATH}/screen-player/artefacts/explainer.mp4"`,
      );
      expect(markup).not.toContain(live.url);
      expect(markup).not.toContain(live.token());
      expect(markup).toContain("<video");

      const still = stillsOf(video)[0];
      expect(still?.name).toBe("frame-30.png");
      expect(markup).toContain(`src="${mediaUrl(still?.url ?? "")}"`);

      // What the element would load, loaded: the same path, over the same bridge the main process
      // puts behind that scheme.
      const bytes = await bridge.media(film?.url ?? "");
      expect(bytes.status).toBe(200);
      bytes.body.destroy();
    },
    CASE_TIMEOUT_MS,
  );
});

describe("the progress screen", () => {
  it(
    "shows a real job's own status, from the events its stream carried",
    async () => {
      const { bridge } = await daemonWithVideo("screen-progress");

      // A dry-run narration: a real job through the real queue, measured from an estimate rather
      // than from speech, so nothing has to be acquired for it. It is queued at the daemon's own
      // route — the window's two verbs are the ones that take no arguments, and this one does.
      const queued = await bridge.json({
        path: `${VIDEOS_PATH}/screen-progress/narrate`,
        method: "POST",
        body: JSON.stringify({
          dry_run: true,
          narration: { segments: [{ id: "one", text: "One short line." }] },
        }),
      });
      expect(queued.status).toBe(202);
      const events = (queued.body as { events: string }).events;

      const seen: JobStreamEvent[] = [];
      await bridge.subscribe(events, (event) => {
        seen.push(event);
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[seen.length - 1]?.name).toBe("end");

      // The window's own reducer, over the events the daemon actually sent.
      const subscription = 1;
      let watch: JobWatch = beginWatch({
        subscription,
        slug: "screen-progress",
        verb: "narrate",
      });
      for (const event of seen) {
        watch = applyJobEvent(watch, {
          subscription,
          kind: event.name === "end" ? "end" : "job",
          data: event.data,
        });
      }
      expect(watch.ended).toBe(true);
      expect(watch.snapshot).not.toBeNull();

      // The reducer's last word and the stream's last word are the same word.
      const streamed = seen.filter((event) => event.name === "job");
      const final = streamed[streamed.length - 1]?.data as { status: string } | undefined;
      const status = watch.snapshot?.status ?? "";
      expect(status).toBe(final?.status);
      expect(status).toBe("done");
      const markup = renderToStaticMarkup(<Progress watches={[watch]} now={Date.now()} />);

      expect(markup).toContain('data-slug="screen-progress"');
      expect(markup).toContain(`data-status="${status}"`);
      expect(markup).toContain("narrate");
      // The row shows what the daemon said, in the daemon's own words: the status it reported and
      // the lines the child process actually wrote.
      expect(markup).toContain(status);
      const written = watch.snapshot?.lines ?? [];
      expect(written.length).toBeGreaterThan(0);
      expect(markup).toContain(escapeMarkup(written[0] ?? ""));
    },
    CASE_TIMEOUT_MS,
  );

  it("shows nothing rather than something invented before a window has queued anything", () => {
    const markup = renderToStaticMarkup(<Progress watches={[]} now={Date.now()} />);
    expect(markup).toContain("Nothing queued from this window yet");
  });
});

describe("the settings screen", () => {
  it(
    "reports where the daemon is and offers both controls, from a real discovery",
    async () => {
      const { live } = await daemonWithVideo("screen-settings");
      const discovery = await discover({
        resourcesPath: payloadResources(),
        stateDir: live.stateDir,
        env: { ...process.env, XPLAINER_STATE_DIR: live.stateDir },
      });
      const message: DiscoveryMessage = {
        outcome: discovery.outcome,
        action: discovery.action,
        detail: discovery.detail,
        url: discovery.url,
        stateDir: discovery.stateDir,
        tokenFile: discovery.tokenFile,
        condition: discovery.report.condition,
        sentences: discovery.report.sentences,
      };

      const markup = renderToStaticMarkup(
        <Settings
          discovery={message}
          connecting={null}
          connectResult={null}
          installing={false}
          installResult={null}
          onConnect={() => undefined}
          onStartAtLogin={() => undefined}
        />,
      );

      expect(markup).toContain(discovery.outcome);
      expect(markup).toContain(discovery.stateDir);
      expect(markup).toContain('data-vendor="claude"');
      expect(markup).toContain('data-vendor="codex"');
      expect(markup).toContain('data-control="start-at-login"');
      // A path, never a value: the token file is named on the discovery message and the token
      // itself has no way to reach this screen.
      expect(markup).not.toContain(live.token());
    },
    CASE_TIMEOUT_MS,
  );

  it("names the stage a control ran through, which is the whole of what D10 claims", () => {
    const markup = renderToStaticMarkup(
      <Settings
        discovery={null}
        connecting={null}
        connectResult={{
          event: "control_ran",
          stage: "payload",
          executable: "/Applications/Xplainer.app/Contents/Resources/xplainer-runtime/bin/node",
          argv: [
            "/Applications/Xplainer.app/Contents/Resources/xplainer-runtime/lib/node_modules/@xplainer/cli/dist/bin.js",
            "connect",
            "claude",
          ],
          ok: true,
          exitCode: 0,
          detail: 'registered the MCP server "xplainer" with Claude Code.',
        }}
        installing={false}
        installResult={null}
        onConnect={() => undefined}
        onStartAtLogin={() => undefined}
      />,
    );

    expect(markup).toContain('data-stage="payload"');
    expect(markup).toContain("packaged runtime");
    expect(markup).toContain("xplainer-runtime/bin/node /Applications");
    expect(markup).toContain("dist/bin.js connect claude");
  });
});
