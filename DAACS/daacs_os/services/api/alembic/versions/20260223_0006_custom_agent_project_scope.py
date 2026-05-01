"""scope custom agents to projects

Revision ID: 20260223_0006
Revises: 20260223_0005
Create Date: 2026-02-23
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260223_0006"
down_revision = "20260223_0005"
branch_labels = None
depends_on = None


def _backfill_project_id() -> None:
    op.execute(
        """
        WITH ranked_memberships AS (
            SELECT
                pm.user_id,
                pm.project_id,
                ROW_NUMBER() OVER (
                    PARTITION BY pm.user_id
                    ORDER BY
                        CASE WHEN pm.is_owner THEN 0 ELSE 1 END,
                        pm.created_at ASC,
                        pm.id ASC
                ) AS rn
            FROM project_memberships pm
        ),
        chosen_project AS (
            SELECT user_id, project_id
            FROM ranked_memberships
            WHERE rn = 1
        )
        UPDATE custom_agents ca
        SET project_id = cp.project_id
        FROM chosen_project cp
        WHERE ca.user_id = cp.user_id
          AND ca.project_id IS NULL
        """
    )

    conn = op.get_bind()
    unresolved = conn.execute(
        sa.text("SELECT COUNT(*) FROM custom_agents WHERE project_id IS NULL")
    ).scalar_one()
    if int(unresolved or 0) > 0:
        raise RuntimeError(
            "custom_agents rows without a valid project membership exist; "
            "cannot complete project_id backfill."
        )


def upgrade() -> None:
    op.add_column(
        "custom_agents",
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=True),
    )

    _backfill_project_id()

    op.alter_column("custom_agents", "project_id", nullable=False)
    op.create_foreign_key(
        "fk_custom_agents_project_id_projects",
        "custom_agents",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_custom_agents_project_id", "custom_agents", ["project_id"])
    op.create_index(
        "ix_custom_agents_user_project",
        "custom_agents",
        ["user_id", "project_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_custom_agents_user_project", table_name="custom_agents")
    op.drop_index("ix_custom_agents_project_id", table_name="custom_agents")
    op.drop_constraint(
        "fk_custom_agents_project_id_projects",
        "custom_agents",
        type_="foreignkey",
    )
    op.drop_column("custom_agents", "project_id")

