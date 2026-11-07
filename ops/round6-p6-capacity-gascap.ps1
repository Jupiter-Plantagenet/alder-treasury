# One admitted P6 packet: bind existing isolated state, reach 100k, then run
# the gas-cap freeze/capped/restore sequence. Keep the API and worker alive on
# success for the separately admitted solo load window. On failure, preserve
# the current chain, database, processes, and all reports for inspection.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\user\portfolio-build\alder'
Set-Location -LiteralPath $root
$node = Join-Path $root '.local\runtime\node-v26.7.0\node.exe'
$start = Join-Path $root 'tests\round6-perf\p6-start.ps1'
$baseLedger = Join-Path $root '.local\scratch-r6\runs\p6-20261102T093900Z-a2api\reload-points-18548.jsonl'
$runId = 'p6-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-a2capgas'
$runRoot = Join-Path $root ('.local\scratch-r6\runs\' + $runId)
$ledger = Join-Path $runRoot 'reload-points-18548.jsonl'
$phase = 'preflight'

function Assert-Exit([string]$Code) {
    if ($LASTEXITCODE -ne 0) { throw $Code }
}
function Owner([int]$Port) {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
    return $null
}
function Get-P6Head {
    $body = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:18548' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 8
    if ($response.error -or $response.result -notmatch '^0x[0-9a-fA-F]+$') { throw 'P6_HEAD_READ_FAILED' }
    return [Convert]::ToInt64($response.result.Substring(2), 16)
}
function FileSha([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}
function Record-StageTelemetry([string]$Name) {
    $disk = [long](Get-PSDrive C).Free
    $ram = $null
    $commit = $null
    try { $ram = [long](Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).FreePhysicalMemory * 1024 } catch { }
    try {
        $c = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop
        $commit = @{ used=[long]$c.CommittedBytes; limit=[long]$c.CommitLimit; percent=[double]$c.PercentCommittedBytesInUse }
    } catch { $commit = @{ unavailable=$true } }
    Write-Output (@{ event='stage-resource-telemetry'; stage=$Name; freeCBytes=$disk; availableRamBytes=$ram;
        commit=$commit; memoryOverride=$env:ALDER_OPERATOR_MEMORY_OVERRIDE } | ConvertTo-Json -Compress)
}
function Wait-ApiReady {
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:9103/health' -TimeoutSec 3
            if ($health.ready -and $health.database -eq 'ready' -and $health.chainId -eq 31337) {
                $pidValue = Owner 9103
                $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue"
                if (-not $processInfo -or [IO.Path]::GetFullPath($processInfo.ExecutablePath) -ine [IO.Path]::GetFullPath($node) -or
                    $processInfo.CommandLine -notmatch 'tests[\\/]round5-ops[\\/]isolated-api\.ts') { throw 'P6_API_START_IDENTITY_MISMATCH' }
                $script:apiIdentity = @{ pid=[int]$pidValue; creationDate=[string]$processInfo.CreationDate;
                    executable=[IO.Path]::GetFullPath($processInfo.ExecutablePath); commandLine=[string]$processInfo.CommandLine }
                Write-Output (@{ event='api-ready'; pid=$pidValue; chainId=$health.chainId; birth=$processInfo.CreationDate } | ConvertTo-Json -Compress)
                return
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw 'P6_API_HEALTH_TIMEOUT'
}
function Wait-WorkerReady {
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $status = Invoke-RestMethod -Uri 'http://127.0.0.1:9113/status' -TimeoutSec 3
            if ($status.role -eq 'active' -and $status.lease.name -eq 'indexer' -and
                $null -ne $status.fence -and $status.consecutive_failures -eq 0 -and -not $status.retry_exhausted) {
                Write-Output (@{ event='worker-ready'; pid=(Owner 9113); fence=$status.fence; passes=$status.passes } | ConvertTo-Json -Compress)
                return
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw 'P6_WORKER_HEALTH_TIMEOUT'
}
function Stop-OwnedP6Api {
    $pidValue = Owner 9103
    if (-not $pidValue) { throw 'P6_API_LISTENER_MISSING_BEFORE_RESTART' }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue"
    if (-not $processInfo) { throw 'P6_API_PROCESS_IDENTITY_MISMATCH_RETAINED' }
    if (-not $script:apiIdentity -or $script:apiIdentity.pid -ne $pidValue -or
        $script:apiIdentity.creationDate -ne $processInfo.CreationDate -or
        $script:apiIdentity.commandLine -ne $processInfo.CommandLine) { throw 'P6_API_NOT_THE_EXACT_STARTED_PROCESS_RETAINED' }
    $birth = [System.Management.ManagementDateTimeConverter]::ToDateTime($processInfo.CreationDate).ToUniversalTime()
    $expectedExe = [IO.Path]::GetFullPath($node)
    if (-not $processInfo -or [IO.Path]::GetFullPath($processInfo.ExecutablePath) -ine $expectedExe -or
        $processInfo.CommandLine -notmatch 'tests[\\/]round5-ops[\\/]isolated-api\.ts') {
        throw 'P6_API_PROCESS_IDENTITY_MISMATCH_RETAINED'
    }
    $process = [Diagnostics.Process]::GetProcessById([int]$pidValue)
    if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $birth).TotalSeconds) -gt 2) { throw 'P6_API_PROCESS_BIRTH_MISMATCH_RETAINED' }
    $again = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue"
    if (-not $again -or $again.CreationDate -ne $processInfo.CreationDate -or
        [IO.Path]::GetFullPath($again.ExecutablePath) -ine $expectedExe -or
        $again.CommandLine -ne $processInfo.CommandLine) { throw 'P6_API_PROCESS_CHANGED_RETAINED' }
    Write-Output (@{ event='stopping-owned-api'; pid=$pidValue; birthUtc=$birth.ToString('o'); executable=$expectedExe } | ConvertTo-Json -Compress)
    $process.Kill()
    if (-not $process.WaitForExit(15000)) { throw 'P6_API_STOP_TIMEOUT' }
    if (Owner 9103) { throw 'P6_API_PORT_REMAINS_BOUND' }
    $script:apiIdentity = $null
}
function Start-P6Api([string]$GasCap = '') {
    if (Owner 9103) { throw 'P6_API_PORT_ALREADY_BOUND' }
    if ($GasCap) { $env:P6_GAS_CAP = $GasCap } else { Remove-Item Env:\P6_GAS_CAP -ErrorAction SilentlyContinue }
    & $start api
    Wait-ApiReady
}
function Invoke-P6Runner([string]$ScriptPath, [string]$ReportPath) {
    & $node --import tsx $ScriptPath
    Assert-Exit 'P6_NODE_RUNNER_FAILED'
    if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) { throw 'P6_RUNNER_REPORT_MISSING' }
    $report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
    if ($report.fail -ne 0) { throw 'P6_RUNNER_REPORT_HAS_FAILURES' }
    Write-Output (@{ event='runner-passed'; report=$ReportPath; pass=$report.pass; fail=$report.fail } | ConvertTo-Json -Compress)
}

