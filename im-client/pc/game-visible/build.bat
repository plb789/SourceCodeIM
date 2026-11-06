@echo off
rem =============================================================
rem  game-visible.exe one-click build (double-click to run)
rem  Source : game-visible.c (game window-visibility probe tool)
rem  Output : .\game-visible.exe (this folder; packed into
rem           resources/game-visible/ via package.json extraResources;
rem           main.js looks here in dev mode)
rem  Notes  : /MT static CRT (no runtime dependency), /utf-8 source.
rem           Edit game-visible.c then double-click this script.
rem =============================================================
setlocal
cd /d "%~dp0"

rem ---- locate Visual Studio via vswhere (Community/Professional/Build Tools) ----
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [ERROR] vswhere not found. Install Visual Studio 2022 or Build Tools with C++ workload first.
    pause
    exit /b 1
)
set "VSPATH="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH (
    echo [ERROR] Visual Studio with C++ toolchain not found ^(need "Desktop development with C++" workload^).
    pause
    exit /b 1
)
set "VCVARS=%VSPATH%\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
    echo [ERROR] vcvars64.bat not found: %VCVARS%
    pause
    exit /b 1
)
call "%VCVARS%" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] failed to init build environment
    pause
    exit /b 1
)

rem ---- build: x64 static CRT, size optimized; user32 for window enumeration ----
cl /nologo /utf-8 /O1 /MT /DUNICODE /D_UNICODE game-visible.c /Fe:game-visible.exe /Fo:game-visible.obj /link /OPT:REF /OPT:ICF user32.lib
if errorlevel 1 (
    echo [ERROR] build failed, see errors above
    pause
    exit /b 1
)
del /q game-visible.obj >nul 2>&1

echo [OK] build done: game-visible\game-visible.exe
pause
