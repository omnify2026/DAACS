"""
DAACS LLM Source Provider
역할별로 CLI Assistant의 LLM 또는 플러그인 LLM을 선택할 수 있는 추상화 계층

Classes:
- LLMSource: 추상 베이스 클래스
- CLIAssistantLLMSource: CLI Assistant (codex, claude) 사용
- PluginLLMSource: 플러그인 LLM (Gemini, Groq 등)
- MockLLMSource: 테스트용
- LLMSourceFactory: 역할별 LLM 생성 팩토리
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional
import subprocess
import json
import re
import logging

logger = logging.getLogger(__name__)


class LLMSource(ABC):
    """LLM 소스 베이스 클래스 (CLI Assistant 또는 Plugin)"""

    @abstractmethod
    def invoke(self, prompt: str, **kwargs) -> str:
        """LLM 호출"""
        pass

    @abstractmethod
    def invoke_structured(self, prompt: str, schema: Optional[Dict] = None) -> Dict:
        """구조화된 출력 (JSON)"""
        pass


class CLIAssistantLLMSource(LLMSource):
    """
    CLI Assistant의 내장 LLM 사용
    
    예: Claude Code를 실행하면 내부적으로 Claude의 LLM이 동작
    Codex를 실행하면 내부적으로 GPT의 LLM이 동작
    """

    def __init__(
        self,
        cli_type: str = "codex",
        temperature: float = 0.7,
        timeout_sec: int = 60,
        fallback_config: Optional[Dict] = None,
        cwd: str = "."
    ):
        """
        Args:
            cli_type: CLI Assistant 타입 (codex, claude, local)
            temperature: LLM temperature
            timeout_sec: 타임아웃 (초)
            fallback_config: Fallback 플러그인 LLM 설정
            cwd: 작업 디렉토리
        """
        self.cli_type = cli_type
        self.temperature = temperature
        self.timeout_sec = timeout_sec
        self.fallback_config = fallback_config
        self.cwd = cwd
        
        # Initialize CLI Client from existing module
        from .cli_executor import SessionBasedCLIClient
        from daacs.config import PLANNER_MODEL
        self.client = SessionBasedCLIClient(
            cwd=cwd,
            timeout_sec=timeout_sec,
            client_name="cli_assistant",
            cli_type=cli_type,
            model_name=PLANNER_MODEL  # Use configured default
        )

    def invoke(self, prompt: str, **kwargs) -> str:
        """CLI Assistant LLM 호출 (실패 시 Fallback)"""
        try:
            result = self.client.execute(prompt)
            
            if result.startswith("Error:") or result.startswith("Exception:"):
                raise RuntimeError(f"CLI Assistant failed: {result}")
                
            return result

        except Exception as e:
            logger.warning(f"CLI Assistant LLM failed: {e}")

            # Fallback to Plugin LLM
            if self.fallback_config:
                logger.info(f"Falling back to Plugin LLM ({self.fallback_config['provider']})")
                fallback_source = PluginLLMSource(
                    provider=self.fallback_config["provider"],
                    model=self.fallback_config.get("model", "gemini-2.0-flash"),
                    temperature=self.temperature
                )
                return fallback_source.invoke(prompt, **kwargs)

            raise RuntimeError(f"CLI Assistant LLM unavailable and no fallback configured: {e}")

    def invoke_structured(self, prompt: str, schema: Optional[Dict] = None) -> Dict:
        """구조화된 출력"""
        response = self.invoke(prompt + "\n\nRespond in JSON format only.")
        return _parse_json_response(response)


class PluginLLMSource(LLMSource):
    """
    플러그인 LLM 사용 (Groq, Claude, Gemini, GPT 등)
    """

    def __init__(
        self,
        provider: str,
        model: str,
        temperature: float = 0.7,
        api_key: Optional[str] = None
    ):
        """
        Args:
            provider: LLM 프로바이더 (groq, claude, gemini, openai)
            model: 모델 이름
            temperature: LLM temperature
            api_key: API 키 (옵션, 환경 변수에서 자동 로드)
        """
        self.provider = provider
        self.model = model
        self.temperature = temperature
        self.api_key = api_key
        self.llm = self._initialize_llm()

    def _initialize_llm(self):
        """LLM 플러그인 초기화"""
        import os
        
        if self.provider == "gemini":
            try:
                import google.generativeai as genai
                api_key = self.api_key or os.environ.get("GOOGLE_API_KEY")
                if not api_key:
                    logger.warning("GOOGLE_API_KEY not found. Gemini plugin will fail.")
                    return None
                genai.configure(api_key=api_key)
                return genai.GenerativeModel(self.model)
            except ImportError:
                logger.warning("google-generativeai package not installed.")
                return None
            except Exception as e:
                logger.warning(f"Failed to initialize Gemini: {e}")
                return None
        
        logger.info(f"[PluginLLMSource] Initialized: {self.provider}/{self.model}")
        return None

    def invoke(self, prompt: str, **kwargs) -> str:
        """플러그인 LLM 호출"""
        if self.llm:
            try:
                if self.provider == "gemini":
                    response = self.llm.generate_content(
                        prompt,
                        generation_config={"temperature": self.temperature}
                    )
                    return response.text
                return self.llm.invoke(prompt)
            except Exception as e:
                logger.warning(f"Plugin execution failed: {e}")

        # Fallback: codex exec 사용
        logger.warning("Plugin LLM not available, using codex fallback")
        try:
            result = subprocess.run(
                ["codex", "exec", "--full-auto", prompt],
                capture_output=True,
                text=True,
                timeout=60,
                check=False
            )
            if result.returncode == 0:
                return result.stdout.strip()
            raise RuntimeError(f"Codex failed: {result.stderr}")
        except Exception as e:
            logger.warning(f"Codex fallback failed: {e}")
            mock = MockLLMSource(role="backend")
            return mock.invoke(prompt)

    def invoke_structured(self, prompt: str, schema: Optional[Dict] = None) -> Dict:
        """구조화된 출력"""
        response = self.invoke(prompt + "\n\nRespond in JSON format only.")
        return _parse_json_response(response)


class MockLLMSource(LLMSource):
    """테스트용 Mock LLM"""

    def __init__(self, role: str = "unknown"):
        self.role = role

    def invoke(self, prompt: str, **kwargs) -> str:
        logger.debug(f"[MockLLM:{self.role}] Invoked with prompt length: {len(prompt)}")
        
        responses = {
            "orchestrator": '{"needs_backend": true, "needs_frontend": true, "plan": "Create fullstack app"}',
            "backend": 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/")\ndef root():\n    return {"hello": "world"}',
            "frontend": 'export default function App() { return <h1>Hello World</h1>; }',
        }
        return responses.get(self.role, "Mock response")

    def invoke_structured(self, prompt: str, schema: Optional[Dict] = None) -> Dict:
        return {"response": self.invoke(prompt)}


class LLMSourceFactory:
    """역할별 LLM 소스 생성 팩토리"""

    @staticmethod
    def create_from_config(
        role_config: Dict,
        cli_type: str = "codex",
        timeout_sec: int = 60,
        cwd: str = "."
    ) -> LLMSource:
        """
        설정에서 LLM 소스 생성

        Args:
            role_config: 역할 설정
                예: {"source": "cli_assistant", "temperature": 0.7}
                또는: {"source": "plugin", "plugin": {"provider": "gemini", "model": "gemini-2.0-flash"}}
            cli_type: CLI Assistant 타입 (codex, claude, etc)
            timeout_sec: 타임아웃 (초)
            cwd: 작업 디렉토리

        Returns:
            LLMSource 인스턴스
        """
        source = role_config.get("source", "cli_assistant")
        temperature = role_config.get("temperature", 0.7)

        if source == "cli_assistant":
            effective_cli_type = role_config.get("cli_type", cli_type)
            fallback = role_config.get("fallback")
            return CLIAssistantLLMSource(
                cli_type=effective_cli_type,
                temperature=temperature,
                timeout_sec=timeout_sec,
                fallback_config=fallback,
                cwd=cwd
            )

        elif source == "plugin":
            plugin_config = role_config.get("plugin", {})
            return PluginLLMSource(
                provider=plugin_config.get("provider", "gemini"),
                model=plugin_config.get("model", "gemini-2.0-flash"),
                temperature=temperature,
                api_key=plugin_config.get("api_key")
            )

        elif source == "mock":
            return MockLLMSource(role=role_config.get("role", "unknown"))

        else:
            raise ValueError(f"Unknown LLM source: {source}. Must be 'cli_assistant', 'plugin', or 'mock'")


def _parse_json_response(response: str) -> Dict[str, Any]:
    """
    LLM 응답에서 JSON 추출 - 강화된 파싱 로직 (KK에서 이식)
    
    파싱 우선순위:
    1. 순수 JSON (response 전체)
    2. ```json ... ``` 블록
    3. ``` ... ``` 블록 (언어 식별자 제거)
    4. {...} 중괄호 기반 추출
    5. Fallback: 텍스트를 response 필드에 매핑
    """
    if not response:
        return {"response": ""}
    
    # 1. 순수 JSON 파싱 시도
    try:
        return json.loads(response)
    except json.JSONDecodeError:
        pass

    # 2. Markdown 코드 블록 (```json ... ```) 추출
    if "```json" in response:
        try:
            json_str = response.split("```json")[1].split("```")[0].strip()
            return json.loads(json_str)
        except (json.JSONDecodeError, IndexError):
            pass
    
    # 3. 일반 코드 블록 (``` ... ```) 추출
    if "```" in response:
        try:
            # 첫 번째 코드 블록 시도
            parts = response.split("```")
            if len(parts) >= 3:
                json_str = parts[1].strip()
                # 언어 식별자 제거 (예: ```python)
                if "\n" in json_str and not json_str.startswith("{"):
                    json_str = json_str.split("\n", 1)[1].strip()
                return json.loads(json_str)
        except (json.JSONDecodeError, IndexError):
            pass

    # 4. 중괄호 {} 기반 추출 (가장 강력함)
    try:
        start_idx = response.find("{")
        end_idx = response.rfind("}")
        if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
            json_str = response[start_idx : end_idx + 1]
            return json.loads(json_str)
    except json.JSONDecodeError:
        pass

    # 5. 최후의 수단: 텍스트를 response/plan/analysis 필드에 매핑
    logger.warning(f"Failed to parse JSON from LLM response. Raw length: {len(response)}")
    return {"response": response, "plan": response, "analysis": response}
