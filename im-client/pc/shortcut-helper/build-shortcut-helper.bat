@echo off
rem ============================================
rem shortcut-helper.exe build script (IM client shortcut helper)
rem output: .\shortcut-helper.exe (x64 /MT static CRT, no manifest needed)
rem deploy: copy to im-client.exe dir, electron-builder extraResources packs exe only
rem ============================================
cd /d "%~dp0"

set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
if not exist "%VCVARS%" (
    echo [build] vcvarsall.bat not found, check VS2022 install path
    exit /b 1
)
call "%VCVARS%" x64 >nul
if errorlevel 1 (
    echo [build] x64 toolchain init failed
    exit /b 1
)

if exist shortcut-helper.exe del shortcut-helper.exe
if exist shortcut-helper.obj del shortcut-helper.obj

cl /nologo /utf-8 /MT /O2 /W3 shortcut-helper.c ^
    /Fe:shortcut-helper.exe ^
    /link /SUBSYSTEM:CONSOLE ole32.lib shell32.lib user32.lib
if errorlevel 1 (
    echo [build] compile failed
    exit /b 1
)

echo [build] done: %~dp0shortcut-helper.exe
exit /b 0
