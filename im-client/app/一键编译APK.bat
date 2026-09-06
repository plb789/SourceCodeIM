@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM 即时通讯手机版一键编译脚本（Capacitor + Gradle）
REM 用法：双击运行，或在任意位置执行本脚本
REM 产物：im-client/app/bin/im-client.apk（已签名 Release 包）
REM ============================================================

REM 切换到脚本所在目录（im-client/app），支持从任意位置调用
cd /d "%~dp0"

REM JDK 17 随工程免安装存放（tools 目录，相对路径不硬编码）
if not exist "tools\jdk-17.0.20.1+1\bin\java.exe" (
    echo [错误] 未找到 JDK 17：tools\jdk-17.0.20.1+1
    echo 请确认 im-client\app\tools 目录完整。
    goto :fail
)
set "JAVA_HOME=%~dp0tools\jdk-17.0.20.1+1"
set "PATH=%JAVA_HOME%\bin;%PATH%"

echo.
echo [1/3] 同步前端资源到 Android 工程（im-client/web -^> android）...
call npx cap sync android
if errorlevel 1 (
    echo [错误] 前端资源同步失败，请检查上方错误信息。
    goto :fail
)

echo.
echo [2/3] 编译 Release APK（首次编译需下载依赖，耗时较长）...
cd /d "%~dp0android"
call gradlew.bat assembleRelease --no-daemon
if errorlevel 1 (
    echo [错误] APK 编译失败，请检查上方错误信息。
    goto :fail
)

echo.
echo [3/3] 复制 APK 到发布目录...
cd /d "%~dp0"
if not exist "bin" mkdir "bin"
copy /y "android\app\build\outputs\apk\release\app-release.apk" "bin\im-client.apk" >nul
if errorlevel 1 (
    echo [错误] APK 复制失败。
    goto :fail
)

echo.
echo ============================================================
echo 编译成功！产物位置：%~dp0bin\im-client.apk
echo ============================================================
goto :end

:fail
echo.
echo 编译失败，请按上方错误信息排查后重试。
pause
exit /b 1

:end
pause
exit /b 0
