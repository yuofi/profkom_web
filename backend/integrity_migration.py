"""Database constraints complement serialized, versioned HTTP transactions."""

from sqlalchemy import text
from database import engine

INDEXES = {
    "v13_one_planned": "CREATE UNIQUE INDEX IF NOT EXISTS v13_one_planned ON seasons(state) WHERE state='planned'",
    "v13_one_current": "CREATE UNIQUE INDEX IF NOT EXISTS v13_one_current ON seasons(is_current) WHERE is_current=1",
    "v13_one_master": "CREATE UNIQUE INDEX IF NOT EXISTS v13_one_master ON role_assignments(scope_id) WHERE scope_kind='block' AND role='master'",
    "v13_one_chair": "CREATE UNIQUE INDEX IF NOT EXISTS v13_one_chair ON role_assignments(role) WHERE scope_kind='global' AND role='chair'",
    "v13_unique_role": "CREATE UNIQUE INDEX IF NOT EXISTS v13_unique_role ON role_assignments(user_id,role,scope_kind,COALESCE(scope_id,''),COALESCE(principal_assignment_id,''))",
    "v13_assignment_contribution": "CREATE UNIQUE INDEX IF NOT EXISTS v13_assignment_contribution ON contributions(assignment_id) WHERE assignment_id IS NOT NULL",
    "v13_merit_contribution": "CREATE UNIQUE INDEX IF NOT EXISTS v13_merit_contribution ON contributions(merit_id,user_id) WHERE merit_id IS NOT NULL",
    "v13_bonus_contribution": "CREATE UNIQUE INDEX IF NOT EXISTS v13_bonus_contribution ON contributions(bonus_id) WHERE bonus_id IS NOT NULL",
    "v13_one_master_bonus": "CREATE UNIQUE INDEX IF NOT EXISTS v13_one_master_bonus ON master_bonuses(season_id,block_id)",
    "v13_one_summary": "CREATE UNIQUE INDEX IF NOT EXISTS v13_one_summary ON season_summaries(season_id)",
    "v13_one_final": "CREATE UNIQUE INDEX IF NOT EXISTS v13_one_final ON reports(owner_kind,owner_id) WHERE kind='final'",
}


def ensure_integrity():
    # Existing conflicting rows cause a diagnostic failure, never automatic data loss.
    with engine.begin() as connection:
        for name, statement in INDEXES.items():
            try:
                connection.execute(text(statement))
            except Exception as error:
                raise RuntimeError(
                    f"Cannot install {name}; inspect duplicate domain rows on a database copy before migration"
                ) from error
