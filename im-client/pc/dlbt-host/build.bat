@echo off
rem dlbt-host 构建脚本：固定 x86（DLBT.dll 为 32 位引擎，宿主必须同位数）
rem 产物：本目录 dlbt-host.exe（+ 运行时同目录 DLBT.dll 由部署脚本/手动拷贝）
setlocal
cd /d "%~dp0"

set VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat
if not exist "%VCVARS%" (
    echo [build] 未找到 vcvarsall.bat，请确认 VS2022 安装路径
    exit /b 1
)
call "%VCVARS%" x86 >nul
if errorlevel 1 (
    echo [build] x86 工具链初始化失败
    exit /b 1
)

cl /nologo /utf-8 /MT /EHsc /O2 /W3 main.cpp /Fe:dlbt-host.exe /link "..\dll\DLBT.lib"
if errorlevel 1 (
    echo [build] 编译失败
    exit /b 1
)
echo [build] 编译完成: %~dp0dlbt-host.exe
endlocal
