"""API 1.3 access policy: who may do what, in one table (RELEASE_PLAN.md, section 2).

`POLICY` maps an action to the relations that allow it. `relations()` derives the actor's
relations to one object (a block, event, subevent or material) from the stored roles, and
`allowed()` is the single check behind both the commands and the `capabilities` lists, so
a capability is shown exactly when the command is permitted. Season state still decides
what can change at all (planned/open/closed); a rule can narrow its relations by state.
"""

from contextvars import ContextVar
import hashlib
import json
from database import db

actor_id = ContextVar("profkom_actor_id", default=None)

# ── Relations ──
# Global
CHAIR = "chair"
CHAIR_DEPUTY = "chair_deputy"
HR_MASTER = "hr_master"
PGAS_ADMIN = "pgas_admin"
BLOCK_LEAD_ANYWHERE = "block_lead_anywhere"  # master or deputy of some block
QUEUE_HOLDER = "queue_holder"  # leads some block, event or subevent
# Block
BLOCK_MASTER = "block_master"
BLOCK_DEPUTY = "block_deputy"
BLOCK_MEMBER = "block_member"
# Event; a subevent also inherits the relations to its event
EVENT_LEADER = "event_leader"
EVENT_DEPUTY = "event_deputy"
EVENT_SUB_LEAD = "event_sub_lead"  # leads one of the event's subevents
# Subevent
SUB_LEADER = "sub_leader"
SUB_DEPUTY = "sub_deputy"
ORGANIZER = "organizer"
# Material
MATERIAL_EDITOR = "material_editor"

TACHKI = frozenset({CHAIR, CHAIR_DEPUTY})  # the chair and the chair's deputies
SUMMARY = TACHKI | {HR_MASTER}
EVENT_LEADS = frozenset({EVENT_LEADER, EVENT_DEPUTY})
SUB_LEADS = frozenset({SUB_LEADER, SUB_DEPUTY})
BLOCK_LEADS = frozenset({BLOCK_MASTER, BLOCK_DEPUTY})
# Leaders of a task area: block master and deputy; subevent leader and deputy, and the
# parent event's leader and deputy.
AREA_LEADS = BLOCK_LEADS | SUB_LEADS | EVENT_LEADS
AREA_TEAM = AREA_LEADS | {BLOCK_MEMBER, ORGANIZER}
SUBEVENT_READERS = TACHKI | {HR_MASTER} | EVENT_LEADS | SUB_LEADS | {ORGANIZER}


class ByState(dict):
    """A rule whose relations depend on the season state ('*' is every other state)."""


