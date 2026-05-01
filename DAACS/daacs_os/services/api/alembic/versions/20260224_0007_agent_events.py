"""add agent_events table for durable agent activity logs

Revision ID: 20260224_0007
Revises: 20260223_0006
Create Date: 2026-02-24
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260224_0007"
down_revision = "20260223_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_role", sa.String(length=50), nullable=False),
        sa.Column("event_type", sa.String(length=50), nullable=False),
        sa.Column("data", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_events_project_id", "agent_events", ["project_id"])
    op.create_index("ix_agent_events_agent_role", "agent_events", ["agent_role"])
    op.create_index("ix_agent_events_event_type", "agent_events", ["event_type"])
    op.create_index("ix_agent_events_project_role", "agent_events", ["project_id", "agent_role"])


def downgrade() -> None:
    op.drop_index("ix_agent_events_project_role", table_name="agent_events")
    op.drop_index("ix_agent_events_event_type", table_name="agent_events")
    op.drop_index("ix_agent_events_agent_role", table_name="agent_events")
    op.drop_index("ix_agent_events_project_id", table_name="agent_events")
    op.drop_table("agent_events")
