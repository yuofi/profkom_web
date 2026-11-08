"""The eight KKR criteria of the owner's table (2026-11-08): wording, order and multipliers on both
sides, and records saved with the five earlier criteria keep their scores."""
from dataclasses import fields
from datetime import datetime
from itertools import product
import json
import math
from pathlib import Path
import re

import pytest

from database import (KKR_CRITERIA, KKR_CRITERIA_TABLE, ContributionORM, TaskORM, _xlsx_criteria,
                      calculate_kkr_score, criteria_flags, db)
from models import Criteria
from profile_features_models import KkrTemplateORM
from test_kkr_iteration import batch, close_task, payload
from test_v13_tracker import work  # noqa: F401

OWNER_TABLE = [
    ("urgent", "Срочная задача", 1.5),
    ("unique", "Задача уникальная", 1.2),
    ("monotonous", "Нудная / монотонная задача", 1.2),
    ("creative", "Задача требует творческого подхода", 1.3),
    ("external_communication", "Требует общения с администрацией или людьми вне вуза", 1.1),
    ("physical", "Требуется ли физическая сила", 1.2),
    ("in_person", "Требует очного присутствия", 1.2),
    ("fixed_time", "Выполняется в определённое время", 1.1),
]
OLD_FIVE = ["unique", "creative", "external_communication", "in_person", "fixed_time"]
OLD_FACTORS = {"unique": 1.2, "creative": 1.3, "external_communication": 1.1, "in_person": 1.2, "fixed_time": 1.1}
KKR_CRITERIA_TS = Path(__file__).resolve().parents[2] / "frontend/src/utils/kkrCriteria.ts"
ASSIGNED, DEADLINE = "2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z"  # three available days: weight × 1.5