try {
    if ($env:ALDER_OPERATOR_MEMORY_OVERRIDE -ne '20261102-user-directed') { throw 'ALDER_AUTHORIZED_OVERRIDE_WRAPPER_REQUIRED' }
    if (Test-Path -LiteralPath $runRoot) { throw 'P6_RUN_ID_COLLISION' }
    if ((Owner 9103) -or (Owner 9113)) { throw 'P6_SERVICE_PORT_ALREADY_BOUND' }
    if (-not (Test-Path -LiteralPath $baseLedger -PathType Leaf)) { throw 'P6_RELOAD_LEDGER_MISSING' }
    $ledgerLines = @(Get-Content -LiteralPath $baseLedger | Where-Object { $_.Trim() })
    if ($ledgerLines.Count -lt 1) { throw 'P6_RELOAD_LEDGER_EMPTY' }
    $firstPoint = $ledgerLines[0] | ConvertFrom-Json
    $deployment = Get-Content -LiteralPath (Join-Path $root 'evidence\round5-ops\isolated-deployment.json') -Raw | ConvertFrom-Json
    if ($firstPoint.genesis -ine $deployment.genesis -or [string]$firstPoint.height -ne '10161') { throw 'P6_RELOAD_LEDGER_ANCHOR_MISMATCH' }
    New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
    Copy-Item -LiteralPath $baseLedger -Destination $ledger
    $ledgerHash = FileSha $ledger
    $sourceLedgerHash = FileSha $baseLedger
    if ($ledgerHash -ne $sourceLedgerHash) { throw 'P6_RELOAD_LEDGER_COPY_MISMATCH' }
    $env:P6_RUN_ID = $runId
    $env:ALDER_RPC_URL = 'http://127.0.0.1:18547'
    $env:ALDER_DEPLOYMENT_FILE = 'evidence/round5-ops/isolated-deployment.json'
    Write-Output (@{ event='p6-run'; runId=$runId; reloadLedgerSha256=$ledgerHash; headFloor=69174; nonce=124; allowance='100004950' } | ConvertTo-Json -Compress)

    $phase = 'start-default-api'
    Start-P6Api
    $phase = 'start-worker'
    & $start worker
    Wait-WorkerReady

    $phase = 'preserved-state-preflight'
    & $node --import tsx 'tests/round6-perf/p6-capacity-preflight.ts'
    Assert-Exit 'P6_PRESERVED_STATE_PREFLIGHT_FAILED'
    $preflightHead = Get-P6Head
    if ($preflightHead -ge 100000) { $env:P6_SCALE_START = '100000' }
    else { $env:P6_SCALE_START = '10000' }
    Write-Output (@{ event='capacity-resume-target'; preservedHead=$preflightHead; scaleStart=$env:P6_SCALE_START } | ConvertTo-Json -Compress)

    $phase = 'capacity-scale'
    Record-StageTelemetry $phase
    $env:P6_CAP_PART = 'scale'
    Invoke-P6Runner 'tests/round6-perf/capacity-p6.ts' (Join-Path $runRoot 'capacity\report-scale.json')

    $phase = 'gascap-freeze-default'
    Record-StageTelemetry $phase
    $env:P6_PHASE = 'freeze'
    Invoke-P6Runner 'tests/round6-perf/gascap-p6.ts' (Join-Path $runRoot 'capacity\report-gascap-freeze.json')

    $phase = 'gascap-capped'
    Record-StageTelemetry $phase
    Stop-OwnedP6Api
    Start-P6Api '3000000'
    $env:P6_PHASE = 'capped'
    Invoke-P6Runner 'tests/round6-perf/gascap-p6.ts' (Join-Path $runRoot 'capacity\report-gascap-capped.json')

    $phase = 'gascap-restore-default'
    Record-StageTelemetry $phase
    Stop-OwnedP6Api
    Start-P6Api
    $env:P6_PHASE = 'restore'
    Invoke-P6Runner 'tests/round6-perf/gascap-p6.ts' (Join-Path $runRoot 'capacity\report-gascap-restore.json')

    $phase = 'worker-final-health'
    Wait-WorkerReady
    Write-Output (@{ status='PASS'; runId=$runId; reports=@(
        (Join-Path $runRoot 'capacity\report-scale.json'),
        (Join-Path $runRoot 'capacity\report-gascap-freeze.json'),
        (Join-Path $runRoot 'capacity\report-gascap-capped.json'),
        (Join-Path $runRoot 'capacity\report-gascap-restore.json'));
        reloadLedgerSha256=$ledgerHash; servicesRemainRunning=$true; phase=$phase } | ConvertTo-Json -Compress)
} catch {
    $failure = $_
    $message = [string]$failure.Exception.Message
    if ($message.Length -gt 400) { $message = $message.Substring(0,400) }
    Write-Output (@{ status='FAILED_OR_PARTIAL'; runId=$runId; phase=$phase;
        errorCategory=$failure.Exception.GetType().Name; errorId=[string]$failure.FullyQualifiedErrorId;
        line=[int]$failure.InvocationInfo.ScriptLineNumber; message=$message;
        preserveChainDatabaseProcessesAndEvidence=$true } | ConvertTo-Json -Compress)
    exit 2
}
