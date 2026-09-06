"""The contract manifest, Python side.

Every Python surface that serves or checks the protocol iterates ``TOOL_NAMES``
rather than writing the eight names out, so the one thing worth proving here is
that the tuple still says exactly what ``schemas/manifest.json`` says, in the
same order. If it ever drifts, every one of those surfaces drifts with it.

``ENGINE_OWNED_FILES`` is held to the same standard, and to one more: it must
equal the ``not``/``enum`` in ``explainer_put_source``'s input schema. Nothing in
Python enforces that list yet — ``apps/api``'s tools are placeholders in this
phase — so this test is what stops the constant and the published schema drifting
apart in the meantime, and it is the reason the hosted implementation will have
the right five names to refuse the day it is written (ADR 0018).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from xplainer_protocol.manifest import ENGINE_OWNED_FILES, TOOL_NAMES

SCHEMAS_DIR = Path(__file__).resolve().parent.parent / "schemas"

# The eight tools, spelled out once, from spec section Constraints/Contract.
CONTRACT_TOOL_NAMES = (
    "explainer_create",
    "explainer_put_source",
    "explainer_put_media",
    "explainer_narrate",
    "explainer_still",
    "explainer_render",
    "explainer_job",
    "explainer_list",
)


# The five scaffold files the engine owns, spelled out once. They mount the
# narration audio, the caption track and the per-segment sequencing, so an agent
# that rewrote one could ship a video that renders successfully and is silent.
ENGINE_OWNED = (
    "index.ts",
    "types.ts",
    "Root.tsx",
    "Captions.tsx",
    "Video.tsx",
)


def _manifest() -> dict[str, Any]:
    manifest: dict[str, Any] = json.loads(
        (SCHEMAS_DIR / "manifest.json").read_text(encoding="utf-8")
    )
    return manifest


def _manifest_tool_names() -> list[str]:
    tools: list[dict[str, Any]] = _manifest()["tools"]
    return [str(tool["name"]) for tool in tools]


def _put_source_reserved_paths() -> list[str]:
    """The paths explainer_put_source's input schema refuses outright."""
    schema: dict[str, Any] = json.loads(
        (SCHEMAS_DIR / "tools" / "explainer_put_source.input.json").read_text(encoding="utf-8")
    )
    path_schema: dict[str, Any] = schema["$defs"]["SourceFile"]["properties"]["path"]
    reserved: list[str] = path_schema["not"]["enum"]
    return reserved


def test_tool_names_repeat_the_manifest_in_contract_order() -> None:
    assert list(TOOL_NAMES) == _manifest_tool_names()


def test_tool_names_are_the_eight_the_contract_fixes() -> None:
    assert TOOL_NAMES == CONTRACT_TOOL_NAMES


def test_tool_names_is_a_tuple_so_a_caller_cannot_extend_the_contract() -> None:
    assert isinstance(TOOL_NAMES, tuple)


def test_every_tool_has_an_input_and_an_output_schema_on_disk() -> None:
    for name in TOOL_NAMES:
        assert (SCHEMAS_DIR / "tools" / f"{name}.input.json").is_file()
        assert (SCHEMAS_DIR / "tools" / f"{name}.output.json").is_file()


def test_engine_owned_files_repeat_the_manifest_in_scaffold_order() -> None:
    assert list(ENGINE_OWNED_FILES) == _manifest()["engine_owned_files"]


def test_engine_owned_files_are_the_five_the_contract_reserves() -> None:
    assert ENGINE_OWNED_FILES == ENGINE_OWNED


def test_put_source_schema_reserves_exactly_the_engine_owned_files() -> None:
    assert _put_source_reserved_paths() == list(ENGINE_OWNED_FILES)


def test_engine_owned_files_is_a_tuple_so_a_caller_cannot_widen_the_reservation() -> None:
    assert isinstance(ENGINE_OWNED_FILES, tuple)
