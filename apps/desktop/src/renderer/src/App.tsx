/**
 * The window: four screens over one bridge.
 *
 * Everything this component does goes through `window.xplainer`, the preload's verbs — a document,
 * a queued job, a stream, a media URL, and the two one-click controls. There is no `fetch` here, no
 * origin, and no token: context isolation is on, Node integration is off, and the main process is
 * what authenticates.
 *
 * The decisions are not here either. What the library says is `library.ts`; what a job's progress
 * means is `progress.ts`; which program a control shells out to is `main/controls.ts`. What is left
 * in this file is the wiring — which screen is showing, what is in flight, and which stream belongs
 * to which row.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { EnqueueVerb } from "../../shared/daemon-api";
import { VIDEOS_PATH } from "../../shared/daemon-api";
import type {
  ConnectVendor,
  ControlMessage,
  DiscoveryMessage,
  JobSubscription,
} from "../../shared/ipc";
import { type LibraryVideo, readLibrary } from "./library";
import { applyJobEvent, beginWatch, type JobWatch } from "./progress";
import { Library } from "./screens/Library";
import { Player } from "./screens/Player";
import { Progress } from "./screens/Progress";
import { Settings } from "./screens/Settings";
import { BUTTON, COLORS, FONT, MUTED } from "./theme";

/** The four screens, in the order the tabs show them. */
const SCREENS = ["library", "player", "progress", "settings"] as const;

/** One of {@link SCREENS}. */
type Screen = (typeof SCREENS)[number];

/** How often the elapsed second on a running job is redrawn. */
const CLOCK_INTERVAL_MS = 500;

type AppProps = {
  /** The version the main process reported, via the preload bridge. */
  readonly version: string;
};

