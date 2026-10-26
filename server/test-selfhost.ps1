$ErrorActionPreference='Stop'
$bin=Join-Path $PSScriptRoot 'artifacts\payload\postgres\bin'
if (-not (Test-Path -LiteralPath "$bin\initdb.exe")) { throw 'Run server/prepare-runtime.ps1 first' }
$runRoot=Join-Path ([IO.Path]::GetTempPath()) ('study-selfhost-test-' + [Guid]::NewGuid().ToString('N'))
$data=Join-Path $runRoot 'data'
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
& robocopy.exe (Split-Path -Parent $bin) "$runRoot\postgres" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Test runtime copy failed' }
$bin=Join-Path $runRoot 'postgres\bin'
& "$bin\initdb.exe" -D $data -U study_test_owner --auth=trust --encoding=UTF8 --locale=C *> "$runRoot\init.log"
if ($LASTEXITCODE -ne 0) { throw "Test DB init failed: $runRoot\init.log" }
$started=$false
try {
  $postgresProcess=Start-Process -FilePath "$bin\postgres.exe" -ArgumentList @('-D',('"'+$data+'"'),'-h','127.0.0.1','-p','15433') -WindowStyle Hidden -PassThru -RedirectStandardOutput "$runRoot\postgres.stdout.log" -RedirectStandardError "$runRoot\postgres.log"
  $started=$true
  $ready=$false
  for ($attempt=0;$attempt -lt 50;$attempt++) {
    & "$bin\pg_isready.exe" -h 127.0.0.1 -p 15433 -U study_test_owner *> "$runRoot\ready.log"
    if ($LASTEXITCODE -eq 0) { $ready=$true; break }
    if ($postgresProcess.HasExited) { break }
    Start-Sleep -Milliseconds 200
  }
  if (-not $ready) { throw "Test DB start failed: $runRoot\postgres.log" }
  & "$bin\createdb.exe" -h 127.0.0.1 -p 15433 -U study_test_owner study_selfhost_test
  if ($LASTEXITCODE -ne 0) { throw 'Test database create failed' }
  $env:STUDY_TEST_DATABASE_URL='postgresql://study_test_owner@127.0.0.1:15433/study_selfhost_test'
  & node --test --test-concurrency=1 (Join-Path $PSScriptRoot '..\tests\selfhost.test.mjs') *> "$runRoot\tests.log"
  $result=$LASTEXITCODE
  Get-Content -LiteralPath "$runRoot\tests.log" -Tail 32
  Write-Output "SELFHOST_TEST_LOG=$runRoot\tests.log"
  if ($result -ne 0) { exit $result }
} finally {
  if ($started) { & "$bin\pg_ctl.exe" -D $data -m fast -w stop *> "$runRoot\stop.log" }
  Remove-Item Env:\STUDY_TEST_DATABASE_URL -ErrorAction SilentlyContinue
}
