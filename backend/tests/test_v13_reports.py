from datetime import datetime, timezone, timedelta
import pytest
from database import db


@pytest.fixture
def reports(client, superuser, make_user):
    author = make_user()
    colead = make_user()
    newlead = make_user()
    stranger = make_user()
    now = datetime.now(timezone.utc)
    season = client.post(
        "/api/seasons",
        headers=superuser.headers,
        json=dict(
            title="Reports",
            type="autumn_winter",
            starts_at=(now - timedelta(days=10)).isoformat(),
            ends_at=(now + timedelta(days=10)).isoformat(),
        ),
    ).json()
    sid = season["season_id"]
    client.post(
        f"/api/seasons/{sid}/open",
        headers=superuser.headers,
        json=dict(expected_revision=1),
    )
    event = client.post(
        "/api/events",
        headers=superuser.headers,
        json=dict(season_id=sid, title="Festival", description=""),
    ).json()
    eid = event["event_id"]
    client.put(
        f"/api/events/{eid}/leaders",
        headers=superuser.headers,
        json=dict(expected_revision=1, user_ids=[author.user_id, colead.user_id]),
    )
    report = client.post(
        "/api/reports",
        headers=author.headers,
        json=dict(
            owner_kind="event",
            owner_id=eid,
            kind="final",
            title="Final",
            content="Published",
            file_ids=[],
        ),
    ).json()
    rid = report["report_id"]
    client.post(
        f"/api/reports/{rid}/publish",
        headers=author.headers,
        json=dict(expected_revision=1),
    )
    return dict(
        author=author,
        colead=colead,
        newlead=newlead,
        stranger=stranger,
        event=event,
        season=season,
        rid=rid,
    )


def test_removed_author_does_not_keep_editing_rights_and_coleader_does(
    client, reports, superuser
):
    r = reports
    eid = r["event"]["event_id"]
    sid = r["season"]["season_id"]
    rid = r["rid"]
    assert (
        client.put(
            f"/api/events/{eid}/leaders",
            headers=superuser.headers,
            json=dict(expected_revision=2, user_ids=[r["colead"].user_id]),
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/reports/{rid}",
            headers=r["author"].headers,
            json=dict(expected_revision=2, title="Wrong"),
        ).status_code
        == 403
    )
    client.post(
        f"/api/seasons/{sid}/begin-summary",
        headers=superuser.headers,
        json=dict(expected_revision=2),
    )
    closed = client.post(
        f"/api/seasons/{sid}/close",
        headers=superuser.headers,
        json=dict(expected_revision=3),
    )
    assert closed.status_code == 200, closed.text
    version = closed.json()["summary"]["version"]
    assert (
        client.patch(
            f"/api/reports/{rid}",
            headers=r["author"].headers,
            json=dict(expected_revision=2, title="Still wrong"),
        ).status_code
        == 403
    )
    result = client.patch(
        f"/api/reports/{rid}",
        headers=r["colead"].headers,
        json=dict(expected_revision=2, title="Correct"),
    )
    assert result.status_code == 200, result.text
    assert (
        client.post(
            f"/api/reports/{rid}/publish",
            headers=r["colead"].headers,
            json=dict(expected_revision=3),
        ).status_code
        == 200
    )
    assert (
        client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers).json()[
            "version"
        ]
        == version
    )


