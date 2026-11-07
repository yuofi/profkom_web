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
from types import MappingProxyType
from database import db
from read_context import memoized

actor_id = ContextVar("profkom_actor_id", default=None)

# ── Relations ──
# Global
CHAIR = "chair"
CHAIR_DEPUTY = "chair_deputy"
HR_MASTER = "hr_master"
HR_DEPUTY = "hr_deputy"  # the actual deputy of the configured HR block, also BLOCK_DEPUTY there
HR_TRACKER_READER = "hr_tracker_reader"  # narrowly scoped global tracker read, not KKR/reports
PGAS_ADMIN = "pgas_admin"
BLOCK_LEAD_ANYWHERE = "block_lead_anywhere"  # master or deputy of some block
QUEUE_HOLDER = "queue_holder"  # leads some block, event or subevent
# HereBot (owner, 2026-11-04): the console belongs to the master of the block named exactly
# IT_BLOCK and the maintainers they assign; broadcasts to the chair, deputies and senders.
IT_MASTER = "it_master"
BOT_MAINTAINER = "bot_maintainer"  # role_assignments: scope_kind "site", role "bot_maintainer"
BROADCASTER = "broadcaster"  # role_assignments: scope_kind "site", role "broadcaster"
# Block
BLOCK_MASTER = "block_master"
BLOCK_DEPUTY = "block_deputy"
BLOCK_HR = "block_hr"  # explicit HR curator of this block; never a membership/guide role
BLOCK_MEMBER = "block_member"
# Event; a subevent also inherits the relations to its event
EVENT_LEADER = "event_leader"
EVENT_DEPUTY = "event_deputy"
EVENT_TEAM = "event_team"  # public tracker scope only; never report/meeting authority
EVENT_SUB_LEAD = "event_sub_lead"  # leads one of the event's subevents
# Subevent
SUB_LEADER = "sub_leader"
SUB_DEPUTY = "sub_deputy"
SUBEVENT_HR = "subevent_hr"  # exact curator ID, never an inherited event role
ORGANIZER = "organizer"
# Material
MATERIAL_EDITOR = "material_editor"

