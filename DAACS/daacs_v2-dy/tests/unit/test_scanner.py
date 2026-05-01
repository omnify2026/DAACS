"""
DAACS Unit Tests - Orchestrator Scanner
프로젝트 스캐너 단위 테스트
"""
import os
import tempfile
import pytest
from daacs.orchestrator.scanner import ProjectScanner, scan_project, get_project_type


class TestProjectScanner:
    """ProjectScanner 클래스 테스트"""
    
    def test_scan_empty_directory(self):
        """빈 디렉토리 스캔 테스트"""
        with tempfile.TemporaryDirectory() as tmpdir:
            scanner = ProjectScanner(tmpdir)
            result = scanner.scan()
            
            assert "files" in result
            assert "key_files" in result
            assert len(result["files"]) == 0
            assert len(result["key_files"]) == 0
    
    def test_scan_with_files(self):
        """파일이 있는 디렉토리 스캔 테스트"""
        with tempfile.TemporaryDirectory() as tmpdir:
            # 테스트 파일 생성
            (open(os.path.join(tmpdir, "index.html"), "w")).close()
            (open(os.path.join(tmpdir, "app.js"), "w")).close()
            (open(os.path.join(tmpdir, "styles.css"), "w")).close()
            
            scanner = ProjectScanner(tmpdir)
            result = scanner.scan()
            
            assert len(result["files"]) == 3
            assert "index.html" in result["files"]
            assert "app.js" in result["files"]
    
    def test_scan_ignores_node_modules(self):
        """node_modules 디렉토리 무시 테스트"""
        with tempfile.TemporaryDirectory() as tmpdir:
            nm_dir = os.path.join(tmpdir, "node_modules")
            os.makedirs(nm_dir)
            (open(os.path.join(nm_dir, "package.json"), "w")).close()
            (open(os.path.join(tmpdir, "index.js"), "w")).close()
            
            scanner = ProjectScanner(tmpdir)
            result = scanner.scan()
            
            assert len(result["files"]) == 1
            assert "index.js" in result["files"]
    
    def test_scan_reads_key_files(self):
        """주요 파일 내용 읽기 테스트"""
        with tempfile.TemporaryDirectory() as tmpdir:
            pkg_path = os.path.join(tmpdir, "package.json")
            with open(pkg_path, "w") as f:
                f.write('{"name": "test-project", "version": "1.0.0"}')
            
            scanner = ProjectScanner(tmpdir)
            result = scanner.scan()
            
            assert "package.json" in result["key_files"]
            assert "test-project" in result["key_files"]["package.json"]
    
    def test_scan_max_files_limit(self):
        """최대 파일 수 제한 테스트"""
        with tempfile.TemporaryDirectory() as tmpdir:
            # 10개 파일 생성
            for i in range(10):
                (open(os.path.join(tmpdir, f"file{i}.txt"), "w")).close()
            
            scanner = ProjectScanner(tmpdir)
            result = scanner.scan(max_files=5)
            
            assert len(result["files"]) == 5


class TestGetProjectType:
    """프로젝트 타입 추론 테스트"""
    
    def test_detect_node_project(self):
        """Node.js 프로젝트 감지"""
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "package.json"), "w") as f:
                f.write('{"name": "test"}')
            
            assert get_project_type(tmpdir) == "node"
    
    def test_detect_react_project(self):
        """React 프로젝트 감지"""
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "package.json"), "w") as f:
                f.write('{"dependencies": {"react": "18.0.0"}}')
            
            assert get_project_type(tmpdir) == "react"
    
    def test_detect_vite_project(self):
        """Vite 프로젝트 감지"""
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "package.json"), "w") as f:
                f.write('{"devDependencies": {"vite": "5.0.0"}}')
            
            assert get_project_type(tmpdir) == "vite"
    
    def test_detect_python_project(self):
        """Python 프로젝트 감지"""
        with tempfile.TemporaryDirectory() as tmpdir:
            (open(os.path.join(tmpdir, "requirements.txt"), "w")).close()
            
            assert get_project_type(tmpdir) == "python"
    
    def test_detect_vanilla_project(self):
        """Vanilla HTML 프로젝트 감지"""
        with tempfile.TemporaryDirectory() as tmpdir:
            (open(os.path.join(tmpdir, "index.html"), "w")).close()
            
            assert get_project_type(tmpdir) == "vanilla"
    
    def test_unknown_project(self):
        """알 수 없는 프로젝트 타입"""
        with tempfile.TemporaryDirectory() as tmpdir:
            assert get_project_type(tmpdir) == "unknown"


class TestScanProjectFunction:
    """scan_project 편의 함수 테스트"""
    
    def test_scan_project(self):
        """편의 함수 동작 테스트"""
        with tempfile.TemporaryDirectory() as tmpdir:
            (open(os.path.join(tmpdir, "test.py"), "w")).close()
            
            result = scan_project(tmpdir)
            
            assert "files" in result
            assert "test.py" in result["files"]
