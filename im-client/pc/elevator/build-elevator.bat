@echo off
rem ============================================
rem elevator.exe build script (IM client elevated launcher)
rem output: .\elevator.exe (x64 /MT static CRT, requireAdministrator manifest embedded)
rem deploy: copy to same dir as im-client.exe (im-client\bin\), point shortcuts to this launcher
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

if exist elevator.exe del elevator.exe
rc /nologo elevator.rc
if errorlevel 1 (
    echo [build] resource compile failed
    exit /b 1
)
cl /nologo /utf-8 /MT /EHsc /O2 /W3 elevator.c elevator.res /Fe:elevator.exe /link /SUBSYSTEM:WINDOWS user32.lib
if errorlevel 1 (
    echo [build] compile failed
    exit /b 1
)
echo [build] done: %~dp0elevator.exe
echo [build] deploy: copy to im-client.exe dir, point shortcuts to this launcher
endlocal
