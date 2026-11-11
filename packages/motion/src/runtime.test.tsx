/**
 * The state a scene shares with the harness — registration, render holds, failures, the `<Audio>`
 * count — and the `<Composition>` declaration the harness resolves. Each test imports a fresh copy
 * of the modules, because that state is module-level by design (one copy per bundle).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Modules = {
  runtime: typeof import("./runtime.js");
  composition: typeof import("./composition.js");
  context: typeof import("./context.js");
  components: typeof import("./components.js");
};

async function fresh(): Promise<Modules> {
  vi.resetModules();
  return {
    runtime: await import("./runtime.js"),
    composition: await import("./composition.js"),
    context: await import("./context.js"),
    components: await import("./components.js"),
  };
}

let modules: Modules;

beforeEach(async () => {
  modules = await fresh();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("render holds", () => {
  it("labels each hold, releases it, and tolerates a second release", () => {
    const { delayRender, continueRender, renderHolds } = modules.runtime;
    const fonts = delayRender("fonts for the title");
    const anonymous = delayRender();
    expect([...renderHolds().values()].map((hold) => hold.label)).toEqual([
      "fonts for the title",
      `unlabelled #${anonymous}`,
    ]);
    continueRender(fonts);
    continueRender(fonts);
    expect([...renderHolds().keys()]).toEqual([anonymous]);
  });

  it("carries a per-hold timeout, and refuses one that is not positive", () => {
    const { delayRender, renderHolds } = modules.runtime;
    const handle = delayRender("chart data", { timeoutInMilliseconds: 5000 });
    expect(renderHolds().get(handle)?.timeoutMs).toBe(5000);
    expect(() => delayRender("x", { timeoutInMilliseconds: 0 })).toThrow(/timeoutInMilliseconds/);
  });

  it("cancelRender records PAGE_ERROR: cancelRender with the reason", () => {
    const { cancelRender, recordedFailures } = modules.runtime;
    cancelRender(new Error("the chart data did not load"));
    cancelRender("a plain reason");
    expect(recordedFailures()).toEqual([
      "PAGE_ERROR: cancelRender: the chart data did not load",
      "PAGE_ERROR: cancelRender: a plain reason",
    ]);
  });

  it("keeps a repeated failure once", () => {
    const { recordFailure, recordedFailures } = modules.runtime;
    recordFailure("PAGE_ERROR: x");
    recordFailure("PAGE_ERROR: x");
    expect(recordedFailures()).toEqual(["PAGE_ERROR: x"]);
  });
});

describe("<Audio> mounts", () => {
  it("warn once when a second is mounted at the same time, and never console.error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mountAudio } = modules.runtime;
    const unmountFirst = mountAudio();
    expect(warn).not.toHaveBeenCalled();
    const unmountSecond = mountAudio();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/more than one <Audio>/);
    mountAudio();
    unmountSecond();
    unmountFirst();
    mountAudio();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("registration", () => {
  it("hands the entry to a listener, whether it subscribed before or after", () => {
    const { registerEntry, onRegistration } = modules.runtime;
    const Root = (): null => null;
    const early: string[] = [];
    onRegistration((entry) => early.push(entry.kind));
    registerEntry({ kind: "root", Root });
    expect(early).toEqual(["root"]);
    const late: string[] = [];
    onRegistration((entry) => late.push(entry.kind));
    expect(late).toEqual(["root"]);
  });

  it("refuses a second registration", () => {
    const Root = (): null => null;
    modules.composition.registerRoot(Root);
    expect(() => modules.composition.registerRoot(Root)).toThrow(/called twice/);
  });

  it("registerVideo defaults the id to Explainer", () => {
    const Scene = (): null => null;
    modules.composition.registerVideo({
      component: Scene,
      width: 640,
      height: 360,
      fps: 30,
      durationInFrames: 60,
      defaultProps: {},
    });
    const entry = modules.runtime.registeredEntry();
    expect(entry?.kind === "video" ? entry.registration.id : undefined).toBe("Explainer");
  });
});

describe("<Composition>", () => {
  type Props = { title: string; seconds: number };
  const Title = ({ title }: Props): React.ReactElement => <h1>{title}</h1>;

  function declare(
    calculateMetadata?: import("./composition.js").CalculateMetadataFunction<Props>,
  ): import("./context.js").VideoRegistration {
    const { Composition } = modules.composition;
    const { CompositionCollectorContext } = modules.context;
    const found: import("./context.js").VideoRegistration[] = [];
    const markup = renderToStaticMarkup(
      <CompositionCollectorContext.Provider value={(registration) => found.push(registration)}>
        <Composition
          id="Explainer"
          component={Title}
          durationInFrames={300}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={{ title: "default", seconds: 10 }}
          {...(calculateMetadata === undefined ? {} : { calculateMetadata })}
        />
      </CompositionCollectorContext.Provider>,
    );
    expect(markup).toBe("");
    const [registration] = found;
    if (registration === undefined) {
      throw new Error("the composition declared nothing");
    }
    return registration;
  }

  it("renders nothing and declares nothing outside the harness's probe", () => {
    const { Composition } = modules.composition;
    expect(
      renderToStaticMarkup(
        <Composition
          id="Explainer"
          component={Title}
          durationInFrames={1}
          fps={30}
          width={2}
          height={2}
          defaultProps={{ title: "", seconds: 0 }}
        />,
      ),
    ).toBe("");
  });

  it("resolves to its declared metadata and default props without calculateMetadata", async () => {
    const resolved = await declare().resolve(new AbortController().signal);
    expect(resolved.config).toEqual({
      id: "Explainer",
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 300,
      defaultProps: { title: "default", seconds: 10 },
      props: { title: "default", seconds: 10 },
    });
    expect(renderToStaticMarkup(resolved.render())).toBe("<h1>default</h1>");
  });

  it("lets calculateMetadata override duration, fps and props, and passes it the defaults", async () => {
    const seen: unknown[] = [];
    const registration = declare(async (options) => {
      seen.push(options.compositionId, options.props, options.defaultProps);
      return { durationInFrames: 123, fps: 25, props: { title: "measured", seconds: 4.92 } };
    });
    const resolved = await registration.resolve(new AbortController().signal);
    expect(seen).toEqual([
      "Explainer",
      { title: "default", seconds: 10 },
      { title: "default", seconds: 10 },
    ]);
    expect(resolved.config).toMatchObject({ durationInFrames: 123, fps: 25, width: 1920 });
    expect(renderToStaticMarkup(resolved.render())).toBe("<h1>measured</h1>");
  });

  it("refuses metadata a renderer cannot use", async () => {
    const fractional = declare(() => ({ durationInFrames: 12.5 }));
    await expect(fractional.resolve(new AbortController().signal)).rejects.toThrow(
      /durationInFrames must be a positive whole number, got 12.5/,
    );
    const noFps = declare(() => ({ fps: 0 }));
    await expect(noFps.resolve(new AbortController().signal)).rejects.toThrow(/fps must be/);
  });
});

describe("the package entry", () => {
  it("imports in Node with no DOM and no side effects", async () => {
    vi.resetModules();
    expect(Reflect.has(globalThis, "window")).toBe(false);
    const entry = await import("./index.js");
    expect(typeof entry.interpolate).toBe("function");
    expect(Reflect.has(globalThis, "__xplainer")).toBe(false);
  });
});
