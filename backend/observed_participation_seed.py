"""Record known state from migration onward without inventing approval/join dates."""

import json
import uuid
from database import db, UserORM
from domain_models import MigrationORM, MembershipORM, ParticipationORM
from domain_seed import now

VERSION = "v13-observed-participation"


def seed_observed_participation(at=None):
    with db.atomic():
        with db._session() as s:
            if s.get(MigrationORM, VERSION):
                return
            stamp = at or now()
            memberships = {}
            intervals = {}
            for user in s.query(UserORM).filter_by(
                account_state="active", banned=False
            ):
                if (
                    not s.query(ParticipationORM)
                    .filter_by(user_id=user.user_id, ended_at=None)
                    .first()
                ):
                    iid = str(uuid.uuid4())
                    s.add(
                        ParticipationORM(
                            interval_id=iid,
                            user_id=user.user_id,
                            participant_id=f"participant-{user.user_id}",
                            started_at=stamp,
                        )
                    )
                    intervals[str(user.user_id)] = iid
                for member in s.query(MembershipORM).filter_by(
                    user_id=user.user_id, left_at=None
                ):
                    if member.joined_at is None:
                        memberships[member.membership_id] = stamp
            s.add(
                MigrationORM(
                    version=VERSION,
                    completed_at=stamp,
                    report_json=json.dumps(
                        dict(
                            memberships_observed_since=memberships,
                            observed_interval_ids=intervals,
                        )
                    ),
                )
            )
            s.commit()
