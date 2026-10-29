"""The closed-summary correction and its selected template are one transaction."""
import json

from database import db
from profile_features_models import KkrTemplateUseORM
from test_merit_create_without_reason import merit_context, payload_for, request, close_season, accounting_snapshot
from test_profile_features import template


def test_closed_merit_correction_captures_template_and_stale_selection_rolls_back(client, merit_context):
    context = merit_context
    chair, sid = context["chair"], context["season"]["season_id"]
    created = request(client, chair, "POST", "/merits", payload_for(context, "chair_merit"))
    frozen = close_season(client, context)
    selected = template(client, chair)
    values = {"title": "Explicitly saved corrected work", "template_selection": {"template_id": selected["template_id"], "revision": selected["revision"]}}
    body = {"expected_version": frozen["version"], "reason": "Closed accounting correction", "changes": [
        {"kind": "merit", "id": created["merit_id"], "expected_revision": created["revision"], "values": values}]}
    changed = request(client, chair, "POST", f"/seasons/{sid}/summary/correct", body)
    with db._session() as session:
        use = session.query(KkrTemplateUseORM).one()
        assert (use.template_id, use.template_revision, use.target_kind, use.target_id, use.actor_user_id) == (
            selected["template_id"], 1, "merit", created["merit_id"], chair.user_id)
        assert json.loads(use.saved_values_json) == {"title": values["title"]}
        assert json.loads(use.template_snapshot_json) == selected["values"]
    before = accounting_snapshot()
    stale = {**body, "expected_version": changed["version"], "changes": [{**body["changes"][0],
        "expected_revision": created["revision"] + 1, "values": {**values, "title": "Must roll back",
            "template_selection": {"template_id": selected["template_id"], "revision": 999}}}]}
    denied = client.post(f"/api/seasons/{sid}/summary/correct", headers=chair.headers, json=stale)
    assert denied.status_code == 409, denied.text
    assert accounting_snapshot() == before
    with db._session() as session:
        assert session.query(KkrTemplateUseORM).count() == 1
