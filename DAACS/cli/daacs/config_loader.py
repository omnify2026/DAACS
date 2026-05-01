"""
DAACS v6.0 - Configuration Loader
YAML 설정 파일 + v5.0 환경 변수 하위 호환성 지원
"""

import yaml
import os
from typing import Dict, Optional
from .llm.providers import LLMSourceFactory, LLMSource


class DAACSConfig:
    """
    DAACS 설정 로더 (Singleton 패턴)

    우선순위:
    1. YAML 파일 (daacs_config.yaml) - v6.0 방식
    2. 환경 변수 - v5.0 호환 모드
    
    🆕 Singleton: 모든 모듈이 동일한 인스턴스 공유 → role_cli_types 설정 유지
    """
    
    _instance: Optional['DAACSConfig'] = None
    _initialized: bool = False
    
    def __new__(cls, config_path: str = "daacs_config.yaml"):
        """Singleton 패턴 - 이미 인스턴스가 있으면 반환"""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    @classmethod
    def reset_instance(cls):
        """테스트용: 인스턴스 리셋 (프로덕션에서는 사용 금지)"""
        cls._instance = None
        cls._initialized = False
    
    @classmethod
    def get_instance(cls, config_path: str = "daacs_config.yaml") -> 'DAACSConfig':
        """명시적 인스턴스 접근자"""
        if cls._instance is None:
            return cls(config_path)
        return cls._instance

    def __init__(self, config_path: str = "daacs_config.yaml"):
        # 🆕 이미 초기화된 경우 스킵 (Singleton)
        if DAACSConfig._initialized:
            return
        DAACSConfig._initialized = True
        
        self.config_path = config_path
        self.config: Dict = {}
        self.mode: str = "v6"  # v6 or v5

        # 설정 로드
        self._load_configuration()

        # CLI Assistant 기본 타입
        self.cli_type = self.config["cli_assistant"]["type"]
        
        # 역할별 CLI 타입 (런타임에 오버라이드 가능) - 🆕 Singleton으로 유지됨
        self.role_cli_types: Dict[str, str] = {}
        
        # 역할별 LLM 소스 생성
        self.llm_sources: Dict[str, LLMSource] = {}
        self._create_llm_sources()

    def _load_configuration(self):
        """설정 로드 (YAML 우선, 없으면 환경 변수)"""

        # 1. YAML 파일이 있으면 우선 사용
        if os.path.exists(self.config_path):
            # print(f"[OK] Loading config from {self.config_path} (v6.0 mode)")
            self.config = self._load_yaml(self.config_path)
            self.mode = "v6"

        # 2. YAML 없으면 환경 변수 사용 (v5.0 호환)
        else:
            print(f"[WARN] No {self.config_path} found - using environment variables (v5.0 compatibility mode)")
            self.config = self._load_from_env()
            self.mode = "v5"

    def _load_yaml(self, path: str) -> Dict:
        """YAML 파일 로드"""
        try:
            with open(path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
        except Exception as e:
            raise RuntimeError(f"Failed to load YAML config: {e}")

    def _load_from_env(self) -> Dict:
        """
        환경 변수에서 v5.0 설정 로드 후 v6.0 구조로 변환

        v5.0 환경 변수:
        - DAACS_PLANNER_MODEL
        - DAACS_BACKEND_MODEL
        - DAACS_FRONTEND_MODEL
        - DAACS_MODE
        - DAACS_MAX_TURNS
        """

        planner_model = os.getenv("DAACS_PLANNER_MODEL", "gpt-5.1-codex-max")
        backend_model = os.getenv("DAACS_BACKEND_MODEL", planner_model)
        frontend_model = os.getenv("DAACS_FRONTEND_MODEL", planner_model)

        # v5.0 환경 변수를 v6.0 YAML 구조로 변환
        return {
            "cli_assistant": {
                "type": "codex",  # v5.0은 Codex 고정
                "timeout": 180
            },
            "roles": {
                "orchestrator": {
                    "source": "plugin",  # v5.0은 플러그인 LLM만 사용
                    "plugin": {
                        "provider": self._parse_model_provider(planner_model),
                        "model": planner_model,
                        "temperature": 0.3
                    }
                },
                "backend": {
                    "source": "plugin",
                    "plugin": {
                        "provider": self._parse_model_provider(backend_model),
                        "model": backend_model,
                        "temperature": 0.7
                    }
                },
                "frontend": {
                    "source": "plugin",
                    "plugin": {
                        "provider": self._parse_model_provider(frontend_model),
                        "model": frontend_model,
                        "temperature": 0.7
                    }
                }
            },
            "execution": {
                "mode": os.getenv("DAACS_MODE", "test"),
                "max_iterations": int(os.getenv("DAACS_MAX_TURNS", "10")),
                "max_failures": 5,
                "parallel_execution": False,  # v5.0은 순차 실행
                "log_dir": "logs"
            }
        }

    def _parse_model_provider(self, model_name: str) -> str:
        """모델 이름에서 프로바이더 추론"""
        model_lower = model_name.lower()

        if "gpt" in model_lower or "codex" in model_lower:
            return "openai"
        elif "claude" in model_lower:
            return "anthropic"
        elif "gemini" in model_lower:
            return "google"
        elif "llama" in model_lower or "groq" in model_lower:
            return "groq"
        else:
            return "openai"  # 기본값

    def _create_llm_sources(self):
        """
        역할별 LLM 소스 생성

        각 역할(orchestrator, backend, frontend, clarification)별로
        CLI Assistant LLM 또는 플러그인 LLM 선택
        
        🆕 clarification 역할은 항상 Gemini CLI 고정 (설정 파일에서 cli_type: "gemini")
        """
        roles_config = self.config.get("roles", {})
        cli_config = self.config.get("cli_assistant", {})
        timeout = cli_config.get("timeout", 60)

        # 🆕 clarification 역할 추가
        for role in ["clarification", "orchestrator", "backend", "frontend", "verifier"]:
            role_config = roles_config.get(role)
            if role_config:
                try:
                    # 역할별 CLI 타입 사용 (get_role_cli_type 메서드 사용)
                    # clarification은 설정에서 cli_type: "gemini"로 고정됨
                    role_cli_type = self.get_role_cli_type(role)
                    self.llm_sources[role] = LLMSourceFactory.create_from_config(
                        role_config,
                        role_cli_type,
                        timeout_sec=timeout
                    )
                    # print(f"  [{role}] LLM Source: {role_config['source']} (CLI: {role_cli_type})")
                except Exception as e:
                    # print(f"  [WARN] [{role}] Failed to create LLM source: {e}")
                    # Fallback: CLI Assistant LLM
                    from .llm.providers import CLIAssistantLLMSource
                    role_cli_type = self.get_role_cli_type(role)
                    self.llm_sources[role] = CLIAssistantLLMSource(
                        cli_or_type=role_cli_type,
                        temperature=0.7
                    )

    def get_llm_source(self, role: str) -> Optional[LLMSource]:
        """역할별 LLM 소스 반환"""
        return self.llm_sources.get(role)

    def get_execution_config(self) -> Dict:
        """실행 설정 반환"""
        return self.config.get("execution", {
            "mode": "test",
            "max_iterations": 10,
            "max_failures": 5,
            "parallel_execution": False,
            "log_dir": "logs"
        })

    def get_cli_config(self) -> Dict:
        """글로벌 CLI Assistant 설정 반환"""
        return self.config.get("cli_assistant", {
            "type": "codex",
            "timeout": 180
        })
    
    def get_role_cli_type(self, role: str) -> str:
        """
        역할별 CLI 타입 반환
        
        우선순위:
        1. role_cli_types (런타임 오버라이드)
        2. roles 설정의 cli_type
        3. 글로벌 cli_type
        """
        # 1. 런타임 오버라이드 확인
        if role in self.role_cli_types:
            return self.role_cli_types[role]
        
        # 2. 설정 파일에서 역할별 cli_type 확인
        roles_config = self.config.get("roles", {})
        role_config = roles_config.get(role, {})
        
        # 역할별 cli_type이 설정되어 있으면 사용, 아니면 글로벌 cli_type
        return role_config.get("cli_type", self.cli_type)

    def __repr__(self) -> str:
        return (
            f"DAACSConfig(mode={self.mode}, "
            f"cli={self.cli_type}, "
            f"roles={list(self.llm_sources.keys())})"
        )


# 사용 예시
if __name__ == "__main__":
    print("=== DAACS Config Loader Test ===\n")

    # YAML 파일이 있으면 v6.0 모드, 없으면 v5.0 호환 모드
    config = DAACSConfig("daacs_config.yaml")

    print(f"\nConfig Mode: {config.mode}")
    print(f"CLI Assistant: {config.cli_type}")

    print("\n=== LLM Sources ===")
    for role in ["orchestrator", "backend", "frontend"]:
        llm_source = config.get_llm_source(role)
        if llm_source:
            print(f"  {role}: {type(llm_source).__name__}")

    print("\n=== Execution Config ===")
    exec_config = config.get_execution_config()
    for key, value in exec_config.items():
        print(f"  {key}: {value}")

    print(f"\n{config}")
