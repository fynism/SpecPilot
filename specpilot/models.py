"""Validated models shared by the tool runtime."""

from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ToolInput(BaseModel):
    """Base class for strict tool arguments."""

    model_config = ConfigDict(extra="forbid", strict=True)


class EmptyInput(ToolInput):
    pass


class SearchNotesInput(ToolInput):
    query: str = Field(min_length=1, description="Text to search for in Markdown notes.")


class ReadNotesInput(ToolInput):
    path: str = Field(min_length=1, description="Note path relative to the notes directory.")


class PwshInput(ToolInput):
    command: str = Field(min_length=1, description="PowerShell command to execute.")


class ToolSpec(BaseModel):
    """Model-facing declaration of a tool and its validated input type."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=1)
    input_model: type[ToolInput]

    def to_anthropic(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_model.model_json_schema(),
        }


class RegisteredTool(BaseModel):
    """A specification paired with its implementation."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    spec: ToolSpec
    handler: Callable[[Any], str]


class ToolCall(BaseModel):
    """A normalized, validated call passed through execution hooks."""

    model_config = ConfigDict(frozen=True)

    name: str
    input: dict[str, Any]

