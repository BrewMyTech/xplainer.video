"""Kokoro-FastAPI connection contract for the xplainer TTS sidecar.

This package holds how to reach Kokoro and which image to run, and nothing else.
Synthesis, WAV assembly, word timings and caption emission are narrate.py's job
and land at roadmap phase 1 (spec section Non-Goals).
"""

from __future__ import annotations

from xplainer_tts_sidecar.config import KOKORO_IMAGE, KokoroSettings

__all__ = ["KOKORO_IMAGE", "KokoroSettings"]
