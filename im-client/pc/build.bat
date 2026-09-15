@echo off
chcp 936 >nul
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

rem 阶段一百二十一：electron-builder 缓存重定向到 builder-cache\
rem 原因：signAndEditExecutable 开启后需 winCodeSign 工具包，其官方 7z 内含 macOS 符号链接，
rem Windows 下 7za 创建符号链接需管理员/开发者模式特权，否则解压必败导致整体打包失败。
rem builder-cache 为预置缓存（winCodeSign 已剔除 darwin 目录，rcedit 仅 Windows 需要；nsis 复用本机缓存）
set "ELECTRON_BUILDER_CACHE=%~dp0builder-cache"

set "BIN_DIR=%~dp0..\bin"
set "UNPACKED_DIR=%~dp0dist\win-unpacked"

rem 应用图标路径（可配置）：更换新图标只需改这一处，支持 ico/png 任意文件名与完整路径
rem NOTE: keep this icon in sync with main.js tray icon const
set "APP_ICON=%~dp064.ico"

echo [1/8] 检查 Node 环境...
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 20 或更高版本
    pause
    exit /b 1
)

echo [2/8] 安装依赖（首次较慢，之后秒级）...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
)

echo [3/8] 准备便携 Node 运行时（bundled\ 内无 zip 则下载缓存，仅首次 34.5MB）...
rem 阶段一百一十八：内嵌便携 Node 到安装包（TRAE CN 同款 bundled 运行时机制，离线可用）——
rem electron-builder 经 package.json extraResources 将 zip 复制为 resources\node-runtime.zip，
rem 客户端 node-runtime.js 优先解压本地 zip，缺失时才联网下载
if not exist "%~dp0bundled\node-v24.14.0-win-x64.zip" (
    if not exist "%~dp0bundled" mkdir "%~dp0bundled"
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://registry.npmmirror.com/-/binary/node/v24.14.0/node-v24.14.0-win-x64.zip' -OutFile '%~dp0bundled\node-v24.14.0-win-x64.zip' -UseBasicParsing"
    if not exist "%~dp0bundled\node-v24.14.0-win-x64.zip" (
        echo [警告] 便携 Node 运行时下载失败，本次打包将不含内嵌运行时（客户端联网场景自动降级为在线下载）
    ) else (
        echo 便携 Node 运行时已缓存到 bundled\
    )
) else (
    echo 便携 Node 运行时已存在（bundled\ 缓存）
)

echo [4/8] 准备 uv 工具链（bundled\ 内无 zip 则下载缓存，仅首次约 17MB）...
rem 阶段一百一十九：内嵌 uv 工具链到安装包（与便携 Node 同款双通道机制，离线可用）——
rem fetch/sqlite 等 Python 系 MCP 插件依赖 uvx 命令，客户端优先解压本地 zip，缺失时才联网下载
if not exist "%~dp0bundled\uv-runtime.zip" (
    if not exist "%~dp0bundled" mkdir "%~dp0bundled"
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile '%~dp0bundled\uv-runtime.zip' -UseBasicParsing"
    if not exist "%~dp0bundled\uv-runtime.zip" (
        echo [警告] uv 工具链 zip 下载失败，本次打包将不含内嵌 uv 工具链（客户端联网场景自动降级为在线下载）
    ) else (
        echo uv 工具链 zip 已缓存到 bundled\
    )
) else (
    echo uv 工具链 zip 已存在（bundled\ 缓存）
)

echo [5/8] JS 混淆打包（TRAE CN 同款：esbuild 压缩+变量名混淆，输出 bundled\web-obfuscated）...
rem 阶段一百二十三：对 im-client\web\js 自研代码逐文件 esbuild transform（minify+mangle，
rem 不改模块结构与全局名，跨文件全局通信不受影响），lib 第三方库与 html/css/图片等原样复制；
rem 同时生成 snapshot-manifest.json（源文件 size/mtime 清单），客户端增量同步按源属性比对，
rem 保证出厂快照与服务端清单一致（首启 0 下载）。失败即中止打包（产物不完整不如明确报错）
node obfuscate.js
if errorlevel 1 (
    echo [ERROR] JS 混淆失败，请检查 obfuscate.js 输出与 im-client\web\js 源码语法
    pause
    exit /b 1
)