TACHKI = frozenset({CHAIR, CHAIR_DEPUTY})  # the chair and the chair's deputies
IT_BLOCK = "IT"  # renamed, its master loses the console until the name returns
SITE_ROLES = {"bot_maintainer": BOT_MAINTAINER, "broadcaster": BROADCASTER}
SUMMARY = TACHKI | {HR_MASTER, HR_DEPUTY}
# Who changes a closed season, its marks included: the chair, the chair's deputies and the
# HR master; not the HR deputy or area leads (owner, 2026-10-31, SE-13).
CLOSED_SEASON = TACHKI | {HR_MASTER}
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
    "subevent.view": SUBEVENT_READERS | {SUBEVENT_HR},  # working data: tasks, meeting, report (УВ-3)
    "subevent.hr.assign": TACHKI | {HR_MASTER},
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
    "task.view": TACHKI | {HR_MASTER,HR_DEPUTY,HR_TRACKER_READER,BLOCK_HR,SUBEVENT_HR,EVENT_TEAM} | AREA_TEAM,
    "task.create": TACHKI | {HR_MASTER,HR_TRACKER_READER,BLOCK_HR,SUBEVENT_HR,EVENT_TEAM} | AREA_TEAM,
    "task.assign_others": TACHKI | AREA_LEADS | {BLOCK_HR,SUBEVENT_HR},
    "task.edit": ByState({"*": TACHKI | {HR_MASTER,HR_DEPUTY} | AREA_LEADS, "closed": CLOSED_SEASON}),  # public task editing
    "task.review": ByState({"*": TACHKI | {HR_MASTER,HR_DEPUTY,BLOCK_HR,SUBEVENT_HR} | AREA_LEADS, "closed": CLOSED_SEASON}),
    # A new assignment row for someone's work: a reassignment; in a closed season also the
    # roster's join/take/assign. A closed season's rows are added by its circle: the chair,
    # the deputies and the HR master, not the HR deputy (owner, 2026-10-31, TR-05).
    "task.add_assignment": ByState({"*": TACHKI | {HR_MASTER,HR_DEPUTY,BLOCK_HR,SUBEVENT_HR} | AREA_LEADS, "closed": CLOSED_SEASON}),
    "task.inputs.view": TACHKI | {HR_MASTER,HR_DEPUTY,BLOCK_HR,SUBEVENT_HR} | AREA_LEADS,
    "task.inputs.edit": ByState({"*": TACHKI | {HR_MASTER,HR_DEPUTY,BLOCK_HR,SUBEVENT_HR} | AREA_LEADS, "closed": CLOSED_SEASON}),
    # Issue date, deadline and completion date, once set; area leads do not move them (УВ-5)
    "task.dates.edit": ByState({"*": SUMMARY, "closed": CLOSED_SEASON}),
    "queue.view": TACHKI | {HR_MASTER, HR_DEPUTY, QUEUE_HOLDER},
    "queue.create": TACHKI | BLOCK_LEADS | EVENT_LEADS | SUB_LEADS,
    "event.close": TACHKI,
    "event.reopen": TACHKI,
    "dashboard.all": TACHKI | {HR_MASTER},  # every block and event on the home page (АВ-26, АВ-35)
    # KKR, summary, merits
    "kkr.view": SUMMARY,
    "summary.view": SUMMARY,
    # Marks (отметки); a planned season takes none, its summary stays readable (owner, 2026-10-31, SE-21)
    "summary.decide": ByState({"*": SUMMARY, "planned": frozenset(), "closed": CLOSED_SEASON}),
    "summary.correct": CLOSED_SEASON,  # closed season corrections, coefficients included
    # Calling leaders to fill KKR of closed tasks, only while work is accounted: the HR master
    # and the HR deputy, not the chair or the chair's deputies (owner, 2026-10-31, SE-14)
    "kkr.remind": ByState({"*": frozenset(), "open": {HR_MASTER, HR_DEPUTY}, "summarizing": {HR_MASTER, HR_DEPUTY}}),
    # A new merit in a closed season is a change of that season: its circle only (SE-13)
    "merit.create.chair": ByState({"*": TACHKI, "closed": CLOSED_SEASON}),
    "merit.create.head": ByState({"*": TACHKI | EVENT_LEADS, "closed": CLOSED_SEASON}),  # decision 12
    "merit.create.block_volunteer": ByState({"*": TACHKI, "closed": CLOSED_SEASON}),
    "merit.create.subevent_volunteer": ByState({"*": TACHKI | EVENT_LEADS, "closed": CLOSED_SEASON}),  # A-KKR-8 (a)
    "merit.view.chair_merit": SUMMARY,
    "merit.view.head_merit": SUMMARY | EVENT_LEADS,
    "merit.view.block_volunteer": SUMMARY | BLOCK_LEADS | {BLOCK_HR},
    "merit.view.subevent_volunteer": SUMMARY | EVENT_LEADS | SUB_LEADS | {SUBEVENT_HR},
    "merit.manage.chair_merit": ByState({"*": TACHKI, "closed": CLOSED_SEASON}),
    "merit.manage.head_merit": ByState({"*": TACHKI | EVENT_LEADS, "closed": CLOSED_SEASON}),
    "merit.manage.block_volunteer": ByState({"*": TACHKI, "closed": CLOSED_SEASON}),
    "merit.manage.subevent_volunteer": ByState({"*": TACHKI | EVENT_LEADS, "closed": CLOSED_SEASON}),
    "achievement.manage": TACHKI | {HR_MASTER, BLOCK_MASTER, EVENT_LEADER},
    # Blocks and membership
    "block.edit": TACHKI | BLOCK_LEADS,
    "block.rename": TACHKI,
    "block.remove_member": TACHKI | {HR_MASTER,HR_DEPUTY} | BLOCK_LEADS,  # A-ROL-2
    "block.manage_leader": TACHKI,
    "block.hr.assign": TACHKI | {HR_MASTER},
    "block.manage_master_deputies": TACHKI | {BLOCK_MASTER},
    "block.review_hr_stage": {HR_MASTER,HR_DEPUTY},  # the chair and deputies substitute after 72 hours
    "block.review_block_stage": BLOCK_LEADS,
    "block_request.view_all": TACHKI | {HR_MASTER,HR_DEPUTY},
    "block_request.navigate": TACHKI | {HR_MASTER,HR_DEPUTY,BLOCK_LEAD_ANYWHERE},
    # Checked on the HR block: its whole team reads every request and why it was rejected (decision 16)
    "block_request.view_as_hr": BLOCK_LEADS | {BLOCK_MEMBER},
    "participant.category": TACHKI | {HR_MASTER},
    "former_contact.edit": TACHKI | {HR_MASTER},
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
    # Checked on the owning block of a guide for its block only (owner, 2026-10-25); reading only.
    "material.read_block_guide": TACHKI | BLOCK_LEADS | {BLOCK_MEMBER},
    "material.manage_editors": TACHKI,
    "material.restore": TACHKI,  # deletion is reversible (decision 18)
    "pgas.manage": TACHKI | {PGAS_ADMIN},  # decision 14
    "pgas.grant": TACHKI,  # pgas_admin is given and taken back by the chair and deputies (decision 14)
    "account.reset_password": TACHKI,  # a temporary password, no mail (АВ-52 (а))
    "leadership.view": TACHKI,  # the administration tab; only the chair changes it (АВ-2, АВ-34)
    # HereBot (owner, 2026-11-04): the chair and deputies get no console rights, unless one of
    # them masters the IT block; maintainers assigned earlier keep theirs when the master changes.
    "bot.console.view": {IT_MASTER, BOT_MAINTAINER},
    "bot.console.operate": {IT_MASTER, BOT_MAINTAINER},  # stage 5: restart, logs, update, rollback
    "bot.maintainers.manage": {IT_MASTER},
    "broadcast.send": TACHKI | {BROADCASTER},  # stage 4
    "broadcast.senders.manage": TACHKI,
}

