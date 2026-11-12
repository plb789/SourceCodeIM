<#
.SYNOPSIS
    IM Overlay SDK - dual-arch packaging (x64 + Win32)

.DESCRIPTION
    1. Build IMOverlay.dll Release for both x64 and Win32
    2. Assemble SDK directory (dll/ + unity/ + ue5/ + docs/)
    3. Generate zip package in _sdk_release/

.USAGE
    powershell -ExecutionPolicy Bypass -File package-sdk.ps1
    powershell -ExecutionPolicy Bypass -File package-sdk.ps1 -SkipBuild
    powershell -ExecutionPolicy Bypass -File package-sdk.ps1 -Arch x64
    powershell -ExecutionPolicy Bypass -File package-sdk.ps1 -Arch Win32
#>

param(
    [switch]$SkipBuild,
    [string]$Arch = "Both"   # x64, Win64, Win32, Both
)
$Arch = $Arch.ToLower()
if ($Arch -eq "x64") { $Arch = "Win64" }
if ($Arch -notin @("Win64", "Win32", "Both")) { $Arch = "Both" }

$ErrorActionPreference = "Stop"

$RootDir    = Split-Path -Parent $PSScriptRoot
$SdkDir     = $PSScriptRoot
$DocsDir    = Join-Path $RootDir "docs\sdk"
$CMakePath  = "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"

$Version      = "1.0.0"
$PackageName  = "IMOverlay-SDK-v$Version-Win64"
$StagingDir   = Join-Path $RootDir "_sdk_release\$PackageName"
$OutputDir    = Join-Path $RootDir "_sdk_release"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " IM Overlay SDK v$Version Packaging ($Arch)" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# ============================================================
# Step 1: Build (both arches or selected)
# ============================================================
$arches = @()
if ($Arch -eq "Both") { $arches = @("Win64", "Win32") }
else { $arches = @($Arch) }

$DllMap = @{}  # arch -> { dll, lib }

foreach ($arch in $arches) {
    $ArchArg = if ($arch -eq "Win64") { "x64" } else { "Win32" }
    $BuildDir = Join-Path $SdkDir "dll\build\$arch"

    if (-not $SkipBuild) {
        Write-Host "[1/$($arches.Count)] Building $arch Release..." -ForegroundColor Yellow

        if (-not (Test-Path $CMakePath)) { Write-Error "CMake not found at $CMakePath"; exit 1 }

        # Configure if first time
        if (-not (Test-Path (Join-Path $BuildDir "IMOverlay.sln"))) {
            Write-Host "  Configuring..." -ForegroundColor Gray
            & $CMakePath -S (Join-Path $SdkDir "dll") -B $BuildDir -A $ArchArg
            if ($LASTEXITCODE -ne 0) { Write-Error "Configure failed for $arch"; exit 1 }
        }

        Write-Host "  Building..." -ForegroundColor Gray
        & $CMakePath --build $BuildDir --config Release
        if ($LASTEXITCODE -ne 0) { Write-Error "Build failed for $arch"; exit 1 }
        Write-Host "  OK" -ForegroundColor Green
    }

    $dllSrc = Join-Path $BuildDir "bin\AMD64\Release\IMOverlay.dll"
    $libSrc = Join-Path $BuildDir "lib\AMD64\Release\IMOverlay.lib"
    if (-not (Test-Path $dllSrc)) { Write-Error "IMOverlay.dll not found at $dllSrc"; exit 1 }

    $DllMap[$arch] = @{ dll = $dllSrc; lib = $libSrc }
    Write-Host "  $arch : $([math]::Round((Get-Item $dllSrc).Length/1KB,1)) KB" -ForegroundColor Gray
}

# ============================================================
# Step 2: Prepare staging
# ============================================================
Write-Host "[2/4] Preparing staging..." -ForegroundColor Yellow
if (Test-Path $StagingDir) { Remove-Item $StagingDir -Recurse -Force }
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDir  -Force | Out-Null

