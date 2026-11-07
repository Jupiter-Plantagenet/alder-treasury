param([Parameter(Mandatory=$true)][string]$RunId,[switch]$DeleteOwnedDisposableVolume)
$ErrorActionPreference='Stop'
if($RunId -notmatch '^[a-z0-9-]{8,64}$'){throw 'INVALID_RUN_ID'}
$root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runDir=(Resolve-Path (Join-Path $root ".local/repro/$RunId")).Path
$expectedRoot=[IO.Path]::GetFullPath((Join-Path $root '.local/repro')).TrimEnd('\')+'\'
if(-not $runDir.StartsWith($expectedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'RUN_DIRECTORY_OUTSIDE_PRIVATE_REPRO_ROOT'}
$stackPath=Join-Path $runDir 'stack.json'
$stack=Get-Content -Raw -LiteralPath $stackPath|ConvertFrom-Json -ErrorAction Stop
$project="alder-repro-$RunId"
if($stack.run_id -ne $RunId -or $stack.compose_project -ne $project){throw 'STACK_OWNERSHIP_RECEIPT_MISMATCH'}
$compose=Join-Path $PSScriptRoot 'compose-windows.yaml'
$env:ALDER_REPRO_PROJECT=$project
$env:ALDER_REPRO_SOURCE_VOLUME="$project-repro-source"
$env:ALDER_REPRO_TOOLCHAIN_VOLUME="$project-repro-toolchain"
$env:ALDER_REPRO_ACQUISITION_VOLUME="$project-repro-acquisition"
$env:ALDER_REPRO_SOURCE_ARCHIVE=([string]$stack.source_archive_path).Replace('\','/')
$env:ALDER_REPRO_TOOLCHAIN_DIR=([string]$stack.toolchain_directory).Replace('\','/')
$env:ALDER_REPRO_ACQUISITION_DIR=([string]$stack.acquisition_directory).Replace('\','/')
$env:ALDER_REPRO_IMAGE=[string]$stack.runner_image_tag
& docker compose --project-name $project -f $compose stop
if($LASTEXITCODE -ne 0){throw "COMPOSE_STOP_FAILED_$LASTEXITCODE"}
if($DeleteOwnedDisposableVolume){
  & docker compose --project-name $project -f $compose down
  if($LASTEXITCODE -ne 0){throw "COMPOSE_DOWN_FAILED_$LASTEXITCODE"}
  $volumes=@(& docker volume ls -q --filter "label=com.docker.compose.project=$project")
  if($LASTEXITCODE -ne 0){throw 'OWNED_VOLUME_ENUMERATION_FAILED'}
  foreach($volume in $volumes){
    if($volume -notmatch "^$project(-repro-(source|toolchain|acquisition)|_repro_(input|toolchain|acquisition|work|proof|pgdata))$"){throw "UNEXPECTED_VOLUME_LABEL_MATCH_REFUSING_DELETE_$volume"}
  }
  if($volumes.Count){& docker volume rm @volumes;if($LASTEXITCODE -ne 0){throw 'OWNED_VOLUME_REMOVAL_FAILED'}}
}
$stack.status=if($DeleteOwnedDisposableVolume){'stopped_and_owned_disposable_volumes_deleted'}else{'stopped_volumes_preserved'}
$stack|Add-Member -NotePropertyName stopped_utc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
$stack|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $stackPath -Encoding utf8
Write-Output $stack.status