# The service (root) account holds every relation any rule names, to every object (owner,
# 2026-11-08, service_account.py); a rule's season state still narrows it like anyone's.
SERVICE_RELATIONS = frozenset().union(*(
    frozenset().union(*rule.values()) if isinstance(rule, ByState) else frozenset(rule) for rule in POLICY.values()))

QUEUE_ROLES = {
    "block": {"master", "deputy_master"},
    "event": {"event_leader", "deputy_event_leader"},
    "subevent": {"subevent_leader", "deputy_subevent_leader"},
}


# ── Request-scoped facts ──
# In a clean read UOW the small role/scope tables are read once as immutable facts,
# and the same relation rules below evaluate them for every actor and object of the
# request. Commands, dirty sessions and calls outside a read UOW get None and keep
# the original per-object queries. There is no cache between requests.

def _facts(name, load):
    from read_context import snapshot
    return snapshot("access.facts." + name, load)


def _plain_uid(uid):
    # SQL compares other key types with column affinity; keep those on the old path.
    return isinstance(uid, int) and not isinstance(uid, bool)


def _listed(raw, uid):
    """The JSON roster check of Database.is_block_member/is_subevent_organizer."""
    if not raw:
        return False
    try:
        return uid in json.loads(raw)
    except Exception:
        return False


def _role_facts():
    """user_id -> frozenset((scope_kind, scope_id, role)) of every persisted role."""
    def load():
        from database import RoleAssignmentORM, scalar_rows
        by_user = {}
        with db._session() as session:
            for uid, kind, scope_id, role in scalar_rows(session, RoleAssignmentORM, (
                RoleAssignmentORM.user_id, RoleAssignmentORM.scope_kind,
                RoleAssignmentORM.scope_id, RoleAssignmentORM.role,
            )):
                by_user.setdefault(uid, set()).add((kind, scope_id, role))
        return MappingProxyType({uid: frozenset(rows) for uid, rows in by_user.items()})
    return _facts("roles", load)


def _block_facts():
    """name -> (master_user_id, is_hr, arr_of_human); the rows stay in the session."""
    def load():
        from database import BlockORM
        with db._session() as session:
            return MappingProxyType({
                block.name: (block.master_user_id, bool(is_hr), block.arr_of_human)
                for block, is_hr in session.query(BlockORM, BlockORM.is_hr == True)  # noqa: E712
            })
    return _facts("blocks", load)


def block_facts():
    """(block_id -> legacy_name, legacy_name -> (block_id, hr_user_id)) or None.

    Stable block identities for the current clean read UOW only; the metadata rows
    also remain loaded in its session. A missing metadata row is not repaired here.
    """
    def load():
        from domain_models import BlockMetaORM
        by_id, by_name = {}, {}
        with db._session() as session:
            for meta in session.query(BlockMetaORM):
                by_id[meta.block_id] = meta.legacy_name
                by_name[meta.legacy_name] = (meta.block_id, getattr(meta, "hr_user_id", None))
        return MappingProxyType(by_id), MappingProxyType(by_name)
    return _facts("block_meta", load)


def _subevent_facts():
    """(subevent_id -> (event_id, organizer_user_ids_json), event_id -> subevent ids)."""
    def load():
        from database import SubeventORM, scalar_rows
        rows, children = {}, {}
        with db._session() as session:
            for sid, event_id, organizers in scalar_rows(session, SubeventORM, (
                SubeventORM.subevent_id, SubeventORM.event_id, SubeventORM.organizer_user_ids_json
            )):
                rows[sid] = (event_id, organizers)
                children.setdefault(event_id, []).append(sid)
        return MappingProxyType(rows), MappingProxyType({k: tuple(v) for k, v in children.items()})
    return _facts("subevents", load)


def _subevent_hr_facts():
    """subevent_id -> hr_user_id of existing subevent workspace metadata rows."""
    def load():
        from database import scalar_rows
        from event_workspace_models import EventWorkspaceMetaORM
        with db._session() as session:
            return MappingProxyType({
                owner_id: hr_user_id for owner_id, hr_user_id in scalar_rows(
                    session, EventWorkspaceMetaORM, (EventWorkspaceMetaORM.owner_id, EventWorkspaceMetaORM.hr_user_id),
                    EventWorkspaceMetaORM.owner_kind == "subevent")
            })
    return _facts("subevent_hr", load)


def subevent_ids(event_id):
    """IDs of the event's subevents; their order carries no meaning."""
    facts = _subevent_facts() if isinstance(event_id, str) else None
    if facts is not None:
        return facts[1].get(event_id, ())
    from database import SubeventORM
    with db._session() as session:
        return tuple(row[0] for row in session.query(SubeventORM.subevent_id).filter_by(event_id=event_id))