POLICY = {
    # Seasons
    "season.create": {CHAIR},
    "season.edit": {CHAIR},
    "season.open": {CHAIR},
    "season.begin_summary": {CHAIR},
    "season.close": {CHAIR},
    "season.correct": TACHKI,  # moving objects between seasons
    # Events and subevents
    "event.create": TACHKI,
    "event.edit": TACHKI | EVENT_LEADS,  # not the HR master (УВ-4)
    "event.manage_leaders": TACHKI,
    "event.manage_leader_deputies": TACHKI,
    "event.create_subevent": TACHKI | EVENT_LEADS,
    "event.meeting.view": TACHKI | {HR_MASTER} | EVENT_LEADS | {EVENT_SUB_LEAD},
    "event.meeting.edit": TACHKI | EVENT_LEADS,
    "event.report.create": EVENT_LEADS,
    "event.report.read": TACHKI | {HR_MASTER} | EVENT_LEADS,
    "subevent.view": SUBEVENT_READERS,  # working data: tasks, meeting, report (УВ-3)
    "subevent.list_all": TACHKI | {HR_MASTER} | EVENT_LEADS,
    "subevent.edit": TACHKI | EVENT_LEADS | SUB_LEADS,
    "subevent.manage_leaders": TACHKI | EVENT_LEADS,
    "subevent.manage_leader_deputies": TACHKI | EVENT_LEADS,
    "subevent.manage_organizers": TACHKI | EVENT_LEADS,
    "subevent.meeting.view": SUBEVENT_READERS,
    "subevent.meeting.edit": TACHKI | EVENT_LEADS | SUB_LEADS,
    "subevent.report.create": SUB_LEADS,
    "subevent.report.read": SUBEVENT_READERS,
    "report.read_all": TACHKI | {HR_MASTER},  # every published report, closed seasons too
    # Tasks; the scope is a block or a subevent
    "task.view": TACHKI | {HR_MASTER} | AREA_TEAM,
    "task.create": TACHKI | AREA_LEADS,
    "task.edit": ByState({"*": TACHKI | AREA_LEADS, "closed": TACHKI}),  # title and description (АВ-3)
    "task.review": ByState({"*": TACHKI | {HR_MASTER} | AREA_LEADS, "closed": TACHKI}),
    "task.inputs.view": TACHKI | {HR_MASTER} | AREA_LEADS,
    "task.inputs.edit": ByState({"*": TACHKI | {HR_MASTER} | AREA_LEADS, "closed": TACHKI}),
    # Issue date, deadline and completion date, once set; area leads do not move them (УВ-5)
    "task.dates.edit": ByState({"*": SUMMARY, "closed": TACHKI}),
    "queue.view": TACHKI | {HR_MASTER, QUEUE_HOLDER},
    "dashboard.all": TACHKI | {HR_MASTER},  # every block and event on the home page (АВ-26, АВ-35)
    # KKR, summary, merits
    "kkr.view": SUMMARY,
    "summary.view": SUMMARY,
    "summary.decide": ByState({"*": SUMMARY, "closed": TACHKI}),
    "summary.correct": TACHKI,  # closed season corrections (АВ-2)
    "merit.create.chair": TACHKI,
    "merit.create.head": TACHKI | EVENT_LEADS,  # decision 12
    "merit.create.block_volunteer": TACHKI | {HR_MASTER} | BLOCK_LEADS,
    "merit.create.subevent_volunteer": TACHKI | {HR_MASTER} | EVENT_LEADS | SUB_LEADS,  # A-KKR-8 (a)
    "merit.manage.chair_merit": ByState({"*": SUMMARY, "closed": TACHKI}),
    "merit.manage.head_merit": ByState({"*": SUMMARY | EVENT_LEADS, "closed": TACHKI}),
    "merit.manage.block_volunteer": ByState({"*": SUMMARY | BLOCK_LEADS, "closed": TACHKI}),
    "merit.manage.subevent_volunteer": ByState({"*": SUMMARY | EVENT_LEADS | SUB_LEADS, "closed": TACHKI}),
    # Blocks and membership
    "block.edit": TACHKI | BLOCK_LEADS,
    "block.rename": TACHKI,
    "block.remove_member": TACHKI | {HR_MASTER} | BLOCK_LEADS,  # A-ROL-2
    "block.manage_leader": TACHKI,
    "block.manage_master_deputies": TACHKI | {BLOCK_MASTER},
    "block.review_hr_stage": {HR_MASTER},  # the chair and deputies substitute after 72 hours
    "block.review_block_stage": BLOCK_LEADS,
    "block_request.view_all": TACHKI | {HR_MASTER},
    # Checked on the HR block: its whole team reads every request and why it was rejected (decision 16)
    "block_request.view_as_hr": BLOCK_LEADS | {BLOCK_MEMBER},
    "participant.category": SUMMARY,
    "former_contact.edit": SUMMARY,
    # Registrations, accounts, leadership
    "registration.review": TACHKI,  # not the HR master (АВ-3)
    "account.archive": TACHKI,  # АВ-2
    "account.restore": TACHKI,
    "account.view_archive": TACHKI,
    "leadership.transfer": {CHAIR},
    "leadership.deputies": {CHAIR},
    # Materials and PGAS
    "material.create": TACHKI | {BLOCK_LEAD_ANYWHERE},  # general materials or a block guide
    "material.create_general": TACHKI,
    "material.create_guide": TACHKI | BLOCK_LEADS,  # checked against the owning block
    "material.edit": TACHKI | {MATERIAL_EDITOR},  # also publish and reversible delete (decision 18)
    "material.manage_editors": TACHKI,
    "material.restore": TACHKI,  # deletion is reversible (decision 18)
    "pgas.manage": TACHKI | {PGAS_ADMIN},  # decision 14
    "pgas.grant": TACHKI,  # pgas_admin is given and taken back by the chair and deputies (decision 14)
    "account.reset_password": TACHKI,  # a temporary password, no mail (АВ-52 (а))
    "leadership.view": TACHKI,  # the administration tab; only the chair changes it (АВ-2, АВ-34)
}

