"""SQLAlchemy ORM models used by API layer."""

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import TIMESTAMP, Boolean, ForeignKey, Integer, LargeBinary, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .types import JsonType, UuidArrayType, UuidType


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    goal: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(50), default="created")
    config: Mapped[Dict[str, Any]] = mapped_column(JsonType(), default=dict)
    workspace_path: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    memberships: Mapped[List["ProjectMembership"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
    )
    custom_agents: Mapped[List["CustomAgent"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
    )
    agents: Mapped[List["Agent"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    tasks: Mapped[List["Task"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    cost_logs: Mapped[List["CostLog"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    workflow_runs: Mapped[List["WorkflowRun"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    commands: Mapped[List["Command"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    agent_events: Mapped[List["AgentEventLog"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    plan: Mapped[str] = mapped_column(String(50), default="free")
    agent_slots: Mapped[int] = mapped_column(Integer, default=3)
    custom_agent_count: Mapped[int] = mapped_column(Integer, default=0)
    billing_track: Mapped[str] = mapped_column(String(50), default="project")
    byok_claude_key: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    byok_openai_key: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    memberships: Mapped[List["ProjectMembership"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )
    custom_agents: Mapped[List["CustomAgent"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )


class ProjectMembership(Base):
    __tablename__ = "project_memberships"
    __table_args__ = (
        UniqueConstraint("project_id", "user_id", name="uq_membership_project_user"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(50), default="owner")
    is_owner: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )

    project: Mapped["Project"] = relationship("Project", back_populates="memberships")
    user: Mapped["User"] = relationship("User", back_populates="memberships")


class CustomAgent(Base):
    __tablename__ = "custom_agents"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(60), default="developer")
    prompt: Mapped[str] = mapped_column(Text, default="")
    skills: Mapped[List[str]] = mapped_column(JsonType(), default=list)
    color: Mapped[Optional[str]] = mapped_column(String(30), default=None)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )

    project: Mapped["Project"] = relationship("Project", back_populates="custom_agents")
    user: Mapped["User"] = relationship("User", back_populates="custom_agents")


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="idle")
    current_task: Mapped[Optional[str]] = mapped_column(Text)
    message: Mapped[Optional[str]] = mapped_column(Text)
    position: Mapped[Dict[str, Any]] = mapped_column(
        JsonType(), default={"x": 0, "y": 0}
    )
    metadata_: Mapped[Dict[str, Any]] = mapped_column(
        "metadata", JsonType(), default=dict
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    project: Mapped["Project"] = relationship(back_populates="agents")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"))
    agent_role: Mapped[Optional[str]] = mapped_column(String(50))
    parent_task_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UuidType(), ForeignKey("tasks.id", ondelete="SET NULL")
    )
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="pending")
    priority: Mapped[int] = mapped_column(Integer, default=0)
    dependencies: Mapped[Optional[List[uuid.UUID]]] = mapped_column(
        UuidArrayType(), default=list
    )
    result: Mapped[Optional[Dict[str, Any]]] = mapped_column(JsonType())
    started_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )

    # Relationships
    project: Mapped["Project"] = relationship(back_populates="tasks")


class AgentEventLog(Base):
    __tablename__ = "agent_events"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    agent_role: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    data: Mapped[Dict[str, Any]] = mapped_column(JsonType(), default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )

    project: Mapped["Project"] = relationship(back_populates="agent_events")


class CostLog(Base):
    __tablename__ = "cost_log"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"))
    run_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UuidType(), ForeignKey("workflow_runs.id", ondelete="SET NULL"), nullable=True
    )
    agent_role: Mapped[Optional[str]] = mapped_column(String(50))
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(10, 6), default=0)
    task_complexity: Mapped[Optional[str]] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )

    # Relationships
    project: Mapped["Project"] = relationship(back_populates="cost_logs")


class WorkflowRun(Base):
    __tablename__ = "workflow_runs"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"))
    workflow_name: Mapped[str] = mapped_column(String(100), nullable=False)
    goal: Mapped[Optional[str]] = mapped_column(Text)
    params: Mapped[Dict[str, Any]] = mapped_column(JsonType(), default=dict)
    overnight_config: Mapped[Dict[str, Any]] = mapped_column(JsonType(), default=dict)
    deadline_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True))
    spent_usd: Mapped[float] = mapped_column(Numeric(10, 6), default=0)
    status: Mapped[str] = mapped_column(String(50), default="running")
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    total_steps: Mapped[int] = mapped_column(Integer, default=0)
    steps: Mapped[List[Dict[str, Any]]] = mapped_column(JsonType(), default=list)
    started_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True))

    # Relationships
    project: Mapped["Project"] = relationship(back_populates="workflow_runs")


class WorkflowCheckpoint(Base):
    """LangGraph checkpoints."""

    __tablename__ = "workflow_checkpoints"

    thread_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    checkpoint: Mapped[Optional[bytes]] = mapped_column(LargeBinary)
    metadata_: Mapped[Dict[str, Any]] = mapped_column(
        "metadata", JsonType(), default=dict
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Command(Base):
    __tablename__ = "commands"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"))
    agent_role: Mapped[str] = mapped_column(String(50), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="pending")
    response: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True))

    # Relationships
    project: Mapped["Project"] = relationship(back_populates="commands")


class FileLockRecord(Base):
    """DB records for workspace locks."""

    __tablename__ = "file_locks"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"))
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    lock_type: Mapped[str] = mapped_column(String(10), nullable=False)
    agent_role: Mapped[str] = mapped_column(String(50), nullable=False)
    acquired_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True))


class CollaborationSession(Base):
    __tablename__ = "collaboration_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    shared_goal: Mapped[str] = mapped_column(Text, nullable=False)
    participants: Mapped[List[str]] = mapped_column(JsonType(), default=list)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )


class CollaborationRound(Base):
    __tablename__ = "collaboration_rounds"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("collaboration_sessions.id", ondelete="CASCADE"), index=True)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="completed")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )


class CollaborationArtifact(Base):
    __tablename__ = "collaboration_artifacts"

    id: Mapped[uuid.UUID] = mapped_column(UuidType(), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("collaboration_sessions.id", ondelete="CASCADE"), index=True)
    round_id: Mapped[uuid.UUID] = mapped_column(UuidType(), ForeignKey("collaboration_rounds.id", ondelete="CASCADE"), index=True)
    decision: Mapped[str] = mapped_column(Text, nullable=False)
    open_questions: Mapped[List[str]] = mapped_column(JsonType(), default=list)
    next_actions: Mapped[List[str]] = mapped_column(JsonType(), default=list)
    contributions: Mapped[List[Dict[str, Any]]] = mapped_column(JsonType(), default=list)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )
