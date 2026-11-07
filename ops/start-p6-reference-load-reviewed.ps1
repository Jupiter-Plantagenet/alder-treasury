param([Parameter(Mandatory=$true)][string]$RunId)
$ErrorActionPreference='Stop'
$root='C:\Users\user\portfolio-build\alder'
if($RunId -notmatch '^p6-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{4,20}$'){throw 'P6_RUN_ID_INVALID'}
Set-Location -LiteralPath $root
$node=Join-Path $root '.local\runtime\node-v26.7.0\node.exe'
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'P6_NODE_RUNTIME_MISSING'}
$env:P6_RUN_ID=$RunId
$env:O5_TARGET='10000'
$env:P6_DURATION='1800'
& $node --import tsx tests/round6-perf/load-seed-p6.ts
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
$bash='C:\Program Files\Git\bin\bash.exe'
if(-not (Test-Path -LiteralPath $bash -PathType Leaf)){throw 'P6_GIT_BASH_MISSING'}
& $bash tests/round6-perf/run-load-full-p6.sh
exit $LASTEXITCODE
