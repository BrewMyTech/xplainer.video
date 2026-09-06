"""The generated pydantic models.

Codegen that produces a file which imports cleanly but validates nothing would
still pass a staleness diff, so these assertions exercise the models rather than
their existence: the slug pattern from the schema really rejects a bad slug,
``extra='forbid'`` really rejects an unknown field, and the two deliberate
divergences from max are really absent from the Python half as well as the
TypeScript one.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError
from xplainer_protocol.generated.models import (
    ExplainerCreateInput,
    ExplainerJobOutput,
    ExplainerListOutput,
    ExplainerNarrateInput,
    JobState,
)


def test_a_well_formed_create_input_parses() -> None:
    parsed = ExplainerCreateInput.model_validate({"slug": "how-dns-works"})
    assert parsed.slug == "how-dns-works"


def test_the_slug_pattern_from_the_schema_reaches_the_model() -> None:
    for bad_slug in ("How-DNS-Works", "-leading-hyphen", "has spaces", "a" * 65):
        with pytest.raises(ValidationError):
            ExplainerCreateInput.model_validate({"slug": bad_slug})


def test_an_unknown_field_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ExplainerCreateInput.model_validate({"slug": "ok", "session_name": "sneaky"})


def test_a_narration_needs_at_least_one_segment() -> None:
    ExplainerNarrateInput.model_validate(
        {"slug": "ok", "narration": {"segments": [{"id": "hook", "text": "Hi."}]}}
    )
    with pytest.raises(ValidationError):
        ExplainerNarrateInput.model_validate({"slug": "ok", "narration": {"segments": []}})


def test_job_output_drops_the_command_field_max_returns() -> None:
    assert "command" not in ExplainerJobOutput.model_fields
    assert list(ExplainerJobOutput.model_fields) == [
        "job_id",
        "job_type",
        "status",
        "exit_code",
        "error",
        "started_at",
        "finished_at",
        "output",
    ]


def test_list_output_drops_the_workspace_path_and_installed_flag() -> None:
    assert list(ExplainerListOutput.model_fields) == ["videos"]


def test_job_state_covers_the_five_lifecycle_values() -> None:
    assert [member.value for member in JobState] == [
        "queued",
        "running",
        "done",
        "error",
        "cancelled",
    ]