def test_current_series_leader_reads_history_but_not_draft_or_edit(
    client, reports, superuser
):
    r = reports
    eid = r["event"]["event_id"]
    sid = r["season"]["season_id"]
    rid = r["rid"]
    now = datetime.now(timezone.utc)
    client.post(
        f"/api/seasons/{sid}/begin-summary",
        headers=superuser.headers,
        json=dict(expected_revision=2),
    )
    assert (
        client.post(
            f"/api/seasons/{sid}/close",
            headers=superuser.headers,
            json=dict(expected_revision=3),
        ).status_code
        == 200
    )
    target = client.post(
        "/api/seasons",
        headers=superuser.headers,
        json=dict(
            title="Next",
            type="autumn_winter",
            starts_at=(now + timedelta(days=20)).isoformat(),
            ends_at=(now + timedelta(days=40)).isoformat(),
        ),
    ).json()
    event = client.post(
        f"/api/events/{eid}/copy",
        headers=superuser.headers,
        json=dict(season_id=target["season_id"], title="Next festival"),
    ).json()["event"]
    newid = event["event_id"]
    assert (
        client.put(
            f"/api/events/{newid}/leaders",
            headers=superuser.headers,
            json=dict(expected_revision=1, user_ids=[r["newlead"].user_id]),
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/reports/{rid}",
            headers=r["author"].headers,
            json=dict(expected_revision=2, content="Secret draft"),
        ).status_code
        == 200
    )
    history = client.get(
        "/api/report-history",
        headers=r["newlead"].headers,
        params=dict(series_id=r["event"]["report_series_id"]),
    )
    assert history.status_code == 200, history.text
    assert len(history.json()["items"]) == 1
    item = history.json()["items"][0]
    assert item["content"]["body"] == "Published"
    assert not any(k.startswith("draft_") for k in item)
    assert (
        client.patch(
            f"/api/reports/{rid}",
            headers=r["newlead"].headers,
            json=dict(expected_revision=3, title="No"),
        ).status_code
        == 403
    )
    assert (
        client.get(
            f"/api/reports/{rid}/versions", headers=r["newlead"].headers
        ).status_code
        == 200
    )
    assert (
        client.get(f"/api/reports/{rid}", headers=r["stranger"].headers).status_code
        == 404
    )


def test_file_access_is_revoked_with_report_role(client, reports, superuser, mock_s3):
    r = reports
    rid = r["rid"]
    eid = r["event"]["event_id"]
    content = b"%PDF-1.4\nSynthetic"
    intent = client.post(
        "/api/files/upload-intents",
        headers=r["author"].headers,
        json=dict(
            owner_kind="report",
            owner_id=rid,
            purpose="report",
            name="report.pdf",
            mime_type="application/pdf",
            size_bytes=len(content),
        ),
    ).json()
    fid = intent["file_id"]
    mock_s3["objects"]["private/" + fid] = (content, "application/pdf")
    assert (
        client.post(
            f"/api/files/{fid}/complete", headers=r["author"].headers, json={}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/reports/{rid}",
            headers=r["author"].headers,
            json=dict(expected_revision=2, file_ids=[fid]),
        ).status_code
        == 200
    )
    assert (
        client.get(
            f"/api/files/{fid}/download", headers=r["stranger"].headers
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/reports/{rid}/publish",
            headers=r["author"].headers,
            json=dict(expected_revision=3),
        ).status_code
        == 200
    )
    assert (
        client.put(
            f"/api/events/{eid}/leaders",
            headers=superuser.headers,
            json=dict(expected_revision=2, user_ids=[r["colead"].user_id]),
        ).status_code
        == 200
    )
    assert (
        client.get(
            f"/api/files/{fid}/download", headers=r["author"].headers
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/api/files/{fid}/download", headers=r["colead"].headers
        ).status_code
        == 200
    )


# FIX_PLAN 2.2 and ACC-08: who reads the history of a series and how it is paged.
def _call(client, method, who, path, status=200, **body):
    r = client.request(method, "/api" + path, headers=who.headers, json=body or None)
    assert r.status_code == status, f"{method} {path}: {r.status_code} {r.text}"
    return r.json()


def _publish(client, who, owner_kind, owner_id, title, kind="regular"):
    r = _call(client, "POST", who, "/reports", owner_kind=owner_kind, owner_id=owner_id, kind=kind, title=title, content=title, file_ids=[])
    return _call(client, "POST", who, f"/reports/{r['report_id']}/publish", expected_revision=r["revision"])


