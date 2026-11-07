# O5 resource sampler: every 5 s for $Seconds: RSS/private bytes of the isolated API (9103), O5 proxy (18547), isolated Anvil (18548),
# scratch PG container memory (docker stats), PG connections to the scratch alder DB, host available memory. CSV out.
param([int]$Seconds=1900,[string]$Out='evidence/round5-ops/load/resources.csv')
Set-Location 'C:\Users\user\portfolio-build\alder'
"utc,api_ws_mb,api_private_mb,proxy_ws_mb,anvil_ws_mb,pg_container_mem,pg_conn_total,pg_conn_app,host_avail_mb" | Set-Content -Encoding utf8 $Out
function P($port){ $c=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){ Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue } }
$end=(Get-Date).AddSeconds($Seconds)
while((Get-Date) -lt $end){
 $a=P 9103; $x=P 18547; $v=P 18548
 $mem=(docker stats --no-stream --format "{{.MemUsage}}" alder-o5-pg) -replace ',',';'
 $conn=(docker exec alder-o5-pg psql -U postgres -Atc "select count(*)||';'||count(*) filter (where usename='alder_app') from pg_stat_activity where datname='alder'") -split ';'
 $avail=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
 "$((Get-Date).ToUniversalTime().ToString('o')),$([math]::Round($a.WorkingSet64/1MB,1)),$([math]::Round($a.PrivateMemorySize64/1MB,1)),$([math]::Round($x.WorkingSet64/1MB,1)),$([math]::Round($v.WorkingSet64/1MB,1)),$mem,$($conn[0]),$($conn[1]),$avail" | Add-Content -Encoding utf8 $Out
 Start-Sleep -Seconds 4
}
