@echo off
rem ==================================================
rem IM 服务端启动脚本
rem 说明：服务端必须从 im-server 根目录启动，
rem       静态文件托管与上传目录等相对路径依赖该工作目录
rem 用法：双击运行即可，无需关心当前目录
rem ==================================================
chcp 936 >nul

rem 切换到本脚本所在目录（即 im-server 根目录）
cd /d %~dp0

rem 检查可执行文件，不存在则自动编译
if not exist "bin\im-server.exe" (
    echo 未找到 bin\im-server.exe，正在编译服务端...
    go build -o bin\im-server.exe .
    if errorlevel 1 (
        echo 编译失败，请检查 Go 环境与依赖
        pause
        exit /b 1
    )
    echo 编译完成
)

echo 正在启动 IM 服务端（监听 :8888）...
echo 浏览器访问 http://127.0.0.1:8888
echo 按 Ctrl+C 可停止服务
bin\im-server.exe
pause
