param(
  [Parameter(Mandatory = $true)][string]$InstallerExe,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $InstallerExe)) { throw "找不到待测 EXE：$InstallerExe" }
if (-not $env:RUNNER_TEMP) { throw '这个脚本只允许在一次性的 CI Windows 环境中运行。' }

$installRoot = Join-Path $env:RUNNER_TEMP 'CodeRuntimeAnalyzer-clean-install'
$stateRoot = Join-Path $env:LOCALAPPDATA 'CodeRuntimeAnalyzer'
$startupShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Code Runtime Analyzer.lnk'
$extensionRoots = @(
  (Join-Path $env:USERPROFILE '.vscode\extensions'),
  (Join-Path $env:USERPROFILE '.vscode-insiders\extensions'),
  (Join-Path $env:USERPROFILE '.cursor\extensions')
)

function Get-EditorExtensionSnapshot {
  $snapshot = @()
  foreach ($root in $extensionRoots) {
    if (Test-Path -LiteralPath $root) {
      $snapshot += Get-ChildItem -LiteralPath $root -Force | ForEach-Object { "$root::$($_.Name)" }
    }
  }
  return @($snapshot | Sort-Object)
}

function Invoke-Installer([string]$filePath) {
  $process = Start-Process -FilePath $filePath -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "EXE 静默安装失败，退出码 $($process.ExitCode)" }
}

function Invoke-BundledLauncher([string]$action) {
  $node = Join-Path $installRoot 'runtime\node.exe'
  $launcher = Join-Path $installRoot 'backend\src\launcher.mjs'
  if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $launcher)) {
    throw '安装后缺少自带 Node.js 或后台启动器。'
  }
  $output = & $node $launcher $action --control
  if ($LASTEXITCODE -ne 0) { throw "后台操作失败：$action`n$output" }
  return ($output | Out-String).Trim()
}

function Assert-NoEditorPayload {
  $forbidden = @(Get-ChildItem -LiteralPath $installRoot -Recurse -Force | Where-Object {
    $_.Name -match '\.(vsix|tgz|vsixmanifest)$' -or
    $_.Name -eq 'mcp-server.mjs' -or
    ($_.PSIsContainer -and $_.Name -in @('extension', 'mcp-package'))
  })
  if ($forbidden.Count -gt 0) {
    throw "EXE 安装目录混入扩展或 MCP：$($forbidden.FullName -join '；')"
  }
}

$beforeExtensions = @(Get-EditorExtensionSnapshot)
$preferredPortBlocker = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 47831)
try {
  # Deliberately occupy the preferred port. A portable installation must still
  # start successfully and publish its actual address through service-state.json.
  $preferredPortBlocker.Start()
  if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
  Invoke-Installer $InstallerExe
  Assert-NoEditorPayload

  $nativeController = Join-Path $installRoot 'backend-control.exe'
  if (-not (Test-Path -LiteralPath $nativeController)) { throw '安装后缺少原生后台控制中心。' }
  if (@(Get-ChildItem -LiteralPath $installRoot -Recurse -Filter '*.vbs').Count -gt 0) {
    throw '安装目录仍然包含 VBS，后台控制中心没有彻底完成原生化。'
  }

  $stateFile = Join-Path $stateRoot 'service-state.json'
  if (-not (Test-Path -LiteralPath $stateFile)) { throw '安装后没有生成当前用户的后台连接记录。' }
  $serviceState = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  if (-not $serviceState.accessToken -or -not $serviceState.baseUrl) { throw '后台连接记录缺少实际地址或本机访问密钥。' }
  if ([int]$serviceState.port -eq 47831) { throw '首选端口已被占用，但后台没有自动选择其他端口。' }
  $health = Invoke-RestMethod -Uri "$($serviceState.baseUrl)/health" -Headers @{
    'x-code-runtime-analyzer-token' = $serviceState.accessToken
  } -TimeoutSec 10
  if ($health.product -ne 'code-runtime-analyzer' -or $health.version -ne $ExpectedVersion -or $health.apiVersion -ne '0.10') {
    throw "安装后的健康接口不匹配：$($health | ConvertTo-Json -Compress)"
  }

  $controllerTest = Start-Process -FilePath $nativeController -ArgumentList '--self-test' -Wait -PassThru
  if ($controllerTest.ExitCode -ne 0) {
    throw "原生后台控制中心无法调用已安装的后台，退出码 $($controllerTest.ExitCode)"
  }

  if (-not (Test-Path -LiteralPath $startupShortcut)) { throw "登录启动快捷方式不存在：$startupShortcut" }

  $diagnosticResult = Invoke-BundledLauncher 'export-diagnostics'
  $diagnosticPath = ($diagnosticResult -split '\|', 2)[1]
  if (-not $diagnosticPath -or -not (Test-Path -LiteralPath $diagnosticPath)) {
    throw "没有生成诊断报告：$diagnosticResult"
  }
  $diagnostic = Get-Content -LiteralPath $diagnosticPath -Raw | ConvertFrom-Json
  if ($diagnostic.overall -ne 'ready') { throw "诊断报告没有确认后台可用：$diagnosticResult" }

  # 再安装一次，模拟用户从同一安装位置升级或修复，后台必须仍能恢复。
  Invoke-Installer $InstallerExe
  $restartResult = Invoke-BundledLauncher 'restart'
  if ($restartResult -notmatch '^started\||^already-running\|') {
    throw "重复安装后后台没有恢复：$restartResult"
  }

  $afterExtensions = @(Get-EditorExtensionSnapshot)
  if (Compare-Object -ReferenceObject $beforeExtensions -DifferenceObject $afterExtensions) {
    throw 'EXE 安装前后编辑器扩展目录发生变化。'
  }

  $uninstaller = Join-Path $installRoot 'Uninstall.exe'
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "静默卸载失败，退出码 $($uninstall.ExitCode)" }
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $installRoot) { throw '卸载后安装目录仍然存在。' }

  $finalExtensions = @(Get-EditorExtensionSnapshot)
  if (Compare-Object -ReferenceObject $beforeExtensions -DifferenceObject $finalExtensions) {
    throw 'EXE 卸载前后编辑器扩展目录发生变化。'
  }

  Write-Host '全新 Windows 安装测试通过：安装、健康检查、诊断导出、重复安装、卸载均正常，且未触碰编辑器扩展。' -ForegroundColor Green
} finally {
  $preferredPortBlocker.Stop()
  if (Test-Path -LiteralPath (Join-Path $installRoot 'runtime\node.exe')) {
    Invoke-BundledLauncher 'stop' | Out-Null
  }
  Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
  if (Test-Path -LiteralPath $stateRoot) { Remove-Item -LiteralPath $stateRoot -Recurse -Force }
}
