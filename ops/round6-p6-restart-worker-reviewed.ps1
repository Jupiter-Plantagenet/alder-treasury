$ErrorActionPreference = 'Stop'
$root = 'C:\Users\user\portfolio-build\alder'
$pbPython = 'C:\Users\user\portfolio-build\folio\.venv\Scripts\python.exe'
Set-Location -LiteralPath $root
if ($env:ALDER_OPERATOR_MEMORY_OVERRIDE -ne '20261102-user-directed') { throw 'ALDER_AUTHORIZED_WRAPPER_REQUIRED' }
$oldRunId = 'p6-20261102T130211Z-a2capgas'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$runId = "p6-$stamp-a2leasefix"
if ($runId -notmatch '^p6-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{4,20}$') { throw 'P6_RUN_ID_INVALID' }
$runRoot = Join-Path $root ('.local\scratch-r6\runs\' + $runId)
if (Test-Path -LiteralPath $runRoot) { throw 'P6_RUN_ID_COLLISION' }
$sourceLedger = Join-Path $root ('.local\scratch-r6\runs\' + $oldRunId + '\reload-points-18548.jsonl')
if (-not (Test-Path -LiteralPath $sourceLedger -PathType Leaf)) { throw 'P6_SOURCE_RELOAD_LEDGER_MISSING' }
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$destLedger = Join-Path $runRoot 'reload-points-18548.jsonl'
Copy-Item -LiteralPath $sourceLedger -Destination $destLedger
function FileSha([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}
$srcHash = FileSha $sourceLedger
$dstHash = FileSha $destLedger
if ($srcHash -ne $dstHash) { throw 'P6_RELOAD_LEDGER_COPY_MISMATCH' }
Write-Output (@{event='worker-recovery-run-prepared';runId=$runId;reloadLedgerSha256=$dstHash} | ConvertTo-Json -Compress)
& $pbPython -B (Join-Path $root 'ops\p6-stop-exact-reviewed-worker.py')
if ($LASTEXITCODE -ne 0) { throw 'P6_EXACT_WORKER_STOP_FAILED' }
$env:P6_RUN_ID = $runId
$env:ALDER_RPC_URL = 'http://127.0.0.1:18547'
$env:ALDER_DEPLOYMENT_FILE = 'evidence/round5-ops/isolated-deployment.json'
& (Join-Path $root 'tests\round6-perf\p6-start.ps1') worker
if ($LASTEXITCODE -ne 0) { throw 'P6_WORKER_START_FAILED' }
$deadline = [DateTime]::UtcNow.AddSeconds(120)
$ready = $false
while ([DateTime]::UtcNow -lt $deadline) {
    try {
        $s = Invoke-RestMethod -Uri 'http://127.0.0.1:9113/status' -TimeoutSec 3
        if ($s.pid -and $s.pid -ne 45408 -and $s.role -eq 'active' -and $s.lease.name -eq 'indexer') {
            Write-Output (@{event='new-worker-active';runId=$runId;pid=$s.pid;phase=$s.phase;fence=$s.fence;passes=$s.passes;consecutiveFailures=$s.consecutive_failures;retryExhausted=$s.retry_exhausted} | ConvertTo-Json -Compress)
            $ready = $true; break
        }
    } catch { }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw 'P6_WORKER_RECOVERY_READY_TIMEOUT' }
Write-Output (@{status='RECOVERY_WORKER_RUNNING';runId=$runId;pid=$s.pid;reloadLedgerSha256=$dstHash;request350MustDrainNormally=$true} | ConvertTo-Json -Compress)
