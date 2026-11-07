$ErrorActionPreference = 'Stop'
$root = 'C:\Users\user\portfolio-build\alder'
Set-Location -LiteralPath $root
if ($env:ALDER_OPERATOR_MEMORY_OVERRIDE -ne '20261102-user-directed') { throw 'ALDER_AUTHORIZED_WRAPPER_REQUIRED' }
$node = Join-Path $root '.local\runtime\node-v26.7.0\node.exe'
$python = 'C:\Users\user\portfolio-build\folio\.venv\Scripts\python.exe'
$apiControl = Join-Path $root 'ops\p6-exact-api-control-reviewed.py'
$start = Join-Path $root 'tests\round6-perf\p6-start.ps1'
$capacityRunId = 'p6-20261102T131830Z-a2capfresh'
$capacityRoot = Join-Path $root ('.local\scratch-r6\runs\' + $capacityRunId)
$runId = 'p6-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-a2capgasv2'
if ($runId -notmatch '^p6-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{4,20}$') { throw 'P6_RUN_ID_INVALID' }
$runRoot = Join-Path $root ('.local\scratch-r6\runs\' + $runId)
if (Test-Path -LiteralPath $runRoot) { throw 'P6_RUN_ID_COLLISION' }
function FileSha([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $stream = [System.IO.File]::OpenRead($Path); try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose() } }
    finally { $sha.Dispose() }
}
$capacityReport = Join-Path $capacityRoot 'capacity\report-scale.json'
if (-not (Test-Path -LiteralPath $capacityReport -PathType Leaf)) { throw 'P6_SCALE_REPORT_REQUIRED' }
$capacity = Get-Content -LiteralPath $capacityReport -Raw | ConvertFrom-Json
if ($capacity.fail -ne 0) { throw 'P6_SCALE_REPORT_NOT_PASS' }
$api = Invoke-RestMethod -Uri 'http://127.0.0.1:9103/health' -TimeoutSec 5
$worker = Invoke-RestMethod -Uri 'http://127.0.0.1:9113/status' -TimeoutSec 5
if (-not $api.ready -or $api.chainId -ne 31337 -or $worker.role -ne 'active' -or $worker.lease.name -ne 'indexer' -or $worker.consecutive_failures -ne 0 -or $worker.retry_exhausted) { throw 'P6_SERVICES_NOT_READY' }
$currentApiText = & $python -B $apiControl inspect 43832
if ($LASTEXITCODE -ne 0) { throw 'P6_CURRENT_API_IDENTITY_FAILED' }
$currentApi = $currentApiText | ConvertFrom-Json
Write-Output $currentApiText
$preservedDiagnosticText = & $node --import tsx 'tests/round6-perf/p6-read-gascap-operation.ts'
if ($LASTEXITCODE -ne 0) { throw 'P6_PRESERVED_GASCAP_DIAGNOSTIC_FAILED' }
$preservedDiagnostic = $preservedDiagnosticText | ConvertFrom-Json
if (-not $preservedDiagnostic.found -or $preservedDiagnostic.state -ne 'nonce_consumed' -or $preservedDiagnostic.signatures -ne 0 -or $preservedDiagnostic.attempts -ne 0 -or $preservedDiagnostic.reservations -ne 60) { throw 'P6_PRIOR_GASCAP_FAILURE_STATE_CHANGED' }
$rpcHead = Invoke-RestMethod -Uri 'http://127.0.0.1:18548' -Method Post -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' -TimeoutSec 5
$rpcGenesis = Invoke-RestMethod -Uri 'http://127.0.0.1:18548' -Method Post -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":2,"method":"eth_getBlockByNumber","params":["0x0",false]}' -TimeoutSec 5
$deployment = Get-Content -LiteralPath 'evidence\round5-ops\isolated-deployment.json' -Raw | ConvertFrom-Json
if ($rpcHead.error -or $rpcGenesis.error -or [Convert]::ToInt64($rpcHead.result.Substring(2),16) -lt 100010 -or $rpcGenesis.result.hash -ine $deployment.genesis) { throw 'P6_CHAIN_LINEAGE_HEAD_GUARD_FAILED' }
$safeNonceBaseline = [string]$preservedDiagnostic.safeNonce
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$sourceLedger = Join-Path $capacityRoot 'reload-points-18548.jsonl'
if (-not (Test-Path -LiteralPath $sourceLedger -PathType Leaf)) { throw 'P6_SOURCE_RELOAD_LEDGER_MISSING' }
$ledger = Join-Path $runRoot 'reload-points-18548.jsonl'
Copy-Item -LiteralPath $sourceLedger -Destination $ledger
$ledgerSha = FileSha $ledger
if ($ledgerSha -ne (FileSha $sourceLedger)) { throw 'P6_RELOAD_LEDGER_COPY_MISMATCH' }
$deployment = Get-Content -LiteralPath 'evidence\round5-ops\isolated-deployment.json' -Raw | ConvertFrom-Json
$firstPoint = (Get-Content -LiteralPath $ledger | Where-Object { $_.Trim() } | Select-Object -First 1) | ConvertFrom-Json
if ($firstPoint.genesis -ine $deployment.genesis -or [string]$firstPoint.height -ne '10161') { throw 'P6_RELOAD_LEDGER_ANCHOR_MISMATCH' }
$env:P6_RUN_ID = $runId
$env:ALDER_RPC_URL = 'http://127.0.0.1:18547'
$env:ALDER_DEPLOYMENT_FILE = 'evidence/round5-ops/isolated-deployment.json'
Write-Output (@{event='gascap-run-start';runId=$runId;capacitySourceRunId=$capacityRunId;capacityReport=$capacityReport;capacityFail=$capacity.fail;reloadLedgerSha256=$ledgerSha;apiPid=$currentApi.pid;workerPid=$worker.pid;safeNonceBaseline=$safeNonceBaseline;priorFailedOperationState=$preservedDiagnostic.state;chainHead=$([Convert]::ToInt64($rpcHead.result.Substring(2),16));genesis=$rpcGenesis.result.hash} | ConvertTo-Json -Compress)
function Run-GasCap([string]$Phase) {
    $env:P6_PHASE = $Phase
    & $node --import tsx 'tests/round6-perf/gascap-p6.ts'
    if ($LASTEXITCODE -ne 0) { throw "P6_GASCAP_RUNNER_FAILED_$Phase" }
    $reportPath = Join-Path $runRoot ('capacity\report-gascap-' + $Phase + '.json')
    if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) { throw "P6_GASCAP_REPORT_MISSING_$Phase" }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if ($report.fail -ne 0) { throw "P6_GASCAP_REPORT_FAILED_$Phase" }
    Write-Output (@{event='gascap-phase-passed';phase=$Phase;pass=$report.pass;fail=$report.fail;report=$reportPath} | ConvertTo-Json -Compress)
}
function Start-OwnedApi([string]$Cap) {
    if ($Cap) { $env:P6_GAS_CAP = $Cap } else { Remove-Item Env:\P6_GAS_CAP -ErrorAction SilentlyContinue }
    $output = & $start api
    if ($LASTEXITCODE -ne 0) { throw 'P6_GASCAP_API_START_FAILED' }
    $text = ($output | Out-String)
    if ($text -notmatch 'isolated api pid\s+(\d+)') { throw 'P6_GASCAP_API_PID_MISSING' }
    $pidValue = [int]$Matches[1]
    $identityText = & $python -B $apiControl inspect $pidValue
    if ($LASTEXITCODE -ne 0) { throw 'P6_GASCAP_API_IDENTITY_FAILED' }
    $identity = $identityText | ConvertFrom-Json
    Write-Output $identityText
    return $identity
}
function Stop-OwnedApi($Identity) {
    $text = & $python -B $apiControl stop ([int]$Identity.pid) ([string]$Identity.birth)
    if ($LASTEXITCODE -ne 0) { throw 'P6_GASCAP_API_STOP_IDENTITY_FAILED' }
    Write-Output $text
}
Run-GasCap 'freeze'
Stop-OwnedApi $currentApi
$capped = Start-OwnedApi '3000000'
Run-GasCap 'capped'
Stop-OwnedApi $capped
$restored = Start-OwnedApi ''
Run-GasCap 'restore'
$state = Get-Content -LiteralPath (Join-Path $runRoot 'gascap-state.json') -Raw | ConvertFrom-Json
Write-Output (@{status='PASS';runId=$runId;workerPid=$worker.pid;apiPid=$restored.pid;apiBirth=$restored.birth;frozenSafeNonce=$state.A.safeNonce;gascapReports=@('report-gascap-freeze.json','report-gascap-capped.json','report-gascap-restore.json');servicesRemainRunning=$true} | ConvertTo-Json -Compress)
exit 0
