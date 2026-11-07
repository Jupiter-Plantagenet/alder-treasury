param(
  [ValidateSet('install','uninstall','status','tick','repair-locked','operator-stop','operator-resume','recover-install')]
  [string]$Action='status',
  [string]$ExpectedPolicySha256,
  [string]$ExpectedScriptSha256
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$scriptPath=$PSCommandPath
$policyPath=Join-Path $PSScriptRoot 'alder-watchdog-policy.json'
$guardPath=Join-Path $PSScriptRoot 'alder-watchdog-guard.mjs'
$processIdentityPath=Join-Path $PSScriptRoot 'alder-watchdog-process.cs'
function Get-Hash([string]$file){
  if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'WATCHDOG_BOOTSTRAP_FILE_MISSING'}
  $item=Get-Item -LiteralPath $file -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'WATCHDOG_BOOTSTRAP_REPARSE_REFUSED'}
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$stream=[IO.File]::OpenRead($file);try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose()}}
  finally{$sha.Dispose()}
}
if(-not $ExpectedPolicySha256 -or -not $ExpectedScriptSha256){throw 'WATCHDOG_EXPECTED_POLICY_AND_SCRIPT_HASHES_REQUIRED'}
if($ExpectedPolicySha256 -notmatch '^[0-9a-fA-F]{64}$' -or $ExpectedScriptSha256 -notmatch '^[0-9a-fA-F]{64}$'){throw 'WATCHDOG_EXPECTED_HASH_FORMAT_INVALID'}
if((Get-Hash $policyPath) -ne $ExpectedPolicySha256.ToLowerInvariant()){throw 'WATCHDOG_POLICY_HASH_CHANGED_BEFORE_LOAD'}
if((Get-Hash $scriptPath) -ne $ExpectedScriptSha256.ToLowerInvariant()){throw 'WATCHDOG_SCRIPT_HASH_CHANGED_BEFORE_POLICY_LOAD'}
$policy=Get-Content -Raw -LiteralPath $policyPath|ConvertFrom-Json -ErrorAction Stop
$taskName=[string]$policy.taskName
$taskPath=[string]$policy.taskPath
$taskDescription=[string]$policy.taskDescription
$privateRoot=Join-Path $root '.local\alder-watchdog'
$receiptRoot=Join-Path $privateRoot 'receipts'
$runRoot=Join-Path $privateRoot 'runs'
$taskOwnerRoot=Join-Path $privateRoot 'task-owners'
$pidsPath=Join-Path $root 'runtime-logs\pids.json'
$servicesScript=Join-Path $PSScriptRoot 'round4-services.ps1'
$backupScript=Join-Path $PSScriptRoot 'codex-round6-backup.py'
$node=Join-Path $root ([string]$policy.runtime.nodePath)
$python='C:\Users\user\portfolio-build\folio\.venv\Scripts\python.exe'
$lockWrapper='C:\Users\user\portfolio-build\tools\round5_locked_step.py'
$lockStatus='C:\Users\user\portfolio-build\tools\product_lock.py'
$stopMarker=Join-Path $privateRoot 'operator-stop.marker'
$identityType='AlderWatchdogProcess'
foreach($entry in @(@{path=$scriptPath;pin='ops/alder-watchdog.ps1';name='SCRIPT'},@{path=$guardPath;pin='ops/alder-watchdog-guard.mjs';name='GUARD'},@{path=$processIdentityPath;pin='ops/alder-watchdog-process.cs';name='PROCESS_HELPER'})){
  if((Get-Hash $entry.path) -ne ([string]$policy.sourcePins.PSObject.Properties[$entry.pin].Value).ToLowerInvariant()){throw "WATCHDOG_$($entry.name)_PIN_MISMATCH_BEFORE_HELPER_LOAD"}
}
if($ExpectedPolicySha256 -and (Get-Hash $policyPath) -ne $ExpectedPolicySha256.ToLowerInvariant()){throw 'WATCHDOG_POLICY_HASH_CHANGED_AFTER_LOAD'}
if($ExpectedScriptSha256 -and (Get-Hash $scriptPath) -ne $ExpectedScriptSha256.ToLowerInvariant()){throw 'WATCHDOG_SCRIPT_HASH_CHANGED_AFTER_LOAD'}
if($Action -in @('status','tick','repair-locked') -and -not ($identityType -as [type])){Add-Type -Path $processIdentityPath}
function Get-TextHash([string]$text){
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}
  finally{$sha.Dispose()}
}
function Normalize-Path([string]$value){[IO.Path]::GetFullPath($value).TrimEnd([char[]]@('\','/'))}
function Ensure-PrivateDirectory {
  if(-not (Test-Path -LiteralPath $privateRoot)){New-Item -ItemType Directory -Path $privateRoot -Force|Out-Null}
  foreach($dir in @($receiptRoot,$runRoot,$taskOwnerRoot)){if(-not (Test-Path -LiteralPath $dir)){New-Item -ItemType Directory -Path $dir -Force|Out-Null}}
  $who=([Security.Principal.WindowsIdentity]::GetCurrent()).Name
  foreach($dir in @($privateRoot,$receiptRoot,$runRoot,$taskOwnerRoot)){
    $item=Get-Item -LiteralPath $dir -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'WATCHDOG_PRIVATE_PATH_REPARSE_POINT_REFUSED'}
    & icacls.exe $dir '/inheritance:r' '/grant:r' "$who`:(OI)(CI)F" 'NT AUTHORITY\SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
    if($LASTEXITCODE -ne 0){throw 'WATCHDOG_PRIVATE_ACL_FAILED'}
  }
}
function Get-SourceCheck {
  Assert-NodeRuntime
  $raw=& $node $guardPath source 2>&1
  $exit=$LASTEXITCODE
  $json=$null
  try{$json=($raw -join "`n")|ConvertFrom-Json}catch{}
  if($exit -ne 0 -or -not $json.pass){return [pscustomobject]@{pass=$false;count=$json.pinnedFileCount;mismatches=$json.mismatches}}
  return $json
}
function Assert-NodeRuntime {
  if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'WATCHDOG_NODE_RUNTIME_MISSING'}
  if((Get-Hash $node) -ne ([string]$policy.runtime.nodeSha256).ToLowerInvariant()){throw 'WATCHDOG_NODE_RUNTIME_HASH_MISMATCH'}
}
function Assert-TaskPins {
  if(-not $ExpectedPolicySha256 -or -not $ExpectedScriptSha256){throw 'WATCHDOG_TASK_PIN_ARGUMENTS_MISSING'}
  if((Get-Hash $policyPath) -ne $ExpectedPolicySha256.ToLowerInvariant()){throw 'WATCHDOG_POLICY_HASH_CHANGED'}
  if((Get-Hash $scriptPath) -ne $ExpectedScriptSha256.ToLowerInvariant()){throw 'WATCHDOG_SCRIPT_HASH_CHANGED'}
  $sources=Get-SourceCheck
  if(-not $sources.pass){throw 'WATCHDOG_APPROVED_SOURCE_PIN_MISMATCH'}
}
function Write-StatusRecord($status,$data=@{}){
  Ensure-PrivateDirectory
  $stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $file=Join-Path $privateRoot ("status-$stamp-"+[guid]::NewGuid().ToString('N')+'.json')
  $record=[ordered]@{schema='alder.watchdog.status/v1';atUtc=[DateTime]::UtcNow.ToString('o');action=$Action;status=$status;data=$data}
  [IO.File]::WriteAllText($file,(($record|ConvertTo-Json -Depth 12)+"`n"),[Text.UTF8Encoding]::new($false))
  return $file
}
function Invoke-Curl([string]$url,[int]$timeoutSeconds=4,[string]$jsonBody=$null){
  $curlArgs=@('--silent','--max-time',[string]$timeoutSeconds,'--write-out',"`n__STATUS__%{http_code}")
  if($url.StartsWith('https://')){$curlArgs=@('--insecure')+$curlArgs}
  if(-not [string]::IsNullOrEmpty($jsonBody)){$curlArgs+=@('-H','content-type: application/json','--data-binary',$jsonBody)}
  $curlArgs+=$url
  $raw=& curl.exe @curlArgs 2>$null
  $exit=$LASTEXITCODE
  $text=$raw -join "`n"
  $marker=$text.LastIndexOf("`n__STATUS__")
  $body=if($marker -ge 0){$text.Substring(0,$marker)}else{''}
  $code=if($marker -ge 0){$text.Substring($marker+11).Trim()}else{'000'}
  $parsed=$null
  try{$parsed=$body|ConvertFrom-Json}catch{}
  [pscustomobject]@{status=$code;curlExit=$exit;json=$parsed;bytes=[Text.Encoding]::UTF8.GetByteCount($body);text=$body}
}
function Invoke-Rpc([string]$method,[object[]]$params=@()){
  $body=([ordered]@{jsonrpc='2.0';id=1;method=$method;params=$params}|ConvertTo-Json -Compress -Depth 8)
  $r=Invoke-Curl 'http://127.0.0.1:8547' 5 $body
  if($r.status -ne '200' -or -not $r.json -or $r.json.error){throw "RPC_READ_FAILED_$method"}
  return $r.json.result
}
function Get-PortOwner([int]$port){$l=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue|Select-Object -First 1;if($l){return [int]$l.OwningProcess};return $null}
function Get-PidRecords {
  if(-not (Test-Path -LiteralPath $pidsPath)){return [pscustomobject]@{valid=$true;exists=$false;records=@{};errorCode=$null}}
  try{
    $raw=Get-Content -Raw -LiteralPath $pidsPath|ConvertFrom-Json -ErrorAction Stop
    if($null -eq $raw -or $raw -is [array] -or $raw -isnot [pscustomobject]){throw 'PID_INVENTORY_ROOT_INVALID'}
    $table=@{};$allowed=@('chain','api','worker','ui','release')
    foreach($p in $raw.PSObject.Properties){
      if($p.Name -notin $allowed -or $null -eq $p.Value -or $p.Value -isnot [pscustomobject]){throw 'PID_INVENTORY_RECORD_INVALID'}
      $pidValue=0;if(-not [int]::TryParse([string]$p.Value.pid,[ref]$pidValue) -or $pidValue -le 0){throw 'PID_INVENTORY_PID_INVALID'}
      $table[$p.Name]=$p.Value
    }
    return [pscustomobject]@{valid=$true;exists=$true;records=$table;errorCode=$null}
  }catch{return [pscustomobject]@{valid=$false;exists=$true;records=@{};errorCode='PID_INVENTORY_MALFORMED_OR_UNREADABLE'}}
}
function Get-ProcessFacts([string]$name,[int]$pidValue){
  try{$w=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction Stop}catch{return [pscustomobject]@{readable=$false;exists=$null;pid=$pidValue}}
  if(-not $w){return [pscustomobject]@{readable=$true;exists=$false;pid=$pidValue}}
  try{$p=Get-Process -Id $pidValue -ErrorAction Stop;$cwd=[AlderWatchdogProcess]::GetCurrentDirectory($pidValue)}catch{return [pscustomobject]@{readable=$false;exists=$true;pid=$pidValue}}
  $spec=$policy.services.$name
  [pscustomobject]@{readable=$true;exists=$true;pid=$pidValue;birthUtc=$p.StartTime.ToUniversalTime().ToString('o');image=$w.ExecutablePath;commandLineSha256=(Get-TextHash ([string]$w.CommandLine));roleCommandMatches=([string]$w.CommandLine -match $spec.rolePattern);currentDirectory=(Normalize-Path $cwd)}
}
function Get-RoleProcessState([string]$name){
  try{$processes=Get-CimInstance Win32_Process -ErrorAction Stop}catch{return 'process_scan_unreadable'}
  $spec=$policy.services.$name
  foreach($w in $processes){
    if($w.ExecutablePath -ieq $spec.image -and [string]$w.CommandLine -match $spec.rolePattern){return 'matching_process_alive_without_listener'}
  }
  return 'none'
}
function Get-ServiceIdentity([string]$name,$inventory){
  $spec=$policy.services.$name;$pidValue=Get-PortOwner ([int]$spec.port);$record=$inventory.records[$name]
  if(-not $inventory.valid){return [pscustomobject]@{name=$name;port=$spec.port;listenerPid=$pidValue;healthy=$false;identityMatches=$false;processState='pid_inventory_invalid';health=$null}}
  if(-not $pidValue){
    $orphan=Get-RoleProcessState $name
    if($orphan -eq 'none' -and $record -and $record.pid){$facts=Get-ProcessFacts $name ([int]$record.pid);if(-not $facts.readable){$orphan='uninspectable'}elseif(-not $facts.exists){$orphan='recorded_pid_gone'}elseif($record.birthUtc -and $facts.birthUtc -eq $record.birthUtc){$orphan='recorded_process_alive_without_listener'}elseif(-not $record.birthUtc){$orphan='legacy_pid_unverifiable'}else{$orphan='recorded_pid_reused'}}
    return [pscustomobject]@{name=$name;port=$spec.port;listenerPid=$null;healthy=$false;identityMatches=$false;processState=$orphan;health=$null}
  }
  $facts=Get-ProcessFacts $name $pidValue
  $matches=$false
  if($facts.readable -and $record){$matches=([int]$record.pid -eq $pidValue -and $record.birthUtc -eq $facts.birthUtc -and $record.image -ieq $facts.image -and $record.commandLineSha256 -eq $facts.commandLineSha256 -and (Normalize-Path $record.requestedCwd) -ieq (Normalize-Path $root) -and $facts.currentDirectory -ieq (Normalize-Path $root) -and $facts.image -ieq $spec.image -and $facts.roleCommandMatches)}
  [pscustomobject]@{name=$name;port=$spec.port;listenerPid=$pidValue;birthUtc=$facts.birthUtc;image=$facts.image;cwd=$facts.currentDirectory;identityMatches=$matches;processState=if($facts.readable){'listener'}else{'process_identity_unreadable'};health=$null;healthy=$false}
}
function Get-HealthSnapshot {
  $names=@('chain','api','worker','ui','release');$inventory=Get-PidRecords;$checks=@{}
  foreach($name in $names){$checks[$name]=Get-ServiceIdentity $name $inventory}
  if($checks.chain.listenerPid){
    try{
      $lineage=$policy.lineage;$id=Invoke-Rpc 'eth_chainId';$g=Invoke-Rpc 'eth_getBlockByNumber' @('0x0',$false);$headHex=Invoke-Rpc 'eth_blockNumber';$head=[convert]::ToInt64($headHex.Substring(2),16);$anchor=Invoke-Rpc 'eth_getBlockByNumber' @('0x'+([convert]::ToString([int]$lineage.anchorHeight,16)),$false);$nonceHex=Invoke-Rpc 'eth_call' @(@{to=$policy.safeAddress;data='0xaffed0e0'},'latest');$nonce=[bigint]::Parse($nonceHex.Substring(2),[Globalization.NumberStyles]::HexNumber);$trusted=Invoke-Guard 'lineage'
      $trustedHead=[bigint]::Parse([string]$trusted.result.highWater.trustedHead);$trustedNonce=[bigint]::Parse([string]$trusted.result.highWater.trustedNonce)
      $chainPass=($trusted.exitCode -eq 0 -and $trusted.result.pass -and $id -eq $policy.chainId -and $g.hash -eq $lineage.genesis -and $head -ge [int]$lineage.minimumHead -and $head -ge $trustedHead -and $anchor.hash -eq $lineage.anchorHash -and $nonce -ge [bigint]$lineage.minimumSafeNonce -and $nonce -ge $trustedNonce)
      $checks.chain.health=[pscustomobject]@{chainId=$id;genesis=$g.hash;head=$head;anchorHash=$anchor.hash;safeNonce=$nonce.ToString();trustedHead=$trustedHead.ToString();trustedSafeNonce=$trustedNonce.ToString();highWaterValid=[bool]$trusted.result.pass};$checks.chain.healthy=($checks.chain.identityMatches -and $chainPass)
    }catch{$checks.chain.health=[pscustomobject]@{errorClass='rpc_unavailable_or_invalid'};$checks.chain.healthy=$false}
  }
  $api=Invoke-Curl 'https://127.0.0.1:8103/health';if($checks.api.listenerPid){$checks.api.health=[pscustomobject]@{status=$api.status;ready=$api.json.ready;database=$api.json.database;chainStatus=$api.json.chain.status;chainId=$api.json.chainId};$checks.api.healthy=($checks.api.identityMatches -and $api.status -eq '200' -and $api.json.ready -eq $true -and $api.json.database -eq 'ready' -and $api.json.chain.status -eq 'ready' -and $api.json.chainId -eq 31337)}
  $worker=Invoke-Curl 'http://127.0.0.1:8113/status';if($checks.worker.listenerPid){$checks.worker.health=[pscustomobject]@{status=$worker.status;role=$worker.json.role;phase=$worker.json.phase;fence=$worker.json.fence;passes=$worker.json.passes;consecutiveFailures=$worker.json.consecutive_failures;retryExhausted=$worker.json.retry_exhausted;leaseName=$worker.json.lease.name};$checks.worker.healthy=($checks.worker.identityMatches -and $worker.status -eq '200' -and $worker.json.role -eq 'active' -and $worker.json.lease.name -eq 'indexer' -and $null -ne $worker.json.fence -and $worker.json.consecutive_failures -eq 0 -and -not $worker.json.retry_exhausted)}
  $ui=Invoke-Curl 'https://127.0.0.1:5103/';if($checks.ui.listenerPid){$checks.ui.health=[pscustomobject]@{status=$ui.status;title=([regex]::Match($ui.text,'<title>(.*?)</title>','IgnoreCase').Groups[1].Value)};$checks.ui.healthy=($checks.ui.identityMatches -and $ui.status -eq '200')}
  $rel=Invoke-Curl 'https://127.0.0.1:5113/';$relHealth=Invoke-Curl 'https://127.0.0.1:5113/health';$relManifest=Invoke-Curl 'https://127.0.0.1:5113/__release.json';if($checks.release.listenerPid){$distHash=Get-Hash (Join-Path $root 'dist\index.html');$served=$relManifest.json.dist_index_sha256;$checks.release.health=[pscustomobject]@{rootStatus=$rel.status;healthStatus=$relHealth.status;manifestStatus=$relManifest.status;servedBuildSha256=$served;localBuildSha256=$distHash};$checks.release.healthy=($checks.release.identityMatches -and $rel.status -eq '200' -and $relHealth.status -eq '200' -and $relManifest.status -eq '200' -and $served -eq $distHash)}
  $healthy=($names|Where-Object{-not $checks[$_].healthy}).Count -eq 0
  [pscustomobject]@{atUtc=[DateTime]::UtcNow.ToString('o');healthy=$healthy;pidInventory=[pscustomobject]@{valid=$inventory.valid;exists=$inventory.exists;errorCode=$inventory.errorCode};services=$checks}
}
function Assert-Resources([string]$stage){
  $drive=Get-PSDrive C;$os=Get-CimInstance Win32_OperatingSystem;$memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory;$available=[int64]$os.FreePhysicalMemory*1KB;$commit=[double]$memory.PercentCommittedBytesInUse
  $r=[pscustomobject]@{stage=$stage;atUtc=[DateTime]::UtcNow.ToString('o');cFreeBytes=[int64]$drive.Free;availableRamBytes=$available;perfOsCommitPercent=$commit;pass=([int64]$drive.Free -ge [int64]$policy.resourceGate.minimumCFreeBytes -and $available -ge [int64]$policy.resourceGate.minimumAvailableRamBytes -and $commit -lt [double]$policy.resourceGate.maximumPerfOsCommitPercentExclusive)}
  if(-not $r.pass){throw "WATCHDOG_RESOURCE_GATE_DEFERRED_$stage"};return $r
}
function Invoke-Guard([string]$action){Assert-NodeRuntime;$raw=& $node $guardPath $action 2>&1;$code=$LASTEXITCODE;$j=$null;try{$j=($raw -join "`n")|ConvertFrom-Json}catch{};return [pscustomobject]@{exitCode=$code;result=$j}}
function Has-UnsafeLiveProcesses($snapshot){
  if(-not $snapshot.pidInventory.valid){return $true}
  foreach($name in @('chain','api','worker','ui','release')){$s=$snapshot.services[$name];if($s.listenerPid -and (-not $s.identityMatches -or -not $s.healthy)){return $true};if(-not $s.listenerPid -and $s.processState -in @('recorded_process_alive_without_listener','legacy_pid_unverifiable','uninspectable','matching_process_alive_without_listener','process_scan_unreadable')){return $true}}
  return $false
}
function Get-MissingServices($snapshot){@('chain','api','worker','ui','release'|Where-Object{-not $snapshot.services[$_].listenerPid})}
function Is-AllPortsClosed($snapshot){(@('chain','api','worker','ui','release'|Where-Object{$snapshot.services[$_].listenerPid}).Count -eq 0)}
function Test-OperatorStop {
  $migration=$policy.legacyOperatorStopMigration
  if(-not $migration -or $migration.schema -ne 'alder.operator-stop-migration/v1' -or -not $migration.noLegacyMarkerFound){return $true}
  if(Test-Path -LiteralPath $stopMarker){return $true}
  foreach($legacy in @($migration.legacyMarkerPaths)){if($legacy -and (Test-Path -LiteralPath (Join-Path $root ([string]$legacy)))){return $true}}
  return $false
}
function Save-TaskOwnerRecord($record,[string]$path){
  $json=($record|ConvertTo-Json -Depth 10)+"`n";$tmp=$path+'.pending-'+[guid]::NewGuid().ToString('N')
  [IO.File]::WriteAllText($tmp,$json,[Text.UTF8Encoding]::new($false))
  if(Test-Path -LiteralPath $path){$previous=$path+'.previous-'+[guid]::NewGuid().ToString('N')+[IO.Path]::GetExtension($path);[IO.File]::Replace($tmp,$path,$previous)}else{[IO.File]::Move($tmp,$path)}
}
function Get-VerifiedBootstrapFloor {
  $state=Invoke-Guard 'state';if($state.exitCode -ne 0 -or -not $state.result.pass){throw 'WATCHDOG_LINEAGE_BASELINE_STATE_INVALID'}
  $checkpoint=$policy.lineage.trustedCheckpoint
  if([string]$state.result.state.bestHead -ne [string]$checkpoint.head -or [string]$state.result.reload.trusted.height -ne [string]$checkpoint.head -or [string]$state.result.reload.trusted.safeNonce -ne [string]$checkpoint.safeNonce -or $state.result.state.anchorHash -ne $policy.lineage.anchorHash -or $state.result.reload.lineCount -ne [int]$policy.lineage.legacyReloadPrefix.count -or $state.result.checkpoints.count -ne 0){throw 'WATCHDOG_LINEAGE_BASELINE_NOT_EXACT'}
  $reloadText=[IO.File]::ReadAllText((Join-Path $root ([string]$policy.paths.reloadPoints)))
  $checkpointPath=Join-Path $root ([string]$policy.paths.lineageCheckpoints);$checkpointText=if(Test-Path -LiteralPath $checkpointPath){[IO.File]::ReadAllText($checkpointPath)}else{$null}
  $historyText=$reloadText+"`n--CHECKPOINTS--`n"+$(if($null -eq $checkpointText){'<ABSENT>'}else{$checkpointText})
  return [pscustomobject]@{checkpoint=$checkpoint;historyDigest=(Get-TextHash $historyText)}
}
function Complete-PreparedHighWater($owner,[string]$ownerPath,[string]$highPath,$floor,[bool]$createReceipt){
  if($owner.schema -ne 'alder.watchdog.lineage-owner/v1' -or $owner.bootstrapState -ne 'prepared' -or [string]$owner.instanceId -notmatch '^[0-9a-f]{32}$'){throw 'WATCHDOG_LINEAGE_PREPARED_OWNER_INVALID'}
  if($createReceipt){
    $c=$floor.checkpoint
    $receipt=[ordered]@{schema='alder.watchdog.lineage-high-water/v1';instanceId=[string]$owner.instanceId;source='watchdog-bootstrap';acceptedAtUtc=[DateTime]::UtcNow.ToString('o');genesis=[string]$policy.lineage.genesis;anchorHeight=[int]$policy.lineage.anchorHeight;anchorHash=[string]$policy.lineage.anchorHash;head=[string]$c.head;headHash=[string]$policy.lineage.anchorHash;safeNonce=[string]$c.safeNonce;historyDigest=[string]$floor.historyDigest}
    $receiptLine=($receipt|ConvertTo-Json -Compress -Depth 5)+"`n";$receiptBytes=[Text.UTF8Encoding]::new($false).GetBytes($receiptLine);$highStream=[IO.File]::Open($highPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$highStream.Write($receiptBytes,0,$receiptBytes.Length);$highStream.Flush($true)}finally{$highStream.Dispose()}
  }else{
    $raw=[IO.File]::ReadAllText($highPath);$rows=@($raw -split "`r?`n"|Where-Object{$_})
    if($rows.Count -ne 1 -or -not $raw.EndsWith("`n")){throw 'WATCHDOG_PREPARED_HIGH_WATER_ROW_COUNT_INVALID'}
    try{$receipt=$rows[0]|ConvertFrom-Json -ErrorAction Stop}catch{throw 'WATCHDOG_PREPARED_HIGH_WATER_JSON_INVALID'}
    $c=$floor.checkpoint
    if($receipt.schema -ne 'alder.watchdog.lineage-high-water/v1' -or $receipt.instanceId -ne $owner.instanceId -or $receipt.source -ne 'watchdog-bootstrap' -or $receipt.genesis -ne $policy.lineage.genesis -or [int]$receipt.anchorHeight -ne [int]$policy.lineage.anchorHeight -or $receipt.anchorHash -ne $policy.lineage.anchorHash -or [string]$receipt.head -ne [string]$c.head -or $receipt.headHash -ne $policy.lineage.anchorHash -or [string]$receipt.safeNonce -ne [string]$c.safeNonce -or $receipt.historyDigest -ne $floor.historyDigest){throw 'WATCHDOG_PREPARED_HIGH_WATER_RECEIPT_MISMATCH'}
    $receiptLine=$rows[0]+"`n"
  }
  $owner.bootstrapState='seeded';$owner.latestReceiptSha256=Get-TextHash $receiptLine;$owner.latestHead=[string]$receipt.head;$owner.latestSafeNonce=[string]$receipt.safeNonce;$owner.latestHistoryDigest=[string]$receipt.historyDigest;Save-TaskOwnerRecord $owner $ownerPath
  $verify=Invoke-Guard 'lineage';if($verify.exitCode -ne 0 -or -not $verify.result.pass){throw 'WATCHDOG_LINEAGE_POST_BOOTSTRAP_RECHECK_FAILED'}
  return [string]$owner.instanceId
}
function Initialize-LineageAnchor([string]$newInstanceId){
  $ownerPath=Join-Path $root ([string]$policy.paths.lineageOwner);$highPath=Join-Path $root ([string]$policy.paths.lineageHighWater)
  $ownerExists=Test-Path -LiteralPath $ownerPath;$highExists=Test-Path -LiteralPath $highPath
  foreach($existingPath in @($ownerPath,$highPath)){if(Test-Path -LiteralPath $existingPath){$item=Get-Item -LiteralPath $existingPath -Force;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'WATCHDOG_LINEAGE_ANCHOR_FILE_UNSAFE'}}}
  if($ownerExists -and -not $highExists){$existingOwner=Get-Content -Raw -LiteralPath $ownerPath|ConvertFrom-Json -ErrorAction Stop;if($existingOwner.bootstrapState -ne 'prepared'){throw 'WATCHDOG_LINEAGE_HIGH_WATER_MISSING_REFUSING_RESEED'}}
  if($highExists -and -not $ownerExists){throw 'WATCHDOG_LINEAGE_OWNER_MISSING_REFUSING_RESEED'}
  if($ownerExists){try{$owner=Get-Content -Raw -LiteralPath $ownerPath|ConvertFrom-Json -ErrorAction Stop}catch{throw 'WATCHDOG_LINEAGE_OWNER_INVALID'}}
  else{$owner=[ordered]@{schema='alder.watchdog.lineage-owner/v1';instanceId=$newInstanceId;createdAtUtc=[DateTime]::UtcNow.ToString('o');bootstrapState='prepared';latestReceiptSha256=$null;latestHead=$null;latestSafeNonce=$null;latestHistoryDigest=$null};$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($owner|ConvertTo-Json -Depth 5)+"`n");$stream=[IO.File]::Open($ownerPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}}
  if($owner.bootstrapState -eq 'seeded' -and $highExists){$guard=Invoke-Guard 'lineage';if($guard.exitCode -ne 0 -or -not $guard.result.pass){throw 'WATCHDOG_EXISTING_LINEAGE_ANCHOR_INVALID'};return [string]$guard.result.highWater.last.instanceId}
  if($owner.bootstrapState -ne 'prepared'){throw 'WATCHDOG_LINEAGE_HIGH_WATER_MISSING_REFUSING_RESEED'}
  if(@(Get-ChildItem -LiteralPath $taskOwnerRoot -Filter 'owner-*.json' -File -ErrorAction SilentlyContinue).Count -gt 0){throw 'WATCHDOG_PRIOR_TASK_OWNER_EXISTS_WITHOUT_HIGH_WATER'}
  $floor=Get-VerifiedBootstrapFloor
  return Complete-PreparedHighWater $owner $ownerPath $highPath $floor (-not $highExists)
}
function Get-TaskXmlHash([string]$name,[string]$path){
  $xmlText=Export-ScheduledTask -TaskName $name -TaskPath $path -ErrorAction Stop|Out-String
  [xml]$xml=$xmlText;$enabled=$xml.SelectSingleNode("//*[local-name()='Settings']/*[local-name()='Enabled']")
  if($enabled){$enabled.InnerText='__PORTFOLIO_ALDER_ENABLED__'}
  return Get-TextHash $xml.OuterXml
}
function Get-PrincipalSid([string]$identity){
  if([string]::IsNullOrWhiteSpace($identity)){return $null}
  try{return ([Security.Principal.SecurityIdentifier]$identity).Value}catch{}
  try{$account=New-Object -TypeName System.Security.Principal.NTAccount -ArgumentList $identity;return $account.Translate([Security.Principal.SecurityIdentifier]).Value}catch{return $null}
}
function Test-SamePrincipalIdentity([string]$left,[string]$right){
  if([string]::IsNullOrWhiteSpace($left) -or [string]::IsNullOrWhiteSpace($right)){return $false}
  if([string]::Equals($left,$right,[StringComparison]::OrdinalIgnoreCase)){return $true}
  $leftSid=Get-PrincipalSid $left;$rightSid=Get-PrincipalSid $right
  return [bool]($leftSid -and $rightSid -and $leftSid -eq $rightSid)
}
function Test-TaskOwnerIdentity($task,$record,[bool]$allowPending=$false){
  if(-not $task -or $task.TaskName -cne $record.taskName -or $task.TaskPath -cne $record.taskPath -or $task.Description -cne $record.taskDescription){return $false}
  if($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -cne $record.actionExecute -or $task.Actions[0].Arguments -cne $record.actionArguments -or $task.Actions[0].WorkingDirectory -cne $record.actionWorkingDirectory){return $false}
  if(-not (Test-SamePrincipalIdentity ([string]$task.Principal.UserId) ([string]$record.principalUserId)) -or [string]$task.Principal.RunLevel -cne $record.principalRunLevel){return $false}
  if(-not $allowPending -and [string]$task.Principal.LogonType -cne $record.principalLogonType){return $false}
  $types=@($task.Triggers|ForEach-Object{$_.CimClass.CimClassName});if($types.Count -ne 2 -or $types -notcontains 'MSFT_TaskLogonTrigger' -or $types -notcontains 'MSFT_TaskDailyTrigger'){return $false}
  $logon=$task.Triggers|Where-Object{$_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'}|Select-Object -First 1
  $daily=$task.Triggers|Where-Object{$_.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger'}|Select-Object -First 1
  if(-not $logon -or -not (Test-SamePrincipalIdentity ([string]$logon.UserId) ([string]$record.principalUserId)) -or -not $daily -or $daily.Repetition.Interval -ne 'PT2M' -or $daily.Repetition.Duration -ne 'P1D' -or $daily.Repetition.StopAtDurationEnd){return $false}
  $settings=$task.Settings
  $settingNames=@($settings.PSObject.Properties.Name)
  if('DisallowStartIfOnBatteries' -notin $settingNames -or 'StopIfGoingOnBatteries' -notin $settingNames){return $false}
  if([string]$settings.MultipleInstances -ne 'IgnoreNew' -or -not $settings.StartWhenAvailable -or [bool]$settings.DisallowStartIfOnBatteries -or [bool]$settings.StopIfGoingOnBatteries){return $false}
  if([string]$settings.ExecutionTimeLimit -notin @('PT30M','00:30:00')){return $false}
  if($record.taskXmlSha256 -and (Get-TaskXmlHash $record.taskName $record.taskPath) -cne $record.taskXmlSha256){return $false}
  if(-not $allowPending){$isEnabled=($task.State -ne 'Disabled');if([bool]$record.enabled -ne $isEnabled){return $false}}
  return $true
}
function Find-TaskOwnerRecord($task,[bool]$includePrepared=$false){
  $files=@(Get-ChildItem -LiteralPath $taskOwnerRoot -Filter 'owner-*.json' -File -ErrorAction SilentlyContinue)
  $owners=@()
  foreach($file in $files){if($file.Name -match '\.previous-[0-9a-f]{32}\.json$'){continue}
    try{$record=Get-Content -Raw -LiteralPath $file.FullName|ConvertFrom-Json -ErrorAction Stop}catch{throw 'WATCHDOG_TASK_OWNER_RECORD_INVALID'}
    if($record.schema -ne 'alder.watchdog.task-owner/v1'){throw 'WATCHDOG_TASK_OWNER_RECORD_SCHEMA_INVALID'}
    $states=if($includePrepared){@('prepared','registered-disabled','enable-pending','registered')}else{@('registered','registered-disabled')}
    if($record.taskName -eq $taskName -and $record.taskPath -eq $taskPath -and $record.taskDescription -ceq $task.Description -and $record.installationState -in $states){$owners+=@([pscustomobject]@{path=$file.FullName;record=$record})}
  }
  if($owners.Count -ne 1){throw 'WATCHDOG_TASK_OWNER_RECORD_AMBIGUOUS_OR_MISSING'}
  return $owners[0]
}
function Test-ExpectedHashes {
  if(-not $ExpectedPolicySha256 -or -not $ExpectedScriptSha256){return $false}
  return ((Get-Hash $policyPath) -eq $ExpectedPolicySha256.ToLowerInvariant() -and (Get-Hash $scriptPath) -eq $ExpectedScriptSha256.ToLowerInvariant())
}
function Invoke-RepairChild {
  if(Test-OperatorStop){return Write-StatusRecord 'DEFERRED_OPERATOR_STOP' @{marker=$stopMarker}}
  if(-not (Test-ExpectedHashes)){return Write-StatusRecord 'DEFERRED_TASK_SOURCE_HASH_MISMATCH' @{} }
  $source=Get-SourceCheck;if(-not $source.pass){return Write-StatusRecord 'DEFERRED_APPROVED_SOURCE_PIN_MISMATCH' @{source=$source}}
  $snap=Get-HealthSnapshot
  if($snap.healthy){return Write-StatusRecord 'HEALTHY_NO_ACTION' @{health=$snap}}
  if(Has-UnsafeLiveProcesses $snap){return Write-StatusRecord 'DEFERRED_UNOWNED_OR_UNHEALTHY_LISTENER' @{health=$snap}}
  $missing=Get-MissingServices $snap
  if(-not $missing.Count){return Write-StatusRecord 'DEFERRED_HEALTH_NOT_READY' @{health=$snap}}
  if(-not $snap.services.chain.listenerPid -and -not (Is-AllPortsClosed $snap)){return Write-StatusRecord 'DEFERRED_CHAIN_DOWN_WITH_OTHER_LISTENERS' @{health=$snap}}
  $gate=Assert-Resources 'before-backup'
  $guard=Invoke-Guard 'lineage';if($guard.exitCode -ne 0 -or -not $guard.result.pass){return Write-StatusRecord 'DEFERRED_LINEAGE_GUARD_FAILED' @{guard=$guard.result;resources=$gate}}
  Ensure-PrivateDirectory
  $stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N')
  $receipt=Join-Path $receiptRoot ("backup-$stamp.json")
  if(Test-Path -LiteralPath $receipt){return Write-StatusRecord 'DEFERRED_BACKUP_RECEIPT_COLLISION' @{receipt=$receipt}}
  $offline=Is-AllPortsClosed $snap
  if($offline){$backupArgs=@('-B',$backupScript,'--backup-only','--offline-state',(Join-Path $root 'chain-state\anvil-8547-state.json'),'--receipt',$receipt)}else{$backupArgs=@('-B',$backupScript,'--backup-only','--receipt',$receipt)}
  $backupOutput=& $python @backupArgs 2>&1;$backupExit=$LASTEXITCODE
  if($backupExit -ne 0 -or -not (Test-Path -LiteralPath $receipt)){return Write-StatusRecord 'DEFERRED_BACKUP_FAILED' @{exitCode=$backupExit;receipt=$receipt;outputCategory='backup_helper_failed'}}
  $backup=Get-Content -Raw -LiteralPath $receipt|ConvertFrom-Json
  if($backup.chain_id -ne $policy.chainId -or $backup.chain_genesis_hash -ne $policy.lineage.genesis -or [int]$backup.chain_head_number -lt [int]$policy.lineage.minimumHead){return Write-StatusRecord 'DEFERRED_BACKUP_LINEAGE_MISMATCH' @{receipt=$receipt;chainId=$backup.chain_id;head=$backup.chain_head_number;genesis=$backup.chain_genesis_hash}}
  $started=[System.Collections.Generic.List[string]]::new()
  foreach($name in $missing){
    if(Test-OperatorStop){return Write-StatusRecord 'DEFERRED_OPERATOR_STOP_DURING_REPAIR' @{started=@($started);receipt=$receipt}}
    $currentSource=Get-SourceCheck;if(-not $currentSource.pass){return Write-StatusRecord 'DEFERRED_SOURCE_PIN_CHANGED_DURING_REPAIR' @{started=@($started);receipt=$receipt}}
    $resource=Assert-Resources "before-start-$name"
    if($name -eq 'chain'){$stateGuard=Invoke-Guard 'lineage';if($stateGuard.exitCode -ne 0 -or -not $stateGuard.result.pass){return Write-StatusRecord 'DEFERRED_LINEAGE_GUARD_FAILED_BEFORE_CHAIN' @{guard=$stateGuard.result;started=@($started);receipt=$receipt}}}
    $serviceScriptHash=[string]$policy.sourcePins.PSObject.Properties['ops/round4-services.ps1'].Value
    $startOutput=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $servicesScript start $name -ExpectedPolicySha256 $ExpectedPolicySha256 -ExpectedScriptSha256 $serviceScriptHash 2>&1
    if($LASTEXITCODE -ne 0){return Write-StatusRecord 'PARTIAL_START_FAILED' @{service=$name;started=@($started);receipt=$receipt;exitCode=$LASTEXITCODE;outputCategory='round4_start_failed'}}
    $started.Add($name)
    $record=Get-PidRecords;$identity=Get-ServiceIdentity $name $record
    if(-not $identity.listenerPid -or -not $identity.identityMatches){return Write-StatusRecord 'PARTIAL_START_IDENTITY_UNVERIFIED' @{service=$name;started=@($started);receipt=$receipt}}
    if($name -eq 'chain'){$verify=Invoke-Guard 'all';if($verify.exitCode -ne 0 -or -not $verify.result.source.pass -or -not $verify.result.state.pass){return Write-StatusRecord 'PARTIAL_CHAIN_RELOAD_GUARD_FAILED' @{service=$name;started=@($started);receipt=$receipt;guard=$verify.result}}}
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(90);$final=$null
  do{$final=Get-HealthSnapshot;if($final.healthy){break};Start-Sleep -Seconds 3}while([DateTime]::UtcNow -lt $deadline)
  if(-not $final.healthy){return Write-StatusRecord 'PARTIAL_HEALTH_NOT_READY_NO_RESTART' @{started=@($started);receipt=$receipt;health=$final}}
  $backupHash=Get-Hash $receipt
  return Write-StatusRecord 'RESTORED_AND_HEALTHY' @{started=@($started);backupReceipt=$receipt;backupReceiptSha256=$backupHash;health=$final}
}
function Invoke-LockedRepair {
  if(Test-OperatorStop){return Write-StatusRecord 'DEFERRED_OPERATOR_STOP' @{marker=$stopMarker}}
  if(-not (Test-ExpectedHashes)){return Write-StatusRecord 'DEFERRED_TASK_SOURCE_HASH_MISMATCH' @{} }
  Ensure-PrivateDirectory
  $stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N')
  $log=Join-Path $runRoot ("repair-$stamp.log")
  $childArgs=@('-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',$scriptPath,'repair-locked','-ExpectedPolicySha256',$ExpectedPolicySha256,'-ExpectedScriptSha256',$ExpectedScriptSha256)
  $command=@('powershell.exe')+$childArgs
  $pythonArgs=@('-B',$lockWrapper,'--product','alder','--purpose','alder-watchdog-repair','--cwd',$root,'--log',$log,'--')+$command
  $result=& $python @pythonArgs 2>&1
  $exit=$LASTEXITCODE
  $outcome=if($exit -eq 0){'REPAIR_CHILD_COMPLETED'}elseif($exit -eq 3){'DEFERRED_RESOURCE_GATE'}elseif($exit -eq 4){'DEFERRED_SHARED_LOCK_HELD'}else{'REPAIR_FAILED_OR_PARTIAL'}
  return Write-StatusRecord $outcome @{exitCode=$exit;lockedLog=$log}
}

switch($Action){
  'status' {
    $health=Get-HealthSnapshot
    $task=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue|Select-Object -First 1
    $last=Get-ChildItem -LiteralPath $privateRoot -Filter 'status-*.json' -File -ErrorAction SilentlyContinue|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 1
    [pscustomobject]@{taskName=$taskName;taskInstalled=[bool]$task;taskState=if($task){$task.State}else{$null};operatorStopPresent=(Test-OperatorStop);operatorStopMigrationVerified=[bool]$policy.legacyOperatorStopMigration.noLegacyMarkerFound;pidInventory=$health.pidInventory;healthy=$health.healthy;services=$health.services;latestStatusRecord=if($last){$last.FullName}else{$null}}|ConvertTo-Json -Depth 9
  }
  'operator-stop' {
    Ensure-PrivateDirectory
    if(Test-Path -LiteralPath $stopMarker){Write-Output '{"status":"OPERATOR_STOP_ALREADY_PRESENT","servicesUnchanged":true}';break}
    $record=[ordered]@{schema='alder.watchdog.operator-stop/v1';atUtc=[DateTime]::UtcNow.ToString('o');userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;instruction='Automatic starts and restarts are disabled until an explicit operator-resume archives this marker.'}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Depth 3)+"`n")
    $stream=[IO.File]::Open($stopMarker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    Write-Output '{"status":"OPERATOR_STOP_RECORDED","servicesUnchanged":true}'
  }
  'operator-resume' {
    if(-not (Test-Path -LiteralPath $stopMarker)){Write-Output '{"status":"NO_OPERATOR_STOP_MARKER"}';break}
    Ensure-PrivateDirectory
    $archive=Join-Path $privateRoot ('operator-stop-archived-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'.marker')
    [IO.File]::Move($stopMarker,$archive)
    Write-Output '{"status":"OPERATOR_STOP_ARCHIVED_EXPLICITLY","noServicesStarted":true}'
  }
  'install' {
    if(Test-OperatorStop){throw 'WATCHDOG_OPERATOR_STOP_PRESENT_OR_MIGRATION_UNVERIFIED'}
    $source=Get-SourceCheck;if(-not $source.pass){throw 'WATCHDOG_APPROVED_SOURCE_PIN_MISMATCH'}
    $existing=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue|Select-Object -First 1
    if($existing){throw 'WATCHDOG_TASK_ALREADY_EXISTS_REFUSING_OVERWRITE'}
    Ensure-PrivateDirectory
    $lineageId=Initialize-LineageAnchor ([guid]::NewGuid().ToString('N'))
    $policyHash=Get-Hash $policyPath;$scriptHash=Get-Hash $scriptPath
    $psExe=Join-Path $PSHOME 'powershell.exe'
    $arguments="-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$scriptPath`" tick -ExpectedPolicySha256 $policyHash -ExpectedScriptSha256 $scriptHash"
    $taskAction=New-ScheduledTaskAction -Execute $psExe -Argument $arguments -WorkingDirectory $root
    $user=([Security.Principal.WindowsIdentity]::GetCurrent()).Name
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $onLogon=New-ScheduledTaskTrigger -AtLogOn -User $user
    $daily=New-ScheduledTaskTrigger -Daily -At '12:00AM'
    $daily.Repetition=New-CimInstance -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskRepetitionPattern' -ClientOnly -Property @{Interval='PT2M';Duration='P1D';StopAtDurationEnd=$false}
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;$settings.Enabled=$false
    $installationId=[guid]::NewGuid().ToString('N');$ownerFile=Join-Path $taskOwnerRoot "owner-$installationId.json"
    $installDescription="$taskDescription owner=$installationId"
    $owner=[ordered]@{schema='alder.watchdog.task-owner/v1';installationId=$installationId;lineageInstanceId=$lineageId;taskName=$taskName;taskPath=$taskPath;taskDescription=$installDescription;installationState='prepared';createdAtUtc=[DateTime]::UtcNow.ToString('o');policySha256=$policyHash;scriptSha256=$scriptHash;actionExecute=$psExe;actionArguments=$arguments;actionWorkingDirectory=$root;principalUserId=$user;principalLogonType=[string]$principal.LogonType;principalRunLevel=[string]$principal.RunLevel;taskXmlSha256=$null;enabled=$false}
    $ownerBytes=[Text.UTF8Encoding]::new($false).GetBytes(($owner|ConvertTo-Json -Depth 10)+"`n")
    $ownerStream=[IO.File]::Open($ownerFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$ownerStream.Write($ownerBytes,0,$ownerBytes.Length);$ownerStream.Flush($true)}finally{$ownerStream.Dispose()}
    try{
      Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $taskAction -Trigger @($onLogon,$daily) -Settings $settings -Principal $principal -Description $installDescription|Out-Null
      $registered=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
      $owner.principalUserId=[string]$registered.Principal.UserId;$owner.principalLogonType=[string]$registered.Principal.LogonType;$owner.principalRunLevel=[string]$registered.Principal.RunLevel
      $owner.taskXmlSha256=Get-TaskXmlHash $taskName $taskPath
      if(-not (Test-TaskOwnerIdentity $registered $owner $true) -or $registered.State -ne 'Disabled'){throw 'WATCHDOG_TASK_POSTREGISTER_IDENTITY_MISMATCH'}
      $owner.installationState='registered-disabled';$owner.enabled=$false;$owner.registeredAtUtc=[DateTime]::UtcNow.ToString('o');Save-TaskOwnerRecord $owner $ownerFile
      $owner.installationState='enable-pending';Save-TaskOwnerRecord $owner $ownerFile
      Enable-ScheduledTask -TaskName $taskName -TaskPath $taskPath|Out-Null
      $enabled=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop;$owner.installationState='registered';$owner.enabled=$true
      if(-not (Test-TaskOwnerIdentity $enabled $owner)){throw 'WATCHDOG_TASK_POSTENABLE_IDENTITY_MISMATCH'}
      Save-TaskOwnerRecord $owner $ownerFile
      Write-Output '{"status":"TASK_REGISTERED_AND_ENABLED","taskName":"PortfolioAlderWatchdog","identityRecord":"private task-owner record","initialTick":"next scheduler trigger","servicesUnchanged":true}'
    }catch{
      $failure=$_.Exception.Message
      $current=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue|Select-Object -First 1
      if($current -and (Test-TaskOwnerIdentity $current $owner $true)){
        if($current.State -ne 'Disabled'){Disable-ScheduledTask -TaskName $taskName -TaskPath $taskPath|Out-Null}
        $disabled=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue|Select-Object -First 1
        if($disabled -and $disabled.State -eq 'Disabled' -and (Test-TaskOwnerIdentity $disabled $owner $true)){$owner.installationState='registered-disabled';$owner.enabled=$false;if(-not $owner.taskXmlSha256){$owner.taskXmlSha256=Get-TaskXmlHash $taskName $taskPath};Save-TaskOwnerRecord $owner $ownerFile}
      }
      throw "WATCHDOG_TASK_INSTALL_FAILED_RECOVERY_RECORD_RETAINED: $failure"
    }
  }
  'recover-install' {
    $task=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue|Select-Object -First 1
    if(-not $task){Write-Output '{"status":"NO_PARTIAL_TASK_TO_RECOVER"}';break}
    $owned=Find-TaskOwnerRecord $task $true;$record=$owned.record
    if(-not (Test-TaskOwnerIdentity $task $record $true)){throw 'WATCHDOG_PARTIAL_TASK_IDENTITY_UNVERIFIABLE_REFUSING_CHANGE'}
    if($task.State -ne 'Disabled'){Disable-ScheduledTask -TaskName $taskName -TaskPath $taskPath|Out-Null}
    $task=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
    if($task.State -ne 'Disabled' -or -not (Test-TaskOwnerIdentity $task $record $true)){throw 'WATCHDOG_PARTIAL_TASK_DISABLE_UNVERIFIED'}
    $record.principalUserId=[string]$task.Principal.UserId;$record.principalLogonType=[string]$task.Principal.LogonType;$record.principalRunLevel=[string]$task.Principal.RunLevel
    $record.taskXmlSha256=Get-TaskXmlHash $taskName $taskPath;$record.installationState='registered-disabled';$record.enabled=$false;$record|Add-Member -NotePropertyName recoveredAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force;Save-TaskOwnerRecord $record $owned.path
    Write-Output '{"status":"PARTIAL_INSTALL_RECOVERED_DISABLED","taskRemainsDisabled":true,"ownerRecordPreserved":true,"servicesUnchanged":true}'
  }
  'uninstall' {
    $task=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue|Select-Object -First 1
    if(-not $task){Write-Output '{"status":"TASK_NOT_INSTALLED"}';break}
    $owned=Find-TaskOwnerRecord $task;$record=$owned.record
    if($record.installationState -notin @('registered','registered-disabled') -or -not (Test-TaskOwnerIdentity $task $record)){throw 'WATCHDOG_TASK_IDENTITY_MISMATCH_REFUSING_UNINSTALL'}
    if($record.actionArguments -notlike "*-File `"$scriptPath`" tick -ExpectedPolicySha256 $($record.policySha256) -ExpectedScriptSha256 $($record.scriptSha256)" -or $record.policySha256 -notmatch '^[0-9a-f]{64}$' -or $record.scriptSha256 -notmatch '^[0-9a-f]{64}$'){throw 'WATCHDOG_TASK_PIN_RECORD_MISMATCH_REFUSING_UNINSTALL'}
    Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
    $record.installationState='uninstalled';$record|Add-Member -NotePropertyName uninstalledAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force;Save-TaskOwnerRecord $record $owned.path
    Write-Output '{"status":"TASK_UNREGISTERED","ownerRecordPreserved":true,"operatorStopMarkerPreserved":true,"privateEvidencePreserved":true}'
  }
  'tick' {
    if(-not (Test-ExpectedHashes)){Write-StatusRecord 'DEFERRED_TASK_SOURCE_HASH_MISMATCH' @{}|Out-Null;exit 0}
    if(Test-OperatorStop){Write-StatusRecord 'DEFERRED_OPERATOR_STOP' @{marker=$stopMarker}|Out-Null;exit 0}
    $source=Get-SourceCheck;if(-not $source.pass){Write-StatusRecord 'DEFERRED_APPROVED_SOURCE_PIN_MISMATCH' @{source=$source}|Out-Null;exit 0}
    $health=Get-HealthSnapshot
    if($health.healthy){Write-StatusRecord 'HEALTHY_NO_ACTION' @{health=$health}|Out-Null;exit 0}
    if(Has-UnsafeLiveProcesses $health){Write-StatusRecord 'DEFERRED_UNOWNED_OR_UNHEALTHY_LISTENER' @{health=$health}|Out-Null;exit 0}
    Invoke-LockedRepair|Out-Null
  }
  'repair-locked' {
    if(-not (Test-ExpectedHashes)){throw 'WATCHDOG_TASK_SOURCE_HASH_MISMATCH'}
    $lock=& $python '-B' $lockStatus 'status' 2>$null|ConvertFrom-Json
    if(-not $lock.held -or $lock.owner.product -ne 'alder' -or $lock.owner.purpose -ne 'alder-watchdog-repair' -or $lock.owner_gone[0] -ne $false){Write-StatusRecord 'DEFERRED_LOCK_IDENTITY_MISMATCH' @{lockHeld=$lock.held;product=$lock.owner.product;purpose=$lock.owner.purpose}|Out-Null;exit 0}
    Invoke-RepairChild|Out-Null
  }
}
