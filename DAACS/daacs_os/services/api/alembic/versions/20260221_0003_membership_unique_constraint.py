"""add unique constraint for project membership

Revision ID: 20260221_0003
Revises: 20260220_0002
Create Date: 2026-02-21
"""

from alembic import op


revision = "20260221_0003"
down_revision = "20260220_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DELETE FROM project_memberships pm
        USING (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY project_id, user_id
                    ORDER BY created_at ASC, id ASC
                ) AS rn
            FROM project_memberships
        ) dedup
        WHERE pm.id = dedup.id
          AND dedup.rn > 1
        """
    )
    op.create_unique_constraint(
        "uq_membership_project_user",
        "project_memberships",
        ["project_id", "user_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_membership_project_user",
        "project_memberships",
        type_="unique",
    )