@memoized("access.hr_blocks", copy_result=False)
def _hr_block_names():
    blocks = _block_facts()
    if blocks is not None:
        return frozenset(name for name, (_, is_hr, _) in blocks.items() if is_hr)
    from database import BlockORM

    with db._session() as session:
        return frozenset(b.name for b in session.query(BlockORM).filter(BlockORM.is_hr == True))  # noqa: E712


@memoized("access.block_name", copy_result=False)
def block_name(block_id):
    """Blocks are addressed by API id or by their stored name; roles use the name."""
    blocks = _block_facts() if isinstance(block_id, str) else None
    metas = block_facts() if blocks is not None else None
    if metas is not None:
        if block_id in blocks:
            return block_id
        return metas[0].get(block_id)
    from database import BlockORM
    from domain_models import BlockMetaORM

    with db._session() as session:
        if session.get(BlockORM, block_id):
            return block_id
        meta = session.get(BlockMetaORM, block_id)
        return meta.legacy_name if meta else None


def _is_hr_master(uid):
    blocks = _block_facts() if _plain_uid(uid) else None
    if blocks is None:
        return db.is_hr_master(uid)
    return any(is_hr and master == uid for master, is_hr, _ in blocks.values())


def _mastered_blocks(uid):
    """Names of the blocks whose stored master is `uid`."""
    blocks = _block_facts() if _plain_uid(uid) else None
    if blocks is None:
        return frozenset(db.get_user_master_block_names(uid))
    return frozenset(name for name, (master, _, _) in blocks.items() if master == uid)


def _assignment_roles(uid):
    """(scope_kind, scope_id, role) of stored assignments, as _global reads them.

    Database.get_user_assignments also lists synthetic chair/deputy/block-master
    rows; _global derives those relations from the leadership and block checks.
    """
    if _plain_uid(uid) and _role_facts() is not None:
        return _scoped_roles(uid)
    return [(a.scope_kind, a.scope_id, a.role) for a in db.get_user_assignments(uid)]


def _is_block_deputy(uid, name):
    if _plain_uid(uid) and _role_facts() is not None:
        return _has_scope_role(uid, "block", name, "deputy_master")
    return db.is_block_master_deputy(uid, name)


@memoized("access.global", copy_result=False)
def _global_relations(uid):
    if getattr(db.get_user(uid), "is_service", False):
        return SERVICE_RELATIONS
    rel = set()
    if db.is_chair(uid):
        rel.add(CHAIR)
    if db.is_deputy_chair(uid):
        rel.add(CHAIR_DEPUTY)
    if _is_hr_master(uid):
        rel.add(HR_MASTER)
    if getattr(db.get_user(uid), "pgas_admin", False):
        rel.add(PGAS_ADMIN)
    hr_blocks = _hr_block_names()
    for scope_kind, scope_id, role in _assignment_roles(uid):
        if scope_kind == "block" and role == "deputy_master" and scope_id in hr_blocks:
            # The explicit HR deputy: global HR grants by POLICY; a block lead like any deputy
            # (owner, 2026-10-31, GL-09). CLOSED_SEASON still leaves them out (SE-13).
            rel.update({HR_TRACKER_READER,HR_DEPUTY})
        if role in QUEUE_ROLES.get(scope_kind, set()):
            rel.add(QUEUE_HOLDER)
        if scope_kind == "block" and role in ("master", "deputy_master"):
            rel.add(BLOCK_LEAD_ANYWHERE)
        if scope_kind == "site" and role in SITE_ROLES:
            rel.add(SITE_ROLES[role])
    mastered = _mastered_blocks(uid)
    if mastered:
        rel.update({QUEUE_HOLDER, BLOCK_LEAD_ANYWHERE})
    if IT_BLOCK in mastered:
        rel.add(IT_MASTER)  # the same block read as above: no further query
    return frozenset(rel)


def _global(uid):
    """A caller-owned copy of the actor's global relations."""
    return set(_global_relations(uid))


def _block(uid, block_id):
    name = block_name(block_id)
    if not name:
        return set()
    rel = set()
    blocks = _block_facts() if isinstance(name, str) else None
    metas = block_facts() if blocks is not None else None
    if metas is not None:
        block = blocks.get(name)
        master = block is not None and block[0] == uid
        member = block is not None and _listed(block[2], uid)
        curator = name in metas[1] and metas[1][name][1] == uid
    else:
        from database import BlockORM
        from domain_models import BlockMetaORM
        with db._session() as session:
            block = session.get(BlockORM, name)
        master = bool(block and block.master_user_id == uid)
        member = db.is_block_member(uid, name)
        with db._session() as session:
            metadata = session.query(BlockMetaORM).filter_by(legacy_name=name).one_or_none()
            curator = bool(metadata and getattr(metadata, "hr_user_id", None) == uid)
    if master or _has_scope_role(uid, "block", name, "master"):
        rel.add(BLOCK_MASTER)
    if _has_scope_role(uid, "block", name, "deputy_master"):
        rel.add(BLOCK_DEPUTY)  # the HR block's deputy too (owner, 2026-10-31, GL-09)
    if member:
        rel.add(BLOCK_MEMBER)
    if curator:
        rel.add(BLOCK_HR)
    return rel


