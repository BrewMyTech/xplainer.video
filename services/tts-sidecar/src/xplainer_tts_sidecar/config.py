"""How the sidecar reaches Kokoro-FastAPI.

Every value here is inherited from the reference implementation rather than
invented, so the scaffold pins the contract roadmap phase 1 will execute against
instead of re-deriving it:

* ``base_url`` mirrors ``DEFAULT_SERVER`` at ``max/.explainers/scripts/narrate.py:57``.
* ``voices_path`` is the endpoint queried at ``narrate.py:126``.
* ``speech_path`` is the endpoint posted to at ``narrate.py:162``. It is the
  ``/dev/`` captioned-speech route, not ``/v1/audio/speech``: only the former
  returns the JSON envelope carrying per-word timestamps.
* ``default_voice`` mirrors the fallback at ``narrate.py:192``.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict

# Pinned by digest, never by tag. `ghcr.io/remsky/kokoro-fastapi-cpu:latest` and
# `:v0.8.1` both resolve to this multi-arch index (linux/amd64 + linux/arm64)
# today, and a tag is free to move underneath us; a digest is not. The same
# digest is the FROM line of this service's Dockerfile, and the two must be
# changed together.
KOKORO_IMAGE = (
    "ghcr.io/remsky/kokoro-fastapi-cpu"
    "@sha256:28d6f0b6e4df369559012578299d201b855a08fac466f616653edd1f08c5370a"
)


class KokoroSettings(BaseSettings):
    """Connection settings for a Kokoro-FastAPI instance.

    Every field has a working local default, so constructing this never requires
    an environment. Each is overridable through ``XPLAINER_KOKORO_<FIELD>``.
    """

    model_config = SettingsConfigDict(env_prefix="XPLAINER_KOKORO_")

    base_url: str = "http://localhost:8880"
    image: str = KOKORO_IMAGE
    voices_path: str = "/v1/audio/voices"
    speech_path: str = "/dev/captioned_speech"
    default_voice: str = "af_heart"
