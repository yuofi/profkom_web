"""Error classes and codes (FIX_PLAN 2.13, A-SEC-6, A-SEC-7, owner decision 42).

Each refusal has one status for its class and a stable `code`; the client shows Russian
text by the code. A read the user may not make answers exactly as for a missing object.
The organisation is the one of test_access_matrix, built once for the module.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from test_access_matrix import BAD, Org, _build, stamp

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def clean_db():
    """The module shares one organisation; it is truncated once, by `org`."""
    yield


@pytest.fixture(scope="module")
def org(client):
    from conftest import _truncate, block_factory, user_factory

    _truncate()
    o = Org(client)
    _build(o, user_factory(), block_factory())
    yield o
    _truncate()


def refused(org, who, method, path, body=None):
    status, data = org.raw(method, path, body, who)
    assert isinstance(data, dict) and set(data) == {"detail"}, (path, data)
    detail = data["detail"]
    assert isinstance(detail, dict) and set(detail) == {"code", "message", "fields"}, (path, detail)
    return status, detail["code"], detail["fields"]


def test_leadership_refusals_have_their_codes(org):
    rev = org.req("GET", "/leadership")["revision"]
    many = [org.uid(x) for x in ("deputy", "org1", "org2", "org3")]
    for user_ids, wanted in (
        (many, (422, "deputy_limit", {"limit": 3})),
        ([org.uid("chair")], (422, "self_deputy", {})),
        ([org.uid("deputy"), org.uid("deputy")], (422, "duplicate_users", {})),
        ([org.ids["pending"]], (409, "inactive_user", {"user_id": org.ids["pending"]})),
        ([99999], (422, "unknown_user", {"user_id": 99999})),
    ):
        assert refused(org, "chair", "PUT", "/leadership/deputies", {"user_ids": user_ids, "expected_revision": rev}) == wanted
    for target, wanted in (
        (org.ids["pending"], (409, "inactive_user")),
        (99999, (422, "unknown_user")),
        (org.uid("chair"), (409, "already_chair")),
    ):
        status, code, _ = refused(org, "chair", "POST", "/leadership/transfer",
                                  {"new_chair_user_id": target, "expected_revision": rev})
        assert (status, code) == wanted, target
    assert org.req("GET", "/leadership")["revision"] == rev


def test_roster_candidates_unknown_is_input_inactive_is_conflict(org):
    """Decision 42: a user who is not active yet or any more is a state conflict (409)."""
    sa = org.req("GET", f"/subevents/{org.ids['sa']}")
    for path in ("leaders", "organizers"):
        for user_ids, wanted in (([99999], (422, "unknown_user")), ([org.ids["pending"]], (409, "inactive_user"))):
            status, code, _ = refused(org, "head1", "PUT", f"/subevents/{org.ids['sa']}/{path}",
                                      {"user_ids": user_ids, "expected_revision": sa["revision"]})
            assert (status, code) == wanted, (path, user_ids)
    leader = next(x for x in sa["leaders"] if x["user"]["user_id"] == org.uid("resp1"))
    status, code, fields = refused(org, "head1", "PUT", f"/role-assignments/{leader['role_assignment_id']}/deputies",
                                   {"user_ids": [org.uid(x) for x in ("resp1dep", "org1", "org2")],
                                    "expected_revision": leader["revision"]})
    assert (status, code, fields) == (422, "deputy_limit", {"limit": 2})
    assert org.req("GET", f"/subevents/{org.ids['sa']}")["revision"] == sa["revision"]


def test_season_states_and_input(org):
    cur = org.req("GET", f"/seasons/{org.ids['current']}")
    period = dict(starts_at=stamp(400), ends_at=stamp(500))
    cases = [
        ("POST", f"/seasons/{cur['season_id']}/open", {"expected_revision": cur["revision"]}, 409, "conflict"),
        ("PATCH", f"/seasons/{cur['season_id']}", {"expected_revision": BAD, "title": "x"}, 409, "revision_conflict"),
        ("POST", "/seasons", dict(period, title="Второй", type="winter_spring"), 409, "planned_exists"),
        ("POST", "/seasons", dict(period, title="Без типа"), 422, "validation_error"),
        ("POST", "/seasons", dict(period, title="Лето", type="summer"), 422, "validation_error"),
        ("POST", "/season-corrections", dict(object_kind="task", object_id=org.ids["task_sub"], expected_revision=1,
                                             target_season_id=org.ids["planned"], reason="x"), 422, "validation_error"),
        ("GET", "/seasons/season-missing", None, 404, "not_found"),
    ]
    for method, path, body, status, code in cases:
        assert refused(org, "chair", method, path, body)[:2] == (status, code), (method, path, body)
    assert org.req("GET", f"/seasons/{cur['season_id']}")["revision"] == cur["revision"]


def test_closed_season_refuses_by_role_and_by_state(org):
    task = org.req("GET", f"/tasks/{org.ids['task_closed']}")
    body = {"expected_revision": task["revision"], "title": "Нельзя"}
    assert refused(org, "resp1", "PATCH", f"/tasks/{org.ids['task_closed']}", body)[:2] == (403, "forbidden")
    leader = org.req("GET", f"/events/{org.ids['past_event']}")["leaders"][0]
    status, code, _ = refused(org, "chair", "PUT", f"/role-assignments/{leader['role_assignment_id']}/deputies",
                              {"user_ids": [], "expected_revision": leader["revision"]})
    assert (status, code) == (409, "season_closed")
    assert org.req("GET", f"/tasks/{org.ids['task_closed']}")["revision"] == task["revision"]


def test_hr_deputy_has_approved_global_accounting_and_public_edit_rights(org):
    """New HR deputy rights preserve missing-object and closed-season boundaries."""
    task_id = org.ids["task_sub"]
    before = org.req("GET", f"/tasks/{task_id}", who="hrdeputy")
    assert {"view_assessment_inputs", "edit_task"} <= set(before["capabilities"])
    updated = org.req("PATCH", f"/tasks/{task_id}",
                      {"expected_revision": before["revision"], "title": "Уточнено HR"}, "hrdeputy")
    assert updated["title"] == "Уточнено HR"
    assert org.req("GET", f"/tasks/{task_id}/assessment-inputs", who="hrdeputy")["task_id"] == task_id
    assert refused(org, "hrdeputy", "PATCH", "/tasks/task-missing",
                   {"expected_revision": before["revision"], "title": "Нет задачи"})[:2] == (404, "not_found")
    assert refused(org, "hrdeputy", "GET", "/tasks/task-missing/assessment-inputs")[:2] == (404, "not_found")
    after = org.req("GET", f"/tasks/{task_id}", who="hrdeputy")
    assert after == updated
    org.req("PATCH", f"/tasks/{task_id}",
            {"expected_revision": after["revision"], "title": before["title"]}, "hrdeputy")


def test_upload_to_a_missing_owner_is_not_found(org):
    body = dict(owner_kind="report", owner_id="report-missing", purpose="report", name="a.pdf",
                mime_type="application/pdf", size_bytes=10)
    assert refused(org, "resp1", "POST", "/files/upload-intents", body)[:2] == (404, "not_found")


def test_task_with_a_duplicate_assignee_is_input(org):
    body = dict(season_id=org.ids["current"], scope={"kind": "subevent", "id": org.ids["sa"]}, title="Дубли",
                deadline_at=stamp(3), criteria={}, assignees=[{"user_id": org.uid("org1"), "hours": 1}] * 2)
    assert refused(org, "resp1", "POST", "/tasks", body)[:2] == (422, "duplicate_users")


# Reads of objects that exist and of objects that do not. hract belongs to the HR block
# only: it reads none of these.
HIDDEN = [
    ("resp1", lambda o: f"/subevents/{o.ids['sa']}/meeting", "/subevents/subevent-missing/meeting"),
    ("resp1", lambda o: f"/tasks/{o.ids['task_sub']}", "/tasks/task-missing"),
    ("resp1", lambda o: f"/tasks/{o.ids['task_sub']}/comments", "/tasks/task-missing/comments"),
    ("resp1", lambda o: f"/tasks/{o.ids['task_sub']}/assessment-inputs", "/tasks/task-missing/assessment-inputs"),
    ("resp1", lambda o: f"/reports/{o.ids['report_sub']}", "/reports/report-missing"),
    ("resp1", lambda o: f"/reports/{o.ids['report_sub']}/versions", "/reports/report-missing/versions"),
    ("resp1", lambda o: f"/report-history?series_id={o.ids['past_sub_series']}", "/report-history?series_id=series-missing"),
    ("chair", lambda o: f"/merits/{o.ids['merit_sub']}", "/merits/merit-missing"),
]


@pytest.mark.parametrize("reader,path,missing", HIDDEN, ids=[m for _, _, m in HIDDEN])
def test_an_unreadable_object_answers_as_a_missing_one(org, reader, path, missing):
    """A-SEC-6: the answer does not tell whether the object exists."""
    assert org.raw("GET", path(org), who=reader)[0] == 200
    hidden = org.raw("GET", path(org), who="hract")
    assert hidden[0] == 404 and hidden[1]["detail"]["code"] == "not_found", hidden
    assert hidden == org.raw("GET", missing, who="hract")


def test_a_hidden_meeting_is_not_found_and_leaks_nothing(org):
    """An organiser reads the event but not its main meeting (A-EVT-4)."""
    assert org.raw("GET", f"/events/{org.ids['event']}", who="org1")[0] == 200
    status, data = org.raw("GET", f"/events/{org.ids['event']}/meeting", who="org1")
    assert (status, data["detail"]["code"]) == (404, "not_found")
    assert "join_url" not in str(data) and "Созвон" not in str(data)


def test_new_routes_under_old_prefixes_use_the_new_shape(org, client):
    for method, path, body in (
        ("POST", "/contacts/archive", {}),
        ("PUT", "/profile/me/avatar", {}),
        ("GET", "/contacts/emails", None),
        ("GET", "/pgas-admins", None),
    ):
        for headers in ({}, org.headers("org1")):
            r = client.request(method, "/api" + path, json=body, headers=headers)
            if r.status_code < 400:
                continue
            detail = r.json()["detail"]
            assert isinstance(detail, dict) and {"code", "message"} <= set(detail), (path, r.status_code, detail)
    # The old site's routes keep their plain detail.
    old = client.get("/api/profile/abc", headers=org.headers("org1"))
    assert old.status_code == 422 and isinstance(old.json()["detail"], list)
    old = client.get("/api/materials/legacy-guides/99999", headers=org.headers("org1"))
    assert old.status_code == 404 and old.json()["detail"]["code"] == "not_found"


# ───────────────────────────── static checks ─────────────────────────────
# A plain ValueError or LookupError raised by domain code would become a 422 or 404 by
# accident; domain modules raise errors.py classes. Pydantic validators raise ValueError
# by design, and these two are caught where they are raised.
ALLOWED = {("account_cleanup.py", "purge"), ("api_contract.py", "cursor_page")}
VALIDATORS = {"field_validator", "model_validator", "validator"}


def _modules():
    return sorted([*BACKEND.glob("*.py"), *BACKEND.glob("utils/*.py")])


def _functions(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node


def _decorators(fn):
    for d in fn.decorator_list:
        d = d.func if isinstance(d, ast.Call) else d
        yield d.attr if isinstance(d, ast.Attribute) else getattr(d, "id", "")


def _raised(node):
    exc = node.exc.func if isinstance(node.exc, ast.Call) else node.exc
    return getattr(exc, "id", None)


def test_domain_code_raises_typed_errors():
    found = []
    for path in _modules():
        tree = ast.parse(path.read_text())
        for fn in _functions(tree):
            if set(_decorators(fn)) & VALIDATORS or (path.name, fn.name) in ALLOWED:
                continue
            for node in ast.walk(fn):
                if isinstance(node, ast.Raise) and node.exc is not None and _raised(node) in ("ValueError", "LookupError"):
                    found.append(f"{path.name}:{node.lineno} in {fn.name}")
    assert not found, found


def test_routes_do_not_turn_messages_into_statuses():
    """A-SEC-7: no `except ValueError: raise HTTPException(...)` mapping in the routes."""
    caught = {"ValueError", "LookupError", "DomainError", "NotFound", "Forbidden", "Conflict", "InvalidInput"}
    found = []
    for path in _modules():
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.ExceptHandler) or node.type is None:
                continue
            types = node.type.elts if isinstance(node.type, ast.Tuple) else [node.type]
            if not {getattr(t, "id", None) for t in types} & caught:
                continue
            for inner in ast.walk(node):
                if isinstance(inner, ast.Raise) and _raised(inner) == "HTTPException" and node.name and any(
                    isinstance(n, ast.Name) and n.id == node.name for n in ast.walk(inner)
                ):
                    found.append(f"{path.name}:{inner.lineno}")
    assert not found, found


def _emitted_codes():
    """Every `code` a backend module can put into an error body."""
    typed = {"NotFound", "Forbidden", "Conflict", "InvalidInput", "SeasonNotReadyError", "DomainError"}
    codes = set()
    for path in _modules():
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call):
                # super().__init__(message, code) in a subclass counts as the class itself
                name = getattr(node.func, "id", None) or ("DomainError" if getattr(node.func, "attr", "") == "__init__" else None)
                position = 1 if name in typed else 2 if name == "fail" else None
                args = [*node.args[position:position + 1]] if position is not None else []
                args += [k.value for k in node.keywords if k.arg == "code"]
                codes |= {a.value for a in args if isinstance(a, ast.Constant) and isinstance(a.value, str)}
            elif isinstance(node, ast.Dict):
                codes |= {v.value for k, v in zip(node.keys, node.values)
                          if isinstance(k, ast.Constant) and k.value == "code"
                          and isinstance(v, ast.Constant) and isinstance(v.value, str)}
            elif isinstance(node, ast.Assign) and any("code" in ast.unparse(t).split(", ") for t in node.targets):
                values = node.value.elts if isinstance(node.value, ast.Tuple) else [node.value]
                codes |= {v.value for v in values if isinstance(v, ast.Constant) and isinstance(v.value, str)}
    from api_contract import STATUS_CODES

    return (codes | set(STATUS_CODES.values())) - {"error"}


def test_every_code_has_a_russian_text():
    """The client shows text by code (A-FE-3): a new code needs its line in messages.ts."""
    source = (BACKEND.parent / "frontend/src/utils/api/messages.ts").read_text()
    table = source.split("export const ERROR_TEXTS", 1)[1].split("\n};", 1)[0]
    texts = set(re.findall(r"^\s+(\w+):", table, re.M))
    codes = _emitted_codes()
    assert {"season_not_ready", "deputy_limit", "upload_missing", "unauthenticated"} <= codes
    assert not codes - texts, sorted(codes - texts)


def test_close_blockers_name_the_work_and_whose_it_is(org):
    """A-KKR-15: the client builds a Russian line from kind, subject and assignee. Runs last:
    the current season stays in summary."""
    cur = org.req("GET", f"/seasons/{org.ids['current']}")
    cur = org.req("POST", f"/seasons/{cur['season_id']}/begin-summary", {"expected_revision": cur["revision"]})
    cur = cur.get("season", cur)
    status, code, fields = refused(org, "chair", "POST", f"/seasons/{cur['season_id']}/close", {"expected_revision": cur["revision"]})
    assert (status, code) == (409, "season_not_ready")
    blockers = fields["blockers"]
    org2 = next(b for b in blockers if b["kind"] == "unfinished_assignment" and b["assignee"] == "РольOrg2 org2")
    assert org2["subject"] == "Раздаточные материалы"
    assert {"Посвят", "Лекции"} <= {b["subject"] for b in blockers if b["kind"] == "missing_final_report"}
    for b in blockers:
        assert b["subject"] and set(b) <= {"kind", "owner_kind", "owner_id", "title", "subject", "assignee"}, b
