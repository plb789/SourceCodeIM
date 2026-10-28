@echo off
rem overlay-native 编译脚本（docs/游戏内Overlay二期注入式设计.md §3.2；M3 起双架构）
rem 输出：bin\{injector.exe(x86), injector_x64.exe, overlay_hook_x86.dll, overlay_hook_x64.dll,
rem       d3d9host.exe(x86), d3d9host_x64.exe, d3d8host.exe(x86，D3D8 仅 32 位运行时)}
rem 注意：本文件必须保存为 CRLF 行尾（批处理解释器对 LF 会标签错乱，实测踩坑）
rem 编译要点（已验证）：cl 必须 /utf-8（源码为 UTF-8 无 BOM 中文注释，否则 GBK 误读吞代码结构）；
rem /Fo 中间目录必须预建；user32/gdi32 用 pragma 链接；imgui/d3d8 用 /I 指定第三方头路径

setlocal enabledelayedexpansion
set SCRIPT_DIR=%~dp0
set OUT_DIR=%SCRIPT_DIR%bin
set IMGUI=%SCRIPT_DIR%third_party\imgui

rem [1/5] 定位 MSVC vcvarsall（VS2022 Community 优先；注意 %%~E\* 必须带引号——路径含空格时 for /d 会按空格拆分导致找不到，实测踩坑）
set VCVARSALL=
for %%E in ("%ProgramFiles%\Microsoft Visual Studio\2022" "%ProgramFiles(x86)%\Microsoft Visual Studio\2022") do (
  for /d %%D in ("%%~E\*") do (
    if exist "%%~D\VC\Auxiliary\Build\vcvarsall.bat" set VCVARSALL=%%~D\VC\Auxiliary\Build\vcvarsall.bat
  )
)
if "%VCVARSALL%"=="" (
  echo [错误] 未找到 vcvarsall.bat，请确认已安装 VS2022 C++ 工作负载
  goto :fail
)
echo [1/5] MSVC: %VCVARSALL%
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

rem [2/5] x86 工具链（32 位老游戏主目标）
call "%VCVARSALL%" x86 >nul 2>&1
if errorlevel 1 goto :fail
if not exist "%SCRIPT_DIR%hook\x86" mkdir "%SCRIPT_DIR%hook\x86"
if not exist "%SCRIPT_DIR%injector\x86" mkdir "%SCRIPT_DIR%injector\x86"
if not exist "%SCRIPT_DIR%host\x86" mkdir "%SCRIPT_DIR%host\x86"

echo [2/5] 编译 overlay_hook_x86.dll（D3D9 + D3D8 适配层）...
cl /nologo /utf-8 /LD /MT /O2 /DNDEBUG /W3 /DUNICODE /D_UNICODE ^
  /I"%IMGUI%" /I"%IMGUI%\backends" /I"%SCRIPT_DIR%third_party\d3d8" ^
  "%SCRIPT_DIR%hook\overlay_hook.cpp" ^
  "%IMGUI%\imgui.cpp" ^
  "%IMGUI%\imgui_draw.cpp" ^
  "%IMGUI%\imgui_tables.cpp" ^
  "%IMGUI%\imgui_widgets.cpp" ^
  "%IMGUI%\backends\imgui_impl_dx9.cpp" ^
  "%IMGUI%\backends\imgui_impl_win32.cpp" ^
  "%SCRIPT_DIR%hook\imgui_impl_d3d8.cpp" ^
  /Fe"%OUT_DIR%\overlay_hook_x86.dll" /Fo"%SCRIPT_DIR%hook\x86\\" /link /OUT:"%OUT_DIR%\overlay_hook_x86.dll"
if errorlevel 1 goto :fail

echo [2/5] 编译 injector.exe（x86）...
cl /nologo /utf-8 /MT /O2 /W3 ^
  "%SCRIPT_DIR%injector\injector.cpp" ^
  /Fe"%OUT_DIR%\injector.exe" /Fo"%SCRIPT_DIR%injector\x86\\" /link /OUT:"%OUT_DIR%\injector.exe"
