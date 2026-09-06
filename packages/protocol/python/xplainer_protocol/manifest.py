"""The contract manifest, re-exported from the generated module.

Every Python surface that serves or checks the protocol imports ``TOOL_NAMES``
from here rather than writing the names out, so a tool added to
``schemas/manifest.json`` reaches all of them at once and a tool missing from one
of them is a test failure rather than a silent gap.

``ENGINE_OWNED_FILES`` is here for the same reason and is the same kind of list:
the five scaffold files an agent may not write, because they mount the narration
audio, the caption track and the per-segment sequencing. The Python tools are
placeholders in this phase, so nothing enforces the list here yet; the constant
lands now so that the day ``explainer_put_source`` is implemented on the hosted
control plane it enforces the same five names as the TypeScript surfaces, from
the same source, rather than a list retyped from an ADR.

This indirection exists so callers never import from ``generated`` directly: that
package is rewritten wholesale on every codegen run.
"""

from xplainer_protocol.generated.manifest import ENGINE_OWNED_FILES, TOOL_NAMES

__all__ = ["ENGINE_OWNED_FILES", "TOOL_NAMES"]
