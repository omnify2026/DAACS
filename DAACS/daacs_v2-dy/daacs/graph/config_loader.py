"""
DAACS Configuration Loader v7.2.0
YAML 우선, 환경변수 fallback 지원
"""
import os
import yaml
from typing import Dict, Any, Optional
from pathlib import Path

from ..config import DEFAULT_LLM_TIMEOUT_SEC, MIN_CODE_REVIEW_SCORE
from ..utils import setup_logger

logger = setup_logger("ConfigLoader")


def _env_bool(key: str, default: bool = False) -> bool:
    """환경변수를 bool로 변환"""
    val = os.getenv(key)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _env_int(key: str, default: int) -> int:
    """환경변수를 int로 변환"""
    val = os.getenv(key)
    if val is None:
        return default
    try:
        return int(val)
    except ValueError:
        return default


class DAACSConfig:
    """
    DAACS 설정 관리자 (Singleton-like)
    
    우선순위:
    1. kwargs (코드에서 직접 전달)
    2. YAML 파일 (daacs_config.yaml)
    3. 환경변수 (DAACS_*)
    4. 하드코딩된 기본값
    """
    
    _instance: Optional["DAACSConfig"] = None
    
    def __init__(self, config_path: str = "daacs_config.yaml", **kwargs):
        self.config: Dict[str, Any] = {}
        self._load_yaml(config_path)
        self._apply_env_fallback()
        self._apply_kwargs(kwargs)
        
    @classmethod
    def get_instance(cls, config_path: str = "daacs_config.yaml") -> "DAACSConfig":
        """싱글톤 인스턴스 반환"""
        if cls._instance is None:
            cls._instance = cls(config_path)
        return cls._instance
    
    @classmethod
    def reset_instance(cls):
        """테스트용 인스턴스 리셋"""
        cls._instance = None
    
    def _load_yaml(self, config_path: str):
        """YAML 파일 로드"""
        paths_to_try = [
            config_path,
            Path.cwd() / "daacs_config.yaml",
            Path.home() / ".daacs" / "config.yaml",
        ]
        
        for path in paths_to_try:
            if Path(path).exists():
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        self.config = yaml.safe_load(f) or {}
                        logger.info(f"[ConfigLoader] Loaded config from: {path}")
                        return
                except Exception as e:
                    logger.warning(f"[ConfigLoader] Failed to load {path}: {e}")
        
        logger.info("[ConfigLoader] No YAML config found, using defaults")
    
    def _apply_env_fallback(self):
        """환경변수로 fallback 적용"""
        # CLI 설정
        cli = self.config.setdefault("cli", {})
        cli.setdefault("type", os.getenv("DAACS_CLI_TYPE", "codex"))
        cli.setdefault("timeout", _env_int("DAACS_CLI_TIMEOUT", DEFAULT_LLM_TIMEOUT_SEC))
        
        # Execution 설정
        execution = self.config.setdefault("execution", {})
        execution.setdefault("parallel_execution", _env_bool("DAACS_PARALLEL_EXECUTION", True))
        execution.setdefault("max_iterations", _env_int("DAACS_MAX_ITERATIONS", 10))
        execution.setdefault("max_failures", _env_int("DAACS_MAX_FAILURES", 10))
        execution.setdefault("max_subgraph_iterations", _env_int("DAACS_MAX_SUBGRAPH_ITERATIONS", 3))
        execution.setdefault("max_no_progress", _env_int("DAACS_MAX_NO_PROGRESS", 2))
        execution.setdefault("code_review_min_score", _env_int("DAACS_CODE_REVIEW_MIN_SCORE", MIN_CODE_REVIEW_SCORE))
        execution.setdefault("allow_low_quality_delivery", _env_bool("DAACS_ALLOW_LOW_QUALITY", False))
        execution.setdefault("plateau_max_retries", _env_int("DAACS_PLATEAU_MAX_RETRIES", 3))
        execution.setdefault("verification_lane", os.getenv("DAACS_VERIFICATION_LANE", "full"))
        execution.setdefault("enable_quality_gates", _env_bool("DAACS_ENABLE_QUALITY_GATES", False))
        execution.setdefault("enable_release_gate", None if os.getenv("DAACS_ENABLE_RELEASE_GATE") is None
                             else _env_bool("DAACS_ENABLE_RELEASE_GATE", False))

        # 역할별 CLI 설정
        roles = self.config.setdefault("roles", {})
        roles.setdefault("orchestrator", os.getenv("DAACS_ORCHESTRATOR_CLI", cli["type"]))
        roles.setdefault("backend", os.getenv("DAACS_BACKEND_CLI", cli["type"]))
        roles.setdefault("frontend", os.getenv("DAACS_FRONTEND_CLI", cli["type"]))
        roles.setdefault("code_review", os.getenv("DAACS_CODE_REVIEW_CLI", cli["type"]))
        
        logger.debug(f"[ConfigLoader] Config after env fallback: {self.config}")
    
    def _apply_kwargs(self, kwargs: Dict[str, Any]):
        """kwargs로 최종 오버라이드"""
        if not kwargs:
            return
            
        execution = self.config.get("execution", {})
        cli = self.config.get("cli", {})
        
        # CLI overrides
        if "cli_type" in kwargs:
            cli["type"] = kwargs["cli_type"]
        if "cli_timeout" in kwargs:
            cli["timeout"] = kwargs["cli_timeout"]
            
        # Execution overrides
        for key in ["parallel_execution", "max_iterations", "max_failures", 
                    "code_review_min_score", "allow_low_quality_delivery",
                    "plateau_max_retries", "max_no_progress", "verification_lane"]:
            if key in kwargs:
                execution[key] = kwargs[key]
        
        if "project_dir" in kwargs:
            self.config["project_dir"] = kwargs["project_dir"]
            
        self.config["execution"] = execution
        self.config["cli"] = cli
        
        # Roles override
        if "role_cli_types" in kwargs:
            roles = self.config.get("roles", {})
            roles.update(kwargs["role_cli_types"])
            self.config["roles"] = roles

    def get_cli_config(self) -> Dict[str, Any]:
        """CLI 설정 반환"""
        return self.config.get("cli", {"type": "codex", "timeout": DEFAULT_LLM_TIMEOUT_SEC})

    def get_execution_config(self) -> Dict[str, Any]:
        """Execution 설정 반환"""
        return self.config.get("execution", {
            "parallel_execution": True,
            "max_iterations": 10,
            "max_failures": 10,
            "max_subgraph_iterations": 3,
            "max_no_progress": 2,
            "code_review_min_score": MIN_CODE_REVIEW_SCORE,
            "allow_low_quality_delivery": False,
            "plateau_max_retries": 3,
            "verification_lane": "full",
        })
        
    def get_llm_source(self, role: str) -> str:
        """역할별 LLM CLI 타입 반환"""
        default_type = self.get_cli_config().get("type", "codex")
        return self.config.get("roles", {}).get(role, default_type)
    
    def get_role_cli_types(self) -> Dict[str, str]:
        """모든 역할의 CLI 타입 반환"""
        return self.config.get("roles", {})
    
    def get_constraints(self) -> Dict[str, Any]:
        """프로젝트 제약조건 반환"""
        defaults = {
            "port": 8000,
            "api_prefix": "/api/v1",
            "allowed_extensions": [
                ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".scss",
                ".json", ".yaml", ".yml", ".toml", ".ini", ".xml", ".csv",
                ".sql", ".md", ".txt", ".rst", ".sh", ".conf", ".dockerignore", ".gitignore"
            ]
        }
        return self.config.get("constraints", defaults)
    
    def to_dict(self) -> Dict[str, Any]:
        """전체 설정을 dict로 반환"""
        return self.config.copy()
