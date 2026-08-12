param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [string]$CertificateThumbprint = $env:WINDOWS_CODE_SIGNING_THUMBPRINT,
  [string]$TimestampUrl = $env:WINDOWS_CODE_SIGNING_TIMESTAMP_URL,
  [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-SignTool {
  $fromPath = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (-not (Test-Path -LiteralPath $kitsRoot)) { throw 'Windows SDK SignTool was not found. Install the Windows 10/11 SDK.' }
  $candidate = Get-ChildItem -LiteralPath $kitsRoot -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object { try { [version]$_.Directory.Parent.Name } catch { [version]'0.0' } } -Descending |
    Select-Object -First 1
  if (-not $candidate) { throw 'The Windows SDK does not contain x64 signtool.exe.' }
  return $candidate.FullName
}

$resolvedFile = (Resolve-Path -LiteralPath $FilePath).Path
$signTool = Find-SignTool
if (-not $TimestampUrl) { $TimestampUrl = 'http://timestamp.digicert.com' }
if ($env:GITHUB_ACTIONS -eq 'true' -and $TimestampUrl -eq 'none') {
  throw 'Release signing cannot disable the RFC 3161 timestamp.'
}

if (-not $VerifyOnly) {
  $thumbprint = if ($CertificateThumbprint) { $CertificateThumbprint.Replace(' ', '').ToUpperInvariant() } else { '' }
  if ($thumbprint -notmatch '^[0-9A-F]{40,64}$') {
    throw 'A valid code-signing certificate thumbprint was not provided. Keep the certificate and private key in the certificate store or GitHub Secrets, never in the repository.'
  }
  $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
  if (-not $certificate -or -not $certificate.HasPrivateKey) { throw 'The matching code-signing private key is not available in the current-user certificate store.' }
  if ($certificate.NotAfter -le (Get-Date)) { throw 'The code-signing certificate has expired.' }
  $codeSigningOid = '1.3.6.1.5.5.7.3.3'
  if (-not ($certificate.EnhancedKeyUsageList.ObjectId.Value -contains $codeSigningOid)) {
    throw 'The selected certificate does not have the Code Signing enhanced key usage.'
  }
  $signArguments = @('sign', '/sha1', $thumbprint, '/s', 'My', '/fd', 'SHA256')
  if ($TimestampUrl -ne 'none') { $signArguments += @('/tr', $TimestampUrl, '/td', 'SHA256') }
  $signArguments += @('/d', 'Code Runtime Analyzer', '/du', 'https://github.com/LijunZhang-work/code-runtime-analyzer', $resolvedFile)
  & $signTool @signArguments
  if ($LASTEXITCODE -ne 0) { throw "SignTool failed to sign: $resolvedFile" }
}

& $signTool verify /pa /all /v $resolvedFile
if ($LASTEXITCODE -ne 0) { throw "Authenticode signature verification failed: $resolvedFile" }
$signature = Get-AuthenticodeSignature -LiteralPath $resolvedFile
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
  throw "Windows did not report a valid signature for $resolvedFile ($($signature.Status))."
}
Write-Host "Valid code signature: $resolvedFile; publisher: $($signature.SignerCertificate.Subject)" -ForegroundColor Green
