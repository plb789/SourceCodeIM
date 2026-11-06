@echo off
setlocal
cd /d "%~dp0"

set VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat
if not exist "%VCVARS%" (
    echo [build] vcvarsall.bat not found
    exit /b 1
)
call "%VCVARS%" x86 >nul
if errorlevel 1 (
    echo [build] x86 toolchain init failed
    exit /b 1
)

cl /nologo /utf-8 /MT /EHsc /O2 /W3 main.cpp /Fe:dlbt-host.exe /link "..\dll\DLBT.lib"
if errorlevel 1 (
    echo [build] compile failed
    exit /b 1
)
echo [build] done: dlbt-host.exe
endlocal
