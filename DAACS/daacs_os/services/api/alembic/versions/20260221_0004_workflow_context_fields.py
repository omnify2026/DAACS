"""add workflow goal/params fields

Revision ID: 20260221_0004
Revises: 20260221_0003
Create Date: 2026-02-21
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260221_0004"
down_revision = "20260221_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("workflow_runs", sa.Column("goal", sa.Text(), nullable=True))
    op.add_column(
        "workflow_runs",
        sa.Column(
            "params",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("workflow_runs", "params")
    op.drop_column("workflow_runs", "goal")

