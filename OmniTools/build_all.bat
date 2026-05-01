@echo off
setlocal
set ROOT=%~dp0..
set TOOLS=%~dp0

echo ===== Omnify: build all (OmniUtilities, OmniLocalization, OmniAICore, AllVia core, DAACS desktop, DAACS backend) =====

echo.
echo [1/6] OmniUtilities...
cd /d "%ROOT%\OmniUtilities"
cargo build
if errorlevel 1 (echo Build failed: OmniUtilities & exit /b 1)

echo.
echo [2/6] OmniLocalization...
cd /d "%ROOT%\OmniLocalization"
cargo build
if errorlevel 1 (echo Build failed: OmniLocalization & exit /b 1)

echo.
echo [3/6] OmniAICore...
cd /d "%ROOT%\OmniAICore"
cargo build
if errorlevel 1 (echo Build failed: OmniAICore & exit /b 1)

echo.
echo [4/6] AllVia core...
cd /d "%ROOT%\AllVia\core"
cargo build
if errorlevel 1 (echo Build failed: AllVia core & exit /b 1)

echo.
echo [5/6] DAACS desktop (Tauri)...
cd /d "%ROOT%\DAACS\DAACS_OS\apps\desktop\src-tauri"
cargo build
if errorlevel 1 (echo Build failed: DAACS desktop & exit /b 1)

echo.
echo [6/6] DAACS backend...
cd /d "%ROOT%\DAACS\DAACS_OS\backend"
cargo build
if errorlevel 1 (echo Build failed: DAACS backend & exit /b 1)

echo.
echo ===== All builds succeeded =====
exit /b 0
