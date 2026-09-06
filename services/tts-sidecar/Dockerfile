# The TTS sidecar is upstream Kokoro-FastAPI, pinned. It is deliberately not a
# fork: spec section Constraints/Stack locks the Kokoro-FastAPI HTTP contract as
# this product's TTS interface (ADR 0006), so the value we add here is the pin
# and the liveness probe, not a rebuild.
#
# Build context is THIS directory, not the repository root:
#
#     docker build -t xplainer/tts:dev services/tts-sidecar
#
# The image copies nothing out of the workspace, so the small context keeps the
# build fast and needs no ignore file. The same context is used by acceptance
# criterion AC-11b and by the `images` job in .github/workflows/ci.yml.
#
# Pinned by digest, never by tag. `:latest` and `:v0.8.1` both resolve to this
# multi-arch index (linux/amd64 + linux/arm64) today, and a tag is free to move
# underneath us. The same digest is KOKORO_IMAGE in
# src/xplainer_tts_sidecar/config.py, and tests/test_config.py fails if the two
# ever disagree — so change them together.
FROM ghcr.io/remsky/kokoro-fastapi-cpu@sha256:28d6f0b6e4df369559012578299d201b855a08fac466f616653edd1f08c5370a

# Kokoro-FastAPI listens on 8880; the base image declares no port of its own.
EXPOSE 8880

# /v1/audio/voices is the cheapest endpoint that proves the model is actually
# loaded — it answers only once startup has finished, where a bare TCP connect
# would report healthy while synthesis still 503s. The long start period is not
# padding: the CPU image loads the voice pack before it serves anything.
#
# `python` is on PATH from the base image's own virtualenv (/app/.venv/bin), so
# this needs no curl and adds no layer.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8880/v1/audio/voices', timeout=5).status == 200 else 1)"]

# ENTRYPOINT/CMD, USER and WORKDIR are inherited from the pinned base image
# (`./entrypoint.sh` as appuser in /app) and are deliberately not restated: a
# copy here would silently stop tracking upstream at the next digest bump.
