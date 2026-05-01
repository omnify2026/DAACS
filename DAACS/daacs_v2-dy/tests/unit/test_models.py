"""
DAACS Unit Tests - API Models
Pydantic 모델 단위 테스트
"""
import pytest
from pydantic import ValidationError
from daacs.api.models import (
    ProjectConfig,
    ProjectRequest,
    UserInputRequest,
    AssumptionDeltaRequest,
    FileUpdateRequest,
    ProjectInfo
)


class TestProjectConfig:
    """ProjectConfig 모델 테스트"""
    
    def test_default_values(self):
        """기본값 테스트"""
        config = ProjectConfig()
        
        assert config.mode == "langgraph"
        assert config.orchestrator_model == "gemini-3-flash"
        assert config.backend_model == "gemini-3-flash"
        assert config.frontend_model == "gemini-3-flash"
        assert config.max_iterations == 10
    
    def test_custom_values(self):
        """커스텀 값 테스트"""
        config = ProjectConfig(
            mode="test",
            orchestrator_model="custom-model",
            max_iterations=5
        )
        
        assert config.mode == "test"
        assert config.orchestrator_model == "custom-model"
        assert config.max_iterations == 5


class TestProjectRequest:
    """ProjectRequest 모델 테스트"""
    
    def test_minimal_request(self):
        """최소 요청 테스트"""
        req = ProjectRequest(goal="Build a todo app")
        
        assert req.goal == "Build a todo app"
        assert req.config is None
        assert req.source_path is None
        assert req.source_git is None
    
    def test_with_source_path(self):
        """소스 경로 포함 테스트"""
        req = ProjectRequest(
            goal="Modify existing project",
            source_path="/path/to/project"
        )
        
        assert req.source_path == "/path/to/project"
        assert req.source_git is None
    
    def test_with_source_git(self):
        """Git URL 포함 테스트"""
        req = ProjectRequest(
            goal="Clone and modify",
            source_git="https://github.com/user/repo"
        )
        
        assert req.source_git == "https://github.com/user/repo"
        assert req.source_path is None
    
    def test_with_config(self):
        """설정 포함 테스트"""
        config = ProjectConfig(mode="test")
        req = ProjectRequest(goal="Test project", config=config)
        
        assert req.config.mode == "test"
    
    def test_goal_required(self):
        """goal 필수 검증"""
        with pytest.raises(ValidationError):
            ProjectRequest()


class TestUserInputRequest:
    """UserInputRequest 모델 테스트"""
    
    def test_basic_input(self):
        """기본 입력 테스트"""
        req = UserInputRequest(text="Hello, DAACS!")
        assert req.text == "Hello, DAACS!"
    
    def test_text_required(self):
        """text 필수 검증"""
        with pytest.raises(ValidationError):
            UserInputRequest()


class TestAssumptionDeltaRequest:
    """AssumptionDeltaRequest 모델 테스트"""
    
    def test_default_values(self):
        """기본값 테스트"""
        req = AssumptionDeltaRequest()
        
        assert req.removed == []
        assert req.added == []
        assert req.modified == []
    
    def test_with_changes(self):
        """변경사항 포함 테스트"""
        req = AssumptionDeltaRequest(
            removed=["old_assumption"],
            added=["new_assumption"],
            modified=[("key", "new_value")]
        )
        
        assert "old_assumption" in req.removed
        assert "new_assumption" in req.added


class TestFileUpdateRequest:
    """FileUpdateRequest 모델 테스트"""
    
    def test_basic_update(self):
        """기본 업데이트 테스트"""
        req = FileUpdateRequest(content="console.log('hello');")
        assert req.content == "console.log('hello');"
    
    def test_content_required(self):
        """content 필수 검증"""
        with pytest.raises(ValidationError):
            FileUpdateRequest()


class TestProjectInfo:
    """ProjectInfo 모델 테스트"""
    
    def test_minimal_info(self):
        """최소 정보 테스트"""
        info = ProjectInfo(
            id="1",
            goal="Test project",
            created_at="2025-01-01T00:00:00"
        )
        
        assert info.id == "1"
        assert info.goal == "Test project"
        assert info.status == "created"
        assert info.iteration == 0
    
    def test_full_info(self):
        """전체 정보 테스트"""
        info = ProjectInfo(
            id="2",
            goal="Full project",
            status="completed",
            created_at="2025-01-01T00:00:00",
            iteration=5,
            needs_backend=False,
            needs_frontend=True,
            plan="Build a web app",
            messages=[{"role": "user", "content": "Hello"}]
        )
        
        assert info.status == "completed"
        assert info.iteration == 5
        assert info.needs_backend is False
        assert len(info.messages) == 1
