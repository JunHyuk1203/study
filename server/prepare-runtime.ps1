param([switch]$SkipDownload)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root=Split-Path -Parent $PSScriptRoot
$artifacts=Join-Path $PSScriptRoot 'artifacts'
$cache=Join-Path $artifacts 'cache'
$payload=Join-Path $artifacts 'payload'
New-Item -ItemType Directory -Path $cache,$artifacts,$payload -Force | Out-Null
function Get-Asset([string]$Url,[string]$Name,[string]$Digest='') {
  $destination=Join-Path $cache $Name
  if (-not (Test-Path -LiteralPath $destination)) {
    if ($SkipDownload) { throw "Missing cached runtime: $Name" }
    & curl.exe --fail --location --retry 3 --connect-timeout 20 --max-time 600 --continue-at - --output "$destination.partial" $Url
    if ($LASTEXITCODE -ne 0) { throw "Runtime download failed: $Name" }
    Move-Item -LiteralPath "$destination.partial" -Destination $destination
  }
  $hash=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Digest -and $Digest -ne "sha256:$hash") { throw "Runtime digest mismatch: $Name" }
  return [PSCustomObject]@{File=$destination;Url=$Url;Sha256=$hash}
}
$postgres=Get-Asset 'https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip' 'postgresql-18.6-5-windows-x64-binaries.zip'
$cloudRelease=Invoke-RestMethod 'https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.10.3'
$cloudAsset=$cloudRelease.assets | Where-Object name -eq 'cloudflared-windows-amd64.exe'
if (-not $cloudAsset) { throw 'Pinned Cloudflare runtime was not found' }
$cloud=Get-Asset $cloudAsset.browser_download_url 'cloudflared-2026.10.3.exe' $cloudAsset.digest
$caddyRelease=Invoke-RestMethod 'https://api.github.com/repos/caddyserver/caddy/releases/tags/v2.11.7'
$caddyAsset=$caddyRelease.assets | Where-Object name -eq 'caddy_2.11.7_windows_amd64.zip'
if (-not $caddyAsset) { throw 'Pinned Caddy runtime was not found' }
$caddy=Get-Asset $caddyAsset.browser_download_url $caddyAsset.name $caddyAsset.digest
$postgresRoot=Join-Path $cache 'postgresql-18.6-5'
if (-not (Test-Path -LiteralPath "$postgresRoot\.unpacked")) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive=[System.IO.Compression.ZipFile]::OpenRead($postgres.File)
  try {
    foreach ($entry in $archive.Entries) {
      if (($entry.FullName -notmatch '^pgsql/(bin|lib|share)/' -and $entry.FullName -notmatch '^pgsql/(server_license|commandlinetools_3rd_party_licenses)\.txt$') -or -not $entry.Name) { continue }
      $destination=[IO.Path]::GetFullPath((Join-Path $postgresRoot $entry.FullName))
      if (-not $destination.StartsWith([IO.Path]::GetFullPath($postgresRoot) + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected runtime archive path' }
      New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$true)
    }
    Set-Content -LiteralPath "$postgresRoot\.unpacked" -Value '18.6-5' -Encoding ascii
  } finally { $archive.Dispose() }
}
$caddyRoot=Join-Path $cache 'caddy-2.11.7'
if (-not (Test-Path -LiteralPath "$caddyRoot\caddy.exe")) { Expand-Archive -LiteralPath $caddy.File -DestinationPath $caddyRoot -Force }
foreach ($part in @('bin','lib','share')) {
  & robocopy.exe "$postgresRoot\pgsql\$part" "$payload\postgres\$part" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copy failed: postgres/$part" }
}
New-Item -ItemType Directory -Path "$payload\node","$payload\functions" -Force | Out-Null
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination "$payload\node\node.exe" -Force
$vcRuntimeFiles=@()
$vcNames=@('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll','msvcp140_1.dll','msvcp140_2.dll','msvcp140_atomic_wait.dll','msvcp140_codecvt_ids.dll','vcruntime140_threads.dll','concrt140.dll')
foreach ($name in $vcNames) {
  $source=Join-Path $env:WINDIR ('System32\'+$name)
  if (-not (Test-Path -LiteralPath $source)) { if ($name -in @('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll')) { throw "Build machine requires Microsoft C++ runtime: $name" }; continue }
  $signature=Get-AuthenticodeSignature -LiteralPath $source
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Microsoft Corporation*') { throw "Microsoft C++ signature check failed: $name" }
  $version=(Get-Item -LiteralPath $source).VersionInfo
  if ($version.FileMajorPart -lt 14 -or ($version.FileMajorPart -eq 14 -and $version.FileMinorPart -lt 44)) { throw 'Build machine Microsoft C++ runtime is too old for bundled PostgreSQL' }
  Copy-Item -LiteralPath $source -Destination "$payload\postgres\bin\$name" -Force
  Copy-Item -LiteralPath $source -Destination "$payload\node\$name" -Force
  $vcRuntimeFiles += [PSCustomObject]@{Name=$name;Version=$version.FileVersion;Sha256=(Get-FileHash -LiteralPath $source).Hash}
}
Copy-Item -LiteralPath $cloud.File -Destination "$payload\cloudflared.exe" -Force
Copy-Item -LiteralPath "$caddyRoot\caddy.exe" -Destination "$payload\caddy.exe" -Force
New-Item -ItemType Directory -Path "$payload\licenses" -Force | Out-Null
$licenseArchive=[System.IO.Compression.ZipFile]::OpenRead($postgres.File)
try { foreach ($name in @('server_license.txt','commandlinetools_3rd_party_licenses.txt')) { $entry=$licenseArchive.GetEntry('pgsql/'+$name); if ($entry) { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry,"$payload\licenses\postgres-$name",$true) } } } finally { $licenseArchive.Dispose() }
foreach ($license in @( @('https://raw.githubusercontent.com/cloudflare/cloudflared/2026.10.3/LICENSE','cloudflared-LICENSE.txt'), @('https://raw.githubusercontent.com/caddyserver/caddy/v2.11.7/LICENSE','caddy-LICENSE.txt'), @('https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE','node-LICENSE.txt'), @('https://raw.githubusercontent.com/dotnet/runtime/v8.0.32/LICENSE.TXT','dotnet-LICENSE.txt'), @('https://raw.githubusercontent.com/dotnet/runtime/v8.0.32/THIRD-PARTY-NOTICES.TXT','dotnet-NOTICES.txt') )) {
  $download=Get-Asset $license[0] $license[1]
  Copy-Item -LiteralPath $download.File -Destination (Join-Path "$payload\licenses" $license[1]) -Force
}
Copy-Item -Path "$root\functions\*.js" -Destination "$payload\functions" -Force
Copy-Item -LiteralPath "$root\functions\package.json","$root\functions\package-lock.json" -Destination "$payload\functions" -Force
& robocopy.exe "$root\functions\node_modules" "$payload\functions\node_modules" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Dependency copy failed' }
$manifest=[PSCustomObject]@{BuildUtc=[DateTimeOffset]::UtcNow.ToString('o');NodeVersion=(& node --version);PostgreSQL=$postgres;Cloudflared=$cloud;Caddy=$caddy;VisualCRuntime=$vcRuntimeFiles;NodeSha256=(Get-FileHash -LiteralPath "$payload\node\node.exe").Hash}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$payload\runtime-manifest.json" -Encoding utf8
Copy-Item -LiteralPath "$PSScriptRoot\THIRD-PARTY-NOTICES.md" -Destination "$payload\THIRD-PARTY-NOTICES.md" -Force
$zip=Join-Path $artifacts 'payload.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($payload,$zip,[System.IO.Compression.CompressionLevel]::Optimal,$false)
Write-Output "PAYLOAD=$zip"
Write-Output "POSTGRES_BIN=$payload\postgres\bin"