QUEUE_ROLES = {
    "block": {"master", "deputy_master"},
    "event": {"event_leader", "deputy_event_leader"},
    "subevent": {"subevent_leader", "deputy_subevent_leader"},
}


def _hr_block_names():
    from database import BlockORM

    with db._session() as session:
        return {b.name for b in session.query(BlockORM).filter(BlockORM.is_hr == True)}  # noqa: E712


def block_name(block_id):
    """Blocks are addressed by API id or by their stored name; roles use the name."""
    from database import BlockORM
    from domain_models import BlockMetaORM

    with db._session() as session:
        if session.get(BlockORM, block_id):
            return block_id
        meta = session.get(BlockMetaORM, block_id)
        return meta.legacy_name if meta else None


def _global(uid):
    rel = set()
    if db.is_chair(uid):
        rel.add(CHAIR)
    if db.is_deputy_chair(uid):
        rel.add(CHAIR_DEPUTY)
    if db.is_hr_master(uid):
        rel.add(HR_MASTER)
    if getattr(db.get_user(uid), "pgas_admin", False):
        rel.add(PGAS_ADMIN)
    hr_blocks = _hr_block_names()
    for a in db.get_user_assignments(uid):
        if a.scope_kind == "block" and a.role == "deputy_master" and a.scope_id in hr_blocks:
            continue  # the HR deputy is an ordinary HR block member in release 1 (АВ-25, УВ-2)
        if a.role in QUEUE_ROLES.get(a.scope_kind, set()):
            rel.add(QUEUE_HOLDER)
        if a.scope_kind == "block" and a.role in ("master", "deputy_master"):
            rel.add(BLOCK_LEAD_ANYWHERE)
    if db.get_user_master_block_names(uid):
        rel.update({QUEUE_HOLDER, BLOCK_LEAD_ANYWHERE})
    return rel


def _block(uid, block_id):
    name = block_name(block_id)
    if not name:
        return set()
    rel = set()
    if db.is_block_master(uid, name):
        rel.add(BLOCK_MASTER)
    if db.is_block_master_deputy(uid, name) and name not in _hr_block_names():
        rel.add(BLOCK_DEPUTY)
    if db.is_block_member(uid, name):
        rel.add(BLOCK_MEMBER)
    return rel


def _event(uid, event_id):
    rel = set()
    if db.is_event_leader(uid, event_id):
        rel.add(EVENT_LEADER)
    if db.is_event_leader_deputy(uid, event_id):
        rel.add(EVENT_DEPUTY)
    if any(
        db.is_subevent_leader(uid, s.subevent_id) or db.is_subevent_leader_deputy(uid, s.subevent_id)
        for s in db.list_subevents(event_id)
    ):
        rel.add(EVENT_SUB_LEAD)
    return rel


