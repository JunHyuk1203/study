param([switch]$SkipRuntime, [string]$OutputDirectory, [switch]$EmbedCurrentSettings, [string]$SettingsPath)
$ErrorActionPreference='Stop'
if (-not $SkipRuntime) { & (Join-Path $PSScriptRoot 'prepare-runtime.ps1'); if ($LASTEXITCODE -ne 0) { throw 'Runtime preparation failed' } }
$payload=Join-Path $PSScriptRoot 'artifacts\payload.zip'
if (-not (Test-Path -LiteralPath $payload)) { throw 'The runtime payload is missing' }
$output=if($OutputDirectory){[IO.Path]::GetFullPath($OutputDirectory)}elseif($EmbedCurrentSettings){Join-Path $PSScriptRoot 'artifacts\portable'}else{Join-Path $PSScriptRoot 'artifacts\release'}
$privateDefaults=Join-Path $PSScriptRoot 'artifacts\embedded-settings.json'
try {
    if($EmbedCurrentSettings) {
        $source=if($SettingsPath){[IO.Path]::GetFullPath($SettingsPath)}else{Join-Path $env:USERPROFILE 'AppData\Local\StudyServer\config\settings.protected'}
        Add-Type -AssemblyName System.Security
        $clear=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($source),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        try {
            $saved=[Text.Encoding]::UTF8.GetString($clear) | ConvertFrom-Json
            if([string]::IsNullOrWhiteSpace($saved.ServiceAccountJson) -or [string]::IsNullOrWhiteSpace($saved.NeisKey) -or [string]::IsNullOrWhiteSpace($saved.AiKey)) { throw 'Firebase, NEIS and AI credentials must all be configured' }
            $certificate=$saved.ServiceAccountJson | ConvertFrom-Json
            if($certificate.type -ne 'service_account' -or [string]::IsNullOrWhiteSpace($certificate.private_key) -or [string]::IsNullOrWhiteSpace($certificate.client_email)) { throw 'The configured Firebase service account is invalid' }
            $embedded=@{ServiceAccountJson=$saved.ServiceAccountJson;NeisKey=$saved.NeisKey;AiKey=$saved.AiKey;FaceKmsKey=$saved.FaceKmsKey} | ConvertTo-Json -Compress
            [IO.File]::WriteAllText($privateDefaults,$embedded,(New-Object Text.UTF8Encoding($false)))
            Write-Output 'PRIVATE_BUILD=Firebase account, NEIS and AI credentials embedded; do not publish this EXE'
        } finally { [Array]::Clear($clear,0,$clear.Length) }
    }
    $includePrivate=if($EmbedCurrentSettings){'true'}else{'false'}
    dotnet publish (Join-Path $PSScriptRoot 'launcher\StudyServer.csproj') -c Release -r win-x64 --self-contained true -o $output --nologo "-p:IncludePrivateSettings=$includePrivate"
    if ($LASTEXITCODE -ne 0) { throw 'EXE publish failed' }
} finally {
    if(Test-Path -LiteralPath $privateDefaults) { Remove-Item -LiteralPath $privateDefaults -Force }
}
$exe=Join-Path $output 'StudyServer.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'EXE is missing' }
Get-FileHash -LiteralPath $exe -Algorithm SHA256 | Format-List
Write-Output "SERVER_EXE=$exe"
