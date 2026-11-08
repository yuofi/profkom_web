"""The five KKR criteria of the owner's table (2026-11-08): wording, order and multipliers on both
sides; the automatic deadline premium is the only urgency; a stored key the table does not name is
ignored, so a record carrying one scores as if it were absent."""
from dataclasses import fields
from datetime import datetime
from itertools import product
import json
import math
from pathlib import Path
import re

import pytest
from pydantic import ValidationError

from database import (KKR_CRITERIA, KKR_CRITERIA_TABLE, ContributionORM, TaskORM, _xlsx_criteria,
                      calculate_kkr_score, criteria_flags, db)
from models import Criteria
from profile_features_models import KkrTemplateORM
from test_kkr_iteration import batch, close_task, payload
from test_v13_tracker import work  # noqa: F401

OWNER_TABLE = [
    ("unique", "Задача уникальная", 1.2),
    ("in_person", "Требует очного присутствия", 1.2),
    ("creative", "Задача требует творческого подхода", 1.3),
    ("external_communication", "Требует общения с администрацией или людьми вне вуза", 1.1),
    ("fixed_time", "Выполняется в определённое время", 1.1),
]
KEYS = [key for key, _, _ in OWNER_TABLE]
FACTORS = {key: factor for key, _, factor in OWNER_TABLE}
# A key no table names: a stored record that carries one scores and reads as if it were absent.
UNKNOWN = {"retired_criterion": True}
KKR_CRITERIA_TS = Path(__file__).resolve().parents[2] / "frontend/src/utils/kkrCriteria.ts"
ASSIGNED, DEADLINE = "2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z"  # three available days: weight × 1.5


