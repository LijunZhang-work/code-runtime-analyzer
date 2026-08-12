param(
  [Parameter(Position = 0)]
  [ValidateSet('all', 'exe', 'extension', 'vsix', 'mcp')]
  [string]$Target = 'all',
  [switch]$SkipInstall,
  [switch]$RequireSigning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distributionDirectory = Join-Path $repositoryRoot 'dist'
$rootPackagePath = Join-Path $repositoryRoot 'package.json'
$rootPackage = [System.IO.File]::ReadAllText($rootPackagePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$version = [string]$rootPackage.version
$targetName = if ($Target -eq 'vsix') { 'extension' } else { $Target }
$buildExe = $targetName -in @('all', 'exe')
$buildExtension = $targetName -in @('all', 'extension')
$buildMcp = $targetName -in @('all', 'mcp')

function Invoke-Checked {
  param([string]$Command, [string[]]$Arguments)
  Write-Host "`n> $Command $($Arguments -join ' ')" -ForegroundColor Cyan
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

function Require-Command {
  param([string]$Name, [string]$Help)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "Missing $Name. $Help" }
  return $command.Source
}

function Find-MakeNsis {
  $fromPath = Get-Command 'makensis.exe' -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  $candidates = @(
    (Join-Path $repositoryRoot 'tools\nsis\makensis.exe'),
    (Join-Path $repositoryRoot 'tools\nsis\NSIS\makensis.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
    (Join-Path $env:ProgramFiles 'NSIS\makensis.exe')
  )
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Install-PortableNsis {
  $curl = Require-Command 'curl.exe' 'Windows 10/11 normally includes curl. Install curl or install NSIS manually.'
  $tar = Require-Command 'tar.exe' 'Windows 10/11 normally includes tar. Install tar or install NSIS manually.'
  $downloadDirectory = Join-Path $repositoryRoot 'build\downloads'
  $archive = Join-Path $downloadDirectory 'nsis-3.12-h0ddc74d_0.tar.bz2'
  $target = Join-Path $repositoryRoot 'tools\nsis'
  $url = 'https://anaconda.org/anaconda/nsis/3.12/download/win-64/nsis-3.12-h0ddc74d_0.tar.bz2'
  $expectedHash = '9c1dc50ce28154345f4bfded8438dde037f8f3222f061e7c687c6c045c47e11d'

  New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
  if (-not (Test-Path -LiteralPath $archive)) {
    Write-Host 'NSIS was not found. Downloading a pinned portable NSIS 3.12 package...' -ForegroundColor Yellow
    Invoke-Checked $curl @('-L', '--fail', '--retry', '2', '--max-time', '180', '--output', $archive, $url)
  }

  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "Portable NSIS checksum mismatch. Delete $archive and run the command again. Actual SHA256: $actualHash"
  }

  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Invoke-Checked $tar @('-xjf', $archive, '-C', $target)
  $makeNsis = Find-MakeNsis
  if (-not $makeNsis) { throw 'Portable NSIS was extracted, but makensis.exe is missing.' }
  return $makeNsis
}

function Find-Clangxx {
  if ($env:CLANGXX_PATH -and (Test-Path -LiteralPath $env:CLANGXX_PATH)) { return $env:CLANGXX_PATH }
  $fromPath = Get-Command 'clang++.exe' -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  return Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'tools') -Recurse -Filter 'clang++.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}

function Install-PortableLlvmMingw {
  $curl = Require-Command 'curl.exe' 'Windows 10/11 normally includes curl.'
  $downloadDirectory = Join-Path $repositoryRoot 'build\downloads'
  $archive = Join-Path $downloadDirectory 'llvm-mingw-20260519-ucrt-x86_64.zip'
  $target = Join-Path $repositoryRoot 'tools\llvm-mingw-20260519'
  $url = 'https://github.com/mstorsjo/llvm-mingw/releases/download/20260519/llvm-mingw-20260519-ucrt-x86_64.zip'
  $expectedHash = '72dbd6e64614e3b3401998992d1bd9c8ace29e74611d71c80309ea71c3fb26f9'
  New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
  if (-not (Test-Path -LiteralPath $archive)) {
    Write-Host 'The native control-center compiler was not found. Downloading the pinned portable LLVM-MinGW toolchain...' -ForegroundColor Yellow
    Invoke-Checked $curl @('-L', '--fail', '--retry', '2', '--max-time', '600', '--output', $archive, $url)
  }
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw "Portable LLVM-MinGW checksum mismatch: $actualHash" }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Expand-Archive -LiteralPath $archive -DestinationPath $target -Force
  $compiler = Find-Clangxx
  if (-not $compiler) { throw 'Portable LLVM-MinGW was extracted, but clang++.exe is missing.' }
  return $compiler
}

Set-Location $repositoryRoot
$env:npm_config_cache = Join-Path $repositoryRoot 'build\npm-cache'
$node = Require-Command 'node.exe' 'Install Node.js 20 or newer, then run the same command again.'
$npm = Require-Command 'npm.cmd' 'Install the full Node.js 20 or newer package that includes npm.'
$nodeVersion = (& $node -p 'process.versions.node').Trim()
if ([int]($nodeVersion.Split('.')[0]) -lt 20) { throw "Node.js $nodeVersion is too old. Version 20 or newer is required." }

New-Item -ItemType Directory -Path $distributionDirectory -Force | Out-Null
Write-Host "Code Runtime Analyzer $version - local build: $targetName" -ForegroundColor Green
if ($RequireSigning -and $buildExe -and -not $env:WINDOWS_CODE_SIGNING_THUMBPRINT) {
  throw '正式发布要求代码签名，但当前环境没有 WINDOWS_CODE_SIGNING_THUMBPRINT。'
}

$defaultVsixOutput = Join-Path $distributionDirectory "Code-Runtime-Analyzer-默认右侧栏-v$version.vsix"
$compatibleVsixOutput = Join-Path $distributionDirectory "Code-Runtime-Analyzer-兼容布局-v$version.vsix"
$legacyVsixOutput = Join-Path $distributionDirectory "Code-Runtime-Analyzer-v$version.vsix"
$exeOutput = Join-Path $distributionDirectory "Code-Runtime-Analyzer-Setup-v$version.exe"
$mcpOutput = Join-Path $distributionDirectory "Code-Runtime-Analyzer-MCP-v$version.tgz"

# A previous local build may have left the old single-VSIX name in dist.  It is
# no longer a valid choice now that layout compatibility is explicit, so do not
# let it appear beside the two current packages or enter the checksum file.
if ($buildExtension) {
  foreach ($oldOutput in @($defaultVsixOutput, $compatibleVsixOutput, $legacyVsixOutput)) {
    if (Test-Path -LiteralPath $oldOutput) { Remove-Item -LiteralPath $oldOutput -Force }
  }
}
if ($buildExe -and (Test-Path -LiteralPath $exeOutput)) { Remove-Item -LiteralPath $exeOutput -Force }
if ($buildMcp -and (Test-Path -LiteralPath $mcpOutput)) { Remove-Item -LiteralPath $mcpOutput -Force }

$makeNsis = if ($buildExe) { Find-MakeNsis } else { $null }
if ($buildExe -and -not $makeNsis) {
  $makeNsis = Install-PortableNsis
}
$clangxx = if ($buildExe) { Find-Clangxx } else { $null }
if ($buildExe -and -not $clangxx) { $clangxx = Install-PortableLlvmMingw }
if ($buildExe) { $env:CLANGXX_PATH = $clangxx }

if (-not $SkipInstall) {
  if ($buildExtension) { Invoke-Checked $npm @('--prefix', 'extension', 'ci') }
  if ($buildExe -or $buildExtension) { Invoke-Checked $npm @('--prefix', 'web', 'ci') }
}

if ($buildExe -or $buildExtension) {
  Invoke-Checked $npm @('--prefix', 'web', 'run', 'lint')
  Invoke-Checked $npm @('--prefix', 'web', 'run', 'build')
}

if ($buildExtension) {
  Invoke-Checked $npm @('--prefix', 'extension', 'run', 'package:all')
  & (Join-Path $repositoryRoot 'scripts\verify-vsix-packages.ps1') `
    -DefaultVsix $defaultVsixOutput `
    -CompatibleVsix $compatibleVsixOutput `
    -ExpectedVersion $version
}

if ($buildExe) {
  Invoke-Checked $node @('scripts/build-windows-controller.mjs')
  $signingScript = Join-Path $repositoryRoot 'scripts\sign-windows-artifact.ps1'
  if ($RequireSigning) {
    & $signingScript -FilePath (Join-Path $repositoryRoot 'build\controller\backend-control.exe')
  }
  Invoke-Checked $node @('scripts/prepare-windows-distribution.mjs')
  $sourceRoot = Join-Path $repositoryRoot 'build\distribution\windows'
  $nsisArguments = @('/INPUTCHARSET', 'UTF8', "/DAPP_VERSION=$version", "/DSOURCE_ROOT=$sourceRoot", "/DOUTPUT_DIR=$distributionDirectory")
  if ($RequireSigning) { $nsisArguments += "/DCODE_SIGNING_SCRIPT=$signingScript" }
  $nsisArguments += 'installer\windows\CodeRuntimeAnalyzer.nsi'
  Invoke-Checked $makeNsis $nsisArguments
  if ($RequireSigning) { & $signingScript -FilePath $exeOutput -VerifyOnly }
  & (Join-Path $repositoryRoot 'scripts\verify-windows-distribution.ps1') `
    -DistributionRoot $sourceRoot `
    -InstallerScript (Join-Path $repositoryRoot 'installer\windows\CodeRuntimeAnalyzer.nsi') `
    -InstallerExe $exeOutput `
    -ExpectedVersion $version
}

if ($buildMcp) {
  Invoke-Checked $node @('scripts/prepare-mcp-package.mjs')
  $mcpStaging = Join-Path $repositoryRoot 'build\mcp-package'
  Invoke-Checked $npm @('--prefix', $mcpStaging, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
  Invoke-Checked $npm @('pack', $mcpStaging, '--pack-destination', $distributionDirectory)
  $packed = Join-Path $distributionDirectory "code-runtime-analyzer-mcp-$version.tgz"
  if (-not (Test-Path -LiteralPath $packed)) { throw "MCP package was not created: $packed" }
  Move-Item -LiteralPath $packed -Destination $mcpOutput -Force
}

$artifactPaths = @()
if ($buildExtension) { $artifactPaths += @($defaultVsixOutput, $compatibleVsixOutput) }
if ($buildExe) { $artifactPaths += $exeOutput }
if ($buildMcp) { $artifactPaths += $mcpOutput }
$artifacts = @($artifactPaths | ForEach-Object {
  if (-not (Test-Path -LiteralPath $_)) { throw "Expected distributable package was not created: $_" }
  Get-Item -LiteralPath $_
} | Sort-Object Name)
$checksums = $artifacts | ForEach-Object {
  $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName
  "$($hash.Hash.ToLowerInvariant())  $($_.Name)"
}
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines((Join-Path $distributionDirectory 'SHA256SUMS.txt'), [string[]]$checksums, $utf8WithoutBom)

Write-Host "`nBuild completed. Files are in: $distributionDirectory" -ForegroundColor Green
$artifacts | ForEach-Object { Write-Host "  $($_.Name)" }
Write-Host '  SHA256SUMS.txt'