def _event(uid, event_id):
    rel = set()
    if _has_scope_role(uid, "event", event_id, "event_leader"):
        rel.add(EVENT_LEADER)
    if _has_scope_role(uid, "event", event_id, "deputy_event_leader"):
        rel.add(EVENT_DEPUTY)
    facts = _subevent_facts() if isinstance(event_id, str) else None
    children = facts[1].get(event_id, ()) if facts is not None else subevent_ids(event_id)
    if any(
        _has_scope_role(uid, "subevent", sid, "subevent_leader") or _has_scope_role(uid, "subevent", sid, "deputy_subevent_leader")
        for sid in children
    ):
        rel.add(EVENT_SUB_LEAD)
    organizes = ((lambda sid: _listed(facts[0][sid][1], uid)) if facts is not None
                 else (lambda sid: db.is_subevent_organizer(uid, sid)))
    if any(organizes(sid) for sid in children) or EVENT_SUB_LEAD in rel:
        rel.add(EVENT_TEAM)
    return rel


def _subevent(uid, subevent_id):
    facts = _subevent_facts() if isinstance(subevent_id, str) else None
    curators = _subevent_hr_facts() if facts is not None else None
    if curators is not None:
        sub = facts[0].get(subevent_id)
        if sub is None:
            return set()
        event_id = sub[0]
        organizer = _listed(sub[1], uid)
        curator = subevent_id in curators and curators[subevent_id] == uid
    else:
        from database import SubeventORM
        with db._session() as session:
            sub = session.get(SubeventORM, subevent_id)
        if not sub:
            return set()
        event_id = sub.event_id
        organizer = db.is_subevent_organizer(uid, subevent_id)
        from event_workspace_models import EventWorkspaceMetaORM
        with db._session() as session:
            meta = session.get(EventWorkspaceMetaORM, ("subevent", subevent_id))
            curator = bool(meta and meta.hr_user_id == uid)
    rel = set()
    if _has_scope_role(uid, "subevent", subevent_id, "subevent_leader"):
        rel.add(SUB_LEADER)
    if _has_scope_role(uid, "subevent", subevent_id, "deputy_subevent_leader"):
        rel.add(SUB_DEPUTY)
    if organizer:
        rel.add(ORGANIZER)
    if curator:
        rel.add(SUBEVENT_HR)
    if _has_scope_role(uid, "event", event_id, "event_leader"):
        rel.add(EVENT_LEADER)
    if _has_scope_role(uid, "event", event_id, "deputy_event_leader"):
        rel.add(EVENT_DEPUTY)
    return rel


@memoized("access.scoped_roles", copy_result=False)
def _scoped_roles(uid):
    """One immutable persisted role snapshot, only reused in a clean read UOW.

    Scalar selection retains the old existence-query semantics in mixed command
    sessions: unflushed role changes are not silently treated as committed roles.
    """
    roles = _role_facts() if _plain_uid(uid) else None
    if roles is not None:
        return roles.get(uid, frozenset())
    from database import RoleAssignmentORM
    with db._session() as session:
        return frozenset(tuple(row) for row in session.query(
            RoleAssignmentORM.scope_kind, RoleAssignmentORM.scope_id, RoleAssignmentORM.role
        ).filter_by(user_id=uid))


def _has_scope_role(uid, kind, scope_id, role):
    return (kind, scope_id, role) in _scoped_roles(uid)


def _material(uid, material_id):
    """Editors are assigned per material; a block guide is also edited by the block's leads."""
    from database import RoleAssignmentORM
    from domain_models import BlockMetaORM, MaterialORM

    with db._session() as session:
        m = session.get(MaterialORM, material_id)
        if not m or m.deleted:
            return set()
        meta = session.get(BlockMetaORM, m.owner_block_id) if m.owner_block_id else None
        # A clean read UOW answers the editor check from the persisted role snapshot.
        snapshot = _plain_uid(uid) and isinstance(material_id, str) and _role_facts() is not None
        editor = bool(meta and _block(uid, meta.legacy_name) & BLOCK_LEADS) or (
            _has_scope_role(uid, "material", material_id, "material_editor") if snapshot else session.query(
                RoleAssignmentORM
            ).filter_by(user_id=uid, scope_kind="material", scope_id=material_id, role="material_editor").first() is not None)
        return {MATERIAL_EDITOR} if editor else set()


SCOPES = {"block": _block, "event": _event, "subevent": _subevent, "material": _material,
          "chair": lambda uid, scope_id: set()}


