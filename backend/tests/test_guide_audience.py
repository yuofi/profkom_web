"""Who reads a block guide (owner, 2026-10-25): by default its block only — members, leads
and the chair's team; its writers may open it to every participant and close it again."""
from database import db


def guide(client, headers, make_guide, owner="Медиа"):
    g = make_guide(title="Гайд блока", owner_block=owner, text="Как у нас всё устроено")
    return client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=headers).json()["material_id"], g


def listed(client, actor, material_id):
    return material_id in [m["material_id"] for m in client.get("/api/materials", headers=actor.headers).json()["items"]]


def test_block_guide_reads_to_its_block_until_opened_to_everyone(client, superuser, make_user, make_block, make_guide):
    member, outsider, master = make_user(), make_user(), make_user()
    make_block(arr_of_human=[member.user_id])
    db.set_block_leader("Медиа", master.user_id)
    mid, g = guide(client, superuser.headers, make_guide)

    for actor in (member, master, superuser):
        r = client.get(f"/api/materials/{mid}", headers=actor.headers)
        assert r.status_code == 200, r.text
        assert r.json()["audience"] == "block" and listed(client, actor, mid)
    assert client.get(f"/api/materials/{mid}", headers=outsider.headers).status_code == 404
    assert client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=outsider.headers).status_code == 404
    assert not listed(client, outsider, mid)

    # Who writes the guide decides; a member who only reads does not.
    current = client.get(f"/api/materials/{mid}", headers=master.headers).json()
    assert "edit_audience" in current["capabilities"]
    assert "edit_audience" not in client.get(f"/api/materials/{mid}", headers=member.headers).json()["capabilities"]
    body = dict(audience="everyone", expected_revision=current["revision"])
    assert client.put(f"/api/materials/{mid}/audience", headers=member.headers, json=body).status_code == 403
    opened = client.put(f"/api/materials/{mid}/audience", headers=master.headers, json=body)
    assert opened.status_code == 200, opened.text
    assert opened.json()["audience"] == "everyone" and opened.json()["revision"] == current["revision"] + 1
    assert client.get(f"/api/materials/{mid}", headers=outsider.headers).status_code == 200
    assert client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=outsider.headers).status_code == 200
    assert listed(client, outsider, mid)

    stale = client.put(f"/api/materials/{mid}/audience", headers=superuser.headers, json=dict(audience="block", expected_revision=current["revision"]))
    assert stale.status_code == 409
    closed = client.put(f"/api/materials/{mid}/audience", headers=superuser.headers,
                        json=dict(audience="block", expected_revision=opened.json()["revision"]))
    assert closed.status_code == 200 and closed.json()["audience"] == "block"
    assert client.get(f"/api/materials/{mid}", headers=outsider.headers).status_code == 404


def test_only_a_block_guide_has_an_audience(client, superuser, make_user, make_guide):
    shared = make_user()
    mid, g = guide(client, superuser.headers, make_guide, owner="none")
    m = client.get(f"/api/materials/{mid}", headers=shared.headers)
    assert m.status_code == 200 and "audience" not in m.json()
    r = client.put(f"/api/materials/{mid}/audience", headers=superuser.headers,
                   json=dict(audience="block", expected_revision=m.json()["revision"]))
    assert r.status_code == 422
    assert client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=shared.headers).status_code == 200


def test_a_left_member_no_longer_reads_the_block_guide(client, superuser, make_user, make_block, make_guide):
    member = make_user()
    make_block(arr_of_human=[member.user_id])
    mid, _ = guide(client, superuser.headers, make_guide)
    assert client.get(f"/api/materials/{mid}", headers=member.headers).status_code == 200
    from database import BlockORM
    with db._session() as s:
        s.get(BlockORM, "Медиа").arr_of_human = "[]"
        s.commit()
    assert client.get(f"/api/materials/{mid}", headers=member.headers).status_code == 404
