"""Role × operation access matrix of release 1 (RELEASE_PLAN.md, section 2).

One synthetic organisation is built once for the module through the real API: chair and a
chair deputy, the HR block (master, deputy, member), the IT block (master, deputy, members),
an event with two главорги and a deputy, a subevent with two ответственных, a deputy and
organisers, tasks, reports, meetings, merits and materials. Every role then calls every
operation. Writes that would change shared fixtures send a wrong revision: 409 means the
permission check passed, 403 means it did not.

Each GET that returns `capabilities` is also checked against the write it advertises: the
capability is present exactly when the server accepts the write for that role.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from database import db

BAD = 999999
ROLES = ["chair", "deputy", "hrmaster", "hrdeputy", "hract", "master", "mdeputy", "itmem",
         "head1", "head1dep", "resp1", "resp1dep", "org1", "editor", "pgas", "outsider"]
EXTRA = ["head2", "resp2", "org2", "junior", "multi", "org3"]


def rich(body: str) -> dict:
    return {"format": "markdown", "body": body}


def stamp(days: float = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


@pytest.fixture(autouse=True)
def clean_db():
    """The module shares one organisation; it is truncated once, by `org`."""
    yield


class Org:
    def __init__(self, client):
        self.client = client
        self.people: dict[str, object] = {}
        self.ids: dict[str, object] = {}
        self.applicants = 0

    def headers(self, who):
        return self.people[who].headers

    def uid(self, who):
        return self.people[who].user_id

    def raw(self, method, path, body=None, who="chair"):
        response = self.client.request(method, "/api" + path, headers=self.headers(who), json=body)
        try:
            data = response.json()
        except ValueError:
            data = None
        return response.status_code, data

    def req(self, method, path, body=None, who="chair"):
        status, data = self.raw(method, path, body, who)
        assert status < 300, f"{method} {path} as {who}: {status} {data}"
        return data


def _join(org, who, block_id):
    r = org.req("POST", "/block-requests", {"block_id": block_id}, who)
    r = org.req("POST", f"/block-requests/{r['request_id']}/hr-approve", {"expected_revision": r["revision"]}, "hrmaster")
    if r["state"] == "pending_block":
        org.req("POST", f"/block-requests/{r['request_id']}/block-approve", {"expected_revision": r["revision"]}, "master")


def _build(org, make_user, make_block):
    from database import BlockORM

    org.people["chair"] = make_user(super_user=True, name="Председатель", surname="Тестовый")
    for who in ROLES[1:] + EXTRA:
        org.people[who] = make_user(name=who, surname=f"Роль{who.capitalize()}", tg=f"@{who}_t",
                                    phone="+79990000000", pgas_admin=(who == "pgas"))
    pending = make_user(name="pending", surname="РольPending")
    db.update_user(pending.user_id, account_state="pending")
    org.ids["pending"] = pending.user_id
    lead = org.req("GET", "/leadership")
    org.req("PUT", "/leadership/deputies", {"user_ids": [org.uid("deputy")], "expected_revision": lead["revision"]})

    make_block(name="Integration HR")
    with db._session() as session:
        session.get(BlockORM, "Integration HR").is_hr = True
        session.commit()
    make_block(name="Integration IT")
    blocks = {b["name"]: b for b in org.req("GET", "/blocks")}
    hr = org.req("PUT", f"/blocks/{blocks['Integration HR']['block_id']}/leader",
                 {"user_id": org.uid("hrmaster"), "expected_revision": blocks["Integration HR"]["revision"]})
    org.req("PUT", f"/role-assignments/{hr['master']['role_assignment_id']}/deputies",
            {"user_ids": [org.uid("hrdeputy")], "expected_revision": hr["master"]["revision"]}, "hrmaster")
    it = org.req("PUT", f"/blocks/{blocks['Integration IT']['block_id']}/leader",
                 {"user_id": org.uid("master"), "expected_revision": blocks["Integration IT"]["revision"]})
    org.req("PUT", f"/role-assignments/{it['master']['role_assignment_id']}/deputies",
            {"user_ids": [org.uid("mdeputy")], "expected_revision": it["master"]["revision"]}, "master")
    org.ids.update(hr=hr["block_id"], it=it["block_id"])
    _join(org, "hract", hr["block_id"])
    for who in ("itmem", "org1", "org2", "junior", "multi"):
        _join(org, who, it["block_id"])

    def season(title, start, end, open_=True, kind="autumn_winter"):
        s = org.req("POST", "/seasons", dict(title=title, type=kind, starts_at=stamp(start), ends_at=stamp(end)))
        if open_:
            s = org.req("POST", f"/seasons/{s['season_id']}/open", {"expected_revision": s["revision"]})
        return s

    def event(s, title, heads, subs):
        e = org.req("POST", "/events", dict(season_id=s["season_id"], title=title, description=rich(title)))
        e = org.req("PUT", f"/events/{e['event_id']}/leaders",
                    {"user_ids": [org.uid(h) for h in heads], "expected_revision": e["revision"]})
        out = []
        for title_, leaders, organizers in subs:
            sub = org.req("POST", f"/events/{e['event_id']}/subevents", dict(title=title_, description=rich(title_)), heads[0])
            sub = org.req("PUT", f"/subevents/{sub['subevent_id']}/leaders",
                          {"user_ids": [org.uid(x) for x in leaders], "expected_revision": sub["revision"]}, heads[0])
            sub = org.req("PUT", f"/subevents/{sub['subevent_id']}/organizers",
                          {"user_ids": [org.uid(x) for x in organizers], "expected_revision": sub["revision"]}, heads[0])
            out.append(sub)
        return e, out

    past = season("Прошлый сезон", -120, -20)
    pe, (ps,) = event(past, "Посвят прошлого года", ["head1"], [("Лекции прошлого года", ["resp1"], ["org1"])])
    finals = {}
    for kind, oid, who in (("event", pe["event_id"], "head1"), ("subevent", ps["subevent_id"], "resp1")):
        r = org.req("POST", "/reports", dict(owner_kind=kind, owner_id=oid, kind="final", title="Финальный отчёт",
                                              content=rich("Итоги"), file_ids=[]), who)
        finals[kind] = org.req("POST", f"/reports/{r['report_id']}/publish", {"expected_revision": r["revision"]}, who)["report_id"]
    past = org.req("POST", f"/seasons/{past['season_id']}/begin-summary", {"expected_revision": past["revision"]})
    past = past.get("season", past)
    closed = org.req("POST", f"/seasons/{past['season_id']}/close", {"expected_revision": past["revision"]})
    past = closed.get("season", closed)

    # A season closed early, with one task of its subevent (closed-season edits, АВ-2)
    done = season("Закрытый сезон с задачей", -15, 30, kind="winter_spring")
    de, (ds,) = event(done, "Слёт", ["head1"], [("Регистрация", ["resp1"], ["org1"])])
    t_done = org.req("POST", "/tasks", dict(season_id=done["season_id"], scope={"kind": "subevent", "id": ds["subevent_id"]},
                                            title="Списки", description=rich("Списки"), deadline_at=stamp(3), criteria={},
                                            assignees=[{"user_id": org.uid("org1"), "hours": 1}]), "resp1")
    a = t_done["assignments"][0]
    org.req("POST", f"/assignments/{a['assignment_id']}/cancel", {"expected_revision": a["revision"], "reason": "Фикстура"}, "resp1")
    for kind, oid, who in (("event", de["event_id"], "head1"), ("subevent", ds["subevent_id"], "resp1")):
        r = org.req("POST", "/reports", dict(owner_kind=kind, owner_id=oid, kind="final", title="Финальный отчёт",
                                              content=rich("Итоги"), file_ids=[]), who)
        org.req("POST", f"/reports/{r['report_id']}/publish", {"expected_revision": r["revision"]}, who)
    done = org.req("POST", f"/seasons/{done['season_id']}/begin-summary", {"expected_revision": done["revision"]})
    done = done.get("season", done)
    org.req("POST", f"/seasons/{done['season_id']}/close", {"expected_revision": done["revision"]})
    org.ids["task_closed"] = t_done["task_id"]

    cur = season("Текущий сезон", -10, 80)
    e1, (sa, sb) = event(cur, "Посвят", ["head1", "head2"], [
        ("Лекции", ["resp1", "resp2"], ["org1", "org2", "junior"]),
        ("Квест", ["multi"], ["org3"]),
    ])
    e1 = org.req("GET", f"/events/{e1['event_id']}")
    h1 = next(x for x in e1["leaders"] if x["user"]["user_id"] == org.uid("head1"))
    org.req("PUT", f"/role-assignments/{h1['role_assignment_id']}/deputies",
            {"user_ids": [org.uid("head1dep")], "expected_revision": h1["revision"]})
    sa = org.req("GET", f"/subevents/{sa['subevent_id']}")
    r1 = next(x for x in sa["leaders"] if x["user"]["user_id"] == org.uid("resp1"))
    org.req("PUT", f"/role-assignments/{r1['role_assignment_id']}/deputies",
            {"user_ids": [org.uid("resp1dep")], "expected_revision": r1["revision"]}, "head1")

    t_sub = org.req("POST", "/tasks", dict(season_id=cur["season_id"], scope={"kind": "subevent", "id": sa["subevent_id"]},
                                           title="Раздаточные материалы", description=rich("Материалы"), deadline_at=stamp(5),
                                           criteria={}, assignees=[{"user_id": org.uid("org1"), "hours": 2},
                                                                   {"user_id": org.uid("org2"), "hours": 3}]), "resp1")
    t_blk = org.req("POST", "/tasks", dict(season_id=cur["season_id"], scope={"kind": "block", "id": it["block_id"]},
                                           title="Афиша", description=rich("Афиша"), deadline_at=stamp(4), criteria={},
                                           assignees=[{"user_id": org.uid("org1"), "hours": 1},
                                                      {"user_id": org.uid("junior"), "hours": 1}]), "master")
    a = next(x for x in t_sub["assignments"] if x["assignee"]["user_id"] == org.uid("org1"))
    a = org.req("POST", f"/assignments/{a['assignment_id']}/start", {"expected_revision": a["revision"]}, "org1")
    org.req("POST", f"/assignments/{a['assignment_id']}/submit",
            {"expected_revision": a["revision"], "text": rich("Готово"), "links": [], "file_ids": []}, "org1")
    org.req("PUT", f"/events/{e1['event_id']}/meeting", dict(title="Созвон главоргов", starts_at=stamp(2), join_url="https://example.com/m"), "head1")
    org.req("PUT", f"/subevents/{sa['subevent_id']}/meeting", dict(title="Созвон лекций", starts_at=stamp(2), join_url="https://example.com/m"), "resp1")
    rep = org.req("POST", "/reports", dict(owner_kind="subevent", owner_id=sa["subevent_id"], kind="regular",
                                           title="Отчёт лекций", content=rich("Этап"), file_ids=[]), "resp1")
    rep = org.req("POST", f"/reports/{rep['report_id']}/publish", {"expected_revision": rep["revision"]}, "resp1")
    erep = org.req("POST", "/reports", dict(owner_kind="event", owner_id=e1["event_id"], kind="regular",
                                            title="Отчёт Посвята", content=rich("Текст"), file_ids=[]), "head1")
    erep = org.req("POST", f"/reports/{erep['report_id']}/publish", {"expected_revision": erep["revision"]}, "head1")
    mat = org.req("POST", "/materials", dict(kind="general", title="Памятка", description="", content=rich("Текст")))
    mat = org.req("PUT", f"/materials/{mat['material_id']}/editors", {"user_ids": [org.uid("editor")], "expected_revision": mat["revision"]})
    org.req("POST", f"/materials/{mat['material_id']}/publish", {"expected_revision": mat["revision"]})
    base = dict(season_id=cur["season_id"], description="", assigned_at=stamp(-3), deadline_at=stamp(-2), criteria={}, reason="Фикстура")
    one = lambda who: [{"user_id": org.uid(who), "hours": 1, "evaluation": 1, "completed_at": stamp(-2)}]  # noqa: E731
    merit_head = org.req("POST", "/merits", dict(base, source_kind="head_merit", event_id=e1["event_id"], title="Главорг", recipients=one("org1")))
    merit_block = org.req("POST", "/merits", dict(base, source_kind="block_volunteer", scope={"kind": "block", "id": it["block_id"]},
                                                  title="Волонтёр блока", recipients=one("outsider")))
    merit_sub = org.req("POST", "/merits", dict(base, source_kind="subevent_volunteer", scope={"kind": "subevent", "id": sa["subevent_id"]},
                                                title="Волонтёр подмероприятия", recipients=one("outsider")))
    t_sub = org.req("GET", f"/tasks/{t_sub['task_id']}")
    t_blk = org.req("GET", f"/tasks/{t_blk['task_id']}")
    ev = org.req("GET", f"/events/{e1['event_id']}")
    org.ids.update(
        closed=past["season_id"], current=cur["season_id"],
        planned=season("Следующий сезон", 60, 160, open_=False, kind="winter_spring")["season_id"],
        past_event=pe["event_id"], past_sub=ps["subevent_id"], past_event_report=finals["event"], past_sub_report=finals["subevent"],
        event=e1["event_id"], sa=sa["subevent_id"], sb=sb["subevent_id"], task_sub=t_sub["task_id"], task_blk=t_blk["task_id"],
        report_sub=rep["report_id"], report_event=erep["report_id"], material=mat["material_id"],
        merit_head=merit_head["merit_id"], merit_block=merit_block["merit_id"], merit_sub=merit_sub["merit_id"],
        asg_sub_org1=next(x["assignment_id"] for x in t_sub["assignments"] if x["assignee"]["user_id"] == org.uid("org1")),
        asg_sub_org2=next(x["assignment_id"] for x in t_sub["assignments"] if x["assignee"]["user_id"] == org.uid("org2")),
        asg_blk_org1=next(x["assignment_id"] for x in t_blk["assignments"] if x["assignee"]["user_id"] == org.uid("org1")),
        ra_head1=next(x["role_assignment_id"] for x in ev["leaders"] if x["user"]["user_id"] == org.uid("head1")),
        ra_resp1=r1["role_assignment_id"], ra_master_it=it["master"]["role_assignment_id"],
        ra_master_hr=hr["master"]["role_assignment_id"],
        guide_it=org.req("GET", f"/blocks/{it['block_id']}")["guide_material_id"],
        guide_hr=org.req("GET", f"/blocks/{hr['block_id']}")["guide_material_id"],
        past_event_series=org.req("GET", f"/events/{pe['event_id']}")["report_series_id"],
        past_sub_series=org.req("GET", f"/subevents/{ps['subevent_id']}")["report_series_id"],
    )


@pytest.fixture(scope="module")
def org(client):
    """Built once; the module-level `clean_db` override keeps it between tests."""
    from conftest import _truncate, block_factory, user_factory

    _truncate()
    o = Org(client)
    _build(o, user_factory(), block_factory())
    yield o
    _truncate()



# ───────────────────────────── operations ─────────────────────────────
class Op:
    """`readers` names the read operation of the same object: a role that cannot read it gets 404."""

    def __init__(self, op, method, path, body=None, ok=(200,), deny=(403,), prepare=None, cap=None, readers=None):
        self.op, self.method, self.path, self.body = op, method, path, body
        self.ok, self.deny, self.prepare, self.cap, self.readers = set(ok), set(deny), prepare, cap, readers

    def expected(self, role):
        if role in EXPECTED[self.op]:
            return self.ok
        return {404} if self.readers and role not in EXPECTED[self.readers] else self.deny


def _ensure_meeting(kind, key):
    def prepare(org, role):
        status, body = org.raw("GET", f"/{kind}/{org.ids[key]}/meeting")
        if (status, body) == (200, None):
            org.req("PUT", f"/{kind}/{org.ids[key]}/meeting", dict(title="Созвон", starts_at=stamp(2), join_url="https://example.com/m"))
    return prepare


def _request(block, stage):
    """A fresh applicant with an open request in the wanted stage."""
    def prepare(org, role):
        from conftest import user_factory
        org.applicants += 1
        who = f"applicant{org.applicants}"
        org.people[who] = user_factory()(name=who, surname=f"Заявитель{org.applicants}")
        r = org.req("POST", "/block-requests", {"block_id": org.ids[block]}, who)
        if stage == "pending_block":
            r = org.req("POST", f"/block-requests/{r['request_id']}/hr-approve", {"expected_revision": r["revision"]}, "hrmaster")
        org.ids["request"] = r
    return prepare


def _victim(org, role):
    from conftest import user_factory
    org.people["victim"] = user_factory()(name="victim", surname=f"Архивный{role}")
    org.ids["victim"] = org.uid("victim")


def _disposable_material(org, role):
    m = org.req("POST", "/materials", dict(kind="general", title=f"Одноразовый {role}", description="", content=rich("x")))
    m = org.req("PUT", f"/materials/{m['material_id']}/editors", {"user_ids": [org.uid("editor")], "expected_revision": m["revision"]})
    org.ids["disposable"] = org.req("POST", f"/materials/{m['material_id']}/publish", {"expected_revision": m["revision"]})["material_id"]


def _fresh(path_key, kind):
    def body(org, role, extra=None):
        current = org.req("GET", f"/{kind}/{org.ids[path_key]}")
        return {"expected_revision": current["revision"], **(extra(current) if extra else {})}
    return body


I = lambda key: (lambda org: org.ids[key])  # noqa: E731


def ops():
    cur = lambda o: o.ids["current"]  # noqa: E731
    base = lambda o: dict(season_id=o.ids["current"], description="", assigned_at=stamp(-3), deadline_at=stamp(-2), criteria={}, reason="probe")  # noqa: E731
    one = lambda o, who: [{"user_id": o.uid(who), "hours": 1, "evaluation": 1, "completed_at": stamp(-2)}]  # noqa: E731
    same_title = lambda kind, key: (lambda o, r: {**_fresh(key, kind)(o, r), "title": o.req("GET", f"/{kind}/{o.ids[key]}")["title"]})  # noqa: E731
    return [
        Op("S1", "GET", lambda o: "/session"),
        # Events and subevents
        Op("E1", "GET", lambda o: f"/events?season_id={cur(o)}"),
        Op("E2", "GET", lambda o: f"/events/{o.ids['event']}"),
        Op("E3", "PATCH", lambda o: f"/events/{o.ids['event']}", same_title("events", "event"), cap=("E2", "edit_event")),
        Op("E4", "POST", lambda o: "/events", lambda o, r: dict(season_id=cur(o), title=f"probe-event-{r}", description=rich("p"))),
        Op("E5", "GET", lambda o: f"/subevents/{o.ids['sa']}"),
        Op("E6", "PATCH", lambda o: f"/subevents/{o.ids['sa']}", same_title("subevents", "sa"), cap=("E5", "edit_subevent")),
        Op("E7", "POST", lambda o: f"/events/{o.ids['event']}/subevents", lambda o, r: dict(title=f"probe-sub-{r}", description=rich("p")),
           cap=("E2", "create_subevent")),
        Op("E8", "PUT", lambda o: f"/events/{o.ids['event']}/leaders",
           lambda o, r: {"user_ids": [o.uid("head1"), o.uid("head2")], "expected_revision": BAD}, ok=(409,), cap=("E2", "manage_leaders")),
        Op("E9", "PUT", lambda o: f"/subevents/{o.ids['sa']}/leaders",
           lambda o, r: {"user_ids": [o.uid("resp1"), o.uid("resp2")], "expected_revision": BAD}, ok=(409,), cap=("E5", "manage_leaders")),
        Op("E10", "PUT", lambda o: f"/subevents/{o.ids['sa']}/organizers",
           lambda o, r: {"user_ids": [o.uid("org1")], "expected_revision": BAD}, ok=(409,), cap=("E5", "manage_organizers")),
        Op("E11", "PUT", lambda o: f"/role-assignments/{o.ids['ra_head1']}/deputies",
           lambda o, r: {"user_ids": [o.uid("head1dep")], "expected_revision": BAD}, ok=(409,), cap=("E2", "manage_deputies")),
        Op("E12", "PUT", lambda o: f"/role-assignments/{o.ids['ra_resp1']}/deputies",
           lambda o, r: {"user_ids": [o.uid("resp1dep")], "expected_revision": BAD}, ok=(409,), cap=("E5", "manage_deputies")),
        Op("E13", "GET", lambda o: f"/events/{o.ids['event']}/subevents"),
        # Tasks
        Op("T1", "POST", lambda o: "/tasks", lambda o, r: dict(season_id=cur(o), scope={"kind": "subevent", "id": o.ids["sa"]},
           title=f"probe-task-{r}", description=rich("p"), deadline_at=stamp(6), criteria={}, assignees=[{"user_id": o.uid("org2"), "hours": 1}]),
           cap=("E5", "create_task")),
        Op("T2", "POST", lambda o: "/tasks", lambda o, r: dict(season_id=cur(o), scope={"kind": "block", "id": o.ids["it"]},
           title=f"probe-btask-{r}", description=rich("p"), deadline_at=stamp(6), criteria={}, assignees=[{"user_id": o.uid("itmem"), "hours": 1}]),
           cap=("B1", "create_task")),
        Op("T3", "GET", lambda o: f"/tasks/{o.ids['task_sub']}"),
        Op("T4", "GET", lambda o: f"/tasks/{o.ids['task_blk']}"),
        Op("T5", "PATCH", lambda o: f"/tasks/{o.ids['task_sub']}", same_title("tasks", "task_sub"), cap=("T3", "edit_task"),
           readers="T3"),
        Op("T6", "PATCH", lambda o: f"/tasks/{o.ids['task_blk']}", same_title("tasks", "task_blk"), cap=("T4", "edit_task"),
           readers="T4"),
        Op("T7", "POST", lambda o: f"/assignments/{o.ids['asg_sub_org1']}/request-revision",
           lambda o, r: {"expected_revision": BAD, "review_note": "probe"}, ok=(409,)),
        Op("T8", "POST", lambda o: f"/assignments/{o.ids['asg_blk_org1']}/cancel", lambda o, r: {"expected_revision": BAD, "reason": "probe"}, ok=(409,)),
        Op("T9", "PATCH", lambda o: f"/assignments/{o.ids['asg_sub_org1']}/assessment-inputs",
           lambda o, r: {"expected_revision": BAD, "reason": "probe", "hours": 2}, ok=(409,), cap=("T3", "edit_assessment_inputs")),
        Op("T10", "GET", lambda o: f"/tasks/{o.ids['task_sub']}/assessment-inputs", cap=("T3", "view_assessment_inputs")),
        Op("T11", "GET", lambda o: f"/tasks/{o.ids['task_blk']}/assessment-inputs", cap=("T4", "view_assessment_inputs")),
        Op("T12", "POST", lambda o: f"/assignments/{o.ids['asg_sub_org2']}/reassign",
           lambda o, r: {"expected_revision": BAD, "new_assignee_user_id": o.uid("org1"), "hours": 1, "previous_outcome": "cancelled", "reason": "probe"},
           ok=(409,)),
        Op("T13", "GET", lambda o: "/assignments/unresolved", cap=("S1", "view_unresolved_assignments")),
        Op("T14", "PATCH", lambda o: f"/assignments/{o.ids['asg_blk_org1']}/assessment-inputs",
           lambda o, r: {"expected_revision": BAD, "reason": "probe", "hours": 2}, ok=(409,), cap=("T4", "edit_assessment_inputs")),
        # Dates of a task, once set, are moved by the chair, deputies and HR master (УВ-5).
        Op("T15", "PATCH", lambda o: f"/tasks/{o.ids['task_sub']}/assessment-inputs",
           lambda o, r: {"expected_revision": BAD, "reason": "probe", "deadline_at": stamp(4.25)}, ok=(409,),
           cap=("T10", "edit_assessment_dates")),
        Op("T16", "GET", lambda o: f"/assignments/{o.ids['asg_sub_org1']}/assessment-inputs", cap=("T3", "view_assessment_inputs")),
        Op("T17", "PATCH", lambda o: f"/assignments/{o.ids['asg_sub_org1']}/assessment-inputs",
           lambda o, r: {"expected_revision": BAD, "reason": "probe", "effective_completed_at": stamp(-1.25)}, ok=(409,),
           cap=("T16", "edit_assessment_dates")),
        # KKR, merits, summary, seasons
        Op("K1", "GET", lambda o: f"/assessments?season_id={cur(o)}", cap=("S1", "view_kkr")),
        Op("K2", "GET", lambda o: f"/seasons/{cur(o)}/summary", cap=("S1", "view_summary")),
        Op("K3", "GET", lambda o: f"/seasons/{cur(o)}/summary.xlsx"),
        Op("K4", "PUT", lambda o: f"/seasons/{cur(o)}/summary/decisions/{o.uid('org1')}",
           lambda o, r: {"expected_version": BAD, "decisions": [], "reason": "probe"}, ok=(409,)),
        Op("K5", "GET", lambda o: f"/seasons/{cur(o)}/master-bonuses"),
        Op("K6", "POST", lambda o: "/merits", lambda o, r: dict(base(o), source_kind="head_merit", event_id=o.ids["event"],
           title=f"probe-head-{r}", recipients=one(o, "org1")), cap=("E2", "create_head_merit")),
        Op("K7", "POST", lambda o: "/merits", lambda o, r: dict(base(o), source_kind="block_volunteer", scope={"kind": "block", "id": o.ids["it"]},
           title=f"probe-bv-{r}", recipients=one(o, "outsider")), cap=("B1", "create_volunteer_merit")),
        Op("K8", "POST", lambda o: "/merits", lambda o, r: dict(base(o), source_kind="subevent_volunteer", scope={"kind": "subevent", "id": o.ids["sa"]},
           title=f"probe-sv-{r}", recipients=one(o, "outsider")), cap=("E5", "create_volunteer_merit")),
        Op("K9", "POST", lambda o: "/merits", lambda o, r: dict(base(o), source_kind="chair_merit", title=f"probe-cm-{r}",
           recipients=one(o, "org1")), cap=("S1", "create_chair_merit")),
        Op("K10", "GET", lambda o: f"/merits/{o.ids['merit_sub']}"),
        Op("K11", "PATCH", lambda o: f"/merits/{o.ids['merit_sub']}", lambda o, r: {"expected_revision": BAD, "reason": "probe"}, ok=(409,),
           cap=("K10", "edit_assessment_inputs")),
        Op("K12", "PATCH", lambda o: f"/merits/{o.ids['merit_head']}", lambda o, r: {"expected_revision": BAD, "reason": "probe"}, ok=(409,)),
        Op("K13", "PATCH", lambda o: f"/merits/{o.ids['merit_block']}", lambda o, r: {"expected_revision": BAD, "reason": "probe"}, ok=(409,)),
        Op("K14", "POST", lambda o: f"/seasons/{o.ids['closed']}/summary/correct", lambda o, r: {"expected_version": BAD, "reason": "probe",
           "changes": [{"kind": "merit", "id": o.ids["merit_head"], "expected_revision": BAD, "values": {}}]}, ok=(409,)),
        Op("K15", "POST", lambda o: f"/seasons/{cur(o)}/begin-summary", lambda o, r: {"expected_revision": BAD}, ok=(409,)),
        Op("K16", "POST", lambda o: "/season-corrections", lambda o, r: {"object_kind": "event", "object_id": o.ids["event"],
           "expected_revision": BAD, "target_season_id": o.ids["planned"], "reason": "probe"}, ok=(409,), cap=("S1", "correct_season")),
        Op("K17", "GET", lambda o: f"/merits?season_id={cur(o)}"),
        Op("C4", "GET", lambda o: f"/participants/{o.uid('itmem')}/category"),
        Op("C5", "PATCH", lambda o: f"/participants/{o.uid('itmem')}/category",
           lambda o, r: {**_fresh_category(o), "reason": "probe"}, cap=("C4", "edit_participant_category")),
        # Reports
        Op("R1", "POST", lambda o: "/reports", lambda o, r: dict(owner_kind="subevent", owner_id=o.ids["sa"], kind="regular",
           title=f"probe-rep-{r}", content=rich("x"), file_ids=[]), cap=("E5", "create_report")),
        Op("R2", "POST", lambda o: "/reports", lambda o, r: dict(owner_kind="event", owner_id=o.ids["event"], kind="regular",
           title=f"probe-erep-{r}", content=rich("x"), file_ids=[]), cap=("E2", "create_report")),
        Op("R3", "GET", lambda o: f"/reports/{o.ids['report_sub']}"),
        Op("R4", "PATCH", lambda o: f"/reports/{o.ids['report_sub']}", lambda o, r: {"expected_revision": BAD, "title": "x"}, ok=(409,),
           cap=("R3", "edit_report")),
        Op("R5", "POST", lambda o: f"/reports/{o.ids['report_sub']}/publish", lambda o, r: {"expected_revision": BAD}, ok=(409,),
           cap=("R3", "publish_report")),
        Op("R6", "GET", lambda o: f"/reports/{o.ids['report_event']}"),
        Op("R7", "PATCH", lambda o: f"/reports/{o.ids['report_event']}", lambda o, r: {"expected_revision": BAD, "title": "x"}, ok=(409,),
           cap=("R6", "edit_report")),
        Op("R8", "GET", lambda o: f"/report-history?series_id={o.ids['past_event_series']}"),
        Op("R9", "GET", lambda o: f"/report-history?series_id={o.ids['past_sub_series']}"),
        Op("R10", "GET", lambda o: f"/reports/{o.ids['past_event_report']}"),
        Op("R11", "GET", lambda o: f"/reports/{o.ids['past_sub_report']}"),
        Op("R12", "PATCH", lambda o: f"/reports/{o.ids['past_event_report']}", lambda o, r: {"expected_revision": BAD, "title": "x"}, ok=(409,)),
        Op("R13", "PATCH", lambda o: f"/reports/{o.ids['past_sub_report']}", lambda o, r: {"expected_revision": BAD, "title": "x"}, ok=(409,)),
        # Meetings
        Op("M1", "GET", lambda o: f"/events/{o.ids['event']}/meeting", prepare=_ensure_meeting("events", "event"),
           cap=("E2", "view_meeting")),  # A-EVT-4
        Op("M2", "PUT", lambda o: f"/events/{o.ids['event']}/meeting",
           lambda o, r: dict(expected_revision=BAD, title="x", starts_at=stamp(3), join_url="https://example.com/m"), ok=(409,),
           prepare=_ensure_meeting("events", "event"), cap=("E2", "edit_meeting")),
        Op("M3", "GET", lambda o: f"/subevents/{o.ids['sa']}/meeting", prepare=_ensure_meeting("subevents", "sa"),
           cap=("E5", "view_meeting")),
        Op("M4", "PUT", lambda o: f"/subevents/{o.ids['sa']}/meeting",
           lambda o, r: dict(expected_revision=BAD, title="x", starts_at=stamp(3), join_url="https://example.com/m"), ok=(409,),
           prepare=_ensure_meeting("subevents", "sa"), cap=("E5", "edit_meeting")),
        Op("M5", "DELETE", lambda o: f"/events/{o.ids['event']}/meeting", prepare=_ensure_meeting("events", "event"), cap=("E2", "delete_meeting")),
        Op("M6", "DELETE", lambda o: f"/subevents/{o.ids['sa']}/meeting", prepare=_ensure_meeting("subevents", "sa"), cap=("E5", "delete_meeting")),
        # Blocks and requests
        Op("B1", "GET", lambda o: f"/blocks/{o.ids['it']}"),
        Op("B1h", "GET", lambda o: f"/blocks/{o.ids['hr']}"),
        Op("B2", "PATCH", lambda o: f"/blocks/{o.ids['it']}", _fresh("it", "blocks"), cap=("B1", "edit_block")),
        Op("B3", "PATCH", lambda o: f"/blocks/{o.ids['hr']}", _fresh("hr", "blocks"), cap=("B1h", "edit_block")),
        Op("B4", "DELETE", lambda o: f"/blocks/{o.ids['it']}/members/{o.uid('outsider')}", ok=(200, 404), cap=("B1", "remove_member")),
        Op("B5", "DELETE", lambda o: f"/blocks/{o.ids['hr']}/members/{o.uid('outsider')}", ok=(200, 404), cap=("B1h", "remove_member")),
        Op("B6", "POST", lambda o: f"/block-requests/{o.ids['request']['request_id']}/hr-approve",
           lambda o, r: {"expected_revision": o.ids["request"]["revision"]}, prepare=_request("hr", "pending_hr")),
        Op("B7", "POST", lambda o: f"/block-requests/{o.ids['request']['request_id']}/hr-approve",
           lambda o, r: {"expected_revision": o.ids["request"]["revision"]}, prepare=_request("it", "pending_hr")),
        Op("B8", "POST", lambda o: f"/block-requests/{o.ids['request']['request_id']}/block-approve",
           lambda o, r: {"expected_revision": o.ids["request"]["revision"]}, prepare=_request("it", "pending_block")),
        Op("B9", "POST", lambda o: f"/block-requests/{o.ids['request']['request_id']}/reject",
           lambda o, r: {"expected_revision": o.ids["request"]["revision"], "reason": "probe"}, prepare=_request("hr", "pending_hr")),
        Op("B12", "PUT", lambda o: f"/blocks/{o.ids['it']}/leader", lambda o, r: {"user_id": o.uid("master"), "expected_revision": BAD}, ok=(409,),
           cap=("B1", "manage_leaders")),
        Op("B13", "PUT", lambda o: f"/role-assignments/{o.ids['ra_master_it']}/deputies",
           lambda o, r: {"user_ids": [o.uid("mdeputy")], "expected_revision": BAD}, ok=(409,)),
        Op("B14", "PUT", lambda o: f"/role-assignments/{o.ids['ra_master_hr']}/deputies",
           lambda o, r: {"user_ids": [o.uid("hrdeputy")], "expected_revision": BAD}, ok=(409,)),
        # Registrations, accounts, leadership
        Op("G1", "GET", lambda o: "/registrations", cap=("S1", "review_registrations")),
        Op("G2", "POST", lambda o: f"/registrations/{o.ids['pending']}/approve", lambda o, r: {"expected_revision": BAD}, ok=(409,)),
        Op("A1", "GET", lambda o: "/accounts/archive"),
        Op("A2", "POST", lambda o: f"/accounts/{o.ids['victim']}/archive", lambda o, r: {"reason": "probe"}, prepare=_victim,
           cap=("S1", "archive_account")),
        Op("A3", "POST", lambda o: f"/accounts/{o.ids['victim']}/restore", lambda o, r: {}, ok=(200, 409), cap=("S1", "restore_account")),
        Op("A4", "POST", lambda o: "/leadership/transfer", lambda o, r: {"new_chair_user_id": o.uid("deputy"), "expected_revision": BAD},
           ok=(409,), cap=("S1", "transfer_chair")),
        Op("A5", "PUT", lambda o: "/leadership/deputies", lambda o, r: {"user_ids": [o.uid("deputy")], "expected_revision": BAD}, ok=(409,),
           cap=("S1", "manage_chair_deputies")),
        # PGAS
        Op("P1", "GET", lambda o: "/pgas"),
        Op("P2", "POST", lambda o: "/pgas", lambda o, r: {"title": "probe", "year": 2026, "file_url": "probe.exe", "file_type": ""}, ok=(400, 422)),
        Op("P3", "DELETE", lambda o: "/pgas/999999", ok=(404,)),
        Op("P4", "POST", lambda o: "/files/upload-intents", lambda o, r: {"owner_kind": "pgas", "owner_id": "pgas", "purpose": "pgas",
           "name": "probe.pdf", "mime_type": "application/pdf", "size_bytes": 10}),
        # Materials
        Op("MT1", "GET", lambda o: f"/materials/{o.ids['material']}"),
        Op("MT2", "PATCH", lambda o: f"/materials/{o.ids['material']}", same_title("materials", "material"), cap=("MT1", "edit_material")),
        Op("MT3", "DELETE", lambda o: f"/materials/{o.ids['disposable']}", prepare=_disposable_material, cap=("MT1", "delete_material")),
        Op("MT4", "POST", lambda o: "/materials", lambda o, r: dict(kind="general", title=f"probe-mat-{r}", description="", content=rich("x")),
           cap=("S1", "create_shared_material")),  # A-MAT-13
        Op("MT5", "PUT", lambda o: f"/materials/{o.ids['material']}/editors", lambda o, r: {"user_ids": [o.uid("editor")], "expected_revision": BAD},
           ok=(409,), cap=("MT1", "manage_material_editors")),
        Op("MT6", "PATCH", lambda o: f"/materials/{o.ids['guide_it']}", _fresh("guide_it", "materials")),
        Op("MT7", "PATCH", lambda o: f"/materials/{o.ids['guide_hr']}", _fresh("guide_hr", "materials")),
        # Contacts
        Op("C1", "GET", lambda o: "/contacts"),
        Op("C2", "GET", lambda o: "/contacts/archive"),
        Op("C3", "POST", lambda o: "/contacts/archive", lambda o, r: {"surname": "Бывший", "name": f"Проба-{r}", "participation_periods": []},
           cap=("S1", "edit_former_contacts")),
    ]


def _fresh_category(org):
    current = org.req("GET", f"/participants/{org.uid('itmem')}/category")
    return {"expected_revision": current["revision"], "category": current["category"]}


def run(org, role):
    """Status and capabilities of every operation for one role."""
    results, caps = {}, {}
    for op in ops():
        if op.prepare:
            op.prepare(org, role)
        body = op.body(org, role) if op.body else None
        status, data = org.raw(op.method, op.path(org), body, role)
        results[op.op] = status
        if op.method == "GET" and isinstance(data, dict):
            caps[op.op] = set(data.get("capabilities") or [])
    return results, caps


# ───────────────────────────── expected (RELEASE_PLAN.md, section 2) ─────────────────────────────
ALL = set(ROLES)
TACHKI = {"chair", "deputy"}  # chair and the chair's deputies
HRM = {"hrmaster"}  # the HR deputy is an ordinary HR block member in release 1 (АВ-25, УВ-2)
EVENT_LEAD = {"head1", "head1dep"}
SUB_LEAD = {"resp1", "resp1dep"}
SUB_TEAM = SUB_LEAD | {"org1"}
IT_LEAD = {"master", "mdeputy"}
IT_MEMBERS = {"itmem", "org1"}
QUEUE = TACHKI | HRM | IT_LEAD | EVENT_LEAD | SUB_LEAD

EXPECTED = {
    "S1": ALL, "E1": ALL, "E2": ALL,
    "E3": TACHKI | EVENT_LEAD,  # HR master does not edit events (УВ-4)
    "E4": TACHKI,
    "E5": TACHKI | HRM | EVENT_LEAD | SUB_TEAM,  # subevent working data (УВ-3, УВ-4)
    "E6": TACHKI | EVENT_LEAD | SUB_LEAD,
    "E7": TACHKI | EVENT_LEAD,
    "E8": TACHKI, "E9": TACHKI | EVENT_LEAD, "E10": TACHKI | EVENT_LEAD,
    "E11": TACHKI, "E12": TACHKI | EVENT_LEAD,
    "E13": ALL,
    "T1": TACHKI | EVENT_LEAD | SUB_LEAD, "T2": TACHKI | IT_LEAD,
    "T3": TACHKI | HRM | EVENT_LEAD | SUB_TEAM, "T4": TACHKI | HRM | IT_LEAD | IT_MEMBERS,
    "T5": TACHKI | EVENT_LEAD | SUB_LEAD, "T6": TACHKI | IT_LEAD,  # title and description (АВ-3, ACC-01)
    "T7": TACHKI | HRM | EVENT_LEAD | SUB_LEAD, "T8": TACHKI | HRM | IT_LEAD,
    "T9": TACHKI | HRM | EVENT_LEAD | SUB_LEAD, "T10": TACHKI | HRM | EVENT_LEAD | SUB_LEAD,
    "T11": TACHKI | HRM | IT_LEAD, "T12": TACHKI | HRM | EVENT_LEAD | SUB_LEAD,
    "T13": QUEUE, "T14": TACHKI | HRM | IT_LEAD,
    "T15": TACHKI | HRM, "T16": TACHKI | HRM | EVENT_LEAD | SUB_LEAD, "T17": TACHKI | HRM,  # УВ-5
    "K1": TACHKI | HRM, "K2": TACHKI | HRM, "K3": TACHKI | HRM, "K4": TACHKI | HRM, "K5": TACHKI | HRM,
    "K6": TACHKI | EVENT_LEAD,  # decision 12: unchanged
    "K7": TACHKI | HRM | IT_LEAD,
    "K8": TACHKI | HRM | EVENT_LEAD | SUB_LEAD,  # A-KKR-8, variant (a)
    "K9": TACHKI,
    "K10": TACHKI | HRM | EVENT_LEAD | SUB_LEAD, "K11": TACHKI | HRM | EVENT_LEAD | SUB_LEAD,
    "K12": TACHKI | HRM | EVENT_LEAD, "K13": TACHKI | HRM | IT_LEAD,
    "K14": TACHKI,  # closed season corrections (АВ-2)
    "K15": {"chair"},  # opening and closing a season (АВ-49)
    "K16": TACHKI, "K17": ALL,
    "C4": ALL, "C5": TACHKI | HRM,
    "R1": SUB_LEAD, "R2": EVENT_LEAD,  # АВ-27
    "R3": TACHKI | HRM | EVENT_LEAD | SUB_TEAM, "R4": SUB_LEAD, "R5": SUB_LEAD,
    "R6": TACHKI | HRM | EVENT_LEAD, "R7": EVENT_LEAD,
    # Closed season: the snapshot keeps its leads; the head organizer only reads the
    # subevent's reports and history (decision 19, ACC-08).
    "R8": TACHKI | HRM | {"head1"}, "R9": TACHKI | HRM | {"resp1", "head1"},
    "R10": TACHKI | HRM | {"head1"}, "R11": TACHKI | HRM | {"resp1", "head1"},
    "R12": {"head1"}, "R13": {"resp1"},
    "M1": TACHKI | HRM | EVENT_LEAD | SUB_LEAD, "M2": TACHKI | EVENT_LEAD,
    "M3": TACHKI | HRM | EVENT_LEAD | SUB_TEAM, "M4": TACHKI | EVENT_LEAD | SUB_LEAD,
    "M5": TACHKI | EVENT_LEAD, "M6": TACHKI | EVENT_LEAD | SUB_LEAD,
    "B1": ALL, "B1h": ALL,
    "B2": TACHKI | IT_LEAD, "B3": TACHKI | HRM,
    "B4": TACHKI | HRM | IT_LEAD, "B5": TACHKI | HRM,  # the master's deputy removes members (A-ROL-2)
    "B6": HRM, "B7": HRM, "B8": IT_LEAD, "B9": HRM,  # chair and deputies only after 72 hours (АВ-29)
    "B12": TACHKI, "B13": TACHKI | {"master"}, "B14": TACHKI | HRM,
    "G1": TACHKI, "G2": TACHKI,  # the HR master does not review registrations (АВ-3)
    "A1": TACHKI, "A2": TACHKI, "A3": TACHKI,  # account archive (АВ-2)
    "A4": {"chair"}, "A5": {"chair"},
    "P1": ALL, "P2": TACHKI | {"pgas"}, "P3": TACHKI | {"pgas"}, "P4": TACHKI | {"pgas"},  # decision 14
    "MT1": ALL, "MT2": TACHKI | {"editor"}, "MT3": TACHKI | {"editor"}, "MT4": TACHKI, "MT5": TACHKI,
    "MT6": TACHKI | IT_LEAD, "MT7": TACHKI | HRM,
    "C1": ALL, "C2": ALL, "C3": TACHKI | HRM,
}
SUBEVENTS_VISIBLE = {role: (["sa", "sb"] if role in TACHKI | HRM | EVENT_LEAD else ["sa"] if role in SUB_TEAM else [])
                     for role in ROLES}


def test_every_operation_has_an_expectation():
    assert {op.op for op in ops()} == set(EXPECTED)


@pytest.mark.parametrize("role", ROLES)
def test_role_matrix(org, role):
    results, caps = run(org, role)
    problems = []
    for op in ops():
        allowed = role in EXPECTED[op.op]
        want = op.expected(role)
        if results[op.op] not in want:
            problems.append(f"{op.op} {op.method}: HTTP {results[op.op]}, ожидалось {sorted(want)}")
        if op.cap and op.cap[0] in caps and (op.cap[1] in caps[op.cap[0]]) != allowed:
            problems.append(f"{op.op}: capability {op.cap[1]} в {op.cap[0]} {'есть' if not allowed else 'нет'}, "
                            f"а по таблице права {'нет' if not allowed else 'есть'}")
    status, listing = org.raw("GET", f"/events/{org.ids['event']}/subevents", who=role)
    visible = sorted(k for k in ("sa", "sb") if any(i["subevent_id"] == org.ids[k] for i in listing["items"]))
    if visible != SUBEVENTS_VISIBLE[role]:
        problems.append(f"E13: видны подмероприятия {visible}, ожидалось {SUBEVENTS_VISIBLE[role]}")
    assert not problems, f"{role}:\n  " + "\n  ".join(problems)


def _patch_title(org, task_key, role, title):
    before = org.req("GET", f"/tasks/{org.ids[task_key]}")
    status, body = org.raw("PATCH", f"/tasks/{org.ids[task_key]}", {"expected_revision": before["revision"], "title": title}, role)
    return before, status, body, org.req("GET", f"/tasks/{org.ids[task_key]}")


@pytest.mark.parametrize("task_key,op", [("task_sub", "T5"), ("task_blk", "T6")])
def test_denied_task_edit_leaves_no_trace(org, task_key, op):
    """FIX_PLAN 0.1: a refused PATCH changes nothing and returns no task body."""
    for role in ROLES:
        if role in EXPECTED[op]:
            continue
        before, status, body, after = _patch_title(org, task_key, role, f"probe-{role}")
        assert status == (403 if role in EXPECTED[f"T{int(op[1:]) - 2}"] else 404), (role, status)
        assert "title" not in body and "assignments" not in body, role
        assert (after["title"], after["description"], after["revision"]) == \
            (before["title"], before["description"], before["revision"]), role
    for revision in (1, 2, BAD):
        status, _ = org.raw("PATCH", f"/tasks/{org.ids[task_key]}", {"expected_revision": revision}, "outsider")
        assert status == 404, revision


def test_closed_season_task_edit(org):
    """Only the chair and the deputies edit a closed season's task (АВ-2); others keep 403/404."""
    expected = {"chair": 200, "deputy": 200, "resp1": 403, "head1": 403, "org1": 403, "hrmaster": 403, "outsider": 404}
    for role, status_wanted in expected.items():
        before, status, _, after = _patch_title(org, "task_closed", role, f"Списки ({role})")
        assert status == status_wanted, (role, status)
        assert after["revision"] == before["revision"] + (status == 200), role
        if status != 404:
            caps = org.raw("GET", f"/tasks/{org.ids['task_closed']}", who=role)[1]["capabilities"]
            assert ("edit_task" in caps) == (status == 200), (role, caps)


