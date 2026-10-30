import io, zipfile, xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
import pytest
from database import db, TaskORM, SeasonORM, NotificationORM
from test_v13_tracker import work
from test_v13_season_integrity import accept, close


def test_workspace_keeps_prior_open_season_and_notification_reads(
    client, work, superuser
):
    w = work
    old = w["season"]["season_id"]
    now = datetime.now(timezone.utc)
    second = client.post(
        "/api/seasons",
        headers=superuser.headers,
        json=dict(
            title="New",
            type="autumn_winter",
            starts_at=now.isoformat(),
            ends_at=(now + timedelta(days=100)).isoformat(),
        ),
    ).json()
    client.post(
        f"/api/seasons/{second['season_id']}/open",
        headers=superuser.headers,
        json=dict(expected_revision=1),
    )
    dashboard = client.get("/api/dashboard", headers=w["member"].headers).json()
    assert any(
        t["task_id"] == w["task"]["task_id"] and t["season_id"] == old
        for t in dashboard["my_tasks"]
    )
    calendar = client.get(
        "/api/calendar",
        headers=w["member"].headers,
        params={
            "from": now.date().isoformat(),
            "to": (now + timedelta(days=90)).date().isoformat(),
            "timezone": "Europe/Moscow",
        },
    )
    assert calendar.status_code == 200, calendar.text
    items = calendar.json()["items"]
    assert any(
        x["season_id"] == old and x["target"]["id"] == w["task"]["task_id"]
        for x in items
    )
    n = client.get("/api/notifications", headers=w["member"].headers).json()["items"][0]
    assert n["read_at"] is None
    assert (
        client.post(
            f"/api/notifications/{n['id']}/read", headers=w["member"].headers, json={}
        ).status_code
        == 200
    )
    read = client.get("/api/notifications", headers=w["member"].headers).json()[
        "items"
    ][0]
    assert read["read_at"] is not None
    client.post(
        f"/api/notifications/{n['id']}/read", headers=w["member"].headers, json={}
    )
    assert (
        client.get("/api/notifications", headers=w["member"].headers).json()["items"][
            0
        ]["read_at"]
        == read["read_at"]
    )


def test_xlsx_has_two_sheets_and_matches_frozen_totals(client, work, superuser):
    accept(client, work)
    summary = close(client, work, superuser)
    sid = work["season"]["season_id"]
    assert (
        client.get(
            f"/api/seasons/{sid}/summary.xlsx", headers=work["member"].headers
        ).status_code
        == 403
    )
    r = client.get(f"/api/seasons/{sid}/summary.xlsx", headers=superuser.headers)
    assert r.status_code == 200, r.text if r.status_code != 200 else ""
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        assert [x.attrib["name"] for x in wb.findall("m:sheets/m:sheet", ns)] == [
            "Сводная",
            "Начисления",
        ]
        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
        for xmlrow, row in zip(
            sheet.findall("m:sheetData/m:row", ns)[1:], summary["rows"]
        ):
            cells = {c.attrib["r"].rstrip("0123456789"): c for c in xmlrow}
            assert float(cells["I"].find("m:v", ns).text) == round(
                row["total_score"], 2
            )
        ledger = ET.fromstring(z.read("xl/worksheets/sheet2.xml"))
        assert len(ledger.findall("m:sheetData/m:row", ns)) >= 3
        detail_rows=ledger.findall("m:sheetData/m:row",ns)
        headers=["".join(c.itertext()) for c in detail_rows[0]]
        assert 'Часы' in headers and 'Баллы без округления' in headers
        evaluated=[]
        for row in detail_rows[1:]:
            cells={c.attrib['r'].rstrip('0123456789'):c for c in row}
            hours=cells['M'].find('m:v',ns)
            if hours is not None:
                assert float(hours.text)==2
                assert float(cells['N'].find('m:v',ns).text)==1
                raw=float(cells['S'].find('m:v',ns).text)
                assert round(raw,2)==float(cells['F'].find('m:v',ns).text)
                evaluated.append(raw)
        assert evaluated



