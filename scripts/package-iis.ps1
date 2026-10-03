<#
.SYNOPSIS
  Builds GitDiagram and zips the standalone output for the IIS host.

.DESCRIPTION
  Runs `bun run build`, copies public and .next/static into .next/standalone,
  adds deploy/iis/web.config and the App_Data/logs folder, strips every .env*
  file, checks that server.js and the ffmpeg binary are present, and writes
  artifacts/gitdiagram-iis-<yyyyMMdd-HHmm>.zip. Makes no network calls beyond
  what the build does.

.PARAMETER SkipBuild
  Reuse an existing .next/standalone folder instead of building.

.EXAMPLE
  bun run package:iis
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# ffmpeg-static ships the build machine's binary, so build on Windows x64.
$onWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
if (-not $onWindows -or -not [System.Environment]::Is64BitOperatingSystem) {
  throw 'Package on Windows x64: the ffmpeg binary in the package is the build machine binary.'
}

$nodeVersion = (& node --version).Trim().TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -ne 24 -and $nodeMajor -ne 25) {
  throw "Node 24 or 25 is required (found $nodeVersion)."
}

if (-not $SkipBuild) {
  Write-Host 'Building...'
  & bun run build
  if ($LASTEXITCODE -ne 0) {
    throw "bun run build failed with exit code $LASTEXITCODE."
  }
}

$standalone = Join-Path $repoRoot '.next/standalone'
if (-not (Test-Path (Join-Path $standalone 'server.js'))) {
  throw 'The build produced no .next/standalone/server.js.'
}

Copy-Item -Path (Join-Path $repoRoot 'public') -Destination (Join-Path $standalone 'public') -Recurse -Force

$staticTarget = Join-Path $standalone '.next/static'
New-Item -ItemType Directory -Force -Path $staticTarget | Out-Null
Copy-Item -Path (Join-Path $repoRoot '.next/static/*') -Destination $staticTarget -Recurse -Force

Copy-Item -Path (Join-Path $repoRoot 'deploy/iis/web.config') -Destination (Join-Path $standalone 'web.config') -Force

$logs = Join-Path $standalone 'App_Data/logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $logs '.keep') | Out-Null

# Standalone output can copy .env files; the package must hold none.
Get-ChildItem -Path $standalone -Recurse -Force -File -Filter '.env*' |
  Remove-Item -Force
$leftovers = @(Get-ChildItem -Path $standalone -Recurse -Force -File -Filter '.env*')
if ($leftovers.Count -gt 0) {
  throw "Found .env files in the package: $($leftovers.FullName -join ', ')"
}

# The bundles hold the server code; raw sources (and their tests) mean the
# tracing excludes in next.config.js stopped working.
$sources = Join-Path $standalone 'src'
if (Test-Path $sources) {
  throw "The package holds project sources ($sources). Check outputFileTracingExcludes in next.config.js."
}

$ffmpeg = Join-Path $standalone 'node_modules/ffmpeg-static/ffmpeg.exe'
foreach ($required in @((Join-Path $standalone 'server.js'), $ffmpeg)) {
  if (-not (Test-Path $required)) {
    throw "Missing from the package: $required"
  }
}

$artifacts = Join-Path $repoRoot 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$zip = Join-Path $artifacts ("gitdiagram-iis-{0}.zip" -f (Get-Date -Format 'yyyyMMdd-HHmm'))
if (Test-Path $zip) {
  Remove-Item -Force $zip
}

# -Path with a wildcard keeps dot folders (.next) and avoids a top-level folder.
Compress-Archive -Path (Join-Path $standalone '*') -DestinationPath $zip -CompressionLevel Optimal

$sizeMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Package: $zip ($sizeMb MB)"