def test_closed_season_offers_no_roster_or_merit_actions(org):
    """FIX_PLAN 3.4 (A-ROL-11): a closed season's rosters are immutable, so no capability promises a change."""
    for role in ("chair", "head1"):
        event = org.raw("GET", f"/events/{org.ids['past_event']}", who=role)[1]
        assert event["capabilities"] == [], role
        assert all(x["capabilities"] == [] for x in event["leaders"]), role
    sub = org.raw("GET", f"/subevents/{org.ids['past_sub']}")[1]
    assert sub["capabilities"] == [] and all(x["capabilities"] == [] for x in sub["leaders"])
    leader = org.raw("GET", f"/events/{org.ids['past_event']}")[1]["leaders"][0]
    status, _ = org.raw("PUT", f"/role-assignments/{leader['role_assignment_id']}/deputies",
                        {"user_ids": [], "expected_revision": leader["revision"]})
    assert status == 409
    session = org.raw("GET", "/session", who="head1")[1]
    past = [x for x in session["assignments"] if x["scope_id"] == org.ids["past_event"]]
    assert past and all(x["capabilities"] == [] for x in past)
    current = [x for x in session["assignments"] if x["scope_id"] == org.ids["event"]]
    assert current and all(x["capabilities"] == ["create_head_merit"] for x in current)


