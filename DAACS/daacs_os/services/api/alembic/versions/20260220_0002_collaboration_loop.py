"""collaboration loop schema

Revision ID: 20260220_0002
Revises: 20260220_0001
Create Date: 2026-02-20
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260220_0002"
down_revision = "20260220_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "collaboration_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("shared_goal", sa.Text(), nullable=False),
        sa.Column("participants", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_collaboration_sessions_project_id", "collaboration_sessions", ["project_id"])

    op.create_table(
        "collaboration_rounds",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=50), nullable=False, server_default="completed"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["collaboration_sessions.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_collaboration_rounds_session_id", "collaboration_rounds", ["session_id"])

    op.create_table(
        "collaboration_artifacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("round_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("decision", sa.Text(), nullable=False),
        sa.Column("open_questions", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"),
        sa.Column("next_actions", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"),
        sa.Column("contributions", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["collaboration_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["round_id"], ["collaboration_rounds.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_collaboration_artifacts_session_id", "collaboration_artifacts", ["session_id"])
    op.create_index("ix_collaboration_artifacts_round_id", "collaboration_artifacts", ["round_id"])


def downgrade() -> None:
    op.drop_index("ix_collaboration_artifacts_round_id", table_name="collaboration_artifacts")
    op.drop_index("ix_collaboration_artifacts_session_id", table_name="collaboration_artifacts")
    op.drop_table("collaboration_artifacts")
    op.drop_index("ix_collaboration_rounds_session_id", table_name="collaboration_rounds")
    op.drop_table("collaboration_rounds")
    op.drop_index("ix_collaboration_sessions_project_id", table_name="collaboration_sessions")
    op.drop_table("collaboration_sessions")

