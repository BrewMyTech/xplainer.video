"""The xplainer tool contract, Python side.

``schemas/`` in this package is the source of truth. The pydantic models and the
tool manifest under ``xplainer_protocol.generated`` are produced from it by
``scripts/codegen.mjs``, which writes the TypeScript and the Python halves in one
invocation so the two can never describe different contracts.
"""

from xplainer_protocol.manifest import ENGINE_OWNED_FILES, TOOL_NAMES

__all__ = ["ENGINE_OWNED_FILES", "TOOL_NAMES"]