if errorlevel 1 goto :fail

echo [2/5] 编译 d3d9host.exe（x86 测试宿主）...
cl /nologo /utf-8 /MT /O2 /W3 /DUNICODE /D_UNICODE ^
  "%SCRIPT_DIR%host\d3d9host.cpp" ^
  /Fe"%OUT_DIR%\d3d9host.exe" /Fo"%SCRIPT_DIR%host\x86\\" /link /OUT:"%OUT_DIR%\d3d9host.exe"
if errorlevel 1 goto :fail

echo [2/5] 编译 d3d8host.exe（x86 测试宿主，D3D8 仅 32 位）...
cl /nologo /utf-8 /MT /O2 /W3 /DUNICODE /D_UNICODE ^
  /I"%SCRIPT_DIR%third_party\d3d8" ^
  "%SCRIPT_DIR%host\d3d8host.cpp" ^
  /Fe"%OUT_DIR%\d3d8host.exe" /Fo"%SCRIPT_DIR%host\x86\\" /link /OUT:"%OUT_DIR%\d3d8host.exe"
if errorlevel 1 goto :fail

rem [3/5] x64 工具链（64 位游戏；D3D8 无 x64 运行时——x64 DLL 只含 D3D9 适配）
call "%VCVARSALL%" x64 >nul 2>&1
if errorlevel 1 goto :fail
if not exist "%SCRIPT_DIR%hook\x64" mkdir "%SCRIPT_DIR%hook\x64"
if not exist "%SCRIPT_DIR%injector\x64" mkdir "%SCRIPT_DIR%injector\x64"
if not exist "%SCRIPT_DIR%host\x64" mkdir "%SCRIPT_DIR%host\x64"

echo [3/5] 编译 overlay_hook_x64.dll（D3D9 only）...
cl /nologo /utf-8 /LD /MT /O2 /DNDEBUG /W3 /DUNICODE /D_UNICODE ^
  /I"%IMGUI%" /I"%IMGUI%\backends" ^
  "%SCRIPT_DIR%hook\overlay_hook.cpp" ^
  "%IMGUI%\imgui.cpp" ^
  "%IMGUI%\imgui_draw.cpp" ^
  "%IMGUI%\imgui_tables.cpp" ^
  "%IMGUI%\imgui_widgets.cpp" ^
  "%IMGUI%\backends\imgui_impl_dx9.cpp" ^
  "%IMGUI%\backends\imgui_impl_win32.cpp" ^
  /Fe"%OUT_DIR%\overlay_hook_x64.dll" /Fo"%SCRIPT_DIR%hook\x64\\" /link /OUT:"%OUT_DIR%\overlay_hook_x64.dll"
if errorlevel 1 goto :fail

echo [3/5] 编译 injector_x64.exe ...
cl /nologo /utf-8 /MT /O2 /W3 ^
  "%SCRIPT_DIR%injector\injector.cpp" ^
  /Fe"%OUT_DIR%\injector_x64.exe" /Fo"%SCRIPT_DIR%injector\x64\\" /link /OUT:"%OUT_DIR%\injector_x64.exe"
if errorlevel 1 goto :fail

echo [3/5] 编译 d3d9host_x64.exe（x64 测试宿主）...
cl /nologo /utf-8 /MT /O2 /W3 /DUNICODE /D_UNICODE ^
  "%SCRIPT_DIR%host\d3d9host.cpp" ^
  /Fe"%OUT_DIR%\d3d9host_x64.exe" /Fo"%SCRIPT_DIR%host\x64\\" /link /OUT:"%OUT_DIR%\d3d9host_x64.exe"
if errorlevel 1 goto :fail

echo [OK] 产物输出：%OUT_DIR%
exit /b 0

:fail
echo [失败] 编译中止
exit /b 1
