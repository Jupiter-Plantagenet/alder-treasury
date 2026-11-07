$ErrorActionPreference = 'Stop'
$root = 'C:\Users\user\portfolio-build\alder'
Set-Location -LiteralPath $root
if ($env:ALDER_OPERATOR_MEMORY_OVERRIDE -ne '20261102-user-directed') { throw 'ALDER_AUTHORIZED_WRAPPER_REQUIRED' }
$node = Join-Path $root '.local\runtime\node-v26.7.0\node.exe'
$runId = 'p6-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-a2capfresh'
if ($runId -notmatch '^p6-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{4,20}$') { throw 'P6_RUN_ID_INVALID' }
$runRoot = Join-Path $root ('.local\scratch-r6\runs\' + $runId)
if (Test-Path -LiteralPath $runRoot) { throw 'P6_RUN_ID_COLLISION' }
function FileSha([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $stream = [System.IO.File]::OpenRead($Path); try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose() } }
    finally { $sha.Dispose() }
}
$api = Invoke-RestMethod -Uri 'http://127.0.0.1:9103/health' -TimeoutSec 5
if (-not $api.ready -or $api.database -ne 'ready' -or $api.chainId -ne 31337) { throw 'P6_API_NOT_READY' }
$worker = Invoke-RestMethod -Uri 'http://127.0.0.1:9113/status' -TimeoutSec 5
if ($worker.role -ne 'active' -or $worker.lease.name -ne 'indexer' -or $worker.consecutive_failures -ne 0 -or $worker.retry_exhausted) { throw 'P6_WORKER_NOT_HEALTHY' }
Write-Output (@{event='attached-services-verified';apiReady=$true;chainId=$api.chainId;workerPid=$worker.pid;workerPhase=$worker.phase;fence=$worker.fence;passes=$worker.passes;failures=$worker.consecutive_failures} | ConvertTo-Json -Compress)
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$baseRunId = 'p6-20261102T131602Z-a2leasefix'
$sourceLedger = Join-Path $root ('.local\scratch-r6\runs\' + $baseRunId + '\reload-points-18548.jsonl')
if (-not (Test-Path -LiteralPath $sourceLedger -PathType Leaf)) { throw 'P6_SOURCE_RELOAD_LEDGER_MISSING' }
$ledger = Join-Path $runRoot 'reload-points-18548.jsonl'
Copy-Item -LiteralPath $sourceLedger -Destination $ledger
$ledgerHash = FileSha $ledger
if ($ledgerHash -ne (FileSha $sourceLedger)) { throw 'P6_RELOAD_LEDGER_COPY_MISMATCH' }
$deployment = Get-Content -LiteralPath 'evidence\round5-ops\isolated-deployment.json' -Raw | ConvertFrom-Json
$firstPoint = (Get-Content -LiteralPath $ledger | Where-Object { $_.Trim() } | Select-Object -First 1) | ConvertFrom-Json
if ($firstPoint.genesis -ine $deployment.genesis -or [string]$firstPoint.height -ne '10161') { throw 'P6_RELOAD_LEDGER_ANCHOR_MISMATCH' }
$env:P6_RUN_ID = $runId
$env:P6_SCALE_START = '100000'
$env:P6_CAP_PART = 'scale'
$env:ALDER_RPC_URL = 'http://127.0.0.1:18547'
$env:ALDER_DEPLOYMENT_FILE = 'evidence/round5-ops/isolated-deployment.json'
Write-Output (@{event='fresh-capacity-start';runId=$runId;headFloor=100000;safeNonce=124;allowance='100004950';reloadLedgerSha256=$ledgerHash;workerPid=$worker.pid} | ConvertTo-Json -Compress)
& $node --import tsx 'tests/round6-perf/p6-capacity-preflight.ts'
if ($LASTEXITCODE -ne 0) { throw 'P6_PRESERVED_STATE_PREFLIGHT_FAILED' }
& $node --import tsx 'tests/round6-perf/capacity-p6.ts'
$nodeExit = $LASTEXITCODE
$reportPath = Join-Path $runRoot 'capacity\report-scale.json'
if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) { throw 'P6_SCALE_REPORT_MISSING' }
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
Write-Output (@{event='fresh-capacity-result';runId=$runId;nodeExit=$nodeExit;pass=$report.pass;fail=$report.fail;report=$reportPath;reloadLedgerSha256=$ledgerHash} | ConvertTo-Json -Compress)
if ($nodeExit -ne 0 -or $report.fail -ne 0) { exit 2 }
exit 0