def _subevent(uid, subevent_id):
    sub = db.get_subevent(subevent_id)
    if not sub:
        return set()
    rel = set()
    if db.is_subevent_leader(uid, subevent_id):
        rel.add(SUB_LEADER)
    if db.is_subevent_leader_deputy(uid, subevent_id):
        rel.add(SUB_DEPUTY)
    if db.is_subevent_organizer(uid, subevent_id):
        rel.add(ORGANIZER)
    if db.is_event_leader(uid, sub.event_id):
        rel.add(EVENT_LEADER)
    if db.is_event_leader_deputy(uid, sub.event_id):
        rel.add(EVENT_DEPUTY)
    return rel


def _material(uid, material_id):
    """Editors are assigned per material; a block guide is also edited by the block's leads."""
    from database import RoleAssignmentORM
    from domain_models import BlockMetaORM, MaterialORM

    with db._session() as session:
        m = session.get(MaterialORM, material_id)
        if not m or m.deleted:
            return set()
        meta = session.get(BlockMetaORM, m.owner_block_id) if m.owner_block_id else None
        editor = bool(meta and _block(uid, meta.legacy_name) & BLOCK_LEADS) or session.query(
            RoleAssignmentORM
        ).filter_by(user_id=uid, scope_kind="material", scope_id=material_id, role="material_editor").first() is not None
        return {MATERIAL_EDITOR} if editor else set()


SCOPES = {"block": _block, "event": _event, "subevent": _subevent, "material": _material}


def scope_relations(uid, kind, scope_id):
    """Only the relations to the object itself, without global roles or the account check."""
    return frozenset(SCOPES[kind](uid, scope_id))


def relations(uid, kind=None, scope_id=None):
    """The actor's global relations plus those to one object."""
    if not uid:
        return frozenset()
    user = db.get_user(uid)
    if not user or user.account_state != "active" or user.banned:
        return frozenset()
    rel = _global(uid)
    if kind in SCOPES and scope_id is not None:
        rel |= SCOPES[kind](uid, scope_id)
    return frozenset(rel)


def roles_for(action, state=None):
    rule = POLICY[action]
    if isinstance(rule, ByState):
        return rule.get(state, rule["*"])
    return rule


def allowed(uid, action, kind=None, scope_id=None, *, state=None, rel=None):
    """Whether `uid` may perform `action` on the object; `rel` reuses computed relations."""
    rel = relations(uid, kind, scope_id) if rel is None else rel
    return bool(rel & roles_for(action, state))


def season_state(season_id):
    s = db.get_season(season_id) if season_id else None
    return s.state if s else None


def scope_access_revision(uid):
    """Memberships and organizer rosters are not RoleAssignments in session. Blocks count
    by ID, so renaming a block does not change its members' revision (A-FE-1)."""
    from database import SubeventORM
    from membership import block_id_for

    user = db.get_user(uid)
    with db._session() as session:
        scopes = [
            sorted({block_id_for(name.strip()) for name in user.blocks.split(",") if name.strip()}),
            sorted(
                row.subevent_id for row in session.query(SubeventORM)
                if db.is_subevent_organizer(uid, row.subevent_id)
            ),
        ]
    return hashlib.sha256(json.dumps(scopes, ensure_ascii=True).encode()).hexdigest()


def _caps(table, uid, kind=None, scope_id=None, state=None):
    rel = relations(uid, kind, scope_id)
    return sorted(cap for cap, action in table.items() if allowed(uid, action, kind, scope_id, state=state, rel=rel))


GLOBAL_CAPS = {
    "create_material": "material.create",
    "create_shared_material": "material.create_general",  # A-MAT-13
    "view_unresolved_assignments": "queue.view",
    "create_event": "event.create",
    "review_registrations": "registration.review",
    "create_chair_merit": "merit.create.chair",
    "correct_season": "season.correct",
    "edit_former_contacts": "former_contact.edit",
    "manage_material_editors": "material.manage_editors",
    "restore_material": "material.restore",
    "edit_participant_category": "participant.category",
    "view_kkr": "kkr.view",
    "view_summary": "summary.view",
    "transfer_chair": "leadership.transfer",
    "manage_chair_deputies": "leadership.deputies",
    "archive_account": "account.archive",
    "restore_account": "account.restore",
    "open_season": "season.open",
    "close_season": "season.close",
    "view_all_areas": "dashboard.all",  # the home page lists every block and event
    "manage_pgas": "pgas.manage",
    "grant_pgas_admin": "pgas.grant",
    "reset_password": "account.reset_password",
    "view_leadership": "leadership.view",
}


