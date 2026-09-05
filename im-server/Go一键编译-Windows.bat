@echo off
title Go im-server.exe
cd /d "%~dp0"

echo [1/1] im-server.exe...
go build -ldflags "-s -w" -o Bin\im-server.exe main.go
if %errorlevel% neq 0 (
    echo im-server.exe
    pause
    exit /b 1
)

echo.
echo ========================================
echo OK
echo - im-server.exe: %~dp0\Bin\im-server.exe
echo ========================================
pause
