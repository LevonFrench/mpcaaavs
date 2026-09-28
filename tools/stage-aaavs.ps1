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
# Existing installations own their renamed presets and catalog. Rebuilds must not
# overwrite ratings or resurrect pre-rating filenames. New collections are installed once.
$installed = Test-Path -LiteralPath (Join-Path $targetCollection 'catalog\presets.json')
foreach ($folder in @('catalog', 'presets', 'dependencies')) {
    if ($installed -and $folder -ne 'dependencies') { continue }
    New-Item -ItemType Directory -Force $targetCollection | Out-Null
    Copy-Item -LiteralPath (Join-Path $collection $folder) -Destination $targetCollection -Recurse -Force
}
foreach ($name in @('README.md', 'SOURCES.md', 'COLLECTION_LOG.md')) {
    Copy-Item -LiteralPath (Join-Path $collection $name) -Destination $targetCollection -Force
}
Copy-Item -LiteralPath (Join-Path $appRoot 'COPYING.txt') -Destination $PlayerDirectory
Copy-Item -LiteralPath (Join-Path $appRoot 'THIRD-PARTY-AVS-TRANSITIONS.txt') -Destination $PlayerDirectory -Force
Write-Output "Staged AAAVS beside $player"
