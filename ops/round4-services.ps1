# Alder local services (round 4; round 5 adds the separate indexer/outbox worker). Usage:
#   powershell -File ops/round4-services.ps1 start|stop|restart|status [chain|api|worker|ui|all]
# The worker listens only on 127.0.0.1:8113 for GET /status; it holds the single-writer `indexer` lease.
# Starts loopback-only Anvil 8547 (persistent state), API 8103 and Vite UI 5103 as detached processes.
# Round 6: API (https://127.0.0.1:8103), dev UI (https://127.0.0.1:5103) and the built-bundle release server
# (https://127.0.0.1:5113, `release`, serves dist/) use the local CA/cert in .local/tls (ops/local-tls.sh).
# PIDs are recorded in runtime-logs/pids.json; stop only kills the recorded PID that still owns the port.
param([string]$Action='status',[string]$Which='all',[string]$ExpectedPolicySha256,[string]$ExpectedScriptSha256)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$logs=Join-Path $root 'runtime-logs'
$pidFile=Join-Path $logs 'pids.json'
$identitySource=Join-Path $PSScriptRoot 'alder-watchdog-process.cs'
$guardSource=Join-Path $PSScriptRoot 'alder-watchdog-guard.mjs'
$policyPath=Join-Path $PSScriptRoot 'alder-watchdog-policy.json'
$scriptPath=$PSCommandPath
function FileHash([string]$file){if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'ALDER_BOOTSTRAP_FILE_MISSING'};if((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'ALDER_BOOTSTRAP_REPARSE_REFUSED'};$s=[Security.Cryptography.SHA256]::Create();try{$f=[IO.File]::OpenRead($file);try{return ([BitConverter]::ToString($s.ComputeHash($f))).Replace('-','').ToLowerInvariant()}finally{$f.Dispose()}}finally{$s.Dispose()}}
if([bool]$ExpectedPolicySha256 -ne [bool]$ExpectedScriptSha256){throw 'ALDER_EXPECTED_POLICY_AND_SCRIPT_HASHES_REQUIRED_TOGETHER'}
if($ExpectedPolicySha256){if((FileHash $policyPath) -ne $ExpectedPolicySha256.ToLowerInvariant()){throw 'ALDER_POLICY_HASH_MISMATCH_BEFORE_LOAD'};if((FileHash $scriptPath) -ne $ExpectedScriptSha256.ToLowerInvariant()){throw 'ALDER_SCRIPT_HASH_MISMATCH_BEFORE_POLICY_LOAD'}}
$policy=Get-Content -Raw -LiteralPath $policyPath|ConvertFrom-Json -ErrorAction Stop
foreach($entry in @(@{path=$scriptPath;pin='ops/round4-services.ps1';name='SCRIPT'},@{path=$guardSource;pin='ops/alder-watchdog-guard.mjs';name='GUARD'},@{path=$identitySource;pin='ops/alder-watchdog-process.cs';name='PROCESS_HELPER'})){if((FileHash $entry.path) -ne [string]$policy.sourcePins.PSObject.Properties[$entry.pin].Value){throw "ALDER_$($entry.name)_PIN_MISMATCH_BEFORE_HELPER"}}
if($ExpectedPolicySha256 -and ((FileHash $policyPath) -ne $ExpectedPolicySha256.ToLowerInvariant() -or (FileHash $scriptPath) -ne $ExpectedScriptSha256.ToLowerInvariant())){throw 'ALDER_EXPECTED_HASH_CHANGED_DURING_BOOTSTRAP'}
$node=Join-Path $root '.local\runtime\node-v26.7.0\node.exe'
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){ throw 'ALDER_NODE_RUNTIME_MISSING' }
if((FileHash $node) -ne [string]$policy.runtime.nodeSha256){throw 'ALDER_NODE_RUNTIME_HASH_MISMATCH'}
$sha=[System.Security.Cryptography.SHA256]::Create()
try { $stream=[System.IO.File]::OpenRead($node); try { $nodeHash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose() } }
finally { $sha.Dispose() }
if($nodeHash -ne 'e921fe5307e29bf6fd00000dd594356affd3a7b044e52720c7f10decbdc305b9'){ throw 'ALDER_NODE_RUNTIME_HASH_MISMATCH' }
$sha=[System.Security.Cryptography.SHA256]::Create()
try { $stream=[System.IO.File]::OpenRead($identitySource); try { $identityHash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose() } }
finally { $sha.Dispose() }
if($identityHash -ne [string]$policy.sourcePins.PSObject.Properties['ops/alder-watchdog-process.cs'].Value){throw 'ALDER_PROCESS_IDENTITY_HELPER_HASH_MISMATCH'}
$nodeVersion=& $node --version
if($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v26.7.0'){ throw 'ALDER_NODE_RUNTIME_VERSION_MISMATCH' }
if(-not ('AlderWatchdogProcess' -as [type])){ Add-Type -Path $identitySource }
New-Item -ItemType Directory -Force $logs | Out-Null
$svc=[ordered]@{
 chain=@{port=8547;exe='C:\Users\user\.foundry\bin\anvil.exe';args=@('--host','127.0.0.1','--port','8547','--chain-id','31337','--hardfork','shanghai','--silent','--state',(Join-Path $root 'chain-state\anvil-8547-state.json'),'--state-interval','5');rolePattern='anvil\.exe.*--port 8547.*--state.*anvil-8547-state\.json'};
 api=@{port=8103;exe=$node;args=@('--import','tsx','apps/api/main.ts');rolePattern='apps/api/main\.ts'};
 worker=@{port=8113;exe=$node;args=@('--import','tsx','services/indexer-worker.ts');rolePattern='services/indexer-worker\.ts'};
 ui=@{port=5103;exe=$node;args=@('node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5103','--strictPort');rolePattern='vite\.js.*--port 5103'};
 release=@{port=5113;exe=$node;args=@('--import','tsx','ops/release-server.ts');rolePattern='ops/release-server\.ts'}
}
function Load(){
 if(-not (Test-Path -LiteralPath $pidFile)){return @{}}
 try{
   $o=Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json -ErrorAction Stop
   if($null -eq $o -or $o -is [array] -or $o -isnot [pscustomobject]){throw 'PID_INVENTORY_ROOT_INVALID'}
   $h=@{}
   foreach($p in $o.PSObject.Properties){
     if($p.Name -notin @('chain','api','worker','ui','release') -or $null -eq $p.Value -or $p.Value -isnot [pscustomobject]){throw 'PID_INVENTORY_RECORD_INVALID'}
     $pidValue=0;if(-not [int]::TryParse([string]$p.Value.pid,[ref]$pidValue) -or $pidValue -le 0){throw 'PID_INVENTORY_PID_INVALID'}
     $h[$p.Name]=$p.Value
   }
   return $h
 }catch{throw 'ALDER_PID_INVENTORY_INVALID_REFUSING_SERVICE_ACTION'}
}
function Save($h){ $h | ConvertTo-Json | Set-Content -Encoding utf8 $pidFile }
function Owner($port){ $c=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}else{$null} }
function Has-RoleProcess([string]$name){
 $s=$svc[$name]
 try{$items=Get-CimInstance Win32_Process -ErrorAction Stop}catch{throw 'ALDER_PROCESS_INVENTORY_UNREADABLE_REFUSING_START'}
 foreach($w in $items){if($w.ExecutablePath -ieq $s.exe -and [string]$w.CommandLine -match $s.rolePattern){
   # Isolated P6 services use the same entrypoint but a distinct listener.
   # Ignore only the matching process that positively owns that known port;
   # a matching process with no listener still refuses duplicate startup.
   $isolatedPort=if($name -eq 'worker'){9113}elseif($name -eq 'api'){9103}else{0}
   if($isolatedPort -and (Owner $isolatedPort) -eq [int]$w.ProcessId){continue}
   return $true
 }}
 return $false
}
function NormalizePath([string]$value){[IO.Path]::GetFullPath($value).TrimEnd([char[]]@('\','/'))}
function TextHash([string]$value){ $sha=[System.Security.Cryptography.SHA256]::Create();try{$bytes=[System.Text.Encoding]::UTF8.GetBytes($value);return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()} }
function ProcessInfo($pidValue,$name){ $w=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue;if(-not $w){return $null};$p=Get-Process -Id $pidValue -ErrorAction SilentlyContinue;if(-not $p){return $null};$cwd=[AlderWatchdogProcess]::GetCurrentDirectory([int]$pidValue);return @{pid=[int]$pidValue;birthUtc=$p.StartTime.ToUniversalTime().ToString('o');image=$w.ExecutablePath;commandLineSha256=(TextHash ([string]$w.CommandLine));roleCommandMatches=($w.CommandLine -match $svc[$name].rolePattern);currentDirectory=(NormalizePath $cwd)} }
function Owned($name,$record,$pidValue){ if(-not $record -or [int]$record.pid -ne [int]$pidValue){return $false};$actual=ProcessInfo $pidValue $name;if(-not $actual){return $false};$s=$svc[$name];return ($record.birthUtc -eq $actual.birthUtc -and $record.image -ieq $actual.image -and $record.commandLineSha256 -eq $actual.commandLineSha256 -and $actual.image -ieq $s.exe -and $actual.roleCommandMatches -and $actual.currentDirectory -ieq (NormalizePath $root) -and (NormalizePath $record.requestedCwd) -ieq (NormalizePath $root)) }
function Start-One($name){ $s=$svc[$name]; $h=Load; if(Owner $s.port){ Write-Output "$name already listening on $($s.port) pid $(Owner $s.port)"; return }; if(Has-RoleProcess $name){throw "$name MATCHING_PROCESS_WITHOUT_LISTENER_REFUSING_DUPLICATE_START"}
 if($name -eq 'chain'){ & $node (Join-Path $root 'ops/alder-watchdog-guard.mjs') lineage; if($LASTEXITCODE -ne 0){ throw 'CHAIN_STATE_LINEAGE_GUARD_FAILED' }; & $node (Join-Path $root 'ops/sanitize-anvil-state.mjs') (Join-Path $root 'chain-state/anvil-8547-state.json') '0x6ae4a90c' | Write-Output; if($LASTEXITCODE -ne 0){ throw 'STATE_SANITIZE_FAILED' } }
 $ts=Get-Date -Format 'yyyyMMddTHHmmss'; $out=Join-Path $logs "$name-$ts.out.log"; $err=Join-Path $logs "$name-$ts.err.log"
 # Win32_Process.Create: no inherited handles, so callers (bash/node pipes) never wait on the long-lived service.
 $cmd='cmd.exe /d /c ""' + $s.exe + '" ' + (($s.args | ForEach-Object { if($_ -match ' '){'"'+$_+'"'}else{$_} }) -join ' ') + ' > "' + $out + '" 2> "' + $err + '""'
 # Keep background runtime out of the launcher's console/control-event group.
 $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{CreateFlags=[uint32]520;ShowWindow=[uint16]0}
 $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd;CurrentDirectory=$root;ProcessStartupInformation=$startup}
 if($r.ReturnValue -ne 0){throw "$name WIN32_PROCESS_CREATE_FAILED_$($r.ReturnValue)"}
 for($i=0;$i -lt 60 -and -not (Owner $s.port);$i++){ Start-Sleep -Milliseconds 500 }
 if($name -eq 'chain' -and (Owner $s.port)){ Push-Location $root; try{ & $node (Join-Path $root 'ops/verify-chain-identity.mjs') | Write-Output; $ok=$LASTEXITCODE }finally{ Pop-Location }; if($ok -ne 0){ throw 'CHAIN_IDENTITY_MISMATCH: listener retained for operator inspection; refusing dependent services' } }
 $o=Owner $s.port; $identity=ProcessInfo $o $name;if(-not $identity -or $identity.image -ine $s.exe -or -not $identity.roleCommandMatches -or $identity.currentDirectory -ine (NormalizePath $root)){throw "$name process identity mismatch; listener retained for operator inspection"};$h[$name]=@{pid=$o;wrapper=$r.ProcessId;port=$s.port;started=(Get-Date).ToUniversalTime().ToString('o');birthUtc=$identity.birthUtc;image=$identity.image;commandLineSha256=$identity.commandLineSha256;requestedCwd=(NormalizePath $root);rolePattern=$s.rolePattern;log="$name-$ts"}; Save $h
 Write-Output "$name started pid $o (wrapper $($r.ProcessId)) listening=$([bool]$o)" }
function Stop-One($name){ $s=$svc[$name]; $o=Owner $s.port; $h=Load
 if(-not $o){ Write-Output "$name not listening"; return }
 if(Owned $name $h[$name] $o){ if($name -eq 'chain'){ & $node (Join-Path $root 'ops/chain-prestop-dump.mjs') (Join-Path $root 'chain-state/anvil-8547-state.json') | Write-Output; if($LASTEXITCODE -ne 0){throw 'CHAIN_PRESTOP_SNAPSHOT_FAILED_REFUSING_STOP'}; Start-Sleep -Seconds 7 } # atomic pre-stop snapshot, then let --state-interval 5 dump before a hard stop
   if(-not (Owned $name $h[$name] (Owner $s.port))){Write-Output "$name identity changed after pre-stop wait; refusing stop";return}
   Stop-Process -Id $o -Force; Write-Output "$name stopped pid $o" }
 else { Write-Output "$name port $($s.port) owned by pid $o without exact recorded pid/birth/image/cwd/command identity; refusing (stop it explicitly)" } }
$names= if($Which -eq 'all'){ @('chain','api','worker','ui','release') } else { @($Which) }
switch($Action){
 'start'{ foreach($n in $names){Start-One $n} }
 'stop'{ [array]::Reverse($names); foreach($n in $names){Stop-One $n} }
 'restart'{ $r=$names.Clone(); [array]::Reverse($r); foreach($n in $r){Stop-One $n}; Start-Sleep 1; foreach($n in $names){Start-One $n} }
 default{ foreach($n in $names){ $line="$n port $($svc[$n].port) pid $(Owner $svc[$n].port)"; if($n -eq 'worker' -and (Owner 8113)){ try{ $st=Invoke-RestMethod -Uri 'http://127.0.0.1:8113/status' -TimeoutSec 3; $line+=" role=$($st.role) fence=$($st.fence) phase=$($st.phase) passes=$($st.passes) failures=$($st.consecutive_failures)" }catch{ $line+=' status=unreachable' } }; Write-Output $line } }
}
