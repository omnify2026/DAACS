"""
DAACS Unit Tests - Orchestrator Verification
검증 로직 단위 테스트
"""
import os
import tempfile
import pytest
from daacs.orchestrator.verification import ActionVerifier, verify_action


class TestActionVerifier:
    """ActionVerifier 클래스 테스트"""
    
    def test_verify_empty_action(self):
        """빈 verify 목록 테스트"""
        verifier = ActionVerifier(".")
        result = verifier.verify({"verify": []}, "success")
        
        assert result["success"] is True
        assert len(result["verdicts"]) == 0
    
    def test_verify_error_in_result(self):
        """결과에 error 포함 시 실패"""
        verifier = ActionVerifier(".")
        result = verifier.verify({"verify": []}, "Error: something failed")
        
        assert result["success"] is False
        assert any("error" in v["reason"] for v in result["verdicts"])
    
    def test_verify_exception_in_result(self):
        """결과에 exception 포함 시 실패"""
        verifier = ActionVerifier(".")
        result = verifier.verify({"verify": []}, "Exception occurred")
        
        assert result["success"] is False
    
    def test_verify_files_exist_success(self):
        """파일 존재 검증 성공"""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = os.path.join(tmpdir, "test.txt")
            with open(test_file, "w") as f:
                f.write("content")
            
            verifier = ActionVerifier(tmpdir)
            result = verifier.verify(
                {"verify": ["files_exist:test.txt"]},
                "success"
            )
            
            assert result["success"] is True
    
    def test_verify_files_exist_failure(self):
        """파일 존재 검증 실패"""
        with tempfile.TemporaryDirectory() as tmpdir:
            verifier = ActionVerifier(tmpdir)
            result = verifier.verify(
                {"verify": ["files_exist:nonexistent.txt"]},
                "success"
            )
            
            assert result["success"] is False
    
    def test_verify_files_not_empty_success(self):
        """파일 비어있지 않음 검증 성공"""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = os.path.join(tmpdir, "test.txt")
            with open(test_file, "w") as f:
                f.write("content")
            
            verifier = ActionVerifier(tmpdir)
            result = verifier.verify(
                {"verify": ["files_not_empty:test.txt"]},
                "success"
            )
            
            assert result["success"] is True
    
    def test_verify_files_not_empty_failure(self):
        """빈 파일 검증 실패"""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = os.path.join(tmpdir, "empty.txt")
            open(test_file, "w").close()
            
            verifier = ActionVerifier(tmpdir)
            result = verifier.verify(
                {"verify": ["files_not_empty:empty.txt"]},
                "success"
            )
            
            assert result["success"] is False
    
    def test_verify_tests_pass(self):
        """테스트 통과 검증"""
        verifier = ActionVerifier(".")
        
        # 성공 케이스
        result = verifier.verify(
            {"verify": ["tests_pass"]},
            "All tests passed successfully"
        )
        assert result["success"] is True
        
        # 실패 케이스
        result = verifier.verify(
            {"verify": ["tests_pass"]},
            "1 test failed"
        )
        assert result["success"] is False
    
    def test_verify_build_success(self):
        """빌드 성공 검증"""
        verifier = ActionVerifier(".")
        
        # 성공 케이스
        result = verifier.verify(
            {"verify": ["build_success"]},
            "Build completed successfully"
        )
        assert result["success"] is True
        
        # 실패 케이스
        result = verifier.verify(
            {"verify": ["build_success"]},
            "Build failed with errors"
        )
        assert result["success"] is False
    
    def test_verify_multiple_items(self):
        """다중 검증 항목"""
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "file1.txt"), "w") as f:
                f.write("content")
            
            verifier = ActionVerifier(tmpdir)
            result = verifier.verify(
                {"verify": ["files_exist:file1.txt", "files_exist:file2.txt"]},
                "success"
            )
            
            # file2.txt가 없으므로 실패
            assert result["success"] is False
            assert len(result["verdicts"]) == 2
    
    def test_unknown_verifier_ignored(self):
        """알 수 없는 검증 항목은 무시"""
        verifier = ActionVerifier(".")
        result = verifier.verify(
            {"verify": ["unknown_check"]},
            "success"
        )
        
        # 알 수 없는 검증은 ok=True로 처리
        assert result["success"] is True


class TestVerifyActionFunction:
    """verify_action 편의 함수 테스트"""
    
    def test_verify_action(self):
        """편의 함수 동작 테스트"""
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "test.py"), "w") as f:
                f.write("print('hello')")
            
            result = verify_action(
                {"verify": ["files_exist:test.py"]},
                "success",
                tmpdir
            )
            
            assert result["success"] is True
