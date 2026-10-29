@echo off
rem overlay-native build script (see design doc section 3.2 / section 10; dual-arch since M3)
rem Output: bin\{injector.exe(x86), injector_x64.exe, overlay_hook_x86.dll, overlay_hook_x64.dll,
rem   d3d9host.exe(x86), d3d8host.exe(x86, D3D8 runtime is 32-bit only), d3d9host_x64.exe,
rem   d3d9_proxy.dll, d3d11_proxy.dll (x64 hijack proxies, deploy source of SC:R 5-piece set)}
rem NOTE: this file MUST be saved with CRLF line endings (batch parser breaks on LF, proven pitfall).
rem NOTE: keep all comments/echo pure ASCII (cmd misreads UTF-8 Chinese as GBK -> noise, proven pitfall).
rem Build notes (verified): cl must use /utf-8 (sources are UTF-8 no-BOM with Chinese comments);
rem /Fo intermediate dirs must pre-exist; imgui/d3d8 via /I third-party header paths;
rem hook DLL must link d3d11.lib dxgi.lib (DX11 backend/factory hooks, both arches since 2026-10-29);
rem imm32.lib (panel IME context mgmt) and user32/gdi32 come from source #pragma comment.

setlocal enabledelayedexpansion
set SCRIPT_DIR=%~dp0
set OUT_DIR=%SCRIPT_DIR%bin
set IMGUI=%SCRIPT_DIR%third_party\imgui

rem [1/5] locate MSVC vcvarsall (VS2022 Community first; quoted %%~E\* - paths with spaces break for /d)
set VCVARSALL=
for %%E in ("%ProgramFiles%\Microsoft Visual Studio\2022" "%ProgramFiles(x86)%\Microsoft Visual Studio\2022") do (
  for /d %%D in ("%%~E\*") do (
    if exist "%%~D\VC\Auxiliary\Build\vcvarsall.bat" set VCVARSALL=%%~D\VC\Auxiliary\Build\vcvarsall.bat
  )
)
if "%VCVARSALL%"=="" (
  echo [ERROR] vcvarsall.bat not found - VS2022 C++ workload required
  goto :fail
)
echo [1/5] MSVC: %VCVARSALL%
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

rem [2/5] x86 toolchain (32-bit legacy games primary target)
call "%VCVARSALL%" x86 >nul 2>&1
if errorlevel 1 goto :fail
if not exist "%SCRIPT_DIR%hook\x86" mkdir "%SCRIPT_DIR%hook\x86"
if not exist "%SCRIPT_DIR%injector\x86" mkdir "%SCRIPT_DIR%injector\x86"
if not exist "%SCRIPT_DIR%host\x86" mkdir "%SCRIPT_DIR%host\x86"

echo [2/5] overlay_hook_x86.dll (D3D9 + D3D8 + DX11 backend)...
cl /nologo /utf-8 /LD /MT /O2 /DNDEBUG /W3 /DUNICODE /D_UNICODE ^
  /I"%IMGUI%" /I"%IMGUI%\backends" /I"%SCRIPT_DIR%third_party\d3d8" ^
  "%SCRIPT_DIR%hook\overlay_hook.cpp" ^
  "%IMGUI%\imgui.cpp" ^
  "%IMGUI%\imgui_draw.cpp" ^
  "%IMGUI%\imgui_tables.cpp" ^
  "%IMGUI%\imgui_widgets.cpp" ^
  "%IMGUI%\backends\imgui_impl_dx9.cpp" ^
  "%IMGUI%\backends\imgui_impl_win32.cpp" ^
  "%IMGUI%\backends\imgui_impl_dx11.cpp" ^
  "%SCRIPT_DIR%hook\imgui_impl_d3d8.cpp" ^
  /Fe"%OUT_DIR%\overlay_hook_x86.dll" /Fo"%SCRIPT_DIR%hook\x86\\" /link /OUT:"%OUT_DIR%\overlay_hook_x86.dll" d3d11.lib dxgi.lib d3d9.lib user32.lib gdi32.lib imm32.lib
if errorlevel 1 goto :fail

echo [2/5] injector.exe (x86)...
cl /nologo /utf-8 /MT /O2 /W3 ^
  "%SCRIPT_DIR%injector\injector.cpp" ^
  /Fe"%OUT_DIR%\injector.exe" /Fo"%SCRIPT_DIR%injector\x86\\" /link /OUT:"%OUT_DIR%\injector.exe"
if errorlevel 1 goto :fail

echo [2/5] d3d9host.exe (x86 test host)...
cl /nologo /utf-8 /MT /O2 /W3 /DUNICODE /D_UNICODE ^
  "%SCRIPT_DIR%host\d3d9host.cpp" ^
  /Fe"%OUT_DIR%\d3d9host.exe" /Fo"%SCRIPT_DIR%host\x86\\" /link /OUT:"%OUT_DIR%\d3d9host.exe"
if errorlevel 1 goto :fail

echo [2/5] d3d8host.exe (x86 test host, D3D8 is 32-bit only)...
cl /nologo /utf-8 /MT /O2 /W3 /DUNICODE /D_UNICODE ^
  /I"%SCRIPT_DIR%third_party\d3d8" ^
  "%SCRIPT_DIR%host\d3d8host.cpp" ^
  /Fe"%OUT_DIR%\d3d8host.exe" /Fo"%SCRIPT_DIR%host\x86\\" /link /OUT:"%OUT_DIR%\d3d8host.exe"
