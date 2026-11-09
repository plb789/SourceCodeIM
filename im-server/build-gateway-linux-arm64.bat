@echo off
chcp 65001 >nul
title im-gateway Linux ARM64 Build
setlocal
cd /d "%~dp0"

echo ============================================
echo   im-gateway Linux ARM64 Build
echo ============================================
echo.
echo  Desc: Cross-compile Linux ARM64 gateway (gateway\ source).
echo        Static (CGO_ENABLED=0). Upload + chmod +x to deploy.

set "CGO_ENABLED=0"
set "GOOS=linux"
set "GOARCH=arm64"

where go >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] go not found in PATH
    pause
    exit /b 1
)
if not exist "gateway\main.go" goto nodir

set "OUT=bin\im-gateway-linux-arm64"

echo.
echo [1/1] Cross-compile Linux ARM64 gateway...
go build -trimpath -ldflags "-s -w" -o "%OUT%" .\gateway
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed. See above.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Build Done
echo ============================================
for %%F in ("%OUT%") do echo Output: %~dp0%OUT%  ^(%%~zF bytes^)
echo.
echo Deploy: upload im-gateway-linux-arm64 to server,
echo         chmod +x, put gateway.yaml alongside, then run.
echo.
pause
exit /b 0

:nodir
echo.
echo [ERROR] gateway\ source dir not found
pause
exit /b 1