def _advance(client, superuser, season_id, *commands):
    for command in commands:
        season = next(s for s in _call(client, "GET", superuser, "/seasons")["items"] if s["season_id"] == season_id)
        _call(client, "POST", superuser, f"/seasons/{season_id}/{command}", expected_revision=season["revision"])


def _history(client, who, series_id, status=200, **params):
    r = client.get("/api/report-history", headers=who.headers, params=dict(series_id=series_id, **params))
    assert r.status_code == status, r.text
    return [item["report_id"] for item in r.json()["items"]] if status == 200 else None


@pytest.fixture
def series(client, superuser, make_user):
    """«Посвят» with «Лекции» in an open season, final reports of both published, and a
    copy in a planned next season led by other people."""
    p = {k: make_user() for k in ("head", "resp", "org", "newhead", "newresp", "neworg")}
    now = datetime.now(timezone.utc)
    past = _call(client, "POST", superuser, "/seasons", title="Past", type="autumn_winter",
                 starts_at=(now - timedelta(days=10)).isoformat(), ends_at=(now + timedelta(days=10)).isoformat())
    _advance(client, superuser, past["season_id"], "open")
    ev = _call(client, "POST", superuser, "/events", season_id=past["season_id"], title="Посвят", description="")
    _call(client, "PUT", superuser, f"/events/{ev['event_id']}/leaders", user_ids=[p["head"].user_id], expected_revision=1)
    sub = _call(client, "POST", superuser, f"/events/{ev['event_id']}/subevents", title="Лекции")
    sub = _call(client, "PUT", superuser, f"/subevents/{sub['subevent_id']}/leaders", user_ids=[p["resp"].user_id], expected_revision=1)
    _call(client, "PUT", superuser, f"/subevents/{sub['subevent_id']}/organizers", user_ids=[p["org"].user_id], expected_revision=sub["revision"])
    ev_report = _publish(client, p["head"], "event", ev["event_id"], "Итог Посвята", "final")
    sub_report = _publish(client, p["resp"], "subevent", sub["subevent_id"], "Итог лекций", "final")
    nxt = _call(client, "POST", superuser, "/seasons", title="Next", type="autumn_winter",
                starts_at=(now + timedelta(days=20)).isoformat(), ends_at=(now + timedelta(days=40)).isoformat())
    copy = _call(client, "POST", superuser, f"/events/{ev['event_id']}/copy", season_id=nxt["season_id"], title="Посвят следующего года")
    _call(client, "PUT", superuser, f"/events/{copy['event']['event_id']}/leaders", user_ids=[p["newhead"].user_id], expected_revision=copy["event"]["revision"])
    lek = copy["subevents"][0]
    lek = _call(client, "PUT", superuser, f"/subevents/{lek['subevent_id']}/leaders", user_ids=[p["newresp"].user_id], expected_revision=lek["revision"])
    _call(client, "PUT", superuser, f"/subevents/{lek['subevent_id']}/organizers", user_ids=[p["neworg"].user_id], expected_revision=lek["revision"])
    return dict(p, past=past["season_id"], next=nxt["season_id"], event=ev, sub=sub, copy=copy["event"],
                ev_series=ev["report_series_id"], sub_series=sub["report_series_id"],
                ev_report=ev_report["report_id"], sub_report=sub_report["report_id"])


