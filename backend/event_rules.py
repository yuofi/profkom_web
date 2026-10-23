"""Aware UTC dates and immutable closed event metadata."""

from errors import InvalidInput
from participation import dt
from validation import timestamp


def dates(season, starts_at, ends_at):
    start = timestamp(starts_at) if starts_at is not None else None
    end = timestamp(ends_at) if ends_at is not None else None
    if start and end and dt(start) > dt(end):
        raise InvalidInput("Event dates are reversed")
    if end and dt(end) > dt(season.ends_at):
        raise InvalidInput("Event ends after season")
    if start and dt(start) > dt(season.ends_at):
        raise InvalidInput("Event starts after season")
    return start, end