def expected_score(assigned, deadline, criteria, hours, evaluation, completed=None):
    """The formula written out independently: the deadline premium, the product of the five factors,
    the evaluation and the lateness penalty."""
    if evaluation == 0:
        return 0.0
    def parse(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    days = max(0.0, (parse(deadline) - parse(assigned)).total_seconds() / 86400) if deadline else None
    weight = hours * (1 + 1 / math.sqrt(days + 1)) if deadline else hours
    factor = math.prod(v for k, v in FACTORS.items() if criteria.get(k))
    if evaluation == -1:
        return -factor * weight
    late = max(0.0, (parse(completed) - parse(deadline)).total_seconds() / 86400) if completed and deadline else 0.0
    return max(0.0, 1 - late / 3) * factor * evaluation * weight


def test_the_backend_table_is_the_owners_table_in_its_order_and_wording():
    assert list(KKR_CRITERIA_TABLE) == OWNER_TABLE
    assert list(KKR_CRITERIA.items()) == [(key, label) for key, label, _ in OWNER_TABLE]


def test_every_criteria_shape_declares_the_table_keys_in_order():
    from main import CriteriaSchema
    from profile_features import TemplateCriteria
    assert [f.name for f in fields(Criteria)] == KEYS
    assert list(CriteriaSchema.model_fields) == KEYS and list(TemplateCriteria.model_fields) == KEYS
    assert all(not value for value in CriteriaSchema().model_dump().values())
    assert json.loads(TaskORM.__table__.c.criteria_json.default.arg) == dict.fromkeys(KEYS, False)
    # A client cannot send a criterion the table does not name.
    for schema in (CriteriaSchema, TemplateCriteria):
        with pytest.raises(ValidationError):
            schema(**UNKNOWN)


def test_the_frontend_names_the_criteria_the_same_in_the_same_order():
    source = KKR_CRITERIA_TS.read_text(encoding="utf-8")
    labels = source[source.index("criteriaLabels"):]
    labels = labels[:labels.index("};")]
    assert re.findall(r'^\s*(\w+): "([^"]+)",', labels, re.M) == list(KKR_CRITERIA.items())


@pytest.mark.parametrize("chosen", [dict(zip(KEYS, bits)) for bits in product([False, True], repeat=5)])
@pytest.mark.parametrize("deadline,evaluation,completed", [
    (DEADLINE, 1, None), (DEADLINE, 1.5, "2026-01-05T00:00:00Z"), (DEADLINE, -1, None),
    (None, 1, None), (None, -1, None), (DEADLINE, 0, None),
])
def test_a_record_scores_by_its_criteria_and_an_unknown_key_changes_nothing(chosen, deadline, evaluation, completed):
    expected = expected_score(ASSIGNED, deadline, chosen, 4, evaluation, completed)
    assert calculate_kkr_score(ASSIGNED, deadline, chosen, 4, evaluation, completed) == pytest.approx(expected)
    stored = json.loads(json.dumps({**chosen, **UNKNOWN}))  # as read back from criteria_json
    assert calculate_kkr_score(ASSIGNED, deadline, stored, 4, evaluation, completed) == pytest.approx(expected)
    assert criteria_flags(json.dumps(stored)) == chosen


def test_the_deadline_premium_is_the_only_urgency():
    # Three available days: weight = 4 × (1 + 1/√4) = 6. No criterion adds to it.
    assert calculate_kkr_score(ASSIGNED, DEADLINE, {}, 4, 1) == pytest.approx(6)
    assert calculate_kkr_score(ASSIGNED, DEADLINE, UNKNOWN, 4, 1) == pytest.approx(6)
    # A deadline at the moment of assignment doubles the hours.
    assert calculate_kkr_score(ASSIGNED, "2026-01-01T00:00:00Z", {}, 4, 1) == pytest.approx(8)
    every = dict.fromkeys(KEYS, True)
    assert calculate_kkr_score(ASSIGNED, DEADLINE, every, 4, 1) == pytest.approx(6 * math.prod(FACTORS.values()))
    # A day late: the lateness penalty applies to the whole product.
    assert calculate_kkr_score(ASSIGNED, DEADLINE, every, 4, 1, "2026-01-05T00:00:00Z") == pytest.approx(
        6 * math.prod(FACTORS.values()) * (2 / 3))


def test_the_export_names_ticked_criteria_in_table_order():
    assert _xlsx_criteria('{"creative": true, "unique": true, "in_person": false}') == "Задача уникальная, Задача требует творческого подхода"
    assert _xlsx_criteria('{"fixed_time": true, "in_person": true}') == "Требует очного присутствия, Выполняется в определённое время"
    assert _xlsx_criteria('{"legacy": true}') == "legacy"


def test_a_stored_task_with_an_unknown_key_keeps_its_score_and_revision(client, work, superuser):
    task = work["task"]
    stored = json.dumps({"unique": True, "creative": False, "external_communication": False, "in_person": True, "fixed_time": False, **UNKNOWN})
    with db._session() as session:
        session.get(TaskORM, task["task_id"]).criteria_json = stored
        session.commit()
    stamp = close_task(task)
    value = batch(client, task, superuser)
    assert value["criteria"] == {**dict.fromkeys(KEYS, False), "unique": True, "in_person": True}
    response = client.put("/api/tasks/" + task["task_id"] + "/accounting-batch", headers=superuser.headers, json=payload(value))
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["revision"] == value["revision"]  # the same choice is no change of the criteria
    with db._session() as session:
        row = session.get(TaskORM, task["task_id"])
        assert row.criteria_json == stored
        score = session.query(ContributionORM).filter_by(assignment_id=value["assignments"][0]["assignment_id"]).one().score
        assigned, deadline = row.assigned_at, row.deadline_at
    assert score == pytest.approx(expected_score(assigned, deadline, {"unique": True, "in_person": True}, 2, 1, stamp))
    # Ticking a criterion is a change and multiplies the score; the stored unknown key goes.
    ticked = payload(saved)
    ticked["criteria"]["fixed_time"] = True
    response = client.put("/api/tasks/" + task["task_id"] + "/accounting-batch", headers=superuser.headers, json=ticked)
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == value["revision"] + 1 and response.json()["criteria"]["fixed_time"] is True
    with db._session() as session:
        assert json.loads(session.get(TaskORM, task["task_id"]).criteria_json) == ticked["criteria"]
        assert session.query(ContributionORM).filter_by(assignment_id=value["assignments"][0]["assignment_id"]).one().score == pytest.approx(score * 1.1)
    # The batch names exactly the five criteria: not one more, not one fewer.
    for criteria in ({**ticked["criteria"], **UNKNOWN}, {key: False for key in KEYS if key != "creative"}):
        wrong = payload(response.json())
        wrong["criteria"] = criteria
        assert client.put("/api/tasks/" + task["task_id"] + "/accounting-batch", headers=superuser.headers, json=wrong).status_code in (400, 422)


def test_task_inputs_and_templates_read_only_the_table_criteria(client, work, superuser):
    task = work["task"]
    with db._session() as session:
        session.get(TaskORM, task["task_id"]).criteria_json = json.dumps({"creative": True, **UNKNOWN})
        session.commit()
    inputs = client.get("/api/tasks/" + task["task_id"] + "/assessment-inputs", headers=superuser.headers)
    assert inputs.status_code == 200, inputs.text
    assert inputs.json()["criteria"] == {**dict.fromkeys(KEYS, False), "creative": True}
    values = dict(title="Шаблон", description="", hours=2, evaluation=1)
    refused = client.post("/api/kkr-templates", headers=superuser.headers, json=dict(visibility="personal", values=dict(
        values, criteria=dict(in_person=True, **UNKNOWN))))
    assert refused.status_code in (400, 422), refused.text
    created = client.post("/api/kkr-templates", headers=superuser.headers, json=dict(visibility="personal", values=dict(
        values, criteria=dict(in_person=True))))
    assert created.status_code == 200, created.text
    assert created.json()["values"]["criteria"] == {**dict.fromkeys(KEYS, False), "in_person": True}
    with db._session() as session:
        row = session.get(KkrTemplateORM, created.json()["template_id"])
        stored = json.loads(row.values_json)
        stored["criteria"] = {"in_person": True, **UNKNOWN}  # a stored template that carries an unknown key
        row.values_json = json.dumps(stored)
        session.commit()
    listed = client.get("/api/kkr-templates", headers=superuser.headers).json()["items"]
    assert [item["values"]["criteria"] for item in listed] == [{**dict.fromkeys(KEYS, False), "in_person": True}]
    prepared = client.post(f"/api/kkr-templates/{created.json()['template_id']}/prepare", headers=superuser.headers, json=dict(expected_revision=1))
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["values"]["criteria"] == listed[0]["values"]["criteria"]