@memoized("access.scope_relations", copy_result=False)
def scope_relations(uid, kind, scope_id):
    """Only the relations to the object itself, without global roles or the account check."""
    return frozenset(SCOPES[kind](uid, scope_id))


@memoized("access.relations", copy_result=False)
def relations(uid, kind=None, scope_id=None):
    """The actor's global relations plus those to one object."""
    if not uid:
        return frozenset()
    user = db.get_user(uid)
    if not user or user.account_state != "active" or user.banned:
        return frozenset()
    if user.is_service:
        return SERVICE_RELATIONS
    rel = _global_relations(uid)
    if kind in SCOPES and scope_id is not None:
        rel |= scope_relations(uid, kind, scope_id)
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


@memoized("access.season_state", copy_result=False)
def season_state(season_id):
    s = db.get_season(season_id) if season_id else None
    return s.state if s else None


@memoized("access.all_queue_reader", copy_result=False)
def all_queue_reader(uid):
    """Owner policy: HR deputy's global tracker read is separate from reports/KKR."""
    user=db.get_user(uid)
    if not user or user.banned or user.account_state!="active":return False
    if user.is_service:return True
    if db.is_chair(uid) or db.is_deputy_chair(uid) or _is_hr_master(uid):return True
    return any(_is_block_deputy(uid,name) for name in _hr_block_names())


def scope_access_revision(uid):
    """Memberships and organizer rosters are not RoleAssignments in session. Blocks count
    by ID, so renaming a block does not change its members' revision (A-FE-1)."""
    from database import SubeventORM,TaskQueueORM,TaskQueueMemberORM
    from domain_models import BlockMetaORM
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
        # Privacy/owner/grant changes invalidate client caches independently of role assignments.
        scopes.append(all_queue_reader(uid))
        scopes.append(sorted((q.queue_id,q.owner_user_id,q.is_private,q.revision) for q in session.query(TaskQueueORM)))
        scopes.append(sorted((m.queue_id,m.active,m.request_id,m.revoked_at) for m in session.query(TaskQueueMemberORM).filter_by(user_id=uid)))
        from tracker_collaboration_models import TaskAccessGrantORM
        scopes.append(sorted((g.task_id,g.active,g.granted_at,g.revoked_at) for g in session.query(TaskAccessGrantORM).filter_by(user_id=uid)))
        scopes.append(sorted((row.block_id,getattr(row,"hr_user_id",None)) for row in session.query(BlockMetaORM)))
        from event_workspace_models import EventWorkspaceMetaORM
        scopes.append(sorted((row.owner_id,row.hr_user_id) for row in session.query(EventWorkspaceMetaORM).filter_by(owner_kind="subevent")))
        from support_models import SupportConfigORM, SupportStaffORM
        scopes.append(sorted((row.config_id, row.block_id, row.queue_id, row.revision) for row in session.query(SupportConfigORM)))
        scopes.append(sorted((row.user_id, row.active) for row in session.query(SupportStaffORM)))
    return hashlib.sha256(json.dumps(scopes, ensure_ascii=True).encode()).hexdigest()


def _caps(table, uid, kind=None, scope_id=None, state=None):
    rel = relations(uid, kind, scope_id)
    return sorted(cap for cap, action in table.items() if allowed(uid, action, kind, scope_id, state=state, rel=rel))


GLOBAL_CAPS = {
    "create_material": "material.create",
    "create_shared_material": "material.create_general",  # A-MAT-13
    "view_unresolved_assignments": "queue.view",
    "view_block_requests": "block_request.navigate",
    "assign_block_hr": "block.hr.assign",
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
    "view_bot_console": "bot.console.view",
    "operate_bot": "bot.console.operate",
    "manage_bot_maintainers": "bot.maintainers.manage",
    "send_broadcast": "broadcast.send",
    "manage_broadcast_senders": "broadcast.senders.manage",
}


def global_caps(uid):
    if not uid:
        return []
    return sorted({*_caps(GLOBAL_CAPS, uid), *curated_merit_caps(uid)})


def curated_merit_caps(uid):
    """`view_merits` of an HR curator: a block or subevent HR holds no role assignment there,
    yet merit.view.* lets them read that area's saved merits (SE-05)."""
    from domain_models import BlockMetaORM
    from event_workspace_models import EventWorkspaceMetaORM

    with db._session() as session:
        blocks = [row[0] for row in session.query(BlockMetaORM.legacy_name).filter_by(hr_user_id=uid)]
        subevents = [row[0] for row in session.query(EventWorkspaceMetaORM.owner_id).filter_by(owner_kind="subevent", hr_user_id=uid)]
    readable = any(allowed(uid, "merit.view.block_volunteer", "block", name) for name in blocks) or any(
        allowed(uid, "merit.view.subevent_volunteer", "subevent", sid) for sid in subevents)
    return ["view_merits"] if readable else []


