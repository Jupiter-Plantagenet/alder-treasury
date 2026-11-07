$ErrorActionPreference = 'Stop'
$root = 'C:\Users\user\portfolio-build\alder'
Set-Location -LiteralPath $root
if ($env:ALDER_OPERATOR_MEMORY_OVERRIDE -ne '20261102-user-directed') { throw 'ALDER_AUTHORIZED_WRAPPER_REQUIRED' }
$node = Join-Path $root '.local\runtime\node-v26.7.0\node.exe'
$python = 'C:\Users\user\portfolio-build\folio\.venv\Scripts\python.exe'
$apiControl = Join-Path $root 'ops\p6-exact-api-control-reviewed.py'
$start = Join-Path $root 'tests\round6-perf\p6-start.ps1'
$runId = 'p6-20261102T131830Z-a2capfresh'
$runRoot = Join-Path $root ('.local\scratch-r6\runs\' + $runId)
if (-not (Test-Path -LiteralPath (Join-Path $runRoot 'capacity\report-scale.json') -PathType Leaf)) { throw 'P6_SCALE_REPORT_REQUIRED' }
$capacity = Get-Content -LiteralPath (Join-Path $runRoot 'capacity\report-scale.json') -Raw | ConvertFrom-Json
if ($capacity.fail -ne 0) { throw 'P6_SCALE_REPORT_NOT_PASS' }
$api = Invoke-RestMethod -Uri 'http://127.0.0.1:9103/health' -TimeoutSec 5
$worker = Invoke-RestMethod -Uri 'http://127.0.0.1:9113/status' -TimeoutSec 5
if (-not $api.ready -or $api.chainId -ne 31337 -or $worker.role -ne 'active' -or $worker.lease.name -ne 'indexer' -or $worker.consecutive_failures -ne 0) { throw 'P6_SERVICES_NOT_READY' }
$currentApiText = & $python -B $apiControl inspect 24960
if ($LASTEXITCODE -ne 0) { throw 'P6_CURRENT_API_IDENTITY_FAILED' }
$currentApi = $currentApiText | ConvertFrom-Json
Write-Output $currentApiText
$env:P6_RUN_ID = $runId
$env:ALDER_RPC_URL = 'http://127.0.0.1:18547'
$env:ALDER_DEPLOYMENT_FILE = 'evidence/round5-ops/isolated-deployment.json'
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
# Freeze under default 15M cap. This creates one intended unsigned sandbox operation and records its run-local state.
Run-GasCap 'freeze'
# Cap phase requires the exact old API identity to be stopped before the capped process starts.
Stop-OwnedApi $currentApi
$capped = Start-OwnedApi '3000000'
Run-GasCap 'capped'
Stop-OwnedApi $capped
$restored = Start-OwnedApi ''
Run-GasCap 'restore'
Write-Output (@{status='PASS';runId=$runId;workerPid=$worker.pid;apiPid=$restored.pid;apiBirth=$restored.birth;safeNonceBeforeRestore=124;gascapReports=@('report-gascap-freeze.json','report-gascap-capped.json','report-gascap-restore.json');servicesRemainRunning=$true} | ConvertTo-Json -Compress)
