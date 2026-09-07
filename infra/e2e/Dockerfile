# The Linux half of roadmap P1-1: a headless Debian image that runs the
# end-to-end proof, `scripts/e2e/render.mjs`, against a Kokoro container.
#
# WHY AN IMAGE AND NOT A VM. P1-1 asks for the walking skeleton on "a headless
# Linux VM"; what it is really asking is whether the render survives away from
# macOS — a different Chrome build, a different Remotion compositor binary
# (`@remotion/compositor-linux-*-gnu` rather than `-darwin-arm64`), a different
# ffmpeg and no window server at all. A container settles every one of those and
# can be re-run by anyone with Docker, which a VM cannot.
#
# It is NOT built by `pnpm verify` and NOT built in the push-triggered CI jobs.
# `scripts/e2e/linux.mjs` (`pnpm e2e:render:linux`) builds and runs it, and
# `.github/workflows/e2e-linux.yml` runs the same script without this image.
#
#   docker build -f infra/e2e/Dockerfile -t xplainer-e2e-linux .
#
# The build context is the repository root, filtered by the
# `Dockerfile.dockerignore` beside this file, which says why it lives there.

# Pinned by the caller from `.node-version`, so the container runs the Node this
# repository pins rather than whatever `24` resolves to today. The default is
# the same value, for a plain `docker build` with no `--build-arg`.
ARG NODE_VERSION=24.20.0
FROM node:${NODE_VERSION}-bookworm-slim

# ffmpeg is what the CLI muxes and what the proof probes with. Everything after
# it is the Chrome headless shell's shared-library set on Debian: Remotion
# downloads the shell itself (see `remotion browser ensure` below), but not the
# system libraries it dynamically links, and a missing one surfaces as a Chrome
# that exits before it prints anything. fonts-liberation is not optional either
# — with no font on the box the captions render as empty boxes and the burned
# caption comparison would pass on the wrong pixels.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libpango-1.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# The manifests first, so an edit to a source file does not re-run the install.
# `corepack install` reads the `packageManager` pin out of the root
# package.json, which is why it comes after the copy rather than before it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version ./
COPY apps/cli/package.json apps/cli/
COPY apps/desktop/package.json apps/desktop/
COPY packages/config/package.json packages/config/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/render-core/package.json packages/render-core/
COPY packages/skill/package.json packages/skill/
COPY packages/tts-client/package.json packages/tts-client/
COPY services/tts-sidecar/package.json services/tts-sidecar/
RUN corepack install && pnpm install --frozen-lockfile

# Chrome, downloaded at build time. Remotion fetches its headless shell on first
# use; leaving that to run time would put a multi-hundred-megabyte download
# inside the measured render and make a network failure look like a render
# failure. It goes here, above the sources, because it lands in
# `node_modules/.remotion` and depends on nothing but the install above — below
# them, every edit to a single source file paid for the download again.
RUN pnpm exec remotion browser ensure

COPY . .

# The second install is not a repeat: `injectWorkspacePackages` hard-copies each
# workspace dependency at install time, and the copy made above was made from
# manifests with no sources beside them. This one re-materialises them against
# the real tree. It is a no-op for every external package.
RUN pnpm install --frozen-lockfile

# Build here rather than only at run time so that the image is a proof of a
# Linux build as well as a Linux render, and so a re-run of the container does
# not pay for it. `render.mjs` runs `pnpm turbo build` again itself — against
# the cache this leaves behind, so it costs a second and still guarantees the
# CLI under test is this commit's.
RUN pnpm turbo build

# `render.mjs` writes its transcript and its sample MP4 here. The caller
# bind-mounts a host directory over it; without one the artefacts stay in the
# container's own filesystem and the run still passes.
ENV COLLIE_ARTIFACTS_DIR=/artifacts
RUN mkdir -p /artifacts

# No CMD arguments and no ENTRYPOINT script: the whole point of the image is
# this one command, and overriding it with `docker run ... <cmd>` is how you get
# a shell in the same environment to debug a failure.
CMD ["pnpm", "e2e:render"]
