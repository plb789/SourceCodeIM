@echo off
chcp 65001 >nul
title 清理 Windows 图标缓存

:: ===== 校验管理员权限，无权限则自动提权 =====
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo 正在请求管理员权限，请在弹窗中点击"是"...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ==============================================
echo          Windows 图标缓存清理工具
echo ==============================================
echo 即将执行：
echo   1. 关闭资源管理器（桌面会短暂消失，属正常现象）
echo   2. 删除图标缓存 iconcache_*.db
echo   3. 删除缩略图缓存 thumbcache_*.db
echo   4. 重启资源管理器
echo.
set /p confirm=确认执行？(Y=执行 / 其他键取消)：
if /i not "%confirm%"=="Y" (
    echo 已取消操作。
    pause
    exit /b
)

echo.
echo [1/4] 正在关闭资源管理器...
taskkill /f /im explorer.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/4] 正在清理图标缓存...
del /f /q /a "%LocalAppData%\IconCache.db" >nul 2>&1
del /f /q /a "%LocalAppData%\Microsoft\Windows\Explorer\iconcache_*.db" >nul 2>&1

echo [3/4] 正在清理缩略图缓存...
del /f /q /a "%LocalAppData%\Microsoft\Windows\Explorer\thumbcache_*.db" >nul 2>&1

echo [4/4] 正在重启资源管理器...
start "" explorer.exe

echo.
echo ==============================================
echo 清理完成！桌面和任务栏图标将在几秒内重新加载。
echo.
echo 若任务栏固定图标仍显示默认图标，请按顺序排查：
echo   1. 右键任务栏该图标 - 取消固定，再重新固定一次
echo   2. 检查开始菜单快捷方式的图标路径是否有效
echo ==============================================
echo.
pause
