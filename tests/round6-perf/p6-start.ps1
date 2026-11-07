# Round 6 perf (P6) isolated stack launcher. Usage: p6-start.ps1 api|worker|stop-api|stop-worker|status
# Only ever touches 9103 (isolated API), 9113 (isolated worker status), scratch PG 15543 and RPC 18547 (proxy -> Anvil 18548).
# Never touches live 8103/8113/5103/8547/5543. Credentials are not handled here (scratch roles use local trust auth).
param([string]$What='status')
$root='C:\Users\user\portfolio-build\alder'; $logs="$root\.local\scratch-r6\runtime"; $runEnv=''
if($env:P6_RUN_ID){
 if($env:P6_RUN_ID -notmatch '^p6-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{4,20}$'){throw 'P6_RUN_ID_INVALID'}
 $runRoot=Join-Path $root ('.local\scratch-r6\runs\'+$env:P6_RUN_ID)
 $logs=Join-Path $runRoot 'runtime'; New-Item -ItemType Directory -Force $logs | Out-Null
 $runEnv='set P6_RUN_ID='+$env:P6_RUN_ID+'&& '
 $reloadPoints='.local/scratch-r6/runs/'+$env:P6_RUN_ID+'/reload-points-18548.jsonl'
 $workerLog='.local/scratch-r6/runs/'+$env:P6_RUN_ID+'/runtime/worker.jsonl'
 $notifications='.local/scratch-r6/runs/'+$env:P6_RUN_ID+'/notifications'
}else{
 New-Item -ItemType Directory -Force $logs | Out-Null
 $reloadPoints='.local/scratch-r6/reload-points-18548.jsonl'
 $workerLog='.local/scratch-r6/runtime/worker.jsonl'
 $notifications='.local/scratch-r6/notifications'
}
$node=Join-Path $root '.local\runtime\node-v26.7.0\node.exe'
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){ throw 'P6_NODE_RUNTIME_MISSING' }
$sha=[System.Security.Cryptography.SHA256]::Create()
try { $stream=[System.IO.File]::OpenRead($node); try { $nodeHash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose() } }
finally { $sha.Dispose() }
if($nodeHash -ne 'e921fe5307e29bf6fd00000dd594356affd3a7b044e52720c7f10decbdc305b9'){ throw 'P6_NODE_RUNTIME_HASH_MISMATCH' }
$nodeVersion=& $node --version
if($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v26.7.0'){ throw 'P6_NODE_RUNTIME_VERSION_MISMATCH' }
function Owner($port){ $c=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}else{$null} }
$ts=Get-Date -Format 'yyyyMMddTHHmmss'
$common=$runEnv+'set ALDER_RPC_URL=http://127.0.0.1:18547&& set ALDER_DEPLOYMENT_FILE=evidence/round5-ops/isolated-deployment.json&& set ALDER_RELOAD_POINTS_FILE='+$reloadPoints+'&& '
function Stop-Own($port,$pattern){ $o=Owner $port; if(-not $o){ return "nothing on $port" }; $p=Get-CimInstance Win32_Process -Filter "ProcessId=$o"; if($p.CommandLine -like $pattern){ Stop-Process -Id $o -Force; "stopped pid $o on $port" } else { "port $port owned by foreign pid $o; refusing" } }
switch($What){
 'api' { $pool=if($env:P6_POOL_MAX){$env:P6_POOL_MAX}else{'8'}; $cap=if($env:P6_GAS_CAP){'set ALDER_SAFE_TX_GAS_CAP='+$env:P6_GAS_CAP+'&& '}else{''}; if(Owner 9103){ "9103 busy pid $(Owner 9103)"; exit 1 }
  $cmd='cmd.exe /d /c "'+$common+$cap+'set ALDER_PUBLIC_ORIGINS=http://127.0.0.1:5103,https://127.0.0.1:5103&& set O5_SRC=.&& set O5_POOL_MAX='+$pool+'&& "'+$node+'" --max-old-space-size=2048 --import tsx tests/round5-ops/isolated-api.ts > "'+$logs+"\api-$ts.out.log"+'" 2> "'+$logs+"\api-$ts.err.log"+'""'
  $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{CreateFlags=[uint32]520;ShowWindow=[uint16]0}
  $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd;CurrentDirectory=$root;ProcessStartupInformation=$startup}
  if($r.ReturnValue -ne 0){ throw 'P6_API_DETACHED_CREATE_FAILED' }
  for($i=0;$i -lt 90 -and -not (Owner 9103);$i++){ Start-Sleep -Milliseconds 500 }; "isolated api pid $(Owner 9103) log api-$ts" }
 'worker' { if(Owner 9113){ "9113 busy pid $(Owner 9113)"; exit 1 }
  $cmd='cmd.exe /d /c "'+$common+'set ALDER_ISOLATED_WORKER_DB=postgresql://alder_indexer@127.0.0.1:15543/alder&& set ALDER_WORKER_PORT=9113&& set ALDER_WORKER_ROLE=p6-worker&& set ALDER_WORKER_LOG='+$workerLog+'&& set ALDER_OUTBOX_SINK='+$notifications+'&& "'+$node+'" --import tsx services/indexer-worker.ts > "'+$logs+"\worker-$ts.out.log"+'" 2> "'+$logs+"\worker-$ts.err.log"+'""'
  $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{CreateFlags=[uint32]520;ShowWindow=[uint16]0}
  $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd;CurrentDirectory=$root;ProcessStartupInformation=$startup}
  if($r.ReturnValue -ne 0){ throw 'P6_WORKER_DETACHED_CREATE_FAILED' }
  for($i=0;$i -lt 60 -and -not (Owner 9113);$i++){ Start-Sleep -Milliseconds 500 }; "isolated worker pid $(Owner 9113) log worker-$ts" }
 'stop-api' { Stop-Own 9103 '*isolated-api.ts*' }
 'stop-worker' { Stop-Own 9113 '*indexer-worker.ts*' }
 'status' { foreach($p in 18547,18548,9103,9113){ "$p -> $(Owner $p)" } }
}
