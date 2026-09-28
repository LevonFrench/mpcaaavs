param([string]$PlayerDirectory)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
if (-not $PlayerDirectory) { $PlayerDirectory = Join-Path $appRoot 'bin\mpc-hc_x64 Lite' }
$PlayerDirectory = [IO.Path]::GetFullPath($PlayerDirectory)
function Assert-NoLinkedPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked staging paths are not writable: $current" }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    if (Test-Path -LiteralPath $Path -PathType Container) {
        $linked = Get-ChildItem -LiteralPath $Path -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1
        if ($linked) { throw "Linked staging paths are not writable: $($linked.FullName)" }
    }
}
Assert-NoLinkedPath $PlayerDirectory
$player = Join-Path $PlayerDirectory 'mpc-hc-aaavs.exe'
if (-not (Test-Path -LiteralPath $player)) { throw "Build the player first: $player" }
# Carry forward portable preferences once; a renamed installation owns its new INI.
foreach ($suffix in @('.ini', '.history.ini')) {
    $oldSettings = Join-Path $PlayerDirectory "mpc-aaavs$suffix"
    $newSettings = Join-Path $PlayerDirectory "mpc-hc-aaavs$suffix"
    if ((Test-Path -LiteralPath $oldSettings -PathType Leaf) -and -not (Test-Path -LiteralPath $newSettings)) {
        Copy-Item -LiteralPath $oldSettings -Destination $newSettings
    }
}
Push-Location (Join-Path $appRoot 'visualizer')
try {
    & npm.cmd run build:mpc
    if ($LASTEXITCODE -ne 0) { throw 'AAAVS bundle failed' }
} finally { Pop-Location }
$destination = Join-Path $PlayerDirectory 'visualizer'
Assert-NoLinkedPath $destination
New-Item -ItemType Directory -Force $destination | Out-Null
Copy-Item -LiteralPath (Join-Path $appRoot 'visualizer\mpc.html') -Destination $destination
Copy-Item -LiteralPath (Join-Path $appRoot 'visualizer\dist') -Destination $destination -Recurse -Force
$collection = Join-Path $appRoot 'visualizer\avs presets'
$targetCollection = Join-Path $destination 'avs presets'
Assert-NoLinkedPath $targetCollection
# Existing installations own their renamed presets and catalog. Rebuilds must not
# overwrite ratings or resurrect pre-rating filenames. New collections are installed once.
$installed = Test-Path -LiteralPath (Join-Path $targetCollection 'catalog\presets.json')
foreach ($folder in @('catalog', 'presets', 'dependencies')) {
    if ($installed -and $folder -ne 'dependencies') { continue }
    $sourceFolder = Join-Path $collection $folder
    if (-not (Test-Path -LiteralPath $sourceFolder)) { continue }
    Assert-NoLinkedPath (Join-Path $targetCollection $folder)
    New-Item -ItemType Directory -Force $targetCollection | Out-Null
    Copy-Item -LiteralPath $sourceFolder -Destination $targetCollection -Recurse -Force
}
foreach ($name in @('README.md', 'SOURCES.md', 'COLLECTION_LOG.md')) {
    $sourceFile = Join-Path $collection $name
    if (Test-Path -LiteralPath $sourceFile) { Copy-Item -LiteralPath $sourceFile -Destination $targetCollection -Force }
}
# The source-distributed scene pack also works in a public checkout with no
# historical AVS bank. Merge by content identity; preserve installed ratings.
& node (Join-Path $appRoot 'visualizer\tools\install-nerv-presets.mjs') $targetCollection
if ($LASTEXITCODE -ne 0) { throw 'NERV preset installation failed' }
Copy-Item -LiteralPath (Join-Path $appRoot 'COPYING.txt') -Destination $PlayerDirectory
Copy-Item -LiteralPath (Join-Path $appRoot 'THIRD-PARTY-AVS-TRANSITIONS.txt') -Destination $PlayerDirectory -Force
Copy-Item -LiteralPath (Join-Path $appRoot 'THIRD-PARTY-NERV.txt') -Destination $PlayerDirectory -Force
Write-Output "Staged mpc-hc-aaavs beside $player"