def _sheet(z, n):
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rows = ET.fromstring(z.read(f"xl/worksheets/sheet{n}.xml")).findall("m:sheetData/m:row", ns)
    return [["".join(c.itertext()) for c in row] for row in rows]


def test_xlsx_values_are_russian(client, work, superuser):
    """2.13: the export names categories, decisions, sources and criteria as the screens do."""
    with db._session() as s:
        s.get(TaskORM, work["task"]["task_id"]).criteria_json = '{"unique": true, "in_person": true, "creative": false}'
        s.commit()
    accept(client, work)
    summary = close(client, work, superuser)
    sid = work["season"]["season_id"]
    member = work["member"]
    r = client.put(f"/api/seasons/{sid}/summary/decisions/{member.user_id}", headers=superuser.headers,
                   json=dict(decisions=["nice", "kick_warning"], expected_version=summary["version"], reason="Проверка выгрузки"))
    assert r.status_code == 200, r.text
    r = client.get(f"/api/seasons/{sid}/summary.xlsx", headers=superuser.headers)
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        summary_rows, ledger = _sheet(z, 1), _sheet(z, 2)
    head = summary_rows[0]
    rows = [dict(zip(head, row)) for row in summary_rows[1:]]
    assert rows and {x["Категория"] for x in rows} <= {"Джуниор", "Активист"}
    assert any(x["Решения"] == "Найс, Предупреждение о кике" for x in rows), rows
    head = ledger[0]
    entries = [dict(zip(head, row)) for row in ledger[1:]]
    assert entries and {x["Сезон"] for x in entries} == {work["season"]["title"]}
    assert {x["Тип источника"] for x in entries} <= {"Задача блока", "Задача подмероприятия", "Бонус мастеру"}
    assert {x["Критерии"] for x in entries if x["Назначение"]} == {"Уникальная, Очное присутствие"}


def test_help_notification_repeat_does_not_duplicate(client, work):
    w = work
    aid = w["task"]["assignments"][0]["assignment_id"]
    payload = dict(
        expected_revision=1, message=dict(format="markdown", body="Нужна помощь")
    )
    assert (
        client.post(
            f"/api/assignments/{aid}/request-help",
            headers=w["member"].headers,
            json=payload,
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/assignments/{aid}/request-help",
            headers=w["member"].headers,
            json=payload,
        ).status_code
        == 409
    )
    with db._session() as s:
        assert (
            s.query(NotificationORM)
            .filter_by(user_id=w["master"].user_id, kind="task_status_changed")
            .count()
            == 1
        )


def test_comment_body_and_notification_are_safe(client, work):
    w = work
    tid = w["task"]["task_id"]
    r = client.post(
        f"/api/tasks/{tid}/comments",
        headers=w["member"].headers,
        json=dict(content=dict(format="markdown", body="**Комментарий**")),
    )
    assert r.status_code == 200, r.text
    assert r.json()["content"]["body"] == "**Комментарий**"
    with db._session() as s:
        assert (
            s.query(NotificationORM)
            .filter_by(user_id=w["master"].user_id, kind="task_comment")
            .count()
            == 1
        )
    messages = client.get("/api/notifications", headers=w["master"].headers).json()[
        "items"
    ]
    assert any(m["target"] == dict(kind="task", id=tid) for m in messages)


def test_calendar_zone_does_not_need_the_system_zone_files():
    """python:3.12-slim may lack /usr/share/zoneinfo: the Moscow zone of the calendar then
    comes from the tzdata package in requirements.txt (otherwise 422 «Unknown timezone»)."""
    import os
    import subprocess
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[1]
    assert "tzdata" in {
        line.split("==")[0].strip() for line in (backend / "requirements.txt").read_text().splitlines()
    }
    code = (
        "import os, zoneinfo; assert not any(os.path.isdir(p) for p in zoneinfo.TZPATH);"
        "from workspace import date_range;"
        "print(date_range('2026-10-01', '2026-10-31')[0])"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=backend, capture_output=True, text=True,
        env={**os.environ, "PYTHONTZPATH": str(backend / "no-zoneinfo")},
    )
    assert out.returncode == 0, out.stderr[-500:]
    assert out.stdout.strip() == "2026-09-30T21:00:00+00:00"
