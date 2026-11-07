[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('status','install','remove','run')][string]$Action,
    [string]$ReviewedSourceSha256,
    [string]$ReviewedCryptoSha256,
    [string]$ReviewedTaskSha256,
    [string]$InstallId
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expectedRoot='C:\Users\user\portfolio-build\alder'
if ($root -ne $expectedRoot) { throw 'ALDER_ROOT_PATH_MISMATCH' }
$pythonScript=Join-Path $root 'ops\wal-archive.py'
$cryptoScript=Join-Path $root 'ops\wal-crypto.mjs'
$node=Join-Path $root '.local\runtime\node-v26.7.0\node.exe'
$nodePin='e921fe5307e29bf6fd00000dd594356affd3a7b044e52720c7f10decbdc305b9'
$python=(Get-Command python -ErrorAction Stop).Source
$script=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'wal-archive-task.ps1'))
$ownerDir=Join-Path $root '.local\backups\wal-archive\live\ownership'
$taskName='Alder WAL Archive V1'
$marker='ALDER_WAL_ARCHIVE_MANAGED_V1'
$runUser=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$runUser.User.Value
$userName=$runUser.Name
$powershell=[IO.Path]::GetFullPath((Join-Path $PSHOME 'powershell.exe'))

function Assert-NoReparsePath([string]$Path,[string]$AllowedRoot) {
    $full=[IO.Path]::GetFullPath($Path)
    $allowed=[IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\')
    if ($full -ne $allowed -and -not $full.StartsWith($allowed+'\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'PRIVATE_PATH_OUTSIDE_ALLOWED_ROOT'
    }
    if (-not $full.StartsWith('C:\',[StringComparison]::OrdinalIgnoreCase)) { throw 'PRIVATE_PATH_MUST_REMAIN_ON_C' }
    $current='C:\'
    $tail=$full.Substring(3)
    foreach ($part in $tail.Split('\',[StringSplitOptions]::RemoveEmptyEntries)) {
        $current=Join-Path $current $part
        # Get-Item -Force inspects the link itself; unlike Test-Path it can surface dangling links.
        $item=Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'SYMLINK_OR_REPARSE_COMPONENT_REFUSED'
        }
    }
    return $full
}

function Get-Hash([string]$Path) {
    $Path=Assert-NoReparsePath $Path $root
    $sha=[Security.Cryptography.SHA256]::Create()
    $stream=[IO.File]::OpenRead($Path)
    try { $bytes=$sha.ComputeHash($stream) }
    finally { $stream.Dispose(); $sha.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
}
function ConvertTo-Sid([string]$Identity) {
    if ($Identity -match '^S-1-') { return $Identity }
    return (New-Object Security.Principal.NTAccount($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Get-Seconds([object]$Value) {
    $text=[string]$Value
    try { return [int][System.Xml.XmlConvert]::ToTimeSpan($text).TotalSeconds }
    catch { return [int][TimeSpan]::Parse($text).TotalSeconds }
}
function Ensure-OwnerDir {
    $null=Assert-NoReparsePath $root $expectedRoot
    $null=Assert-NoReparsePath $ownerDir $root
    if (-not (Test-Path -LiteralPath $ownerDir)) { New-Item -ItemType Directory -Path $ownerDir -Force | Out-Null }
    $null=Assert-NoReparsePath $ownerDir $root
    $null=icacls $ownerDir /inheritance:r /grant:r ($userName+':(OI)(CI)F') 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'TASK_OWNER_DIRECTORY_ACL_FAILED' }
    $null=Assert-NoReparsePath $ownerDir $root
}
function Write-ImmutableJson([string]$Path,$Value) {
    $Path=Assert-NoReparsePath $Path $ownerDir
    $json=($Value | ConvertTo-Json -Depth 8) + "`n"
    $bytes=[Text.Encoding]::UTF8.GetBytes($json)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Get-OwnerRecord([string]$Id) {
    if ($Id -notmatch '^[a-f0-9]{32}$') { throw 'TASK_OWNER_ID_INVALID' }
    $receipt=Join-Path $ownerDir ('task-owner-'+$Id+'.registered.json')
    $null=Assert-NoReparsePath $receipt $ownerDir
    if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) { throw 'EXACT_TASK_OWNER_RECEIPT_MISSING' }
    if ((Get-Item -LiteralPath $receipt).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'TASK_OWNER_RECEIPT_REPARSE_REFUSED' }
    return (Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json)
}
function Get-TaskSignature($Task) {
    if ($Task.Actions.Count -ne 1 -or $Task.Triggers.Count -ne 1) { throw 'SCHEDULED_TASK_CARDINALITY_MISMATCH' }
    $trigger=$Task.Triggers[0]
    return [ordered]@{
        taskName=$Task.TaskName; description=$Task.Description
        actionExecute=[IO.Path]::GetFullPath($Task.Actions[0].Execute)
        actionArguments=$Task.Actions[0].Arguments
        actionWorkingDirectory=[IO.Path]::GetFullPath($Task.Actions[0].WorkingDirectory)
        principalSid=(ConvertTo-Sid ([string]$Task.Principal.UserId))
        principalLogonType=[string]$Task.Principal.LogonType
        principalRunLevel=[string]$Task.Principal.RunLevel
        triggerClass=[string]$trigger.CimClass.CimClassName
        triggerSid=(ConvertTo-Sid ([string]$trigger.UserId))
        startWhenAvailable=[bool]$Task.Settings.StartWhenAvailable
        multipleInstances=[string]$Task.Settings.MultipleInstances
        restartCount=[int]$Task.Settings.RestartCount
        restartIntervalSeconds=(Get-Seconds $Task.Settings.RestartInterval)
        executionTimeLimitSeconds=(Get-Seconds $Task.Settings.ExecutionTimeLimit)
    }
}
function Assert-OwnedTask([string]$Id) {
    $t=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $t) { throw 'SCHEDULED_TASK_NOT_PRESENT' }
    $record=Get-OwnerRecord $Id
    if ($t.Description -ne ($marker+':'+$Id)) { throw 'SCHEDULED_TASK_DESCRIPTION_ID_MISMATCH' }
    $actual=Get-TaskSignature $t
    $expected=$record.taskSignature | ConvertTo-Json -Depth 8 -Compress
    $observed=$actual | ConvertTo-Json -Depth 8 -Compress
    if ($observed -ne $expected) { throw 'SCHEDULED_TASK_FULL_SIGNATURE_MISMATCH' }
    if ($record.installId -ne $Id -or $record.principalSid -ne $sid) { throw 'TASK_OWNER_PRINCIPAL_BINDING_MISMATCH' }
    return ,@($t,$record)
}
function Load-ConfigReceipt([string]$Id) {
    $pair=Assert-OwnedTask $Id
    $record=$pair[1]
    if ((Get-Hash $pythonScript) -ne $record.sourceSha256 -or (Get-Hash $cryptoScript) -ne $record.cryptoSha256 -or
        (Get-Hash $script) -ne $record.taskHelperSha256 -or (Get-Hash $node) -ne $record.nodeSha256 -or
        (Get-Hash $node) -ne $nodePin) {
        throw 'TASK_PINNED_SOURCE_OR_RUNTIME_HASH_MISMATCH'
    }
    return $record
}

if ($Action -eq 'run') {
    Ensure-OwnerDir
    $record=Load-ConfigReceipt $InstallId
    $pyVersion=& $python --version
    if ($LASTEXITCODE -ne 0 -or $pyVersion -notmatch '^Python 3\.12\.') { throw 'PYTHON_3_12_RUNTIME_REQUIRED' }
    $nodeVersion=& $node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v26.7.0') { throw 'PINNED_NODE_26_7_0_REQUIRED' }
    $args='"'+$pythonScript+'" service --source-sha256 '+$record.sourceSha256+' --crypto-sha256 '+$record.cryptoSha256
    $child=Start-Process -FilePath $python -ArgumentList $args -WorkingDirectory $root -WindowStyle Hidden -Wait -PassThru
    exit $child.ExitCode
}

if ($Action -eq 'status') {
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { [pscustomobject]@{TaskName=$taskName;State='NOT_INSTALLED'}; exit 0 }
    $descriptionMatch=[regex]::Match($task.Description,'^'+[regex]::Escape($marker)+':([a-f0-9]{32})$')
    if (-not $descriptionMatch.Success) { throw 'SCHEDULED_TASK_IS_NOT_PROVABLY_OWNED' }
    $id=$descriptionMatch.Groups[1].Value; $pair=Assert-OwnedTask $id
    Get-ScheduledTaskInfo -TaskName $taskName | Select-Object TaskName,LastRunTime,LastTaskResult,NextRunTime
    exit 0
}

if ($Action -eq 'install') {
    Ensure-OwnerDir
    if (-not $ReviewedSourceSha256 -or $ReviewedSourceSha256.ToLowerInvariant() -ne (Get-Hash $pythonScript)) { throw 'PYTHON_SOURCE_REVIEW_HASH_REQUIRED' }
    if (-not $ReviewedCryptoSha256 -or $ReviewedCryptoSha256.ToLowerInvariant() -ne (Get-Hash $cryptoScript)) { throw 'CRYPTO_SOURCE_REVIEW_HASH_REQUIRED' }
    if (-not $ReviewedTaskSha256 -or $ReviewedTaskSha256.ToLowerInvariant() -ne (Get-Hash $script)) { throw 'TASK_HELPER_REVIEW_HASH_REQUIRED' }
    if (-not (Test-Path -LiteralPath $node) -or (Get-Hash $node) -ne $nodePin) { throw 'PINNED_NODE_26_7_0_HASH_MISMATCH' }
    $pyVersion=& $python --version
    if ($LASTEXITCODE -ne 0 -or $pyVersion -notmatch '^Python 3\.12\.') { throw 'PYTHON_3_12_RUNTIME_REQUIRED' }
    $nodeVersion=& $node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v26.7.0') { throw 'PINNED_NODE_26_7_0_REQUIRED' }
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'TASK_NAME_ALREADY_EXISTS_REFUSE_TO_OVERWRITE' }
    $installId=[guid]::NewGuid().ToString('N')
    $description=$marker+':'+$installId
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $userName
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    $argumentString='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$script+'" -Action run -InstallId '+$installId
    $action=New-ScheduledTaskAction -Execute $powershell -Argument $argumentString -WorkingDirectory $root
    $principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $expected=[ordered]@{taskName=$taskName;description=$description;actionExecute=$powershell;actionArguments=$argumentString;
        actionWorkingDirectory=$root;principalSid=$sid;principalLogonType='Interactive';principalRunLevel='Limited';
        triggerClass='MSFT_TaskLogonTrigger';triggerSid=$sid;startWhenAvailable=$true;multipleInstances='IgnoreNew';
        restartCount=999;restartIntervalSeconds=60;executionTimeLimitSeconds=0}
    $intent=[ordered]@{schema='alder-wal-task-owner-intent-v1';installId=$installId;principalSid=$sid;expectedTaskSignature=$expected;
        sourceSha256=$ReviewedSourceSha256.ToLowerInvariant();cryptoSha256=$ReviewedCryptoSha256.ToLowerInvariant();
        taskHelperSha256=$ReviewedTaskSha256.ToLowerInvariant();nodeSha256=Get-Hash $node;createdUtc=[DateTime]::UtcNow.ToString('o')}
    Write-ImmutableJson (Join-Path $ownerDir ('task-owner-'+$installId+'.intent.json')) $intent
    Register-ScheduledTask -TaskName $taskName -Description $description -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
    $task=Get-ScheduledTask -TaskName $taskName
    $signature=Get-TaskSignature $task
    $signatureJson=$signature | ConvertTo-Json -Depth 8 -Compress
    $expectedJson=$expected | ConvertTo-Json -Depth 8 -Compress
    if ($signatureJson -ne $expectedJson) {
        $fresh=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($fresh -and $fresh.Description -eq $description) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
        throw 'REGISTERED_TASK_SIGNATURE_DIFFERS_FROM_REVIEWED_INTENT'
    }
    $record=[ordered]@{schema='alder-wal-task-owner-v1';installId=$installId;taskName=$taskName;principalSid=$sid;
        taskSignature=$signature;sourceSha256=$intent.sourceSha256;cryptoSha256=$intent.cryptoSha256;
        taskHelperSha256=$intent.taskHelperSha256;nodeSha256=$intent.nodeSha256;createdUtc=$intent.createdUtc}
    Write-ImmutableJson (Join-Path $ownerDir ('task-owner-'+$installId+'.registered.json')) $record
    Write-Output ('INSTALLED_REVIEWED_TASK '+$installId+'; service remains logon-session scoped.')
    exit 0
}

if ($Action -eq 'remove') {
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Output 'NOT_INSTALLED'; exit 0 }
    $descriptionMatch=[regex]::Match($task.Description,'^'+[regex]::Escape($marker)+':([a-f0-9]{32})$')
    if (-not $descriptionMatch.Success) { throw 'SCHEDULED_TASK_IS_NOT_PROVABLY_OWNED' }
    $id=$descriptionMatch.Groups[1].Value; $pair=Assert-OwnedTask $id
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Ensure-OwnerDir
    Write-ImmutableJson (Join-Path $ownerDir ('task-owner-'+$id+'.removed.json')) ([ordered]@{schema='alder-wal-task-removed-v1';installId=$id;removedUtc=[DateTime]::UtcNow.ToString('o');taskSignature=$pair[1].taskSignature})
    Write-Output 'REMOVED_EXACT_OWNED_TASK; receiver, slot and archive remain preserved.'
}
