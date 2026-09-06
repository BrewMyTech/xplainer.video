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
    JobErrorCode,
    JobState,
)


def _error_record(error_code: object) -> dict[str, object]:
    """A terminal explainer_job record carrying the given error_code.

    Args:
        error_code: The value to put in the ``error_code`` field.

    Returns:
        A mapping ExplainerJobOutput accepts apart from that one field.
    """
    return {
        "job_id": 1,
        "job_type": "explainer_render",
        "status": "error",
        "exit_code": 1,
        "error": "the render exited 1",
        "error_code": error_code,
        "started_at": "2026-09-06T12:00:00+00:00",
        "finished_at": "2026-09-06T12:00:01+00:00",
        "output": {"lines": []},
    }


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
        "error_code",
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


def test_a_known_error_code_decodes_to_its_own_member() -> None:
    for member in JobErrorCode:
        parsed = ExplainerJobOutput.model_validate(_error_record(member.value))
        assert parsed.error_code is member


def test_an_unknown_error_code_decodes_to_the_documented_fallback() -> None:
    # The enum is open: adding a member is a minor contract change (ADR 0024's
    # note of 2026-09-06), so a record written by a newer daemon must parse here
    # rather than raise. Without codegen's `_missing_` hook this raises
    # ValidationError, which is what made the earlier draft of ADR 0025's
    # tolerance promise unkeepable.
    parsed = ExplainerJobOutput.model_validate(_error_record("disk_full"))
    assert parsed.error_code is JobErrorCode.internal
    assert JobErrorCode("some_code_from_2027") is JobErrorCode.internal


def test_a_non_string_error_code_is_still_rejected() -> None:
    # Tolerance is for a newer contract, not for a malformed record.
    with pytest.raises(ValidationError):
        ExplainerJobOutput.model_validate(_error_record(7))


def test_error_code_may_still_be_null() -> None:
    assert ExplainerJobOutput.model_validate(_error_record(None)).error_code is None
