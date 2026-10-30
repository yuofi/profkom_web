"""Domain input invariants shared by HTTP commands and summary corrections."""

from errors import InvalidInput
import math
from pydantic import BaseModel, ConfigDict, field_validator, ValidationInfo
from participation import dt


def timestamp(value):
    return dt(value).isoformat()


def period(assigned, deadline, season_end):
    a, d, e = map(dt, (assigned, deadline, season_end))
    if not a <= d <= e:
        raise InvalidInput(
            "Dates must satisfy assigned_at <= deadline_at <= season ends_at"
        )


def hours(value):
    if not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
        raise InvalidInput("Hours must be finite and nonnegative")


def assessment(value, completed):
    if value is not None and value not in (-1, 0, 1, 1.5):
        raise InvalidInput("Evaluation must be -1, 0, 1, or 1.5")
    if value in (1, 1.5) and not completed:
        raise InvalidInput("Positive evaluation requires a completion date")
    if completed:
        timestamp(completed)


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    @field_validator("*")
    @classmethod
    def normalize(cls, value, info: ValidationInfo):
        if value is not None and info.field_name in {
            "assigned_at",
            "deadline_at",
            "completed_at",
            "effective_completed_at",
            "starts_at",
            "ends_at",
        }:
            return timestamp(value)
        if info.field_name == "hours" and value is not None:
            hours(value)
        if info.field_name in {"expected_revision", "expected_version"} and value < 1:
            raise ValueError("Version must be positive")
        if info.field_name == "join_url" and not value.startswith(
            ("https://", "http://")
        ):
            raise ValueError("HTTP(S) meeting URL required")
        if info.field_name == "scope" and value is not None:
            if (
                set(value) != {"kind", "id"}
                or value["kind"] not in ("block", "subevent", "event", "chair")
                or not isinstance(value["id"], str)
                or not value["id"]
            ):
                raise ValueError("Exactly one valid work scope is required")
        if (
            info.field_name in {"title", "reason"}
            and value is not None
            and not value.strip()
        ):
            raise ValueError("Value cannot be empty")
        return value