function Ensure-Dir($p) { if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null } }

# ============================================================
# Step 3: Assemble
# ============================================================
Write-Host "[3/4] Assembling SDK files..." -ForegroundColor Yellow

# --- dll/ core ---
Ensure-Dir (Join-Path $StagingDir "dll\renderer")
Ensure-Dir (Join-Path $StagingDir "dll\ui")

# Primary dll uses x64 (merchant common case), also include Win32 in a /lib subfolder
$x64Dll = if ($DllMap.ContainsKey("Win64")) { $DllMap["Win64"].dll } else { $DllMap["Win32"].dll }
$x64Lib = if ($DllMap.ContainsKey("Win64")) { $DllMap["Win64"].lib } else { $DllMap["Win32"].lib }

Copy-Item $x64Dll (Join-Path $StagingDir "dll\IMOverlay.dll") -Force
Copy-Item $x64Lib (Join-Path $StagingDir "dll\IMOverlay.lib") -Force
Copy-Item (Join-Path $SdkDir "dll\IMOverlay.h")      (Join-Path $StagingDir "dll\IMOverlay.h")      -Force
Copy-Item (Join-Path $SdkDir "dll\IMOverlay.cpp")    (Join-Path $StagingDir "dll\IMOverlay.cpp")    -Force
Copy-Item (Join-Path $SdkDir "dll\CMakeLists.txt")   (Join-Path $StagingDir "dll\CMakeLists.txt")   -Force
Copy-Item (Join-Path $SdkDir "dll\exports.def")      (Join-Path $StagingDir "dll\exports.def")      -Force
Copy-Item (Join-Path $SdkDir "dll\renderer\render_engine.h")   (Join-Path $StagingDir "dll\renderer\render_engine.h")   -Force
Copy-Item (Join-Path $SdkDir "dll\renderer\render_engine.cpp") (Join-Path $StagingDir "dll\renderer\render_engine.cpp") -Force
Copy-Item (Join-Path $SdkDir "dll\ui\ui_panels.h")   (Join-Path $StagingDir "dll\ui\ui_panels.h")   -Force
Copy-Item (Join-Path $SdkDir "dll\ui\ui_panels.cpp") (Join-Path $StagingDir "dll\ui\ui_panels.cpp") -Force

# If both arches built, put Win32 dll/lib in dll\lib\Win32\ for C++ merchants who need it
if ($DllMap.ContainsKey("Win32") -and $DllMap.ContainsKey("Win64")) {
    Ensure-Dir (Join-Path $StagingDir "dll\lib\Win32")
    Ensure-Dir (Join-Path $StagingDir "dll\lib\x64")
    Copy-Item $DllMap["Win64"].dll (Join-Path $StagingDir "dll\lib\x64\IMOverlay.dll") -Force
    Copy-Item $DllMap["Win64"].lib (Join-Path $StagingDir "dll\lib\x64\IMOverlay.lib") -Force
    Copy-Item $DllMap["Win32"].dll (Join-Path $StagingDir "dll\lib\Win32\IMOverlay.dll") -Force
    Copy-Item $DllMap["Win32"].lib (Join-Path $StagingDir "dll\lib\Win32\IMOverlay.lib") -Force
}

# --- unity/ ---
Ensure-Dir (Join-Path $StagingDir "unity\Plugins\x64")
Ensure-Dir (Join-Path $StagingDir "unity\Plugins\x86")
Ensure-Dir (Join-Path $StagingDir "unity\Runtime")
Ensure-Dir (Join-Path $StagingDir "unity\Editor")

Copy-Item $x64Dll (Join-Path $StagingDir "unity\Plugins\x64\IMOverlay.dll") -Force
# For Unity x86: use actual Win32 dll if built, otherwise copy x64
if ($DllMap.ContainsKey("Win32")) {
    Copy-Item $DllMap["Win32"].dll (Join-Path $StagingDir "unity\Plugins\x86\IMOverlay.dll") -Force
} else {
    Copy-Item $x64Dll (Join-Path $StagingDir "unity\Plugins\x86\IMOverlay.dll") -Force
}

