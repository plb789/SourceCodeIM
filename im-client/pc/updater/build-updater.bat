@echo off
rem ============================================
rem updater.exe build script (PC incremental hot-update guardian)
rem output: .\updater.exe (x64 /MT static CRT, asInvoker manifest embedded)
rem deploy: copy to im-client\resources\updater\updater.exe (extraResources)
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

if exist updater.exe del updater.exe
if exist updater.obj del updater.obj
if exist updater.res del updater.res

rc /nologo updater.rc
if errorlevel 1 (
    echo [build] resource compile failed
    exit /b 1
)

cl /nologo /utf-8 /MT /EHsc /O2 /W3 updater.c updater.res /Fe:updater.exe /link /SUBSYSTEM:WINDOWS psapi.lib shell32.lib
if errorlevel 1 (
    echo [build] compile failed
    exit /b 1
)

if exist updater.obj del updater.obj
if exist updater.res del updater.res

echo [build] done: %~dp0updater.exe
endlocal
