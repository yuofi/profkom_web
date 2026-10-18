"""Workflow helpers send the current revision explicitly; wire failures stay visible."""

from database import db


def post_season(client, path, **kwargs):
    payload = kwargs.pop("json", None) or {}
    sid = path.split("/")[-2]
    if "expected_revision" not in payload:
        payload = {**payload, "expected_revision": db.get_season(sid).revision}
    return client.post(path, json=payload, **kwargs)
