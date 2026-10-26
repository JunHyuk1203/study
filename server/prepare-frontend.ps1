param([string]$OutputDirectory)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$target=if($OutputDirectory){[IO.Path]::GetFullPath($OutputDirectory)}else{Join-Path $PSScriptRoot ('artifacts\frontend-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))}
if(Test-Path -LiteralPath $target){throw 'Choose a new, empty output directory. Existing deployments are never overwritten.'}
New-Item -ItemType Directory -Path $target,(Join-Path $target 'functions') -Force | Out-Null
# Export a public asset allowlist. Never expose the source checkout, .git, server,
# credentials, review artifacts, or backend functions through the file server.
Get-ChildItem -LiteralPath $sourceRoot -File | Where-Object {$_.Extension -in '.html','.js','.css','.png','.svg','.ico','.webmanifest' -and -not $_.Name.StartsWith('.')} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $target}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'functions\face-protocol.js') -Destination (Join-Path $target 'functions\face-protocol.js')
Write-Output "STUDY_FRONTEND_ROOT=$target"
