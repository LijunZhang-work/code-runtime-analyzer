param(
  [Parameter(Mandatory = $true)][string]$DefaultVsix,
  [Parameter(Mandatory = $true)][string]$CompatibleVsix,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Read-ZipText($archive, [string]$entryName) {
  $entry = $archive.Entries | Where-Object FullName -eq $entryName
  if (-not $entry) { throw "VSIX 缺少文件：$entryName" }
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

foreach ($package in @(
  @{ Path = $DefaultVsix; Layout = 'default' },
  @{ Path = $CompatibleVsix; Layout = 'compatible' }
)) {
  if (-not (Test-Path -LiteralPath $package.Path)) { throw "找不到 VSIX：$($package.Path)" }
  $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $package.Path))
  try {
    $manifest = Read-ZipText $archive 'extension/package.json' | ConvertFrom-Json
    $compiled = Read-ZipText $archive 'extension/out/extension.js'
    $worker = $archive.Entries | Where-Object FullName -eq 'extension/backend/src/worker-server.mjs'
    $mcp = $archive.Entries | Where-Object FullName -eq 'extension/backend/src/mcp-server.mjs'
    if ($manifest.version -ne $ExpectedVersion) { throw "VSIX 版本错误：$($manifest.version)，预期 $ExpectedVersion" }
    $mode = $manifest.contributes.configuration.properties.'cppCsvDiagnostics.backendMode'
    if ($mode.default -ne 'auto') { throw 'VSIX 默认后台模式必须是 auto。' }
    if (-not $worker) { throw 'VSIX 缺少自带后台，未安装 EXE 时将无法自动回退。' }
    if ($mcp) { throw 'VSIX 不应混入单独安装的 MCP 服务。' }
    if ($compiled -notmatch 'retryBackendConnection') { throw 'VSIX 编译代码缺少后台自动重连。' }
    if ($compiled -match '健康检查仍未通过') { throw 'VSIX 仍包含旧版笼统健康检查错误。' }
    if ($package.Layout -eq 'default') {
      if ($manifest.engines.vscode -ne '^1.106.0' -or -not $manifest.contributes.viewsContainers.secondarySidebar) {
        throw '默认 VSIX 的版本要求或右侧栏布局不正确。'
      }
    } else {
      if ($manifest.engines.vscode -ne '^1.90.0' -or -not $manifest.contributes.viewsContainers.activitybar) {
        throw '兼容 VSIX 的版本要求或活动栏布局不正确。'
      }
    }
  } finally {
    $archive.Dispose()
  }
}

Write-Host '两个 VSIX 校验通过：默认自动连接、自带备用后台、无 MCP，且布局清单正确。' -ForegroundColor Green
