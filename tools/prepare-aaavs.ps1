$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
$packageRoot = Join-Path $appRoot 'packages'
New-Item -ItemType Directory -Force $packageRoot | Out-Null
$archive = Join-Path $packageRoot 'webview2.zip'
Invoke-WebRequest 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.3650.58/microsoft.web.webview2.1.0.3650.58.nupkg' -OutFile $archive
$expected = '911A472128C82AC8BAA0C486C23342CC9DD6E7DC50D754E676726642CA065C60'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'WebView2 SDK integrity check failed' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $packageRoot 'WebView2') -Force
$buildTools = Join-Path $packageRoot 'build-tools'
New-Item -ItemType Directory -Force $buildTools | Out-Null
$nasmArchive = Join-Path $buildTools 'nasm.zip'
Invoke-WebRequest 'https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/win64/nasm-2.16.03-win64.zip' -OutFile $nasmArchive
if ((Get-FileHash -LiteralPath $nasmArchive -Algorithm SHA256).Hash -ne '3EE4782247BCB874378D02F7EAB4E294A84D3D15F3F6EE2DE2F47A46AA7226E6') { throw 'NASM integrity check failed' }
Expand-Archive -LiteralPath $nasmArchive -DestinationPath $buildTools -Force
$yasmExe = Join-Path $buildTools 'yasm.exe'
Invoke-WebRequest 'https://www.tortall.net/projects/yasm/releases/yasm-1.3.0-win64.exe' -OutFile $yasmExe
if ((Get-FileHash -LiteralPath $yasmExe -Algorithm SHA256).Hash -ne 'D160B1D97266F3F28A71B4420A0AD2CD088A7977C2DD3B25AF155652D8D8D91F') { throw 'Yasm integrity check failed' }
Push-Location (Join-Path $appRoot 'visualizer')
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Visualizer build failed' }
} finally { Pop-Location }
Write-Output "Prepared SDK and visualizer in $appRoot. Native MFC/codec dependencies are separate; see Readme.md."
