"""Domain input invariants shared by HTTP commands and summary corrections."""

from errors import InvalidInput
import math
from pydantic import BaseModel, ConfigDict, field_validator, ValidationInfo
from participation import dt


def timestamp(value):
    return dt(value).isoformat()


def period(assigned, deadline, season_end, start="assigned_at", start_moved=False):
    """assigned_at <= deadline_at <= season end, refused with the field to correct.

    The deadline is named by default, with its allowed range. The start (``start``)
    is named instead when only the start moved or the start itself is past the season
    end. With ``start=None`` the start is now (a new task): when the season has already
    ended there is no allowed deadline, which ``season_ended`` says.
    """
    a, d, e = map(dt, (assigned, deadline, season_end))
    if a <= d <= e:
        return
    message = "Dates must satisfy assigned_at <= deadline_at <= season ends_at"
    if a > e and start is None:
        raise InvalidInput(message, "season_ended", deadline_at="out_of_range", latest=e.isoformat())
    if a > e or (start_moved and d < a):
        raise InvalidInput(message, "assigned_out_of_range", latest=min(d, e).isoformat(), **{start: "out_of_range"})
    raise InvalidInput(
        message, "deadline_out_of_range", deadline_at="out_of_range", earliest=a.isoformat(), latest=e.isoformat()
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
