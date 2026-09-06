"""The Kokoro connection contract.

These assertions exist because each of these values is a place where a plausible
change silently breaks narration later:

* an unpinned image tag means the sidecar's Kokoro version drifts under it;
* ``/v1/audio/speech`` in place of ``/dev/captioned_speech`` returns audio with
  no word timestamps at all, and nothing fails loudly when it does;
* an env prefix that does not actually apply means every deployment override is
  silently ignored and the local default is used in production.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from xplainer_tts_sidecar.config import KOKORO_IMAGE, KokoroSettings

# The env prefix is the whole override contract, so it is written once here and
# every test below derives from it rather than repeating the literal.
ENV_PREFIX = "XPLAINER_KOKORO_"
BASE_URL_ENV = f"{ENV_PREFIX}BASE_URL"


@pytest.fixture(autouse=True)
def clear_kokoro_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """A default is only a default if the ambient environment cannot reach it.

    Without this, a developer who exports XPLAINER_KOKORO_BASE_URL to point at a
    remote Kokoro turns every default assertion below red on their machine and
    green in CI, which is the worst of both.
    """
    for name in list(os.environ):
        if name.upper().startswith(ENV_PREFIX):
            monkeypatch.delenv(name, raising=False)


def test_defaults_point_at_a_local_kokoro_on_its_documented_port() -> None:
    assert KokoroSettings().base_url == "http://localhost:8880"


def test_default_voice_matches_the_reference_implementations_fallback() -> None:
    assert KokoroSettings().default_voice == "af_heart"


def test_voices_path_is_the_openai_compatible_route() -> None:
    assert KokoroSettings().voices_path == "/v1/audio/voices"


def test_speech_path_is_the_captioned_route_not_the_plain_one() -> None:
    """Only /dev/captioned_speech returns the envelope with word timestamps."""
    settings = KokoroSettings()
    assert settings.speech_path == "/dev/captioned_speech"
    assert settings.speech_path != "/v1/audio/speech"


def test_image_is_pinned_by_digest_rather_than_by_a_movable_tag() -> None:
    image = KokoroSettings().image
    assert image == KOKORO_IMAGE
    repository, separator, digest = image.partition("@")
    assert repository == "ghcr.io/remsky/kokoro-fastapi-cpu"
    assert separator == "@", "a tag reference would carry no '@' at all"
    assert digest.startswith("sha256:")
    assert len(digest) == len("sha256:") + 64


def test_base_url_env_var_overrides_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(BASE_URL_ENV, "http://kokoro.internal:9999")
    assert KokoroSettings().base_url == "http://kokoro.internal:9999"


def test_an_unprefixed_env_var_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """The prefix is the contract: a bare BASE_URL must not reach these settings."""
    monkeypatch.setenv("BASE_URL", "http://not-kokoro.example:1234")
    assert KokoroSettings().base_url == "http://localhost:8880"


def test_the_dockerfile_pins_exactly_the_image_the_settings_name() -> None:
    """The FROM line and KOKORO_IMAGE are one decision written in two files."""
    dockerfile = Path(__file__).resolve().parent.parent / "Dockerfile"
    from_lines = [
        line.strip()
        for line in dockerfile.read_text(encoding="utf-8").splitlines()
        if line.startswith("FROM ")
    ]
    assert from_lines == [f"FROM {KOKORO_IMAGE}"]