@pytest.mark.parametrize("phase", ["next planned, past open", "next open, past summarizing"])
def test_new_leads_read_the_past_instance_before_it_closes(client, superuser, series, phase):
    """A-EVT-3: the leads of the next instance read published reports of the previous one
    while its season is still open or summarizing; drafts and writing stay closed."""
    x = series
    if phase.startswith("next open"):
        _advance(client, superuser, x["next"], "open")
        _advance(client, superuser, x["past"], "begin-summary")
    report = _call(client, "GET", x["head"], f"/reports/{x['ev_report']}")
    _call(client, "PATCH", x["head"], f"/reports/{x['ev_report']}", expected_revision=report["revision"], content="Скрытый черновик")
    for who, series_id, rid in ((x["newhead"], x["ev_series"], x["ev_report"]), (x["newhead"], x["sub_series"], x["sub_report"]),
                                (x["newresp"], x["sub_series"], x["sub_report"])):
        r = client.get("/api/report-history", headers=who.headers, params=dict(series_id=series_id))
        assert r.status_code == 200, r.text
        assert [i["report_id"] for i in r.json()["items"]] == [rid]
        assert not any(k.startswith("draft_") for k in r.json()["items"][0])
        assert "Скрытый черновик" not in r.text
        read = _call(client, "GET", who, f"/reports/{rid}")
        assert "draft_content" not in read
        _call(client, "GET", who, f"/reports/{rid}/versions")
        _call(client, "PATCH", who, f"/reports/{rid}", 403, expected_revision=read["revision"], title="Нельзя")
    # The organizer of the copy leads nothing: no series and no history.
    assert x["sub_series"] not in [s["series_id"] for s in _call(client, "GET", x["neworg"], "/report-series")["items"]]
    _history(client, x["neworg"], x["sub_series"], 404)


def test_every_listed_series_opens_its_history(client, superuser, series):
    """A-EVT-6: /report-series and /report-history follow one rule; an organizer reads the
    current report but is not a history reader."""
    x = series
    for who in (superuser, *(x[k] for k in ("head", "resp", "org", "newhead", "newresp", "neworg"))):
        for item in _call(client, "GET", who, "/report-series")["items"]:
            _history(client, who, item["series_id"])
    assert x["sub_series"] not in [s["series_id"] for s in _call(client, "GET", x["org"], "/report-series")["items"]]
    _history(client, x["org"], x["sub_series"], 404)
    _call(client, "GET", x["org"], f"/reports/{x['sub_report']}")


def test_head_organizer_keeps_reading_subevent_reports_after_close(client, superuser, series):
    """ACC-08, decision 19: the snapshot keeps every lead assignment, the head organizer
    reads the subevent's reports read-only, the organizer loses access."""
    from database import UserORM
    x = series

    def banned(user, value):
        with db._session() as s:
            s.get(UserORM, user.user_id).banned = value
            s.commit()

    # Blocked at closing, but still assigned: activity is checked at each operation.
    banned(x["head"], True)
    _advance(client, superuser, x["past"], "begin-summary", "close")
    banned(x["head"], False)
    sub_report = _call(client, "GET", x["head"], f"/reports/{x['sub_report']}")
    assert "edit_report" not in sub_report["capabilities"]
    assert _history(client, x["head"], x["sub_series"]) == [x["sub_report"]]
    _call(client, "PATCH", x["head"], f"/reports/{x['sub_report']}", 403, expected_revision=sub_report["revision"], title="Нельзя")
    _call(client, "PATCH", x["head"], f"/reports/{x['ev_report']}", 409, expected_revision=999, title="Своё можно")
    _call(client, "PATCH", x["resp"], f"/reports/{x['sub_report']}", 409, expected_revision=999, title="Своё можно")
    _call(client, "GET", x["org"], f"/reports/{x['sub_report']}", 404)
    _history(client, x["org"], x["sub_series"], 404)
    banned(x["head"], True)
    assert client.get(f"/api/reports/{x['sub_report']}", headers=x["head"].headers).status_code != 200


