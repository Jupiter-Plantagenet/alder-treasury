# P6 resource telemetry for the isolated stack. Host RAM/commit/free-space are
# recorded for context only; product RSS and evidence/dependency disk are judged
# from the declared P6 contract, not from host admission thresholds.
param(
  [int]$Seconds=1900,
  [string]$Out='.local/scratch-r6/load/resources.csv',
  [string]$Container='alder-p6-20261101t235425z-a2stack-pg',
  [string]$Database='alder',
  [string]$AbortMarker='.local/scratch-r6/load/resource-abort.json'
)
$ErrorActionPreference='Continue'
Set-Location 'C:\Users\user\portfolio-build\alder'
$outFull=[IO.Path]::GetFullPath($Out)
$abortFull=[IO.Path]::GetFullPath($AbortMarker)
$root=[IO.Path]::GetFullPath('C:\Users\user\portfolio-build\alder\.local\scratch-r6') + [IO.Path]::DirectorySeparatorChar
if (-not $outFull.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or -not $abortFull.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'P6_SAMPLER_OUTPUT_OUTSIDE_PRIVATE_SCRATCH' }
if (Test-Path -LiteralPath $abortFull) { throw 'P6_RESOURCE_ABORT_MARKER_ALREADY_EXISTS' }
'utc,api_ws_mb,api_private_mb,worker_ws_mb,proxy_ws_mb,anvil_ws_mb,node_load_tree_ws_mb,node_vitals_tree_ws_mb,p6_stack_process_tree_rss_mb,pg_container_mem,pg_container_used_mb,p6_process_plus_pg_mb,pg_conn_total,pg_conn_app,host_avail_mb,commit_pct,c_free_bytes,sample_errors' | Set-Content -Encoding utf8 -LiteralPath $outFull

function Get-PortProcess([int]$port) {
  $owner=$null
  try {
    $row=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -First 1
    if($row){$owner=[int]$row.OwningProcess}
  } catch {}
  if(-not $owner) {
    try {
      # Windows netstat fallback: its output is used only to recover the PID;
      # addresses and command lines are never persisted.
      $lines=netstat.exe -ano -p tcp 2>$null
      foreach($line in $lines) {
        if($line -match ":$port\s+.*LISTENING\s+(\d+)\s*$") {$owner=[int]$Matches[1];break}
      }
    } catch {}
  }
  if($owner) { try { return Get-Process -Id $owner -ErrorAction Stop } catch {} }
  return $null
}
function Get-NodePids([string]$token) {
  $found=@()
  try {
    foreach($row in (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)) {
      if($row.CommandLine -and $row.CommandLine.Contains($token)) { $found += [int]$row.ProcessId }
    }
  } catch {}
  return $found
}
function Sum-ProcessRss([int[]]$ids) {
  $sum=0.0
  foreach($id in ($ids | Sort-Object -Unique)) { try { $sum += (Get-Process -Id $id -ErrorAction Stop).WorkingSet64 } catch {} }
  return [math]::Round($sum/1MB,1)
}
function Get-TreeProcessIds([int[]]$roots) {
  $owned=@($roots | Sort-Object -Unique)
  try {
    $parents=@{};foreach($row in (Get-CimInstance Win32_Process -ErrorAction Stop)){$parents[[int]$row.ProcessId]=[int]$row.ParentProcessId}
    do {$old=$owned.Count;foreach($entry in $parents.GetEnumerator()){if(($owned -contains [int]$entry.Value) -and -not ($owned -contains [int]$entry.Key)){$owned += [int]$entry.Key}}} while($owned.Count -gt $old)
  } catch {}
  return ,($owned | Sort-Object -Unique)
}
function CsvValue($value) { if($null -eq $value){return ''}; return [string]$value }
function Docker-MemoryMb([string]$text) {
  if($text -match '^\s*([0-9.]+)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\s*/') {
    $n=[double]$Matches[1];$unit=$Matches[2]
    switch -Regex ($unit) {'^(B)$' {return $n/1MB} '^(kB|KB)$' {return $n/1024} '^(KiB)$' {return $n/1024} '^(MB|MiB)$' {return $n} '^(GB|GiB)$' {return $n*1024} '^(TB|TiB)$' {return $n*1048576}}
  }
  return $null
}

