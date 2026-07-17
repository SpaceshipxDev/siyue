[CmdletBinding()]
param(
  [string]$OutputDir = (Join-Path $PSScriptRoot 'dist'),
  [string]$Version = '4.1.2'
)

$ErrorActionPreference = 'Stop'
$name = "YingmaMachineWatcher-$Version"
$stage = Join-Path $OutputDir $name
$archive = Join-Path $OutputDir "$name.zip"
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($file in @(
  'YingmaMachineWatcher.ps1',
  'YingmaCncDiscovery.ps1',
  'YingmaVendorDrivers.ps1',
  'install.ps1',
  'update.ps1',
  'uninstall.ps1',
  'INSTALL-FACTORY.cmd',
  'TEST-NOW.cmd',
  'config.example.json',
  'README.md'
)) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $stage -Force
}

Compress-Archive -LiteralPath $stage -DestinationPath $archive -CompressionLevel Optimal
Write-Output $archive