def global_caps(uid):
    if not uid:
        return []
    return _caps(GLOBAL_CAPS, uid)


def season_caps(season, uid=None):
    uid = uid or actor_id.get()
    by_state = {
        "planned": {"open_season": "season.open", "edit_season": "season.edit", "create_event": "event.create"},
        "open": {"edit_season": "season.edit", "begin_summary": "season.begin_summary", "create_event": "event.create"},
        "summarizing": {"close_season": "season.close"},
    }
    return _caps({**by_state.get(season.state, {}), "view_summary": "summary.view"}, uid)


EVENT_CAPS = {
    "edit_event": "event.edit",
    "view_meeting": "event.meeting.view",  # A-EVT-4
    "manage_organizers": "subevent.manage_organizers",
    "edit_meeting": "event.meeting.edit",
    "delete_meeting": "event.meeting.edit",
    "create_head_merit": "merit.create.head",
    "manage_leaders": "event.manage_leaders",
    "manage_deputies": "event.manage_leader_deputies",
    "create_report": "event.report.create",
}


def event_caps(event, uid=None):
    uid = uid or actor_id.get()
    state = season_state(event.season_id)
    if state in (None, "closed"):
        return []
    table = dict(EVENT_CAPS)  # manage_organizers on the event card: for its subevents
    if state in ("planned", "open"):
        table["create_subevent"] = "event.create_subevent"
    return _caps(table, uid, "event", event.event_id, state)


SUBEVENT_CAPS = {
    "view_meeting": "subevent.meeting.view",
    "manage_leaders": "subevent.manage_leaders",
    "manage_deputies": "subevent.manage_leader_deputies",
    "manage_organizers": "subevent.manage_organizers",
    "edit_subevent": "subevent.edit",
    "edit_meeting": "subevent.meeting.edit",
    "delete_meeting": "subevent.meeting.edit",
    "view_assessment_inputs": "task.inputs.view",
    "edit_assessment_inputs": "task.inputs.edit",
    "create_volunteer_merit": "merit.create.subevent_volunteer",
    "view_unresolved_assignments": "task.review",
    "create_report": "subevent.report.create",
}


def subevent_caps(sub, uid=None):
    uid = uid or actor_id.get()
    state = season_state(db.get_event(sub.event_id).season_id)
    if state == "closed":
        return []
    table = dict(SUBEVENT_CAPS)
    if state in ("planned", "open"):
        table["create_task"] = "task.create"
    return _caps(table, uid, "subevent", sub.subevent_id, state)


def meeting_caps(owner_kind, owner_id, uid=None):
    """`edit_meeting`/`delete_meeting`: a closed season's meetings are read-only."""
    uid = uid or actor_id.get()
    event_id = owner_id if owner_kind == "event" else getattr(db.get_subevent(owner_id), "event_id", None)
    event = db.get_event(event_id) if event_id else None
    if not event or season_state(event.season_id) in (None, "closed"):
        return []
    action = f"{owner_kind}.meeting.edit"
    return _caps({"edit_meeting": action, "delete_meeting": action}, uid, owner_kind, owner_id)


def meeting_read(uid, owner_kind, owner_id):
    return allowed(uid, f"{owner_kind}.meeting.view", owner_kind, owner_id)