export function App({ version }: AppProps) {
  const [screen, setScreen] = useState<Screen>("library");
  const [discovery, setDiscovery] = useState<DiscoveryMessage | null>(null);
  const [videos, setVideos] = useState<LibraryVideo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [watches, setWatches] = useState<JobWatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<ConnectVendor | null>(null);
  const [connectResult, setConnectResult] = useState<ControlMessage | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<ControlMessage | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /** Every open stream, so this window does not leave one running behind a closed screen. */
  const streams = useRef<JobSubscription[]>([]);

  const refresh = useCallback(async () => {
    const answer = await window.xplainer.request({ path: VIDEOS_PATH });
    if (answer.status !== 200) {
      setNotice(`the daemon answered ${String(answer.status)} for the library.`);
      return;
    }
    setNotice(null);
    setVideos(readLibrary(answer.body));
  }, []);

  const ask = useCallback(async () => {
    setDiscovery(await window.xplainer.discover());
    await refresh();
  }, [refresh]);

  useEffect(() => {
    ask().catch((error: unknown) => {
      setNotice(sentence(error));
    });
  }, [ask]);

  // The elapsed second only ticks while something is running, so an idle window is idle.
  const live = watches.some((watch) => !watch.ended);
  useEffect(() => {
    if (!live) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [live]);

  useEffect(() => {
    const open = streams.current;
    return () => {
      for (const stream of open.splice(0)) {
        void stream.stop();
      }
    };
  }, []);

  const queue = useCallback(
    async (slug: string, verb: EnqueueVerb) => {
      setBusy(true);
      try {
        const answer = await window.xplainer.enqueue(slug, verb);
        const events = eventsPath(answer.body);
        if (answer.status !== 202 || events === null) {
          setNotice(`the daemon would not queue that ${verb}: ${describe(answer.body)}`);
          return;
        }
        setNotice(null);
        setScreen("progress");
        const stream = await window.xplainer.subscribe(events, (event) => {
          setWatches((current) => current.map((watch) => applyJobEvent(watch, event)));
          if (event.kind !== "job") {
            // The film only exists once the job is over, so the library is re-read then and not
            // on every progress event.
            refresh().catch((error: unknown) => {
              setNotice(sentence(error));
            });
          }
        });
        streams.current.push(stream);
        setWatches((current) => [
          beginWatch({ subscription: stream.subscription, slug, verb }),
          ...current,
        ]);
      } catch (error) {
        setNotice(sentence(error));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const connect = useCallback((vendor: ConnectVendor) => {
    setConnecting(vendor);
    setConnectResult(null);
    window.xplainer
      .connect(vendor)
      .then(setConnectResult)
      .catch((error: unknown) => {
        setNotice(sentence(error));
      })
      .finally(() => {
        setConnecting(null);
      });
  }, []);

  const startAtLogin = useCallback(() => {
    setInstalling(true);
    setInstallResult(null);
    window.xplainer
      .startAtLogin()
      .then(async (result) => {
        setInstallResult(result);
        // An install writes the stable launcher, which is what moves every later shell-out onto
        // decision D10's second stage — so the app asks again rather than assuming either.
        await ask();
      })
      .catch((error: unknown) => {
        setNotice(sentence(error));
      })
      .finally(() => {
        setInstalling(false);
      });
  }, [ask]);

  const current = videos.find((video) => video.slug === selected) ?? null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        margin: 0,
        fontFamily: FONT,
        color: COLORS.text,
        backgroundColor: COLORS.page,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: "0.75rem 1.5rem",
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <strong style={{ fontSize: "0.95rem" }}>Xplainer</strong>
        <span style={{ ...MUTED, fontSize: "0.75rem" }}>{version}</span>
        <nav style={{ display: "flex", gap: "0.4rem", marginLeft: "auto" }}>
          {SCREENS.map((name) => (
            <button
              key={name}
              type="button"
              data-screen={name}
              aria-current={screen === name ? "page" : undefined}
              onClick={() => {
                setScreen(name);
              }}
              style={{
                ...BUTTON,
                background: screen === name ? COLORS.raised : "transparent",
                borderColor: screen === name ? COLORS.accent : COLORS.border,
                textTransform: "capitalize",
              }}
            >
              {name}
            </button>
          ))}
        </nav>
      </header>

      {discovery !== null && discovery.outcome !== "ready" ? (
        <p
          style={{
            margin: 0,
            padding: "0.6rem 1.5rem",
            background: COLORS.raised,
            borderBottom: `1px solid ${COLORS.border}`,
            color: COLORS.warn,
            fontSize: "0.82rem",
          }}
        >
          {discovery.outcome}: {discovery.action}
        </p>
      ) : null}

      {notice === null ? null : (
        <p
          style={{
            margin: 0,
            padding: "0.6rem 1.5rem",
            background: COLORS.raised,
            borderBottom: `1px solid ${COLORS.border}`,
            color: COLORS.bad,
            fontSize: "0.82rem",
          }}
        >
          {notice}
        </p>
      )}

      {screen === "library" ? (
        <Library
          videos={videos}
          selected={selected}
          busy={busy}
          onSelect={(slug) => {
            setSelected(slug);
            setScreen("player");
          }}
          onQueue={(slug, verb) => {
            void queue(slug, verb);
          }}
          onRefresh={() => {
            refresh().catch((error: unknown) => {
              setNotice(sentence(error));
            });
          }}
        />
      ) : null}
      {screen === "player" ? <Player video={current} mediaUrl={window.xplainer.mediaUrl} /> : null}
      {screen === "progress" ? <Progress watches={watches} now={now} /> : null}
      {screen === "settings" ? (
        <Settings
          discovery={discovery}
          connecting={connecting}
          connectResult={connectResult}
          installing={installing}
          installResult={installResult}
          onConnect={connect}
          onStartAtLogin={startAtLogin}
        />
      ) : null}
    </div>
  );
}

/** The `events` URL a `202` carried, or `null` when the answer was not one. */
function eventsPath(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const events = (body as { events?: unknown }).events;
  return typeof events === "string" && events !== "" ? events : null;
}

/** A refusal body as one line, for a window that has to say what the daemon said. */
function describe(body: unknown): string {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return JSON.stringify(body);
}

/** Anything thrown, as a sentence. */
function sentence(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