@pytest.mark.skipif(not os.environ.get("ACCESS_MATRIX_DUMP"), reason="dump mode only")
def test_dump_current_matrix(org):
    out = {}
    for role in ROLES:
        results, caps = run(org, role)
        out[role] = {"status": results, "caps": {k: sorted(v) for k, v in caps.items()}}
    with open(os.environ["ACCESS_MATRIX_DUMP"], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


@pytest.mark.parametrize("role", ROLES)
def test_report_series_lists_exactly_the_histories_a_role_opens(org, role):
    """FIX_PLAN 2.2 (A-EVT-6): /report-series and /report-history follow one rule."""
    every = [s["series_id"] for s in org.req("GET", "/report-series")["items"]]
    status, body = org.raw("GET", "/report-series", who=role)
    listed = {s["series_id"] for s in body["items"]} if status == 200 else set()
    opened = {s for s in every if org.raw("GET", f"/report-history?series_id={s}", who=role)[0] == 200}
    assert listed == opened, role


@pytest.mark.parametrize("role", ROLES)
def test_home_page_lists_every_area_for_the_chair_deputies_and_hr_master(org, role):
    """АВ-26, АВ-35: the chair, deputies and HR master see every block and every event of
    an unclosed season on the home page; others see their own. `view_all_areas` in
    /session says which of the two the page shows."""
    everything = role in TACHKI | HRM
    live = {s["season_id"] for s in org.req("GET", "/seasons")["items"] if s["state"] != "closed"}
    all_events = {e["event_id"] for e in org.req("GET", "/events")["items"] if e["season_id"] in live}
    all_blocks = {b["block_id"] for b in org.req("GET", "/blocks")}
    dash = org.req("GET", "/dashboard", who=role)
    events, blocks = {e["event_id"] for e in dash["my_events"]}, {b["block_id"] for b in dash["my_blocks"]}
    assert ("view_all_areas" in org.req("GET", "/session", who=role)["capabilities"]) == everything
    if everything:
        assert (events, blocks) == (all_events, all_blocks)
    else:
        assert events < all_events and blocks <= all_blocks