ASSIGNMENT_CAPS = {
    "event": {"create_head_merit": "merit.create.head"},
    "block": {"create_volunteer_merit": "merit.create.block_volunteer"},
    "subevent": {"create_volunteer_merit": "merit.create.subevent_volunteer"},
}


def assignment_caps(uid, kind, scope_id):
    """Capabilities of one role assignment in `/session`: merits for its own scope."""
    if kind == "global":
        return global_caps(uid)
    if _closed_scope(kind, scope_id) and not allowed(uid, "summary.correct"):
        return []
    return _caps(ASSIGNMENT_CAPS.get(kind, {}), uid, kind, scope_id)


def _closed_scope(kind, scope_id):
    """Whether an event or subevent belongs to a closed season (blocks have no season)."""
    if kind == "subevent":
        scope_id = getattr(db.get_subevent(scope_id), "event_id", None)
    elif kind != "event":
        return False
    event = db.get_event(scope_id) if scope_id else None
    return bool(event) and season_state(event.season_id) == "closed"


def leadership_caps(uid):
    return _caps({"transfer_chair": "leadership.transfer", "manage_chair_deputies": "leadership.deputies"}, uid)


BLOCK_CAPS = {
    "edit_block": "block.edit",
    "view_tasks": "task.view",
    "view_unresolved_assignments": "task.review",
    "view_assessment_inputs": "task.inputs.view",
    "edit_assessment_inputs": "task.inputs.edit",
    "create_volunteer_merit": "merit.create.block_volunteer",
    "remove_member": "block.remove_member",
    "manage_leaders": "block.manage_leader",
}


def block_caps(uid, name, open_season):
    """The block card; block tasks are created only in an open season."""
    table = dict(BLOCK_CAPS)
    if open_season:
        table["create_task"] = "task.create"
    return _caps(table, uid, "block", name)


def can_review_request(uid, stage, block_id, substitute_ready):
    """A block request's review stage; the chair and deputies substitute after 72 hours."""
    action = "block.review_hr_stage" if stage == "pending_hr" else "block.review_block_stage"
    return allowed(uid, action, "block", block_id) or (substitute_ready and bool(relations(uid) & TACHKI))


def leader_caps(leader, uid=None):
    """`manage_deputies` of one leader: who may set that leader's deputies."""
    uid = uid or actor_id.get()
    with db._session() as session:
        from database import RoleAssignmentORM

        a = session.get(RoleAssignmentORM, leader.role_assignment_id)
        if not a:
            return []
        kind, scope_id, holder = a.scope_kind, a.scope_id, a.user_id
    if _closed_scope(kind, scope_id):
        return []  # a closed season's rosters are immutable
    return ["manage_deputies"] if can_set_deputies(uid, kind, scope_id, holder) else []


def can_set_deputies(uid, kind, scope_id, holder):
    if kind == "block":
        # A master sets their own deputies; the HR master is the HR block's master.
        return allowed(uid, "block.manage_leader") or (
            holder == uid and allowed(uid, "block.manage_master_deputies", "block", scope_id)
        )
    if kind == "event":
        return allowed(uid, "event.manage_leader_deputies", "event", scope_id)
    if kind == "subevent":
        return allowed(uid, "subevent.manage_leader_deputies", "subevent", scope_id)
    return allowed(uid, "event.manage_leaders")


def scope_inputs(uid, kind, scope_id, season_id, write=False):
    """Assessment inputs (hours, evaluation, criteria) of a block or subevent area."""
    action = "task.inputs.edit" if write else "task.inputs.view"
    return allowed(uid, action, kind, scope_id, state=season_state(season_id))


INPUTS_CAPS = {"edit_assessment_inputs": "task.inputs.edit", "edit_assessment_dates": "task.dates.edit"}


def inputs_caps(uid, kind, scope_id, season_id):
    """Capabilities of the assessment inputs of a task or an assignment."""
    return _caps(INPUTS_CAPS, uid, kind, scope_id, season_state(season_id))
