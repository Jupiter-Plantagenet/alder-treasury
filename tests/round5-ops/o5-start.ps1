# O5 isolated stack launcher (round-5 ops). Usage: o5-start.ps1 api|proxy|anvil|stop-api <srcSnapshotDir>
# Starts detached via Win32_Process.Create (no inherited handles). Only ever touches ports 9103/18547/18548.
param([string]$What='api',[string]$Src='')
$root='C:\Users\user\portfolio-build\alder'; $logs="$root\evidence\round5-ops\runtime"; New-Item -ItemType Directory -Force $logs | Out-Null
$node='C:\Users\user\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe'
function Owner($port){ $c=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}else{$null} }
$ts=Get-Date -Format 'yyyyMMddTHHmmss'
if($What -eq 'stop-api'){ $o=Owner 9103; if($o){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$o"; if($p.CommandLine -like '*isolated-api.ts*'){ Stop-Process -Id $o -Force; "stopped isolated api pid $o" } else { "port 9103 owned by non-O5 pid $o; refusing" } } else { 'isolated api not running' }; exit }
if($What -eq 'api'){ if(Owner 9103){ "9103 busy pid $(Owner 9103)"; exit 1 }
 $env:O5_SRC=$Src; $cmd='cmd.exe /d /c "set O5_SRC='+$Src+'&& "'+$node+'" --import tsx tests/round5-ops/isolated-api.ts > "'+$logs+"\isolated-api-$ts.out.log"+'" 2> "'+$logs+"\isolated-api-$ts.err.log"+'""'
 $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd;CurrentDirectory=$root}
 for($i=0;$i -lt 60 -and -not (Owner 9103);$i++){ Start-Sleep -Milliseconds 500 }
 "isolated api pid $(Owner 9103) wrapper $($r.ProcessId) log isolated-api-$ts started $(Get-Date -Format o)" }
