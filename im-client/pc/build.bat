@echo off
chcp 65001 >nul
setlocal
rem ============================================
rem 即时通讯 PC 端一键打包脚本（阶段三十七）
rem 流程：关闭旧进程 -> 安装依赖 -> electron-builder 打包 -> 部署到 im-client\bin\
rem 用法：双击运行，或在任意目录执行本脚本（路径均相对脚本所在目录，无硬编码）
rem ============================================

cd /d "%~dp0"

rem npmmirror 镜像加速（electron 与打包工具二进制下载）
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

set "BIN_DIR=%~dp0..\bin"
set "UNPACKED_DIR=%~dp0dist\win-unpacked"

rem 应用图标路径（可配置）：更换新图标只需改这一处，支持 ico/png 任意文件名与完整路径
rem NOTE: keep this icon in sync with main.js tray icon const
set "APP_ICON=%~dp064.ico"

echo [1/4] 检查 Node 环境...
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 20 或更高版本
    pause
    exit /b 1
)

echo [2/4] 安装依赖（首次较慢，之后秒级）...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
)

echo [3/4] 打包 win-unpacked...
call npx electron-builder --win --x64 --dir
if errorlevel 1 (
    echo [错误] 打包失败，请查看上方日志
    pause
    exit /b 1
)

rem 设置 exe 图标：electron-builder 配置跳过签名时图标编辑一并跳过，且其要求 ico 至少 256px；
rem rcedit 无尺寸限制，直接对打包产物改图标（APP_ICON 存在时执行，失败不阻断部署）
set "RCEDIT=%~dp0node_modules\rcedit\bin\rcedit-x64.exe"
if exist "%RCEDIT%" if exist "%APP_ICON%" (
    echo 设置 exe 图标为 %APP_ICON% ...
    "%RCEDIT%" "%UNPACKED_DIR%\即时通讯.exe" --set-icon "%APP_ICON%"
    if errorlevel 1 echo [警告] exe 图标设置失败，将继续部署（图标保持默认）
)

echo [4/4] 部署到 im-client\bin ...
rem 先关闭正在运行的客户端，避免 exe 被占用导致清理失败（进程不存在时静默跳过）
rem /T 必须加：MCP/Computer Use 子进程继承主进程工作目录（bin），只杀主进程会残留子进程继续锁住 bin
taskkill /f /t /im im-client.exe >nul 2>nul
rem 删除旧 bin：杀毒软件对新 exe 的瞬时扫描锁可能导致单次删除失败，最多重试 5 次
set /a TRY=0
:RETRY_DEL
if not exist "%BIN_DIR%" goto DEL_OK
set /a TRY+=1
if %TRY% gtr 5 goto DEL_CHECK
timeout /t 1 /nobreak >nul
rd /s /q "%BIN_DIR%" >nul 2>nul
goto RETRY_DEL
:DEL_CHECK
rem 原实现：重试超限直接报错退出。实测目录删不掉分两种情况：
rem   1) 仅被其他进程"当前工作目录"锁定（如记事本曾在 bin 下打开过文件）——目录本身删不掉但文件不占用，
rem      先清空目录内文件再继续部署（xcopy 覆盖写入不受目录锁影响，目录保留不影响使用）
rem   2) 旧 exe 等文件仍被进程真正占用——文件删不掉、目录非空，强行部署会失败，须报错提醒
del /f /q "%BIN_DIR%\*" >nul 2>nul
for /d %%D in ("%BIN_DIR%\*") do rd /s /q "%%D" >nul 2>nul
dir /b "%BIN_DIR%" 2>nul | findstr . >nul
if errorlevel 1 (
    echo [提示] 旧 bin 目录被其他进程的工作目录占用，已清空内容并继续部署（目录保留不影响使用）
    goto DEL_OK
)
echo [错误] 旧 bin 目录内文件被占用无法清理，请关闭 im-client.exe 后重试
pause
exit /b 1
:DEL_OK
if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
xcopy "%UNPACKED_DIR%\*" "%BIN_DIR%\" /e /y /q >nul
ren "%BIN_DIR%\即时通讯.exe" "im-client.exe"
if not exist "%BIN_DIR%\im-client.exe" (
    echo [错误] 部署失败，请检查 %BIN_DIR% 目录
    pause
    exit /b 1
)

echo.
echo [完成] 已生成 im-client\bin\im-client.exe（含最新主进程与 preload）
echo.
pause
