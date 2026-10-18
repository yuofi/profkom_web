"""Stable anonymous accounting identity after irreversible account cleanup."""


def participant_id(uid, session=None):
    from database import db
    from domain_models import AccountArchiveORM

    if session is None:
        with db._session() as session:
            return participant_id(uid, session)
    archived = session.get(AccountArchiveORM, uid)
    return (
        archived.anonymous_participant_id
        if archived and archived.purged_at
        else f"participant-{uid}"
    )
