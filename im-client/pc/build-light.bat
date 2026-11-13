@echo off
rem ============================================
rem Lightweight incremental build script (stage 300)
rem Only produces app.asar for hot-update dispatch
rem Skips electron-builder (no Chromium, no NSIS) -> seconds, not minutes
rem Output: light-dist\app-update.zip (~40MB), upload to server
rem IMPORTANT: asar encryption is IDENTICAL to build.bat (same obfuscate.js pipeline)
rem ============================================
setlocal
cd /d "%~dp0"

echo [light-build] incremental hot-update package builder

rem ====== 1. full encryption pipeline (SAME as build.bat) ======
node obfuscate.js
if errorlevel 1 (
    echo [ERROR] obfuscate.js failed
    pause
    exit /b 1
)

rem ====== 2. Node.js script: filter files by package.json files + asar pack ======
node build-light.js
if errorlevel 1 (
    echo [ERROR] build-light.js failed
    pause
    exit /b 1
)

echo.
echo [DONE] Output: light-dist\
pause
endlocal
