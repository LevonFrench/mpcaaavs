$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
$packageRoot = Join-Path $appRoot 'packages'
New-Item -ItemType Directory -Force $packageRoot | Out-Null
$archive = Join-Path $packageRoot 'webview2.zip'
Invoke-WebRequest 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.3650.58/microsoft.web.webview2.1.0.3650.58.nupkg' -OutFile $archive
$expected = '911A472128C82AC8BAA0C486C23342CC9DD6E7DC50D754E676726642CA065C60'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'WebView2 SDK integrity check failed' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $packageRoot 'WebView2') -Force
Push-Location (Join-Path $appRoot 'visualizer')
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Visualizer build failed' }
} finally { Pop-Location }
Write-Output "Prepared SDK and visualizer in $appRoot. Native MFC/codec dependencies are separate; see Readme.md."