def test_history_year_is_the_moscow_year_of_the_season(client, superuser, series):
    """A-EVT-5: a report belongs to the year its season starts in (Moscow time), also
    after a later correction."""
    from database import SeasonORM, ReportORM, moscow_year
    x = series
    _advance(client, superuser, x["past"], "begin-summary", "close")
    with db._session() as s:
        season = s.get(SeasonORM, x["past"])
        season.starts_at, season.ends_at = "2025-02-01T00:00:00+00:00", "2025-06-30T00:00:00+00:00"
        s.get(ReportORM, x["ev_report"]).published_at = "2025-12-31T22:30:00+00:00"
        s.commit()
    assert _history(client, superuser, x["ev_series"], year=2025) == [x["ev_report"]]
    assert _history(client, superuser, x["ev_series"], year=2026) == []
    report = _call(client, "GET", x["head"], f"/reports/{x['ev_report']}")
    report = _call(client, "PATCH", x["head"], f"/reports/{x['ev_report']}", expected_revision=report["revision"], content="Исправленный итог")
    _call(client, "POST", x["head"], f"/reports/{x['ev_report']}/publish", expected_revision=report["revision"])
    assert _history(client, superuser, x["ev_series"], year=2025) == [x["ev_report"]]
    assert _history(client, superuser, x["ev_series"], year=datetime.now(timezone.utc).year) == []
    # A season that starts at 01:00 on 1 January in Moscow belongs to the new year.
    assert (moscow_year("2025-12-31T22:00:00Z"), moscow_year("2025-12-31T20:59:59+00:00")) == (2026, 2025)


def _walk(client, who, path, **params):
    """All pages of a cursor list; every page holds items and none repeats."""
    pages, cursor = [], None
    while True:
        r = client.get("/api" + path, headers=who.headers, params=dict(params, **({"cursor": cursor} if cursor else {})))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["items"], "a page without items"
        pages.append(body["items"])
        cursor = body["next_cursor"]
        if not cursor:
            return pages


def test_report_versions_and_history_are_paged_by_cursor(client, superuser, series, monkeypatch):
    """A-EVT-10: keyset pages without repeats; readability is applied before paging."""
    import api_contract
    monkeypatch.setattr(api_contract, "PAGE_SIZE", 2)
    x = series
    rid = x["ev_report"]
    for text in ("Вторая редакция", "Третья редакция"):
        report = _call(client, "GET", x["head"], f"/reports/{rid}")
        report = _call(client, "PATCH", x["head"], f"/reports/{rid}", expected_revision=report["revision"], content=text)
        _call(client, "POST", x["head"], f"/reports/{rid}/publish", expected_revision=report["revision"])
    pages = _walk(client, superuser, f"/reports/{rid}/versions")
    assert [[v["version"] for v in page] for page in pages] == [[1, 2], [3]]
    old = [rid] + [_publish(client, x["head"], "event", x["event"]["event_id"], f"Отчёт {i}")["report_id"] for i in range(2)]
    pages = _walk(client, superuser, "/report-history", series_id=x["ev_series"])
    assert [len(page) for page in pages] == [2, 1]
    assert sorted(i["report_id"] for page in pages for i in page) == sorted(old)
    year = datetime.now(timezone.utc).year
    assert sum(len(page) for page in _walk(client, superuser, "/report-history", series_id=x["ev_series"], year=year)) == 3
    for bad in ("not a cursor", "eyJhIjogMX0=", "WzEsIDJd"):  # garbage, {"a": 1}, [1, 2]
        r = client.get("/api/report-history", headers=superuser.headers, params=dict(series_id=x["ev_series"], cursor=bad))
        assert r.status_code == 422, (bad, r.text)
    # Newer reports of the next instance are not the old head's to read: they are left
    # out before paging, so no page is empty and nothing hints at them.
    _advance(client, superuser, x["past"], "begin-summary", "close")
    _advance(client, superuser, x["next"], "open")
    for i in range(3):
        _publish(client, x["newhead"], "event", x["copy"]["event_id"], f"Новый отчёт {i}")
    pages = _walk(client, x["head"], "/report-history", series_id=x["ev_series"])
    assert sorted(i["report_id"] for page in pages for i in page) == sorted(old)
    assert sum(len(page) for page in _walk(client, superuser, "/report-history", series_id=x["ev_series"])) == 6
