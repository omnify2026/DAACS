"""add overnight workflow fields and run-linked cost logs

Revision ID: 20260223_0005
Revises: 20260221_0004
Create Date: 2026-02-23
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260223_0005"
down_revision = "20260221_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workflow_runs",
        sa.Column(
            "overnight_config",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "workflow_runs",
        sa.Column("deadline_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "workflow_runs",
        sa.Column("spent_usd", sa.Numeric(10, 6), nullable=False, server_default="0"),
    )

    op.add_column("cost_log", sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_cost_log_run_id_workflow_runs",
        "cost_log",
        "workflow_runs",
        ["run_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_cost_log_run_id_workflow_runs", "cost_log", type_="foreignkey")
    op.drop_column("cost_log", "run_id")

    op.drop_column("workflow_runs", "spent_usd")
    op.drop_column("workflow_runs", "deadline_at")
    op.drop_column("workflow_runs", "overnight_config")

