from test_v13_reports import reports

def test_report_version_capability_matches_read_access(client, reports, superuser):
    r = reports
    rid = r["rid"]
    for actor in (r["author"], r["colead"], superuser):
        response = client.get(f"/api/reports/{rid}", headers=actor.headers)
        assert response.status_code == 200
        assert "view_report_versions" in response.json()["capabilities"]
        assert client.get(f"/api/reports/{rid}/versions", headers=actor.headers).status_code == 200
    assert "edit_report" not in client.get(f"/api/reports/{rid}", headers=superuser.headers).json()["capabilities"]
    assert client.get(f"/api/reports/{rid}", headers=r["stranger"].headers).status_code == 404
    assert client.get(f"/api/reports/{rid}/versions", headers=r["stranger"].headers).status_code == 404
    changed = client.put(f"/api/events/{r['event']['event_id']}/leaders", headers=superuser.headers,
                         json={"expected_revision": 2, "user_ids": [r["colead"].user_id]})
    assert changed.status_code == 200
    assert client.get(f"/api/reports/{rid}", headers=r["author"].headers).status_code == 404
    assert client.get(f"/api/reports/{rid}/versions", headers=r["author"].headers).status_code == 404
