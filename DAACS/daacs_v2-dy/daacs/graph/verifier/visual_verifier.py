"""
Visual Verifier - Playwright 기반 시각적 검증

프론트엔드 UI를 실제로 렌더링하고 스크린샷을 캡처하여 검증합니다.

v7.2.0: KK에서 이식
"""

import os
import time
import subprocess
import signal
from dataclasses import dataclass, field
from typing import List, Optional
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, Page
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

import logging

logger = logging.getLogger("VisualVerifier")


@dataclass
class VisualVerificationResult:
    """시각적 검증 결과"""
    screenshots: List[str] = field(default_factory=list)  # 캡처된 스크린샷 경로들
    page_loaded: bool = False  # 페이지 정상 로드 여부
    console_errors: List[str] = field(default_factory=list)  # 콘솔 에러 목록
    encoding_issues: List[str] = field(default_factory=list)  # 인코딩 문제
    load_time_ms: float = 0.0  # 페이지 로드 시간
    passed: bool = False  # 검증 통과 여부
    error_message: str = ""  # 실패 시 에러 메시지
    login_detected: bool = False  # 로그인 폼 감지 여부
    login_success: bool = False  # 로그인 성공 여부
    
    def to_dict(self) -> dict:
        return {
            "screenshots": self.screenshots,
            "page_loaded": self.page_loaded,
            "console_errors": self.console_errors,
            "encoding_issues": self.encoding_issues,
            "load_time_ms": self.load_time_ms,
            "passed": self.passed,
            "error_message": self.error_message,
            "login_detected": self.login_detected,
            "login_success": self.login_success
        }


