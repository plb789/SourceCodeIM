@echo off
chcp 936 >nul
setlocal
rem ============================================
rem 即时通讯 PC 客户端（Windows 7 专用版）独立构建脚本
rem 特性：完全独立于现有构建——源码同步到本 win7 目录（源目录只读）、依赖在 win7 目录单独下载安装
rem       （Electron 22.3.27 / ia32 32 位）、产物输出到 im-client\bin32
rem 铁律：绝不写入 pc\、bin\、im-server\ 等任何现有目录，不影响现有客户端及其构建设定
rem 流程：同步源码 -> 生成 package.json -> 补丁(密钥只读) -> npm 安装 -> JS 混淆 -> electron-builder
rem       -> exe 图标元数据 -> 复制到 bin32 -> 32 位 PE 校验
rem ============================================

cd /d "%~dp0"

set "PC_DIR=%~dp0..\pc"
set "BIN32_DIR=%~dp0..\bin32"
set "UNPACKED_DIR=%~dp0dist\win-ia32-unpacked"
set "RCEDIT=%~dp0node_modules\rcedit\bin\rcedit-x64.exe"
set "APP_ICON=%~dp064.ico"

rem npmmirror 加速：Electron 22 与 electron-builder 二进制均走国内镜像（与主工程 build.bat 同款）
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "ELECTRON_BUILDER_CACHE=%~dp0builder-cache"

echo [1/8] 检查 Node 环境...
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 20 或更高版本
    pause
    exit /b 1
)

echo [2/8] 从 pc\ 只读同步源码到 win7 目录（不修改任何现有文件）...
if not exist "%PC_DIR%\package.json" (
    echo [错误] 未找到 %PC_DIR%\package.json ，请确认目录结构
    pause
    exit /b 1
)
robocopy "%PC_DIR%" "%~dp0." /E /NFL /NDL /NJH /NJS /NP ^
    /XD node_modules dist builder-cache bundled .git ^
    /XF *.enc *.log loader.min.js package-lock.json build.bat dev.bat double.bat publish-update.bat
if errorlevel 8 (
    echo [错误] 源码同步失败（robocopy 错误码 %errorlevel%）
    pause
    exit /b 1
)

echo [3/8] 生成 Win7 专用 package.json 与 obfuscate.js 只读补丁...
node gen-package.js
if errorlevel 1 (
    echo [错误] package.json 生成失败
    pause
    exit /b 1
)
node patch-obfuscate.js
if errorlevel 1 (
    echo [错误] obfuscate.js 补丁失败
    pause
    exit /b 1
)
node patch-main.js
if errorlevel 1 (
    echo [错误] Electron 22 兼容补丁失败
    pause
    exit /b 1
)

echo [4/8] 安装依赖（仅 win7 目录独立 node_modules，首次较慢）...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
)

echo [5/8] 复用主工程 builder-cache（只读复制，加速 winCodeSign 获取）...
if exist "%PC_DIR%\builder-cache" (
    robocopy "%PC_DIR%\builder-cache" "%~dp0builder-cache." /E /NFL /NDL /NJH /NJS /NP >nul
    echo builder-cache 已就绪
) else (
    echo 未找到主工程 builder-cache，electron-builder 将自动从镜像下载
)

echo [6/8] JS 混淆与加密打包（输出均在 win7 目录内）...
node obfuscate.js
if errorlevel 1 (
    echo [ERROR] JS 混淆失败，请检查 obfuscate.js 补丁或 im-client\web\js 源码语法
    pause
    exit /b 1
)

echo [7/8] electron-builder 打包（Electron 22.3.27 / ia32 / 未打包目录）...
call npx electron-builder --win --ia32 --dir
if errorlevel 1 (
    echo [错误] 打包失败，请查看上方日志
    pause
    exit /b 1
)

echo 修正 exe 图标与元数据...
if exist "%RCEDIT%" if exist "%APP_ICON%" if exist "%UNPACKED_DIR%\im-client.exe" (
    powershell -NoProfile -Command "$m=(Get-Content -LiteralPath '%~dp0package.json' -Raw -Encoding UTF8 | ConvertFrom-Json).winExeMeta; if(-not $m){exit 2}; & '%RCEDIT%' '%UNPACKED_DIR%\im-client.exe' --set-icon '%APP_ICON%' --set-version-string 'FileDescription' $m.fileDescription --set-version-string 'ProductName' $m.productName; exit $LASTEXITCODE"
    if errorlevel 1 echo [警告] exe 图标/元数据修正失败，不影响产物（沿用默认值）
) else (
    echo [提示] rcedit 或产物缺失，跳过图标修正
)

echo [8/8] 部署到 im-client\bin32 ...
if not exist "%BIN32_DIR%" mkdir "%BIN32_DIR%"
rem 清空旧产物（bin32 仅存放 Win7 版本；不触碰 bin\ 与运行中的正式客户端）
del /f /q "%BIN32_DIR%\*" >nul 2>nul
for /d %%D in ("%BIN32_DIR%\*") do rd /s /q "%%D" >nul 2>nul
xcopy "%UNPACKED_DIR%\*" "%BIN32_DIR%\" /e /y /q >nul
if not exist "%BIN32_DIR%\im-client.exe" (
    echo [错误] 部署失败：bin32\im-client.exe 未生成（若文件被占用请先关闭 bin32 测试客户端）
    pause
    exit /b 1
)

rem 校验产物为 32 位（i386）PE，可运行于 Win7 32/64 位系统
powershell -NoProfile -Command "$fs=[IO.File]::OpenRead('%BIN32_DIR%\im-client.exe'); $b=New-Object byte[] 4096; [void]$fs.Read($b,0,4096); $fs.Close(); $off=[BitConverter]::ToInt32($b,0x3C); $mach=[BitConverter]::ToUInt16($b,$off+4); if($mach -eq 0x14C){Write-Host '[OK] PE 校验通过：32 位 (i386)，支持 Windows 7 32/64 位'}else{Write-Host ('[警告] PE 架构异常: 0x{0:X4}' -f $mach)}"

echo.
echo [完成] Win7 客户端已生成：im-client\bin32\im-client.exe
echo        Electron 22.3.27 / ia32，支持 Windows 7 SP1 32/64 位
echo        正式客户端 im-client\bin 与现有构建设定完全未受影响
echo.
pause
