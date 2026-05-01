@echo off
setlocal
set ROOT=%~dp0..
set DAACS_OS=%ROOT%\DAACS\DAACS_OS
echo Starting DAACS backend (Docker)...
cd /d "%DAACS_OS%"
docker compose up -d
if errorlevel 1 exit /b 1
echo Backend stack is up. Check with: docker compose ps
exit /b 0
