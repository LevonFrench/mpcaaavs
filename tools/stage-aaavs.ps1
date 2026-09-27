param([string]$PlayerDirectory)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
if (-not $PlayerDirectory) { $PlayerDirectory = Join-Path $appRoot 'bin\mpc-hc_x64 Lite' }
$player = Join-Path $PlayerDirectory 'mpc-aaavs.exe'
if (-not (Test-Path -LiteralPath $player)) { throw "Build the player first: $player" }
Push-Location (Join-Path $appRoot 'visualizer')
try {
    & npm.cmd run build:mpc
    if ($LASTEXITCODE -ne 0) { throw 'AAAVS bundle failed' }
} finally { Pop-Location }
$destination = Join-Path $PlayerDirectory 'visualizer'
New-Item -ItemType Directory -Force $destination | Out-Null
Copy-Item -LiteralPath (Join-Path $appRoot 'visualizer\mpc.html') -Destination $destination
Copy-Item -LiteralPath (Join-Path $appRoot 'visualizer\dist') -Destination $destination -Recurse -Force
$collection = Join-Path $appRoot 'visualizer\avs presets'
$targetCollection = Join-Path $destination 'avs presets'
foreach ($folder in @('catalog', 'presets', 'dependencies')) {
    New-Item -ItemType Directory -Force $targetCollection | Out-Null
    Copy-Item -LiteralPath (Join-Path $collection $folder) -Destination $targetCollection -Recurse -Force
}
foreach ($name in @('README.md', 'SOURCES.md', 'COLLECTION_LOG.md')) {
    Copy-Item -LiteralPath (Join-Path $collection $name) -Destination $targetCollection -Force
}
Copy-Item -LiteralPath (Join-Path $appRoot 'COPYING.txt') -Destination $PlayerDirectory
Write-Output "Staged AAAVS beside $player"
