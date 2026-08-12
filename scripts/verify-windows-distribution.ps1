param(
  [Parameter(Mandatory = $true)][string]$DistributionRoot,
  [Parameter(Mandatory = $true)][string]$InstallerScript,
  [Parameter(Mandatory = $true)][string]$InstallerExe,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($requiredPath in @($DistributionRoot, $InstallerScript, $InstallerExe)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "发布校验找不到路径：$requiredPath"
  }
}

$installerSource = Get-Content -LiteralPath $InstallerScript -Raw
$forbiddenInstallerPatterns = @(
  'SEC_VSCODE',
  'FindVSCode',
  '--install-extension',
  '--uninstall-extension',
  'VSIX_NAME',
  'MUI_PAGE_COMPONENTS',
  'Section\s+/o'
)
foreach ($pattern in $forbiddenInstallerPatterns) {
  if ($installerSource -match $pattern) {
    throw "EXE 安装脚本仍包含被禁止的编辑器安装或可选组件逻辑：$pattern"
  }
}

foreach ($requiredPattern in @(
  '本安装程序只安装独立后台',
  '不会查找、安装、卸载或修改任何编辑器扩展',
  'SMSTARTUP\\\$\{PRODUCT_NAME\}\.lnk',
  'IfSilent install_result_done'
)) {
  if ($installerSource -notmatch $requiredPattern) {
    throw "EXE 安装脚本缺少通用安装保护：$requiredPattern"
  }
}

$files = @(Get-ChildItem -LiteralPath $DistributionRoot -Recurse -File)
$relativeFiles = @($files | ForEach-Object {
  [System.IO.Path]::GetRelativePath($DistributionRoot, $_.FullName).Replace('\', '/')
})
$forbiddenFiles = @($relativeFiles | Where-Object {
  $_ -match '(^|/)extension(/|$)' -or
  $_ -match '(^|/)mcp-package(/|$)' -or
  $_ -match 'mcp-server\.mjs$' -or
  $_ -match '\.(vsix|tgz|vsixmanifest)$' -or
  $_ -match '\.vbs$'
})
if ($forbiddenFiles.Count -gt 0) {
  throw "EXE 待打包目录混入了扩展或 MCP：$($forbiddenFiles -join '；')"
}

$requiredFiles = @(
  'runtime/node.exe',
  'backend/src/server.mjs',
  'backend/src/launcher.mjs',
  'backend/web-dist/index.html',
  'backend-control.exe',
  'distribution.json'
)
foreach ($requiredFile in $requiredFiles) {
  if ($relativeFiles -notcontains $requiredFile) {
    throw "EXE 待打包目录缺少必要文件：$requiredFile"
  }
}

$manifest = Get-Content -LiteralPath (Join-Path $DistributionRoot 'distribution.json') -Raw | ConvertFrom-Json
if ($manifest.product -ne 'code-runtime-analyzer' -or [string]$manifest.version -ne $ExpectedVersion) {
  throw "EXE 发布清单不匹配：product=$($manifest.product)，version=$($manifest.version)，预期=$ExpectedVersion"
}

$installerSize = (Get-Item -LiteralPath $InstallerExe).Length
if ($installerSize -lt 1MB) {
  throw "EXE 体积异常，可能没有包含自带运行环境：$installerSize bytes"
}

$controllerSize = (Get-Item -LiteralPath (Join-Path $DistributionRoot 'backend-control.exe')).Length
if ($controllerSize -lt 50KB -or $controllerSize -gt 5MB) {
  throw "原生后台控制中心体积异常：$controllerSize bytes"
}

Write-Host "Windows EXE 内容校验通过：包含原生后台控制中心，不含 VBS、扩展或 MCP。" -ForegroundColor Green
