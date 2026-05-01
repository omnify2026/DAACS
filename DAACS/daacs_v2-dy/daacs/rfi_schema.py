from pydantic import BaseModel, Field
from typing import List, Optional, Literal, Dict

class SpecCard(BaseModel):
    """A single specification item (e.g., Feature, Tech Choice)."""
    id: str = Field(..., description="Unique ID for the card (e.g., 'FR-001', 'TECH-BE')")
    type: Literal["feature", "tech", "architecture"] = Field(..., description="Type of specification")
    title: str = Field(..., description="Title of the spec")
    description: str = Field(..., description="Detailed description")
    status: Literal["proposed", "accepted", "rejected"] = "proposed"
    
    # Traceability
    rationale: Optional[str] = Field(None, description="Why this was chosen (linked to TechContext)")
    sources: List[str] = Field(default_factory=list, description="URLs of sources supporting this choice")
    related_constraints: List[str] = Field(default_factory=list, description="IDs of constraints that influenced this")
    
    # Tech specific
    tech_category: Optional[str] = Field(None, description="e.g., 'Backend', 'Frontend', 'Database'")

class Blueprint(BaseModel):
    """Architecture diagram and high-level structure."""
    mermaid_script: str = Field(..., description="Mermaid.js script for the diagram")
    components: List[str] = Field(default_factory=list, description="List of high-level components")

class RFISnapshot(BaseModel):
    """
    Structured outcome of the RFI phase.
    Contains the structured 'state' of the requirements.
    """
    goal: str = Field(..., description="Refined user goal")
    specs: List[SpecCard] = Field(default_factory=list, description="List of feature/tech specs")
    blueprint: Optional[Blueprint] = Field(None, description="System architecture blueprint")
    
    # Phase 1.5 Integration
    assumptions_hash: Optional[str] = Field(None, description="Hash of assumptions used for this snapshot")