$end=(Get-Date).AddSeconds($Seconds)
while((Get-Date) -lt $end) {
  $now=(Get-Date).ToUniversalTime().ToString('o');$errors=[Collections.Generic.List[string]]::new()
  $a=Get-PortProcess 9103;$w=Get-PortProcess 9113;$x=Get-PortProcess 18547;$v=Get-PortProcess 18548
  $loadIds=Get-NodePids 'load-run-p6.ts';$vitalsIds=@((Get-NodePids 'vitals-p6.ts') + (Get-NodePids 'vitals-release.ts') | Sort-Object -Unique)
  $loadTree=Get-TreeProcessIds $loadIds;$vitalsTree=Get-TreeProcessIds $vitalsIds
  $apiWs=if($a){[math]::Round($a.WorkingSet64/1MB,1)}else{$errors.Add('api_pid_unresolved');$null}
  $apiPriv=if($a){[math]::Round($a.PrivateMemorySize64/1MB,1)}else{$null}
  $workerWs=if($w){[math]::Round($w.WorkingSet64/1MB,1)}else{$errors.Add('worker_pid_unresolved');$null}
  $proxyWs=if($x){[math]::Round($x.WorkingSet64/1MB,1)}else{$errors.Add('proxy_pid_unresolved');$null}
  $anvilWs=if($v){[math]::Round($v.WorkingSet64/1MB,1)}else{$errors.Add('anvil_pid_unresolved');$null}
  $loadWs=Sum-ProcessRss $loadTree;$vitalsWs=Sum-ProcessRss $vitalsTree
  $stackRoots=@();if($a){$stackRoots += $a.Id};if($w){$stackRoots += $w.Id};if($x){$stackRoots += $x.Id};if($v){$stackRoots += $v.Id};$stackRoots += $loadTree;$stackRoots += $vitalsTree
  $stackIds=Get-TreeProcessIds $stackRoots
  $stackRss=Sum-ProcessRss $stackIds
  $pgMem='';$pgUsed='';$connTotal='';$connApp=''
  try { $pgMem=(docker stats --no-stream --format "{{.MemUsage}}" $Container 2>$null);if($LASTEXITCODE -ne 0 -or -not $pgMem){throw 'docker_stats_unavailable'};$pgUsed=Docker-MemoryMb $pgMem;if($null -eq $pgUsed){throw 'docker_stats_parse'} } catch {$errors.Add('pg_container_stats_unavailable')}
  try { $conn=(docker exec $Container psql -U postgres -d $Database -Atc "select count(*)||';'||count(*) filter (where usename='alder_app') from pg_stat_activity where datname=current_database()" 2>$null) -split ';';if($LASTEXITCODE -ne 0 -or $conn.Count -ne 2){throw 'pg_activity_unavailable'};$connTotal=$conn[0];$connApp=$conn[1] } catch {$errors.Add('pg_activity_unavailable')}
  $avail='';$commit='';$cfree=''
  try {$perf=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop;if($null -eq $perf.AvailableMBytes -or $null -eq $perf.PercentCommittedBytesInUse){throw 'perf_counter_missing'};$avail=[math]::Round([double]$perf.AvailableMBytes,1);$commit=[math]::Round([double]$perf.PercentCommittedBytesInUse,2)} catch {$errors.Add('host_perf_counter_unavailable')}
  try {$cfree=[int64](Get-PSDrive -Name C -ErrorAction Stop).Free} catch {$errors.Add('c_drive_telemetry_unavailable')}
  $combined=if($null -ne $pgUsed){[math]::Round($stackRss+$pgUsed,1)}else{$null}
  $vals=@($now,$apiWs,$apiPriv,$workerWs,$proxyWs,$anvilWs,$loadWs,$vitalsWs,$stackRss,$pgMem,$pgUsed,$combined,$connTotal,$connApp,$avail,$commit,$cfree,($errors -join '|'))
  Add-Content -Encoding utf8 -LiteralPath $outFull -Value (($vals | ForEach-Object { CsvValue $_ }) -join ',')
  Start-Sleep -Seconds 5
}
exit 0