class VisualVerifier:
    """
    프론트엔드 시각적 검증
    
    Playwright를 사용하여:
    1. 브라우저에서 페이지 로드
    2. 스크린샷 캡처
    3. 콘솔 에러 수집
    4. 결과 반환
    """
    
    def __init__(
        self,
        project_dir: str,
        port: int = 3000,
        timeout_sec: int = 30,
        headless: bool = True
    ):
        self.project_dir = Path(project_dir)
        self.frontend_dir = self.project_dir / "frontend"
        self.port = port
        self.timeout_sec = timeout_sec
        self.headless = headless
        self.screenshots_dir = self.project_dir / "screenshots"
        
    def verify(self, start_server: bool = False) -> VisualVerificationResult:
        """
        체계적인 시각 검증 수행
        
        Args:
            start_server: True면 npm run dev 서버 자동 시작
            
        Returns:
            VisualVerificationResult
        """
        result = VisualVerificationResult()
        server_process = None
        
        if not PLAYWRIGHT_AVAILABLE:
            result.error_message = "Playwright not installed. Run: pip install playwright && playwright install chromium"
            logger.warning(result.error_message)
            return result
        
        try:
            # 스크린샷 디렉토리 생성
            self.screenshots_dir.mkdir(parents=True, exist_ok=True)
            
            # 서버 시작 (필요 시)
            if start_server:
                server_process = self._start_frontend_server()
                if not server_process:
                    result.error_message = "Failed to start frontend server"
                    return result
                # 서버 준비 대기
                time.sleep(3)
            
            # Playwright로 검증
            result = self._verify_with_playwright()
            
        except Exception as e:
            result.error_message = str(e)
            logger.error(f"Visual verification failed: {e}")
            
        finally:
            # 서버 종료
            if server_process:
                self._stop_server(server_process)
        
        return result
    
    def _start_frontend_server(self) -> Optional[subprocess.Popen]:
        """프론트엔드 개발 서버 시작"""
        try:
            logger.info(f"Starting frontend server in {self.frontend_dir}")
            
            # npm run dev 실행
            process = subprocess.Popen(
                ["npm", "run", "dev"],
                cwd=str(self.frontend_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=True,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0
            )
            
            return process
            
        except Exception as e:
            logger.error(f"Failed to start frontend server: {e}")
            return None
    
    def _stop_server(self, process: subprocess.Popen):
        """서버 프로세스 종료"""
        try:
            if os.name == 'nt':
                process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                process.terminate()
            process.wait(timeout=5)
        except Exception as e:
            logger.warning(f"Failed to stop server gracefully: {e}")
            process.kill()
    
    def _verify_with_playwright(self) -> VisualVerificationResult:
        """Playwright를 사용한 실제 검증"""
        result = VisualVerificationResult()
        console_errors = []
        
        with sync_playwright() as p:
            # 브라우저 시작
            browser = p.chromium.launch(headless=self.headless)
            context = browser.new_context(
                viewport={"width": 1280, "height": 720}
            )
            page = context.new_page()
            
            # 콘솔 에러 수집
            def handle_console(msg):
                if msg.type == "error":
                    console_errors.append(msg.text)
            
            page.on("console", handle_console)
            
            try:
                # 페이지 로드
                url = f"http://localhost:{self.port}"
                start_time = time.time()
                
                logger.info(f"Loading page: {url}")
                response = page.goto(url, timeout=self.timeout_sec * 1000)
                
                # 네트워크 안정화 대기
                page.wait_for_load_state("networkidle", timeout=10000)
                
                load_time = (time.time() - start_time) * 1000
                result.load_time_ms = round(load_time, 2)
                
                # 응답 확인
                if response and response.ok:
                    result.page_loaded = True
                    logger.info(f"Page loaded successfully in {result.load_time_ms}ms")
                else:
                    result.error_message = f"Page returned status {response.status if response else 'unknown'}"
                
                # 스크린샷 캡처 (로그인 전)
                screenshots = self._capture_screenshots(page)
                result.screenshots = screenshots
                
                # 스마트 로그인 시도
                self._attempt_login(page, result)
                
            except Exception as e:
                result.error_message = str(e)
                logger.error(f"Page load failed: {e}")
            
            finally:
                result.console_errors = console_errors
                browser.close()
        
        # 통과 여부 판단
        result.passed = (
            result.page_loaded and 
            len(result.console_errors) == 0 and
            not result.error_message
        )
        
        return result

    def _attempt_login(self, page: "Page", result: VisualVerificationResult):
        """
        🔐 스마트 로그인 시도 (Smart E2E)
        로그인 폼이 감지되면 자동으로 로그인을 시도합니다.
        """
        try:
            # 1. 로그인 폼 감지 (비밀번호 필드 존재 여부)
            password_field = page.locator('input[type="password"]').first
            if not password_field.is_visible():
                return

            logger.info("🔐 Login form detected! Attempting Smart Login...")
            result.login_detected = True
            
            # 2. 아이디 필드 찾기 (이메일 -> username -> text 순)
            email_field = page.locator('input[type="email"]').first
            username_field = page.locator('input[name="username"]').first
            text_field = page.locator('input[type="text"]').first
            
            target_user_field = None
            user_value = "admin"
            
            if email_field.is_visible():
                target_user_field = email_field
                user_value = "admin"
            elif username_field.is_visible():
                target_user_field = username_field
            elif text_field.is_visible():
                target_user_field = text_field
            
            # 3. 입력 수행
            if target_user_field:
                target_user_field.fill(user_value)
                logger.info(f"   Filled username: {user_value}")
            
            password_field.fill("admin")
            logger.info("   Filled password: admin")
            
            # 4. 제출 버튼 클릭 (Submit -> Login -> Sign In 순)
            submit_btn = page.locator('button[type="submit"]').first
            if not submit_btn.is_visible():
                submit_btn = page.get_by_role("button", name="Login").first
            if not submit_btn.is_visible():
                submit_btn = page.get_by_role("button", name="Sign In").first
            if not submit_btn.is_visible():
                submit_btn = page.get_by_role("button", name="로그인").first
                
            if submit_btn.is_visible():
                submit_btn.click()
                logger.info("   Clicked submit button")
                
                # 5. 로그인 처리 대기 (최대 10초)
                try:
                    logger.info("   Waiting for login to complete (max 10s)...")
                    # 비밀번호 필드가 사라지면 로그인 성공으로 간주
                    password_field.wait_for(state="hidden", timeout=10000)
                    
                    logger.info("   ✅ Login successful (Password field disappeared)")
                    result.login_success = True
                    
                    # 로그인 후 안정화를 위해 잠시 대기
                    page.wait_for_timeout(3000)
                    
                    # 7. 로그인 후 스크린샷 촬영
                    timestamp = int(time.time())
                    post_login_path = self.screenshots_dir / f"post_login_{timestamp}.png"
                    page.screenshot(path=str(post_login_path), full_page=True)
                    result.screenshots.append(str(post_login_path))
                    
                except Exception:
                    # 타임아웃: 여전히 비밀번호 필드가 보임 -> 실패
                    logger.warning("   ❌ Login failed (Timeout: Password field still visible)")
                    
                    # 실패 원인 분석을 위한 스크린샷
                    timestamp = int(time.time())
                    fail_path = self.screenshots_dir / f"login_failed_{timestamp}.png"
                    page.screenshot(path=str(fail_path), full_page=True)
                    result.screenshots.append(str(fail_path))
            else:
                logger.warning("   ⚠️ Submit button not found")
                
        except Exception as e:
            logger.warning(f"   ⚠️ Smart Login failed: {e}")

    def _capture_screenshots(self, page: "Page") -> List[str]:
        """스크린샷 캡처"""
        screenshots = []
        timestamp = int(time.time())
        
        try:
            # 전체 페이지 스크린샷
            full_path = self.screenshots_dir / f"full_{timestamp}.png"
            page.screenshot(path=str(full_path), full_page=True)
            screenshots.append(str(full_path))
            logger.info(f"Captured full page screenshot: {full_path}")
            
            # 뷰포트 스크린샷
            viewport_path = self.screenshots_dir / f"viewport_{timestamp}.png"
            page.screenshot(path=str(viewport_path), full_page=False)
            screenshots.append(str(viewport_path))
            
        except Exception as e:
            logger.error(f"Screenshot capture failed: {e}")
        
        return screenshots


def verify_frontend(project_dir: str, port: int = 3000) -> VisualVerificationResult:
    """간단한 함수형 인터페이스"""
    verifier = VisualVerifier(project_dir, port)
    return verifier.verify(start_server=False)
