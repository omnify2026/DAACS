@echo off
setlocal
set ROOT=%~dp0..
echo Building OmniAICore...
cd /d "%ROOT%\OmniAICore"
cargo build
if errorlevel 1 exit /b 1
echo Building OmniLocalization...
cd /d "%ROOT%\OmniLocalization"
cargo build
if errorlevel 1 exit /b 1
echo Done.
exit /b 0