Get-ChildItem (Join-Path $SdkDir "unity\Runtime") -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $StagingDir "unity\Runtime\$($_.Name)") -Force }
Get-ChildItem (Join-Path $SdkDir "unity\Editor")   -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $StagingDir "unity\Editor\$($_.Name)")   -Force }

# --- ue5/ ---
$ue5Src = Join-Path $SdkDir "ue5\Plugins\ImOverlay"
$ue5Dst = Join-Path $StagingDir "ue5\Plugins\ImOverlay"
Ensure-Dir (Join-Path $ue5Dst "Binaries\Win64")
Ensure-Dir (Join-Path $ue5Dst "Lib\Win64")
Ensure-Dir (Join-Path $ue5Dst "Include")

Copy-Item $x64Dll (Join-Path $ue5Dst "Binaries\Win64\IMOverlay.dll") -Force
Copy-Item $x64Lib (Join-Path $ue5Dst "Lib\Win64\IMOverlay.lib")      -Force
Copy-Item (Join-Path $SdkDir "dll\IMOverlay.h") (Join-Path $ue5Dst "Include\IMOverlay.h") -Force
Copy-Item (Join-Path $ue5Src "ImOverlay.uplugin") $ue5Dst -Force
Get-ChildItem (Join-Path $ue5Src "Source") -Recurse -File | Where-Object { $_.Extension -in ".h", ".cpp", ".cs" } | ForEach-Object {
    $rel = $_.FullName.Substring((Join-Path $ue5Src "Source").Length)
    $dstFile = Join-Path (Join-Path $ue5Dst "Source") $rel.TrimStart("\")
    $dstDir  = Split-Path -Parent $dstFile
    Ensure-Dir $dstDir
    Copy-Item $_.FullName $dstFile -Force
}

# --- docs/ ---
Ensure-Dir (Join-Path $StagingDir "docs")
Get-ChildItem $DocsDir -File -Filter "*.md" | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $StagingDir "docs\$($_.Name)") -Force
}

# --- SDK-Info.txt ---
$BuildTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$InfoLines = @(
    "IM Overlay SDK v$Version"
    "=========================="
    "Build Time  : $BuildTime"
    ""
    "Contents:"
    "  dll/          Core SDK"
    "  unity/        Unity wrapper"
    "  ue5/          UE 5 plugin"
    "  docs/         6 Markdown docs"
)
if ($DllMap.ContainsKey("Win32") -and $DllMap.ContainsKey("Win64")) {
    $InfoLines += @(
        ""
        "Architectures built:"
        "  [OK] x64  : $([math]::Round((Get-Item $DllMap['Win64'].dll).Length/1KB,1)) KB"
        "  [OK] Win32: $([math]::Round((Get-Item $DllMap['Win32'].dll).Length/1KB,1)) KB"
    )
}
$InfoLines | Set-Content -Path (Join-Path $StagingDir "SDK-Info.txt") -Encoding UTF8

Write-Host "  OK - assembly done" -ForegroundColor Green

# ============================================================
# Step 4: zip
# ============================================================
Write-Host "[4/4] Creating zip..." -ForegroundColor Yellow
$ZipPath = Join-Path $OutputDir "$PackageName.zip"
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $StagingDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal

$ZipSize    = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)
$totalFiles = (Get-ChildItem $StagingDir -Recurse -File).Count

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " OK - Package generated" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Path  : $ZipPath" -ForegroundColor White
Write-Host "  Size  : $ZipSize MB" -ForegroundColor White
Write-Host "  Files : $totalFiles" -ForegroundColor White
Write-Host "  Arch  : $($arch -join '+')" -ForegroundColor White
