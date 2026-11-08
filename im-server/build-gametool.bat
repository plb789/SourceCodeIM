@echo off
chcp 65001 >nul
title GamePatchTool gametool.exe 一键编译
cd /d "%~dp0"

echo ============================================
echo   GamePatchTool gametool.exe 一键编译
echo ============================================
echo.
echo 说明：编译补丁制作工具（源码 tools\gamepatch），产物直接落 bin\gametool.exe——
echo       与 im-server.exe 同目录，商户后台/管理后台「下载工具」即取即用，无需重启服务端。
echo.

if not exist "tools\gamepatch\main.go" goto nodir

rem [1/2] 编译（trimpath 去本机路径；-s -w 减小体积）
echo [1/2] 编译 gametool.exe（Windows amd64）...
go build -trimpath -ldflags "-s -w" -o bin\gametool.exe .\tools\gamepatch
if errorlevel 1 (
    echo.
    echo [错误] gametool.exe 编译失败，请检查上方报错
    echo        提示：需本机已安装 Go（与编译 im-server 同一套环境）
    pause
    exit /b 1
)
echo        OK: bin\gametool.exe

rem [2/2] 单元测试（diff/verify 核心逻辑回归；失败不阻断产物，仅提示）
echo.
echo [2/2] 运行单元测试...
go test .\tools\gamepatch -count=1
if errorlevel 1 (
    echo.
    echo [警告] 单元测试未通过：产物已生成但建议先排查再分发
) else (
    echo        测试通过
)

echo.
echo ============================================
echo   编译完成
echo ============================================
for %%F in ("bin\gametool.exe") do echo 产物: %~dp0bin\gametool.exe ^(%%~zF 字节^)
echo 部署：bin\gametool.exe 与 im-server.exe 同目录即为部署完成（下载接口按请求现读文件，
echo       覆盖后立即生效，无需重启 im-server；Linux 服务器同理放在其可执行文件旁）。
echo.
pause
exit /b 0

:nodir
echo.
echo [错误] 未找到源码目录（%cd%\tools\gamepatch）
pause
exit /b 1
