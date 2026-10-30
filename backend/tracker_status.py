"""Public tracker vocabulary; private assignment outcomes keep their own states."""

STATUSES = ("open", "in_progress", "completed", "closed")
LABELS = {"open": "Открыта", "in_progress": "В работе", "completed": "Выполнена", "closed": "Закрыта"}
ALIASES = {
    "assigned": "open", "help_required": "in_progress", "needs_revision": "in_progress",
    "submitted": "completed", "accepted": "closed", "not_completed": "closed", "cancelled": "closed",
}


def public_status(value):
    return ALIASES.get(value, value) if value else "open"
