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
        == 403
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
