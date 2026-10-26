$ErrorActionPreference='Stop'
$source=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'launcher\Program.cs')
$match=[regex]::Match($source,'(?s)static string FirewallCommand.*?\$\$"""\r?\n(.*?)\r?\n\s*""";')
if(-not $match.Success){throw 'Firewall command not found'}
$template=$match.Groups[1].Value.Replace('{{caddy.Replace("''", "''''")}}','C:\Study Test\O''''Brien\caddy.exe')
# Simulate only the OS boundary; execute the actual generated rule-check and repair code.
$template=[regex]::Replace($template,'(?m)^\s*\$principal=\[Security.*$','$principal=$null')
$template=$template.Replace('if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))','if($false)')
$stub=@'
$script:state='__STATE__'
function Get-NetFirewallRule {
 param($Name,$ErrorAction)
 if($Name -ne 'StudyServer-Caddy-HTTPS'){throw 'Unexpected rule scope'}
 if($script:state -eq 'missing'){return}
 [pscustomobject]@{Enabled='True';Direction='Inbound';Action='Allow';Profile='Any'}
}
function Get-NetFirewallApplicationFilter {
 param([Parameter(ValueFromPipeline)]$InputObject)
 [pscustomobject]@{Program=$(if($script:state -eq 'stale'){'C:\old\caddy.exe'}else{"C:\Study Test\O'Brien\caddy.exe"})}
}
function Get-NetFirewallPortFilter {param([Parameter(ValueFromPipeline)]$InputObject) [pscustomobject]@{Protocol='TCP';LocalPort=$(if($script:state -eq 'wide'){@('80','443')}else{@('443')})}}
function Remove-NetFirewallRule {param([Parameter(ValueFromPipeline)]$InputObject) if('__MUTATE__' -ne 'yes'){throw 'Unexpected mutation'}; $script:state='missing'}
function Test-Path {param($LiteralPath,$PathType) return $true}
function New-NetFirewallRule {
 param($Name,$DisplayName,$Description,$Direction,$Action,$Enabled,$Protocol,$LocalPort,$Program,$Profile)
 if('__MUTATE__' -ne 'yes'){throw 'Unexpected mutation'}
 if($Name -ne 'StudyServer-Caddy-HTTPS' -or $Direction -ne 'Inbound' -or $Action -ne 'Allow' -or $Protocol -ne 'TCP' -or ($LocalPort -join ',') -ne '443' -or $Program -ne "C:\Study Test\O'Brien\caddy.exe" -or $Profile -ne 'Any'){throw 'Unexpected public scope'}
 $script:state='correct'
}
'@
$cases=@(
 @{Name='existing rule';State='correct';Apply=$false;Mutate='no';Expected=0},
 @{Name='missing rule read-only';State='missing';Apply=$false;Mutate='no';Expected=1},
 @{Name='create exact scoped rule';State='missing';Apply=$true;Mutate='yes';Expected=0},
 @{Name='repair old runtime path';State='stale';Apply=$true;Mutate='yes';Expected=0},
 @{Name='narrow old 80 and 443 rule';State='wide';Apply=$true;Mutate='yes';Expected=0},
 @{Name='existing rule apply is idempotent';State='correct';Apply=$true;Mutate='no';Expected=0}
)
foreach($case in $cases){
 $flag=if($case.Apply){'$false'}else{'$true'}
 $command=$stub.Replace('__STATE__',$case.State).Replace('__MUTATE__',$case.Mutate)+"`n"+$template.Replace('{{(apply ? "$false" : "$true")}}',$flag)
 $tokens=$null;$parseErrors=$null
 [Management.Automation.Language.Parser]::ParseInput($command,[ref]$tokens,[ref]$parseErrors)|Out-Null
 if($parseErrors.Count){throw $parseErrors[0].Message}
 $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
 & powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded
 if($LASTEXITCODE -ne $case.Expected){throw ('Failed: '+$case.Name+' (exit '+$LASTEXITCODE+')')}
 Write-Output ('PASS '+$case.Name)
}
Write-Output '6 firewall command tests passed; no Windows firewall rules were changed.'
