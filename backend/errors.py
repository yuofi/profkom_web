"""Typed domain errors: each class has one HTTP status and a stable code (FIX_PLAN 2.13).

Routes no longer read message text to choose a status (A-SEC-7): api_contract.install_errors
answers every DomainError as {detail: {code, message, fields}}. The message is a technical
English detail; the client shows Russian text by `code` (A-FE-3).

The classes also derive from ValueError or LookupError, so callers that catch those keep
working; NotFound is a LookupError.
"""


class DomainError(Exception):
    status = 500
    code = "error"

    def __init__(self, message, code=None, **fields):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.fields = fields


class NotFound(DomainError, LookupError):
    """Missing, or not readable by this user: both answer the same (A-SEC-6)."""

    status, code = 404, "not_found"


class Forbidden(DomainError, ValueError):
    """The object is readable, the action is not allowed."""

    status, code = 403, "forbidden"


class Conflict(DomainError, ValueError):
    """The state or version of the data does not allow the command now."""

    status, code = 409, "conflict"


class InvalidInput(DomainError, ValueError):
    status, code = 422, "invalid_input"


def revision_conflict(message="Conflict: revision mismatch"):
    return Conflict(message, "revision_conflict")


def season_closed(message="Conflict: season is closed"):
    return Conflict(message, "season_closed")