echo [6/8] 生成 PC 客户端网页资源快照（来自混淆产物 web-obfuscated）...
rem 阶段一百二十二：快照经 package.json extraResources 嵌入 resources\web-snapshot，
rem 客户端 http 协议三级回退（增量缓存 - 快照 - 服务端代理），首次启动页面即秒开。
rem robocopy 退出码 0~7 均为成功（1=有复制、3=复制+跳过等），仅 >=8 判定失败
robocopy "%~dp0bundled\web-obfuscated" "%~dp0bundled\web-snapshot" /MIR /XD static /XF *.zip /NFL /NDL /NJH /NJS /NP
if errorlevel 8 (
    echo [ERROR] 网页资源快照生成失败，请检查混淆输出 bundled\web-obfuscated
    pause
    exit /b 1
)
echo [7/8] 打包 win-unpacked...
call npx electron-builder --win --x64 --dir
if errorlevel 1 (
    echo [错误] 打包失败，请查看上方日志
    pause
    exit /b 1
)

rem 设置 exe 图标：electron-builder 配置跳过签名时图标编辑一并跳过，且其要求 ico 至少 256px；
rem rcedit 无尺寸限制，直接对打包产物改图标（APP_ICON 存在时执行，失败不阻断部署）
rem exe 名随 package.json productName：im-client（现）/ 即时通讯（旧），两者兼容探测
set "RCEDIT=%~dp0node_modules\rcedit\bin\rcedit-x64.exe"
set "PACKED_EXE=%UNPACKED_DIR%\im-client.exe"
if not exist "%PACKED_EXE%" set "PACKED_EXE=%UNPACKED_DIR%\即时通讯.exe"
rem 阶段一百二十一：文件说明/产品名称中文归口——electron-builder 打包时按 productName(=im-client)
rem 覆写这两项，此处打包后以 rcedit 覆写回中文；值取 package.json winExeMeta 单一事实源
rem （公司名 CompanyName 由 electron-builder 按 author.name 烘焙，无需 rcedit）
rem 批处理块级解析陷阱：括号块内 %VAR% 在块入口即展开，块内 set 后引用恒为旧值——
rem 故 for 提取必须放在块外执行，rcedit 调用留在块内读取已完成的变量
if exist "%RCEDIT%" if exist "%APP_ICON%" if exist "%PACKED_EXE%" (
    echo 设置 exe 图标与元数据 ...
    rem 阶段一百二十一：图标 + 文件说明/产品名称一步完成。必须经 PowerShell 通道：
    rem 批处理 for /f 捕获 node -p 输出的是 UTF-8 原始字节（与 chcp 无关），rcedit 写入版本资源后
    rem 资源管理器按 GBK 显示即成乱码；PowerShell 读取 JSON 后以 .NET Unicode 字符串直调 rcedit，
    rem 与控制台代码页完全解耦，中文恒正确
    powershell -NoProfile -Command "$m=(Get-Content -LiteralPath '%~dp0package.json' -Raw -Encoding UTF8 | ConvertFrom-Json).winExeMeta; if(-not $m){exit 2}; & '%RCEDIT%' '%PACKED_EXE%' --set-icon '%APP_ICON%' --set-version-string 'FileDescription' $m.fileDescription --set-version-string 'ProductName' $m.productName; exit $LASTEXITCODE"
    if errorlevel 1 echo [警告] exe 图标/元数据设置失败，将继续部署（保持默认）
)

rem 阶段一百一十九：uv 工具链 zip 直拷进打包产物 resources\（不走 electron-builder extraResources：
rem bundled 缺 zip 时 extraResources 会打包报错，直拷仅跳过内嵌、运行时降级在线下载），部署时随 resources 入 bin
if exist "%~dp0bundled\uv-runtime.zip" (
    copy /y "%~dp0bundled\uv-runtime.zip" "%UNPACKED_DIR%\resources\uv-runtime.zip" >nul
    echo uv 工具链 zip 已内嵌到 resources\
) else (
    echo [提示] bundled\uv-runtime.zip 不存在，本次打包不含内嵌 uv 工具链（客户端联网场景自动在线下载）
)

echo [8/8] 部署到 im-client\bin ...
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
rem productName=im-client 时产物拷入即 im-client.exe；旧中文 productName 产物需改名兼容
if exist "%BIN_DIR%\即时通讯.exe" ren "%BIN_DIR%\即时通讯.exe" "im-client.exe"
if not exist "%BIN_DIR%\im-client.exe" (
    echo [错误] 部署失败，请检查 %BIN_DIR% 目录
    pause
    exit /b 1
)

echo.
echo [完成] 已生成 im-client\bin\im-client.exe（含最新主进程与 preload）
echo.
pause
