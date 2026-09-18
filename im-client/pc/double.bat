@echo off
chcp 936 >nul
setlocal
rem ============================================
rem 即时通讯 PC 客户端双实例启动脚本（阶段一百四十四：多账号并行测试）
rem 原理：单实例锁按 userData 路径区分——--user-data-dir 指向不同目录即视为不同实例，
rem       可同时运行两个客户端（各自独立登录态/缓存，用于会议等双端互测）
rem 注意：两实例必须各自独立 user-data-dir（同一目录并发写缓存 LevelDB 会崩溃，阶段一百三十四实测）
rem 用法：双击运行。想保留日常登录态时：实例 A 正常双击 im-client.exe（默认目录），
rem       仅实例 B 用本脚本第二段命令手动启动即可
rem ============================================

set "EXE=%~dp0..\bin\im-client.exe"
if not exist "%EXE%" (
    echo [错误] 未找到打包客户端：%EXE%
    echo 请先运行 build.bat 完成打包
    pause
    exit /b 1
)

echo [1/2] 启动实例 1（独立数据目录 user-data-1）...
start "" "%EXE%" --user-data-dir="%~dp0user-data-1"

rem 间隔 2 秒错开首窗口创建，避免启动竞态
timeout /t 2 /nobreak >nul

echo [2/2] 启动实例 2（独立数据目录 user-data-2）...
start "" "%EXE%" --user-data-dir="%~dp0user-data-2"

echo.
echo [完成] 两个实例已启动（user-data-1 / user-data-2 数据目录在 pc\ 下，可随时删除重置登录态）
pause
