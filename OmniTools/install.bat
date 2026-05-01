@echo off
setlocal
set TOOLS=%~dp0
set ROOT=%~dp0..

if not exist "%TOOLS%AIRules.md" (
    echo Error: %TOOLS%AIRules.md not found.
    exit /b 1
)

copy /Y "%TOOLS%AIRules.md" "%ROOT%AIRules.md"
if errorlevel 1 (echo Copy failed. & exit /b 1)

echo Installed: %ROOT%AIRules.md
exit /b 0
