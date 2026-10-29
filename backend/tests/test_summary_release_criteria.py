"""Release acceptance for stable sources, compensated totals and provisional bonuses."""
from datetime import datetime, timedelta, timezone
import io
import uuid
import zipfile
from xml.etree import ElementTree as ET

import pytest

from database import ContributionORM, ContactInfoORM, TaskORM, db
from test_v13_tracker import work
from test_v13_season_integrity import accept, close


def summary(client, chair, sid):
    response = client.get(f"/api/seasons/{sid}/summary", headers=chair.headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_draft_bonus_is_a_projection_with_the_same_total_and_rank_after_close(client, work, superuser):
    accept(client, work)
    sid = work["season"]["season_id"]
    before = summary(client, superuser, sid)
    master = next(row for row in before["rows"] if row["user"]["user_id"] == work["master"].user_id)
    member = next(row for row in before["rows"] if row["user"]["user_id"] == work["member"].user_id)
    assert member["source_scores"][0]["title"] == "IT"
    assert master["source_scores"][0]["title"] == "Мастер: IT"
    assert master["total_score"] == member["total_score"] > 0
    assert master["rank"] == member["rank"]
    with db._session() as session:
        assert session.query(ContributionORM).filter_by(season_id=sid, source_kind="master_bonus").count() == 0
    after = close(client, work, superuser)
    expected = {row["participant_id"]: (row["total_score"], row["rank"]) for row in before["rows"]}
    assert {row["participant_id"]: (row["total_score"], row["rank"]) for row in after["rows"]} == expected
    assert summary(client, superuser, sid)["rows"] == after["rows"]


@pytest.mark.parametrize("first, second, total", [([0.1, 0.2], [0.3], 0.3), ([1e16, 1, -1e16], [1], 1)])
def test_compensated_sources_share_stable_season_table_id_and_equal_ranks(
    client, superuser, make_user, first, second, total
):
    people = [make_user(password=None), make_user(password=None)]
    now = datetime.now(timezone.utc)
    season = client.post("/api/seasons", headers=superuser.headers, json={
        "title": "Stable compensated summary", "type": "autumn_winter",
        "starts_at": (now - timedelta(days=5)).isoformat(), "ends_at": (now + timedelta(days=5)).isoformat(),
    }).json()
    sid = season["season_id"]
    opened = client.post(f"/api/seasons/{sid}/open", headers=superuser.headers, json={"expected_revision": season["revision"]})
    assert opened.status_code == 200, opened.text
    with db._session() as session:
        for actor, values in zip(people, [first, second]):
            for index, value in enumerate(values):
                session.add(ContributionORM(contribution_id=str(uuid.uuid4()), season_id=sid,
                    participant_id=f"participant-{actor.user_id}", user_id=actor.user_id, source_kind="chair_merit",
                    source_id="merit", source_title=f"Order-dependent title {index}", score=value,
                    calculation_version="kkr_v1", created_at=now.isoformat()))
        session.commit()
    before = summary(client, superuser, sid)
    rows = [row for row in before["rows"] if row["user"]["user_id"] in {actor.user_id for actor in people}]
    assert len(rows) == 2 and rows[0]["rank"] == rows[1]["rank"]
    for row in rows:
        assert row["total_score"] == pytest.approx(total)
        assert row["source_scores"] == [{"source_kind": "chair_merit", "source_id": "chair-merits:" + sid,
                                          "title": "Заслуги председателя", "score": pytest.approx(total)}]
    ledger = client.get("/api/assessments", headers=superuser.headers,
        params={"season_id": sid, "source_kind": "chair_merit", "source_id": "chair-merits:" + sid})
    assert ledger.status_code == 200, ledger.text
    assert len(ledger.json()["items"]) == len(first) + len(second)
    assert {row["source_id"] for row in ledger.json()["items"]} == {"chair-merits:" + sid}
    after = close(client, {"season": season}, superuser)
    assert [(row["participant_id"], row["total_score"], row["rank"]) for row in before["rows"]] == [
        (row["participant_id"], row["total_score"], row["rank"]) for row in after["rows"]]


def test_xlsx_has_source_values_and_only_xml_safe_preserved_text(client, work, superuser):
    with db._session() as session:
        session.get(ContactInfoORM, work["member"].user_id).surname = "  Synthetic\x0bname  "
        session.get(TaskORM, work["task"]["task_id"]).title = "Synthetic\x0btask"
        session.commit()
    accept(client, work)
    sid = work["season"]["season_id"]
    data = summary(client, superuser, sid)
    response = client.get(f"/api/seasons/{sid}/summary.xlsx", headers=superuser.headers)
    assert response.status_code == 200, response.text
    namespace = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        for name in archive.namelist():
            ET.fromstring(archive.read(name))
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        rows = sheet.findall("m:sheetData/m:row", namespace)
        headers = ["".join(cell.itertext()) for cell in rows[0]]
        assert "IT (Задача блока)" in headers and "Мастер: IT (Бонус мастеру)" in headers
        for xmlrow, row in zip(rows[1:], data["rows"]):
            for source in row["source_scores"]:
                index = next(i for i, header in enumerate(headers) if header.startswith(source["title"] + " ("))
                assert float(xmlrow[index].find("m:v", namespace).text) == source["score"]
        assert all(node.attrib.get("{http://www.w3.org/XML/1998/namespace}space") == "preserve"
                   for node in sheet.findall(".//m:t", namespace))