if errorlevel 1 goto :fail

rem [3/5] x64 toolchain (64-bit games; no D3D8 x64 runtime - x64 DLL covers D3D9 + D3D11)
call "%VCVARSALL%" x64 >nul 2>&1
if errorlevel 1 goto :fail
if not exist "%SCRIPT_DIR%hook\x64" mkdir "%SCRIPT_DIR%hook\x64"
if not exist "%SCRIPT_DIR%injector\x64" mkdir "%SCRIPT_DIR%injector\x64"
if not exist "%SCRIPT_DIR%host\x64" mkdir "%SCRIPT_DIR%host\x64"
if not exist "%SCRIPT_DIR%proxy\x64" mkdir "%SCRIPT_DIR%proxy\x64"

echo [3/5] overlay_hook_x64.dll (D3D9 + D3D11)...
cl /nologo /utf-8 /LD /MT /O2 /DNDEBUG /W3 /DUNICODE /D_UNICODE ^
  /I"%IMGUI%" /I"%IMGUI%\backends" ^
  "%SCRIPT_DIR%hook\overlay_hook.cpp" ^
  "%IMGUI%\imgui.cpp" ^
  "%IMGUI%\imgui_draw.cpp" ^
  "%IMGUI%\imgui_tables.cpp" ^
  "%IMGUI%\imgui_widgets.cpp" ^
  "%IMGUI%\backends\imgui_impl_dx9.cpp" ^
  "%IMGUI%\backends\imgui_impl_win32.cpp" ^
  "%IMGUI%\backends\imgui_impl_dx11.cpp" ^
  /Fe"%OUT_DIR%\overlay_hook_x64.dll" /Fo"%SCRIPT_DIR%hook\x64\\" /link /OUT:"%OUT_DIR%\overlay_hook_x64.dll" d3d11.lib dxgi.lib user32.lib gdi32.lib imm32.lib
if errorlevel 1 goto :fail

echo [3/5] injector_x64.exe ...
cl /nologo /utf-8 /MT /O2 /W3 ^
  "%SCRIPT_DIR%injector\injector.cpp" ^
  /Fe"%OUT_DIR%\injector_x64.exe" /Fo"%SCRIPT_DIR%injector\x64\\" /link /OUT:"%OUT_DIR%\injector_x64.exe"
if errorlevel 1 goto :fail

echo [3/5] d3d9host_x64.exe (x64 test host)...
cl /nologo /utf-8 /MT /O2 /W3 /DUNICODE /D_UNICODE ^
  "%SCRIPT_DIR%host\d3d9host.cpp" ^
  /Fe"%OUT_DIR%\d3d9host_x64.exe" /Fo"%SCRIPT_DIR%host\x64\\" /link /OUT:"%OUT_DIR%\d3d9host_x64.exe"
if errorlevel 1 goto :fail

rem Hijack proxies (deploy source of SC:R 5-piece set, deployD3D9Hijack reads from bin):
rem all exports are source-level __declspec(dllexport) code forwards (with handoff).
rem WARNING: do NOT add /DEF here - d3d9_proxy.def forwarder entries override same-name code
rem exports (LNK4197 "using first specification" = def-forwarder wins), losing handoff kills
rem the SC:R in-frame panel (proven pitfall 2026-10-29).
echo [3/5] d3d9_proxy.dll (x64 proxy: code-level forwards + handoff)...
cl /nologo /utf-8 /LD /MT /O2 /DNDEBUG /W3 /DUNICODE /D_UNICODE ^
  "%SCRIPT_DIR%proxy\d3d9_proxy.cpp" ^
  /Fe"%OUT_DIR%\d3d9_proxy.dll" /Fo"%SCRIPT_DIR%proxy\x64\\" /link /OUT:"%OUT_DIR%\d3d9_proxy.dll"
if errorlevel 1 goto :fail

echo [3/5] d3d11_proxy.dll (x64 proxy: D3D11CreateDevice* signature forwards + handoff)...
cl /nologo /utf-8 /LD /MT /O2 /DNDEBUG /W3 /DUNICODE /D_UNICODE ^
  "%SCRIPT_DIR%proxy\d3d11_proxy.cpp" ^
  /Fe"%OUT_DIR%\d3d11_proxy.dll" /Fo"%SCRIPT_DIR%proxy\x64\\" /link /OUT:"%OUT_DIR%\d3d11_proxy.dll"
if errorlevel 1 goto :fail

rem [4/5] artifact integrity check (dual-arch + hijack proxy deploy sources; any missing = fail.
rem A single lost file once degraded the whole injection chain, 2026-10-29 proven lesson)
echo [4/5] artifact integrity check...
set MISS=0
for %%F in (overlay_hook_x86.dll overlay_hook_x64.dll injector.exe injector_x64.exe d3d9host.exe d3d8host.exe d3d9host_x64.exe d3d9_proxy.dll d3d11_proxy.dll) do (
  if not exist "%OUT_DIR%\%%F" (
    echo   [MISSING] %%F
    set MISS=1
  ) else (
    echo   [OK] %%F
  )
)
if "%MISS%"=="1" goto :fail

echo [5/5] all artifacts in: %OUT_DIR%
exit /b 0

:fail
echo [FAILED] build aborted
exit /b 1
