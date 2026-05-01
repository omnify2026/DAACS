@echo off
setlocal
set ROOT=%~dp0..
set DAACS_ROOT=%ROOT%\DAACS
set DAACS_BACKEND=%DAACS_ROOT%\DAACS_OS\backend
set DAACS_DESKTOP=%DAACS_ROOT%\DAACS_OS\apps\desktop

echo Building DAACS backend...
cd /d "%DAACS_BACKEND%"
cargo build
if errorlevel 1 exit /b 1

echo Building DAACS desktop...
cd /d "%DAACS_DESKTOP%"
call npm run build
if errorlevel 1 exit /b 1

echo Done.
exit /b 0