def score_before_the_eight(assigned, deadline, criteria, hours, evaluation, completed=None):
    """The formula as it was with the five criteria (before 2026-11-08), for comparison."""
    if evaluation == 0:
        return 0.0
    def parse(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    days = max(0.0, (parse(deadline) - parse(assigned)).total_seconds() / 86400) if deadline else None
    weight = hours * (1 + 1 / math.sqrt(days + 1)) if deadline else hours
    factor = math.prod(v for k, v in OLD_FACTORS.items() if criteria.get(k))
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
    keys = list(KKR_CRITERIA)
    assert [f.name for f in fields(Criteria)] == keys
    assert list(CriteriaSchema.model_fields) == keys and list(TemplateCriteria.model_fields) == keys
    assert all(not value for value in CriteriaSchema().model_dump().values())
    assert json.loads(TaskORM.__table__.c.criteria_json.default.arg) == dict.fromkeys(keys, False)


def test_the_frontend_names_the_criteria_the_same_in_the_same_order():
    source = KKR_CRITERIA_TS.read_text(encoding="utf-8")
    labels = source[source.index("criteriaLabels"):]
    labels = labels[:labels.index("};")]
    assert re.findall(r'^\s*(\w+): "([^"]+)",', labels, re.M) == list(KKR_CRITERIA.items())


@pytest.mark.parametrize("chosen", [dict(zip(OLD_FIVE, bits)) for bits in product([False, True], repeat=5)])
@pytest.mark.parametrize("deadline,evaluation,completed", [
    (DEADLINE, 1, None), (DEADLINE, 1.5, "2026-01-05T00:00:00Z"), (DEADLINE, -1, None),
    (None, 1, None), (None, -1, None), (DEADLINE, 0, None),
])
def test_a_record_with_the_five_earlier_criteria_scores_as_before(chosen, deadline, evaluation, completed):
    stored = json.loads(json.dumps(chosen))  # exactly the five keys, as stored before 2026-11-08
    assert calculate_kkr_score(ASSIGNED, deadline, stored, 4, evaluation, completed) == pytest.approx(
        score_before_the_eight(ASSIGNED, deadline, stored, 4, evaluation, completed))
    assert criteria_flags(json.dumps(stored)) == {**dict.fromkeys(KKR_CRITERIA, False), **stored}


@pytest.mark.parametrize("key,factor", [("urgent", 1.5), ("monotonous", 1.2), ("physical", 1.2)])
def test_each_new_criterion_multiplies_by_its_factor(key, factor):
    assert calculate_kkr_score(ASSIGNED, None, {key: True}, 4, 1) == pytest.approx(4 * factor)
    assert calculate_kkr_score(ASSIGNED, None, {key: True, "creative": True}, 4, 1.5) == pytest.approx(4 * factor * 1.3 * 1.5)
    assert calculate_kkr_score(ASSIGNED, None, {key: True}, 4, -1) == pytest.approx(-4 * factor)
    assert calculate_kkr_score(ASSIGNED, None, {key: False}, 4, 1) == pytest.approx(4)


def test_urgent_multiplies_on_top_of_the_automatic_deadline_premium():
    # Three available days: weight = 4 × (1 + 1/√4) = 6; the checkbox adds ×1.5 to it, it does not replace it.
    plain = calculate_kkr_score(ASSIGNED, DEADLINE, {}, 4, 1)
    assert plain == pytest.approx(6)
    assert calculate_kkr_score(ASSIGNED, DEADLINE, {"urgent": True}, 4, 1) == pytest.approx(6 * 1.5)
    # A day late: the lateness penalty still applies to the whole product.
    assert calculate_kkr_score(ASSIGNED, DEADLINE, {"urgent": True}, 4, 1, "2026-01-05T00:00:00Z") == pytest.approx(6 * 1.5 * (2 / 3))
    every = dict.fromkeys(KKR_CRITERIA, True)
    assert calculate_kkr_score(ASSIGNED, DEADLINE, every, 4, 1) == pytest.approx(6 * math.prod(f for _, _, f in OWNER_TABLE))


def test_the_export_names_ticked_criteria_in_table_order():
    assert _xlsx_criteria('{"in_person": true, "urgent": true, "unique": false}') == "Срочная задача, Требует очного присутствия"
    assert _xlsx_criteria('{"physical": true, "monotonous": true}') == "Нудная / монотонная задача, Требуется ли физическая сила"
    assert _xlsx_criteria('{"legacy": true}') == "legacy"


def test_an_old_task_keeps_its_score_and_revision_through_old_and_new_clients(client, work, superuser):
    task = work["task"]
    old_json = '{"unique": true, "creative": false, "external_communication": false, "in_person": true, "fixed_time": false}'
    with db._session() as session:
        session.get(TaskORM, task["task_id"]).criteria_json = old_json
        session.commit()
    stamp = close_task(task)
    value = batch(client, task, superuser)
    assert value["criteria"] == {**dict.fromkeys(KKR_CRITERIA, False), "unique": True, "in_person": True}
    # An old client names only the five criteria it knows.
    old_client = payload(value)
    old_client["criteria"] = {key: value["criteria"][key] for key in OLD_FIVE}
    response = client.put("/api/tasks/" + task["task_id"] + "/accounting-batch", headers=superuser.headers, json=old_client)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["revision"] == value["revision"]  # the same choice is no change of the criteria
    with db._session() as session:
        row = session.get(TaskORM, task["task_id"])
        assert row.criteria_json == old_json
        score = session.query(ContributionORM).filter_by(assignment_id=value["assignments"][0]["assignment_id"]).one().score
        assigned, deadline = row.assigned_at, row.deadline_at
    assert score == pytest.approx(score_before_the_eight(assigned, deadline, json.loads(old_json), 2, 1, stamp))
    # The current client sends all eight; unticked new ones change nothing either.
    response = client.put("/api/tasks/" + task["task_id"] + "/accounting-batch", headers=superuser.headers, json=payload(saved))
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == value["revision"]
    # Ticking a new criterion is a change and multiplies the score.
    ticked = payload(response.json())
    ticked["criteria"]["physical"] = True
    response = client.put("/api/tasks/" + task["task_id"] + "/accounting-batch", headers=superuser.headers, json=ticked)
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == value["revision"] + 1 and response.json()["criteria"]["physical"] is True
    with db._session() as session:
        assert session.query(ContributionORM).filter_by(assignment_id=value["assignments"][0]["assignment_id"]).one().score == pytest.approx(score * 1.2)
    for criteria in ({**ticked["criteria"], "bogus": True}, {key: False for key in OLD_FIVE if key != "creative"}):
        wrong = payload(response.json())
        wrong["criteria"] = criteria
        assert client.put("/api/tasks/" + task["task_id"] + "/accounting-batch", headers=superuser.headers, json=wrong).status_code in (400, 422)


def test_old_task_inputs_and_templates_read_the_new_criteria_as_false(client, work, superuser):
    task = work["task"]
    with db._session() as session:
        session.get(TaskORM, task["task_id"]).criteria_json = '{"unique": false, "creative": true, "external_communication": false, "in_person": false, "fixed_time": false}'
        session.commit()
    inputs = client.get("/api/tasks/" + task["task_id"] + "/assessment-inputs", headers=superuser.headers)
    assert inputs.status_code == 200, inputs.text
    assert inputs.json()["criteria"] == {**dict.fromkeys(KKR_CRITERIA, False), "creative": True}
    created = client.post("/api/kkr-templates", headers=superuser.headers, json=dict(visibility="personal", values=dict(
        title="Старый шаблон", description="", hours=2, evaluation=1, criteria=dict(in_person=True))))
    assert created.status_code == 200, created.text
    assert created.json()["values"]["criteria"] == {**dict.fromkeys(KKR_CRITERIA, False), "in_person": True}
    with db._session() as session:
        row = session.get(KkrTemplateORM, created.json()["template_id"])
        values = json.loads(row.values_json)
        values["criteria"] = {key: key == "in_person" for key in OLD_FIVE}  # a template saved before 2026-11-08
        row.values_json = json.dumps(values)
        session.commit()
    listed = client.get("/api/kkr-templates", headers=superuser.headers).json()["items"]
    assert [item["values"]["criteria"] for item in listed] == [{**dict.fromkeys(KKR_CRITERIA, False), "in_person": True}]
    prepared = client.post(f"/api/kkr-templates/{created.json()['template_id']}/prepare", headers=superuser.headers, json=dict(expected_revision=1))
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["values"]["criteria"] == listed[0]["values"]["criteria"]
