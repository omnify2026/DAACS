@echo off
setlocal
set ROOT=%~dp0..
set DAACS_DESKTOP=%ROOT%\DAACS\DAACS_OS\apps\desktop
echo Starting DAACS front (Tauri dev)...
cd /d "%DAACS_DESKTOP%"
call npm run dev
exit /b %errorlevel%
