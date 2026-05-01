import os
import json
import threading
from typing import Any, Dict, List, Optional

from .utils import setup_logger
from .config import DEFAULT_LLM_TIMEOUT_SEC, PLANNER_MODEL, SUPPORTED_MODELS, PROJECT_SCAN_MAX_FILES, _safe_int_env
from .codex_client import CodexClient
from .context import TechContext
from .agent_config import DEFAULT_VERIFY_TEMPLATES, MAX_FAILED_STREAK  # Issue 110, 117

logger = setup_logger("OrchestratorAgent")

class OrchestratorAgent:
    """
    Former Planner renamed to OrchestratorAgent.
    Handles planning, sanitizing actions, verification, and replanning.
    """

    def __init__(self, model_name: Optional[str] = None, mode: Optional[str] = None, workdir: str = "."):
        self.model_name: str = model_name or PLANNER_MODEL
        self.model_config = SUPPORTED_MODELS.get(self.model_name) or SUPPORTED_MODELS.get(PLANNER_MODEL) or {}
        if not self.model_config:
            logger.warning("No model config found for %s; defaulting to empty config.", self.model_name)
            self.model_config = {}
        logger.info("OrchestratorAgent initialized with model: %s", self.model_name)
        mode_value = mode if mode is not None else os.getenv("DAACS_MODE", "test")
        self.mode = (mode_value or "test").lower()
        self.constraints_enabled = self.mode == "test"
        self.workdir = workdir  # 프로젝트 작업 디렉토리 (검증 시 기준 경로)

        # Planner용 클라이언트 초기화 (멀티 프로바이더 지원)
        # Planner용 클라이언트 초기화 (멀티 프로바이더 지원)
        self.llm_timeout = _safe_int_env("DAACS_PLANNER_TIMEOUT_SEC", DEFAULT_LLM_TIMEOUT_SEC)
        provider = self.model_config.get("provider", "codex")
        self.client = CodexClient(
            client_name="planner", 
            model_name=self.model_name, 
            timeout_sec=self.llm_timeout,
            provider=provider
        )

        self.use_llm = os.getenv("DAACS_PLANNER_USE_LLM", "true").lower() == "true"

        self.state: Dict[str, int] = {
            "current_index": 0,
            "total_actions": 0
        }
        self.feedback: List[Dict[str, Any]] = []
        self.failed_streak = 0
        # Max feedback entries to prevent memory growth (issue 118)
        self.max_feedback_size = 50
        # Use class-level verify templates (externalized for configurability - issue 110)
        self.verify_templates = DEFAULT_VERIFY_TEMPLATES
        
        # Thread safety lock (issue 119)
        self._lock = threading.Lock()
        
        # Caching for project structure (Issue 121)
        self._structure_cache: Optional[Dict[str, Any]] = None
        self._cache_timestamp: float = 0.0


    def _scan_project_structure(self, max_files: int = 0, use_cache: bool = True) -> Dict[str, Any]:
        """
        workdir의 현재 파일 구조를 스캔하여 LLM에게 제공.
        파일 목록 + 주요 파일 내용을 반환.
        """
        if use_cache and self._structure_cache:
            return self._structure_cache

        from .orchestrator.agent_helpers import scan_project_structure
        if max_files <= 0:
            max_files = PROJECT_SCAN_MAX_FILES
        result = scan_project_structure(self.workdir, max_files, logger)
        
        if use_cache:
            self._structure_cache = result
            # self._cache_timestamp = time.time() # Optional timestamp tracking
            
        return result
        
    def invalidate_cache(self) -> None:
        """Cache invalidation (e.g. after edits)"""
        self._structure_cache = None

    def _call_llm(self, prompt: str) -> Optional[str]:
        """CodexClient(멀티 프로바이더)를 사용해 계획을 생성. 실패 시 None."""
        if not self.use_llm:
            return None

        result = self.client.execute(prompt)
        # Issue 112: Standardized error checking using tuple
        error_prefixes = ("Error:", "Exception:")
        if result.startswith(error_prefixes):
            logger.error("OrchestratorAgent LLM call failed: %s", result)
            return None
        return result

    def _sanitize_actions(self, actions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """액션 목록을 후처리하여 위험/비일관 지시를 교정."""
        from .orchestrator.agent_helpers import sanitize_actions
        return sanitize_actions(actions, self.workdir, self.verify_templates, logger)

    def _parse_llm_response(self, text: str) -> Optional[Dict[str, Any]]:
        """LLM 응답에서 JSON을 추출/파싱."""
        from .orchestrator.agent_helpers import parse_llm_response
        return parse_llm_response(text, logger)


    def add_feedback(self, action: Dict[str, Any], result: str, review: Dict[str, Any]) -> None:
        """Codex 실행 결과를 Planner 피드백으로 적재."""
        self.feedback.append({
            "action": action,
            "result": result,
            "review": review
        })
        # Issue 118: Enforce feedback size limit to prevent memory growth
        if len(self.feedback) > self.max_feedback_size:
            self.feedback = self.feedback[-self.max_feedback_size:]

    def create_plan(self, goal: str, tech_context: Optional[TechContext] = None, skip_llm: bool = False) -> dict:
        """목표를 받아 실행 계획을 수립합니다."""
        logger.info("Planning for goal: %s", goal)
        if tech_context:
            logger.info("Using TechContext with %d facts", len(tech_context.facts))

        # 프로젝트 구조 스캔 (Context Injection)
        project_structure = self._scan_project_structure()
        files_count = len(project_structure.get("files", []))
        key_files_count = len(project_structure.get("key_files", {}))
        if files_count > 0:
            logger.info("Project structure: %d files found, %d key files analyzed", files_count, key_files_count)
        else:
            logger.info("Project structure: EMPTY (new project)")

        # Build fallback actions (used if LLM fails or is disabled)
        from .orchestrator.fallback_actions import build_fallback_actions
        actions = build_fallback_actions(goal)

        # Issue 113: Removed hardcoded magic strings ("pynet", "bitburner"). 
        # Control via explicit `skip_llm` parameter.
        
        if self.use_llm and not skip_llm:
            # Use build_orchestrator_prompt directly from prompt_builder module
            from .orchestrator.prompt_builder import build_orchestrator_prompt
            llm_prompt = build_orchestrator_prompt(
                goal=goal,
                constraints_enabled=self.constraints_enabled,
                tech_context=tech_context,
                project_structure=project_structure,
            )
            llm_raw = self._call_llm(llm_prompt)
            if llm_raw:
                parsed = self._parse_llm_response(llm_raw)
                # Issue 122: Explicit empty check for actions
                if parsed and isinstance(parsed.get("actions"), list) and len(parsed["actions"]) > 0:
                    actions = parsed["actions"]
                    logger.info("LLM-produced actions accepted: %d", len(actions))
                else:
                    logger.warning("LLM response parsed but no valid actions (or empty); using fallback.")


        actions = self._sanitize_actions(actions)

        plan: Dict[str, Any] = {
            "goal": goal,
            "actions": actions,
            "current_index": 0,
            "next_goal": "",
            "mode": self.mode,
            "constraints_enabled": self.constraints_enabled,
            "tech_context_used": bool(tech_context and tech_context.facts)
        }

        with self._lock:
            self.state["total_actions"] = len(plan["actions"])
        return plan

    def get_next_instruction(self, plan: dict) -> Optional[Dict[str, Any]]:
        """계획에서 다음 실행할 액션을 가져옵니다."""
        current = plan.get("current_index", 0)
        actions = plan.get("actions", [])
        if current < len(actions):
            action = actions[current]
            plan["current_index"] = current + 1
            with self._lock:
                self.state["current_index"] = plan["current_index"]
            return action
        
        # Explicitly return None if no more actions
        return None

    def review_result(self, action: Dict[str, Any], result: str) -> dict:
        """Codex의 실행 결과를 리뷰합니다."""
        logger.info("Reviewing result...")

        # Use consolidated ActionVerifier from orchestrator module
        from .orchestrator.verification import ActionVerifier
        verifier = ActionVerifier(self.workdir)
        verify_outcome = verifier.verify(action, result)
        success = verify_outcome["success"]
        if success:
            self.failed_streak = 0
        else:
            self.failed_streak += 1

        with self._lock:
            is_complete = self.state.get("current_index", 0) >= self.state.get("total_actions", 0)

        return {
            "success": success,
            "needs_retry": not success,
            "is_complete": is_complete,
            "verify": verify_outcome
        }

    def plan_next(self, goal: str) -> Optional[Dict[str, Any]]:
        """
        실패 피드백을 기반으로 재계획.
        - 연속 실패 초과 시(MAX_FAILED_STREAK) 중단.
        - 권한 문제(rollout recorder/permission) 시 즉시 중단 요청.
        - 타입/검증 실패에 따라 보강된 next_actions를 제안하고 기존 goal을 유지.
        """
        if self.failed_streak > MAX_FAILED_STREAK:
            logger.error("Max failed streak (%d) exceeded. Stopping.", MAX_FAILED_STREAK)
            return None

        from .orchestrator.plan_next import build_next_plan
        plan = build_next_plan(
            goal=goal,
            failed_streak=self.failed_streak,
            feedback=self.feedback,
            verify_templates=self.verify_templates,
        )
        if plan.get("next_actions"):
            plan["next_actions"] = self._sanitize_actions(plan["next_actions"])
        return plan

    def quality_gate_actions(self) -> List[Dict[str, Any]]:
        """
        품질 게이트 실행용 보조 액션 (옵션).
        ruff/mypy/bandit/radon/pytest를 실행하고, 임계치 불만족 또는 미설치 시 실패.
        """

        from .orchestrator.agent_quality import quality_gate_actions as build_quality_gate_actions
        return build_quality_gate_actions()

    def clarify_goal(self, goal: str, history: Optional[List[Dict[str, str]]] = None) -> Dict[str, Any]:
        """
        사용자 목표가 명확한지 분석(RFI 단계). 모호하면 질문을 던짐.
        Returns: {"clear": bool, "question": optional_str}
        
        LLM 응답 파싱 실패 시 최대 2회 재시도하며,
        최종 실패 시 사용자에게 명확한 에러 메시지를 반환함.
        """
        history_lines = []
        if history:
            for idx, item in enumerate(history[-5:], start=1):
                question = (item.get("question") or "").strip().replace("\n", " ")
                answer = (item.get("answer") or "").strip().replace("\n", " ")
                if not question and not answer:
                    continue
                if len(question) > 200:
                    question = f"{question[:197]}..."
                if len(answer) > 200:
                    answer = f"{answer[:197]}..."
                history_lines.append(f"Q{idx}: {question}")
                if answer:
                    history_lines.append(f"A{idx}: {answer}")
        history_block = ""
        if history_lines:
            history_block = "Previous Q/A:\n" + "\n".join(history_lines) + "\n\n"

        # 🆕 Scan Project Structure for Context Awareness
        project_struct = self._scan_project_structure(max_files=50)
        files = project_struct.get("files", [])
        struct_str = "\n".join(f"- {f}" for f in files) if files else "(No files found/Empty)"
        if len(files) > 0:
            logger.info(f"[RFI] Context: Found {len(files)} existing files.")

        prompt = (
            f"As a Professional RFI/RFP Analyst, evaluate this software goal: '{goal}'\n"
            f"Current Project Context (Existing Files):\n{struct_str}\n\n"
            f"{history_block}"
            "Your job is to gather missing specs (Tech Stack, Core Features, Target Users, etc.) "
            "before the Orchestrator starts building.\n"
            "IMPORTANT: If a topic is already answered in Previous Q/A, do NOT repeat it.\n"
            "CRITICAL: Always inform the user about their interaction options in your 'question':\n"
            "1. Type 'go' or 'build' whenever they want to start the orchestration.\n"
            "2. Press 'Enter' without typing to let YOU (the Analyst) auto-complete the specs and proceed.\n"
            "3. Answer your questions to refine the project further.\n\n"
            "If the goal is clear enough to start, return JSON: {\"clear\": true, "
            "\"question\": \"정보가 충분합니다. 바로 시작하려면 'go'를 입력하거나 추가 요구사항을 알려주세요.\"}\n"
            "If it needs more detail (RFI required), return JSON: {\"clear\": false, "
            "\"question\": \"[Your question] + [Briefly mention that they can type 'go' at any time or press Enter for auto-spec]\"}\n"
            "CRITICAL: YOUR RESPONSE MUST BE IN KOREAN. Keep it professional and concise.\n"
            "Respond ONLY with JSON."
        )
        
        MAX_RETRIES = 2
        last_error = None
        
        for attempt in range(MAX_RETRIES + 1):
            resp = self._call_llm(prompt)
            
            if not resp:
                logger.warning("LLM returned empty response (attempt %d/%d)", attempt + 1, MAX_RETRIES + 1)
                last_error = "empty_response"
                continue
            
            try:
                # 마크다운 코드 블록 제거 (Gemini CLI 응답 형식 처리)
                cleaned = resp.strip()
                if cleaned.startswith("```"):
                    # ```json 또는 ``` 제거
                    lines = cleaned.split("\n")
                    if lines[0].startswith("```"):
                        lines = lines[1:]  # 첫 줄 제거
                    if lines and lines[-1].strip() == "```":
                        lines = lines[:-1]  # 마지막 줄 제거
                    cleaned = "\n".join(lines).strip()
                
                # JSON 추출 (중괄호 기준)
                start = cleaned.find("{")
                end = cleaned.rfind("}")
                if start != -1 and end != -1 and end > start:
                    cleaned = cleaned[start:end+1]
                
                parsed = json.loads(cleaned)
                # 성공적으로 파싱됨
                return parsed
            except json.JSONDecodeError as e:
                logger.warning("JSON parse failed (attempt %d/%d): %s", attempt + 1, MAX_RETRIES + 1, e)
                last_error = str(e)
                
                # 마지막 시도가 아니면 재시도
                continue

        error_msg = f"Failed to parse Analyst response after {MAX_RETRIES + 1} attempts. Last error: {last_error}"
        logger.error(error_msg)
        return {
            "clear": False,
            "question": f"시스템 오류: 분석가의 응답을 처리할 수 없습니다. ({last_error})\n잠시 후 다시 시도하거나 'go'를 입력하여 강제로 진행하세요.",
        }

    def auto_complete_specs(self, goal: str) -> str:
        """
        사용자가 답변을 하지 않았을 때, 기술 스펙만 자동으로 결정.
        원래 목표는 반드시 보존하고, 기술 스택 선택만 추가.
        """
        prompt = (
            f"User's original goal: '{goal}'\n\n"
            "The user skipped RFI clarification. Keep the EXACT original goal as-is.\n"
            "Only add a brief tech stack recommendation (1-2 sentences max).\n"
            "Format: '[Original Goal] using [simple tech stack]'\n"
            "Example: 'echo test using Python CLI' or 'todo app using React + FastAPI'\n"
            "DO NOT expand, redesign, or reinterpret the goal.\n"
            "Respond in the same language as the original goal."
        )
        resp = self._call_llm(prompt)
        # LLM이 목표를 확장하면 원래 goal 사용
        if resp and len(resp) > len(goal) * 3:
            logger.warning("LLM expanded goal too much (%d chars), using original", len(resp))
            return goal
        return resp if resp else goal

    def finalize_rfp(self, goal_history: str, tech_context: Optional[Dict[str, Any]] = None) -> str:
        """
        수집된 모든 대화 기록을 바탕으로 최종 RFP(Request for Proposal) 문서를 생성함.
        오케스트레이터가 작업을 시작하기 전 가장 명확한 지침이 됨.
        이제 JSON 형식으로 구조화된 데이터를 반환함.
        """
        schema_hint = {
            "goal": "Final refined project goal summary (natural language, under 100 words)",
            "specs": [
                {
                    "id": "FR-001", "type": "feature", "title": "Todo Creation", 
                    "description": "User can create todos...", "status": "accepted",
                    "rationale": "Core MVP requirement"
                },
                {
                    "id": "TECH-BE", "type": "tech", "title": "FastAPI",
                    "description": "Python backend framework", 
                    "tech_category": "Backend",
                    "rationale": "Based on Python preference and stability constraint",
                    "sources": ["https://fastapi.tiangolo.com", "https://survey.stackoverflow.co/2024"]
                }
            ],
            "blueprint": {
                "mermaid_script": "graph TD; Client-->API; ...",
                "components": ["Client", "API", "DB"]
            }
        }
        
        context_str = ""
        if tech_context:
            context_str = (
                f"\n[Tech Context & Constraints]\n"
                f"Facts: {json.dumps(tech_context.get('facts', []), ensure_ascii=False)}\n"
                f"Constraints: {json.dumps(tech_context.get('constraints', []), ensure_ascii=False)}\n"
                f"Sources: {json.dumps(tech_context.get('sources', []), ensure_ascii=False)}\n"
            )
        
        # 🆕 Inject Project Structure into RFP Prompt
        project_struct = self._scan_project_structure(max_files=50)
        files = project_struct.get("files", [])
        struct_str = "\n".join(f"- {f}" for f in files) if files else "(No files found)"

        prompt = (
            f"Conversation History: '{goal_history}'\n"
            f"Existing Project Structure:\n{struct_str}\n"
            f"{context_str}\n"
            "Synthesize all requirements into a structured Request for Proposal (RFP).\n"
            "If the goal is simple (e.g. 'echo hello', 'print test'), keep the specs and blueprint VERY minimal:\n"
            " - Specs: 1 simple feature\n"
            " - Blueprint: 1 simple component (no complex mermaid diagrams)\n"
            " - Rationale: 'Simple task from user goal'\n"
            "Return a JSON object exactly matching this schema:\n"
            f"{json.dumps(schema_hint, indent=2)}\n"
            "RULES:\n"
            "1. 'goal': A clear, concise summary of the project.\n"
            "2. 'specs': Detailed list of functional requirements (FR-xxx) and key tech choices (TECH-xxx).\n"
            "   - For 'tech' specs, include 'rationale' linked to user constraints (e.g. 'Chosen for stability').\n"
            "   - explicitly reference the [Tech Context] constraints in the rationale if applicable.\n"
            "   - POPULATE 'sources' list with relevant URLs from [Tech Context] Sources that support this choice.\n"
            "3. 'blueprint': A valid Mermaid.js graph string visualizing the architecture. CRITICAL: Use format NodeID[\"Label\"] for ALL nodes. Do NOT use spaces/special characters in Node IDs. Example: Client[\"User Interface\"] --> API[\"Backend API\"].\n"
            "Respond ONLY with the JSON string. Do not include markdown blocks."
        )
        resp = self._call_llm(prompt)
        # Fallback if empty
        if not resp:
            return json.dumps({"goal": goal_history, "specs": [], "blueprint": None})
        
        # Clean up markdown if present
        stripped = resp.strip()
        if stripped.startswith("```"):
            stripped = stripped.strip("`")
            if stripped.startswith("json"):
                stripped = stripped[4:]
        return stripped.strip()

    def analyze_feedback(self, feedback: str, history_summary: str) -> Dict[str, Any]:
        """
        사용자의 피드백을 분석하여 다음 단계 결정.
        Returns: {"action": "refine"|"complete", "new_goal": optional_str}
        """
        prompt = (
            f"User provided feedback: '{feedback}'\n"
            f"Previous Run Summary: '{history_summary}'\n"
            "Should we refine the project or is it complete?\n"
            "Return JSON: {\"action\": \"refine\", \"new_goal\": \"Combined goal...\"} or {\"action\": \"complete\"}\n"
            "Respond ONLY with JSON."
        )
        resp = self._call_llm(prompt)
        try:
            return json.loads(resp) if resp else {"action": "complete"}
        except json.JSONDecodeError:
            logger.debug("Failed to parse feedback analysis JSON", exc_info=True)
            return {"action": "complete"}