def season_caps(season, uid=None):
    uid = uid or actor_id.get()
    by_state = {
        "planned": {"open_season": "season.open", "edit_season": "season.edit", "create_event": "event.create"},
        "open": {"edit_season": "season.edit", "begin_summary": "season.begin_summary", "create_event": "event.create"},
        "summarizing": {"close_season": "season.close"},
    }
    return _caps({**by_state.get(season.state, {}), "view_summary": "summary.view", "view_readiness": "summary.view", "remind_kkr": "kkr.remind"}, uid, state=season.state)


EVENT_CAPS = {
    "edit_event": "event.edit",
    "close_event": "event.close",
    "reopen_event": "event.reopen",
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
        table["create_task"] = "task.create"
    result = _caps(table, uid, "event", event.event_id, state)
    from event_workspace import event_closed
    with db._session() as session:
        closed = event_closed(session, event.event_id)
    result = [cap for cap in result if cap != ("close_event" if closed else "reopen_event")]
    if closed:
        result = [cap for cap in result if cap != "create_head_merit" or bool(relations(uid) & TACHKI)]
    return result


SUBEVENT_CAPS = {
    "assign_subevent_hr": "subevent.hr.assign",
    "view_tasks": "task.view",
    "view_meeting": "subevent.meeting.view",
    # The team's published reports; the subevent's HR curator reads tasks, not reports.
    "view_reports": "subevent.report.read",
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
    state = season_state(_event_row(sub.event_id).season_id)
    if state == "closed":
        return []
    table = dict(SUBEVENT_CAPS)
    if state in ("planned", "open"):
        table["create_task"] = "task.create"
    result = _caps(table, uid, "subevent", sub.subevent_id, state)
    if "create_volunteer_merit" in result:
        from merit_rules import can_create
        if not can_create(uid, "subevent_volunteer", None, sub.subevent_id, state=state):
            result.remove("create_volunteer_merit")
    return result


def subevent_task_caps(sub, uid=None):
    """Tracker entry for task readers without the subevent working ACL; no working-data capabilities."""
    uid = uid or actor_id.get()
    state = season_state(db.get_event(sub.event_id).season_id)
    if state == "closed":
        return []
    table = {"view_tasks": "task.view"}
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


MERIT_VIEW_CAPS = {
    "event": {"view_merits": "merit.view.head_merit"},
    "block": {"view_merits": "merit.view.block_volunteer"},
    "subevent": {"view_merits": "merit.view.subevent_volunteer"},
}


def assignment_caps(uid, kind, scope_id):
    """Capabilities of one role assignment in `/session`: merits for its own scope.
    Reading saved merits (`view_merits`) also covers closed seasons."""
    if kind == "global":
        return global_caps(uid)
    readable = _caps(MERIT_VIEW_CAPS.get(kind, {}), uid, kind, scope_id)
    # In a closed season's scope merit.create.* narrows to the season's circle (SE-13)
    state = "closed" if _closed_scope(kind, scope_id) else None
    result = _caps(ASSIGNMENT_CAPS.get(kind, {}), uid, kind, scope_id, state)
    if kind in {"event", "subevent"}:
        from merit_rules import can_create
        source = "head_merit" if kind == "event" else "subevent_volunteer"
        if not can_create(uid, source, scope_id if kind == "event" else None, scope_id if kind == "subevent" else None, state=state):
            result = [cap for cap in result if cap not in {"create_head_merit", "create_volunteer_merit"}]
    return sorted({*result, *readable})


def _event_row(event_id):
    """The stored event row only: season checks need no leadership DTO."""
    from database import EventORM
    from read_context import orm_get
    with db._session() as session:
        return orm_get(session, EventORM, event_id)


def _subevent_event_id(subevent_id):
    from database import SubeventORM
    from read_context import orm_get
    with db._session() as session:
        sub = orm_get(session, SubeventORM, subevent_id)
        return sub.event_id if sub else None


def _closed_scope(kind, scope_id):
    """Whether an event or subevent belongs to a closed season (blocks have no season)."""
    if kind == "subevent":
        scope_id = _subevent_event_id(scope_id)
    elif kind != "event":
        return False
    event = _event_row(scope_id) if scope_id else None
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
    "assign_block_hr": "block.hr.assign",
}


def block_caps(uid, name, open_season):
    """The block card; block tasks are created only in an open season."""
    table = dict(BLOCK_CAPS)
    if open_season:
        table["create_task"] = "task.create"
    return _caps(table, uid, "block", name)


# Relations holders() can enumerate from their stored sources; any other relation
# (block membership, PGAS, "leads some queue") makes it decline (None).
_HOLDER_RELATIONS = TACHKI | {HR_MASTER, HR_DEPUTY, HR_TRACKER_READER, BLOCK_MASTER, BLOCK_DEPUTY, BLOCK_HR,
                              EVENT_LEADER, EVENT_DEPUTY, EVENT_SUB_LEAD, EVENT_TEAM, SUB_LEADER, SUB_DEPUTY,
                              SUBEVENT_HR, ORGANIZER}


def _rule_relations(action):
    rule = POLICY[action]
    return frozenset().union(*rule.values()) if isinstance(rule, ByState) else frozenset(rule)


def holders(actions, kind=None, scope_id=None, *, scopes=()):
    """A superset of the users who may hold a relation granting one of ``actions``
    on one block, event or subevent (or globally with ``kind=None``), else None.

    Only bounds a recipient scan: every candidate is still decided by the caller's
    own ACL (allowed(), report or meeting readers). Covers the chair and deputies,
    HR masters and HR-block roles, the block master and curator, every role on the
    object, its parent event and child subevents, their organizers and curators;
    ``scopes`` adds every role holder of further (kind, id) objects.
    """
    needed = frozenset().union(*(_rule_relations(action) for action in actions))
    if needed - _HOLDER_RELATIONS or kind not in (None, "block", "event", "subevent"):
        return None
    from database import BlockORM, LeadershipORM, RoleAssignmentORM, SubeventORM
    from domain_models import BlockMetaORM
    from event_workspace_models import EventWorkspaceMetaORM

    def listed(raw):
        try:
            values = json.loads(raw) if raw else []
        except Exception:
            return set()
        return {value for value in values if isinstance(value, int)} if isinstance(values, list) else set()

    result = set()
    pairs = set(scopes)
    with db._session() as session:
        leadership = session.get(LeadershipORM, 1)
        if leadership is not None:
            result.add(leadership.chair_user_id)
            result |= listed(leadership.deputies_json)
        hr_blocks = set()
        for name, master, is_hr in session.query(BlockORM.name, BlockORM.master_user_id, BlockORM.is_hr):
            if is_hr:
                hr_blocks.add(name)
                result.add(master)
        pairs |= {("block", name) for name in hr_blocks}
        if kind == "block":
            name = block_name(scope_id) or scope_id
            pairs |= {("block", scope_id), ("block", name)}
            block = session.get(BlockORM, name)
            if block is not None:
                result.add(block.master_user_id)
            # Entity reads: the ACL reads these rows' current (possibly unflushed) fields.
            result |= {meta.hr_user_id for meta in session.query(BlockMetaORM).filter(
                (BlockMetaORM.legacy_name == name) | (BlockMetaORM.block_id == scope_id))}
        elif kind in ("event", "subevent"):
            sub = session.get(SubeventORM, scope_id) if kind == "subevent" else None
            event_id = sub.event_id if sub is not None else scope_id if kind == "event" else None
            children = [sub] if sub is not None else list(session.query(SubeventORM).filter_by(event_id=event_id)) if kind == "event" else []
            pairs |= {("event", event_id), ("subevent", scope_id)} | {("subevent", child.subevent_id) for child in children}
            for child in children:
                result |= listed(child.organizer_user_ids_json)
            ids = [child.subevent_id for child in children] + ([scope_id] if kind == "subevent" else [])
            if ids:
                result |= {meta.hr_user_id for meta in session.query(EventWorkspaceMetaORM).filter(
                    EventWorkspaceMetaORM.owner_kind == "subevent", EventWorkspaceMetaORM.owner_id.in_(ids))}
        scope_ids = sorted({scope for _, scope in pairs if scope is not None})
        for index in range(0, len(scope_ids), 400):
            for user_id, scope_kind, scope in session.query(
                    RoleAssignmentORM.user_id, RoleAssignmentORM.scope_kind, RoleAssignmentORM.scope_id).filter(
                    RoleAssignmentORM.scope_id.in_(scope_ids[index:index + 400])):
                if (scope_kind, scope) in pairs:
                    result.add(user_id)
    result.discard(None)
    return frozenset(result)


def can_review_request(uid, stage, block_id, substitute_ready):
    """A block request's review stage; the chair and deputies substitute after 72 hours."""
    action = "block.review_hr_stage" if stage == "pending_hr" else "block.review_block_stage"
    return allowed(uid, action, "block", block_id) or (substitute_ready and bool(relations(uid) & TACHKI))


def leader_caps(leader, uid=None):
    """`manage_deputies` of one leader: who may set that leader's deputies."""
    uid = uid or actor_id.get()
    with db._session() as session:
        from database import role_assignment_scope

        stored = role_assignment_scope(session, leader.role_assignment_id)
        if not stored:
            return []
        kind, scope_id, holder = stored
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


# main -> access -> database is a supported startup order. Database migrations
# may defer ownership repair until every central ACL helper above is available.
_QUEUE_OWNER_RECOVERY_READY = True
import sys as _sys
_finish_queue_recovery = getattr(_sys.modules.get("queue_ownership"), "finish_startup_recovery", None)
if _finish_queue_recovery is not None:
    _finish_queue_recovery()
_finish_kkr_recovery = getattr(_sys.modules.get("kkr_control_hooks"), "finish_startup_recovery", None)
if _finish_kkr_recovery is not None:
    _finish_kkr_recovery()
