param([string]$RunId='')
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if(-not $RunId){$RunId=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ').ToLowerInvariant()+'-'+([Guid]::NewGuid().ToString('N').Substring(0,8))}
if($RunId -notmatch '^[a-z0-9-]{8,64}$'){throw 'INVALID_RUN_ID'}
$project="alder-repro-$RunId";$runDir=Join-Path $root ".local/repro/$RunId";$ctx=Join-Path $runDir 'image-build-context'
$image="alder-repro:$RunId";$compose=Join-Path $root 'tests/round6-repro/compose.yaml'
$sourceArchive=Join-Path $runDir 'source.tar.gz';$sourceManifest=Join-Path $runDir 'source-manifest.json'
$tool=''
$acq=''
$sourceInContainer="/work/.local/repro/$RunId/source.tar.gz"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
function Invoke-Docker([string[]]$DockerArgs){& docker @DockerArgs;if($LASTEXITCODE -ne 0){throw "DOCKER_COMMAND_FAILED exit=$LASTEXITCODE args=$($DockerArgs -join ' ')"}}
$nodeImage='node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32'
$postgresImage='postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
Invoke-Docker @('version','--format','{{.Server.Os}} {{.Server.Arch}}')
$engine=(& docker version --format '{{.Server.Os}} {{.Server.Arch}}').Trim();if($engine -ne 'linux amd64'){throw "LINUX_AMD64_DOCKER_ENGINE_REQUIRED got=$engine"}
foreach($pinned in @($nodeImage,$postgresImage)){Invoke-Docker @('image','inspect',$pinned,'--format','{{.Id}}')}
if((Test-Path (Join-Path $runDir 'image.json')) -or (Test-Path $sourceArchive) -or (Test-Path $sourceManifest)){throw 'RUN_OUTPUT_ALREADY_EXISTS_REFUSING_OVERWRITE'}
New-Item -ItemType Directory -Force -Path $ctx | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'tests/round6-repro/Dockerfile') -Destination (Join-Path $ctx 'Dockerfile')
Invoke-Docker @('build','--pull=false','--file',(Join-Path $ctx 'Dockerfile'),'--tag',$image,$ctx)
$imageId=(& docker image inspect $image --format '{{.Id}}').Trim();if($LASTEXITCODE -ne 0){throw 'RUNNER_IMAGE_INSPECT_FAILED'}
$dockerfileHash=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $ctx 'Dockerfile')).Hash.ToLowerInvariant()
$imageReceipt=[ordered]@{schema_version='1';run_id=$RunId;image_tag=$image;image_id=$imageId;base=$nodeImage;debian_snapshot='20261102T000000Z';dockerfile='tests/round6-repro/Dockerfile';dockerfile_sha256=$dockerfileHash;status='locally_built_for_this_run';licenses=@('Node MIT','Debian component licenses; notices retained in image','Chrome is locally mounted and not redistributed');created_utc=[DateTime]::UtcNow.ToString('o')}
$imageReceipt|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $runDir 'image.json') -Encoding utf8
$builderName="$project-bootstrap"
if(@(& docker ps -aq --filter "name=^/$builderName$").Count -gt 0){throw 'BOOTSTRAP_CONTAINER_EXISTS_REFUSING_REUSE'}
$builder=(& docker create --name $builderName --workdir /work --entrypoint bash $image -lc 'sleep infinity').Trim();if($LASTEXITCODE -ne 0 -or -not $builder){throw 'BOOTSTRAP_CONTAINER_CREATE_FAILED'}
Invoke-Docker @('start',$builder)
Invoke-Docker @('exec',$builder,'mkdir','-p','/work/docs/inputs','/work/docs/licenses','/work/contracts')
foreach($dir in @('apps','packages','services','db','ops','tests','vendor','contracts/src','contracts/test','docs/licenses')){$parent=Split-Path $dir -Parent;$destination=if($parent){'/work/'+$parent.Replace('\','/')+'/'}else{'/work/'};Invoke-Docker @('cp',(Join-Path $root $dir),($builder + ':' + $destination))}
foreach($file in @('package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html','foundry.toml','README.md','RELEASE.md','.gitignore','docs/CUSTODY.md','docs/acceptance.json','docs/inputs/treasury-blueprint.md','docs/inputs/PORTFOLIO-QUALITY-CHARTER.md','docs/TR-T-REPRO-LINUX.md')){Invoke-Docker @('cp',(Join-Path $root $file),($builder + ':/work/' + $file))}
Invoke-Docker @('exec',$builder,'env',"ALDER_REPRO_RUN_ID=$RunId",'bash','tests/round6-repro/source-bundle-linux.sh')
Invoke-Docker @('cp',($builder + ":/work/.local/repro/$RunId/source.tar.gz"),$sourceArchive)
Invoke-Docker @('cp',($builder + ":/work/.local/repro/$RunId/source-manifest.json"),$sourceManifest)
if(-not (Test-Path $sourceArchive) -or -not (Test-Path $sourceManifest)){throw 'SOURCE_BUNDLE_CREATION_FAILED'}
$manifest=Get-Content -Raw -LiteralPath $sourceManifest|ConvertFrom-Json
$acqRoot=Join-Path $runDir 'acquisition';$tool=Join-Path $acqRoot 'toolchain';$acq=Join-Path $acqRoot 'browser'
$cachedAcq=Join-Path $root '.local/repro-acquisition/linux-x86_64'
$cachedMeta=Join-Path $cachedAcq 'browser/browser-linux.json'
$cachedReady=(Test-Path $cachedMeta) -and (Test-Path (Join-Path $cachedAcq 'foundry/anvil')) -and (Test-Path (Join-Path $cachedAcq 'npm-cache')) -and (Test-Path (Join-Path $cachedAcq 'browser/chrome-linux64/chrome')) -and (Test-Path (Join-Path $cachedAcq 'browser/metamask-chrome-13.50.0.zip'))
if($cachedReady){
  $browserMeta=Get-Content -Raw -LiteralPath $cachedMeta|ConvertFrom-Json
  if((Get-FileHash (Join-Path $cachedAcq 'foundry-v1.5.1-linux-amd64.tar.gz') -Algorithm SHA256).Hash.ToLowerInvariant() -ne '73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88'){throw 'CACHED_FOUNDRY_DIGEST_MISMATCH'}
  if((Get-FileHash (Join-Path $cachedAcq 'solc-0.8.24') -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f'){throw 'CACHED_SOLC_DIGEST_MISMATCH'}
  if((Get-FileHash (Join-Path $cachedAcq 'browser/metamask-chrome-13.50.0.zip') -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'b759caca275dec1a10edfebb9d1de1d26589a92104d8b0523ec442930e20e47c'){throw 'CACHED_WALLET_DIGEST_MISMATCH'}
  if($browserMeta.version -ne '151.0.7922.34' -or (Get-FileHash (Join-Path $cachedAcq 'browser/chrome-linux64.zip') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $browserMeta.linux_x64_archive_sha256 -or (Get-FileHash (Join-Path $cachedAcq 'browser/chrome-linux64/chrome') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $browserMeta.linux_x64_executable_sha256){throw 'CACHED_BROWSER_DIGEST_MISMATCH'}
  $knownGood=Join-Path $cachedAcq 'browser/known-good-versions-with-downloads.json'
  if((Get-FileHash $knownGood -Algorithm SHA256).Hash.ToLowerInvariant() -ne $browserMeta.official_version_metadata_sha256){throw 'CACHED_CFT_METADATA_DIGEST_MISMATCH'}
  if(-not (Select-String -LiteralPath $knownGood -SimpleMatch $browserMeta.download_url -Quiet)){throw 'CACHED_CFT_VERSION_URL_NOT_IN_OFFICIAL_METADATA'}
  $chromeZip=Join-Path $cachedAcq 'browser/chrome-linux64.zip'
  if((Get-Item $chromeZip).Length -ne $browserMeta.google_storage_object.content_length){throw 'CACHED_CFT_CONTENT_LENGTH_MISMATCH'}
  $md5=[Security.Cryptography.MD5]::Create();try{$stream=[IO.File]::OpenRead($chromeZip);try{$md5Base64=[Convert]::ToBase64String($md5.ComputeHash($stream))}finally{$stream.Dispose()}}finally{$md5.Dispose()}
  if($md5Base64 -ne $browserMeta.google_storage_object.md5_base64){throw 'CACHED_CFT_STORAGE_MD5_MISMATCH'}
  $lockHash=(Get-FileHash (Join-Path $root 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant();if($manifest.package_lock_sha256 -ne $lockHash){throw 'SOURCE_LOCKFILE_ACQUISITION_MISMATCH'}
  New-Item -ItemType Directory -Force -Path $tool,$acq|Out-Null
  foreach($item in @('foundry','npm-cache')){Copy-Item -LiteralPath (Join-Path $cachedAcq $item) -Destination $tool -Recurse}
  foreach($file in @('foundry-v1.5.1-linux-amd64.tar.gz','solc-0.8.24','toolchain.json')){Copy-Item -LiteralPath (Join-Path $cachedAcq $file) -Destination $tool}
  foreach($item in @('chrome-linux64','metamask-chrome-13.50.0-unpacked')){Copy-Item -LiteralPath (Join-Path $cachedAcq "browser/$item") -Destination $acq -Recurse}
  foreach($file in @('chrome-linux64.zip','metamask-chrome-13.50.0.zip','browser-linux.json','known-good-versions-with-downloads.json')){Copy-Item -LiteralPath (Join-Path $cachedAcq "browser/$file") -Destination $acq}
}else{
  Invoke-Docker @('exec',$builder,'env',"ALDER_REPRO_RUN_ID=$RunId","ALDER_REPRO_SOURCE_ARCHIVE=$sourceInContainer",'bash','tests/round6-repro/acquire-linux.sh')
  $stage=Join-Path $runDir 'acquisition-stage';New-Item -ItemType Directory -Force -Path $stage|Out-Null
  Invoke-Docker @('cp',($builder + ':/work/.local/repro-acquisition/linux-x86_64/toolchain'),$stage)
  Invoke-Docker @('cp',($builder + ':/work/.local/repro-acquisition/linux-x86_64/browser'),$stage)
  Move-Item -LiteralPath (Join-Path $stage 'toolchain') -Destination $tool;Move-Item -LiteralPath (Join-Path $stage 'browser') -Destination $acq
}
if(-not (Test-Path (Join-Path $tool 'toolchain.json')) -or -not (Test-Path (Join-Path $acq 'browser-linux.json'))){throw 'OFFLINE_TOOLCHAIN_ACQUISITION_FAILED'}
Invoke-Docker @('rm','-f',$builder)
$env:ALDER_REPRO_SOURCE_VOLUME="$project-repro-source";$env:ALDER_REPRO_TOOLCHAIN_VOLUME="$project-repro-toolchain";$env:ALDER_REPRO_ACQUISITION_VOLUME="$project-repro-acquisition"
$sourceHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $sourceArchive).Hash.ToLowerInvariant()
$manifest=Get-Content -Raw -LiteralPath $sourceManifest|ConvertFrom-Json
if($manifest.archive_sha256 -ne $sourceHash){throw 'SOURCE_ARCHIVE_MANIFEST_MISMATCH'}
$env:ALDER_REPRO_PROJECT=$project;$env:ALDER_REPRO_SOURCE_ARCHIVE=$sourceArchive.Replace('\','/')
$env:ALDER_REPRO_TOOLCHAIN_DIR=$tool;$env:ALDER_REPRO_ACQUISITION_DIR=$acq;$env:ALDER_REPRO_IMAGE=$image
if(@(& docker ps -aq --filter "label=com.docker.compose.project=$project").Count -gt 0){throw 'COMPOSE_PROJECT_EXISTS_REFUSING_REUSE'}
if(@(& docker volume ls -q --filter "label=com.docker.compose.project=$project").Count -gt 0){throw 'COMPOSE_VOLUME_EXISTS_REFUSING_REUSE'}
$stackPath=Join-Path $runDir 'stack.json'
$stack=[ordered]@{schema_version='1';run_id=$RunId;compose_project=$project;status='compose_start_attempted';source_archive_path=$sourceArchive;source_manifest_path=$sourceManifest;source_manifest_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $sourceManifest).Hash.ToLowerInvariant();toolchain_directory=$tool;acquisition_directory=$acq;runner_image_tag=$image;runner_image_id=$imageId;host_kernel='Windows Docker Desktop Linux VM; Linux kernel evidence collected by container run';architecture='linux/amd64';network_mode='hub:none; postgres/anvil share hub network namespace';anvil_hardfork='shanghai';published_host_ports=@();internal_endpoints=@{postgres='127.0.0.1:5543';wallet_and_truth_anvil='127.0.0.1:8547';API='127.0.0.1:8103';compiled_UI='127.0.0.1:5113';worker='127.0.0.1:8113'};source_archive_sha256=$sourceHash;node_image=$nodeImage;postgres_image=$postgresImage;created_utc=[DateTime]::UtcNow.ToString('o')}
$stack|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $stackPath -Encoding utf8
$compose=Join-Path $root 'tests/round6-repro/compose-windows.yaml'
Invoke-Docker @('compose','--project-name',$project,'-f',$compose,'up','--pull','never','--detach','hub','postgres')
$hubId=(& docker compose --project-name $project -f $compose ps --quiet hub).Trim();if(-not $hubId){throw 'ISOLATED_HUB_NOT_CREATED'}
Invoke-Docker @('cp',$sourceArchive,($hubId + ':/input/source.tar.gz'))
foreach($item in @('foundry','npm-cache')){Invoke-Docker @('cp',(Join-Path $tool $item),($hubId + ':/opt/toolchain/'))}
foreach($file in @('foundry-v1.5.1-linux-amd64.tar.gz','solc-0.8.24','toolchain.json')){Invoke-Docker @('cp',(Join-Path $tool $file),($hubId + ':/opt/toolchain/'))}
foreach($item in @('chrome-linux64','metamask-chrome-13.50.0-unpacked')){Invoke-Docker @('cp',(Join-Path $acq $item),($hubId + ':/opt/acquisition/'))}
foreach($file in @('chrome-linux64.zip','metamask-chrome-13.50.0.zip','browser-linux.json','known-good-versions-with-downloads.json')){Invoke-Docker @('cp',(Join-Path $acq $file),($hubId + ':/opt/acquisition/'))}
Invoke-Docker @('compose','--project-name',$project,'-f',$compose,'up','--pull','never','--detach','anvil')
for($i=0;$i -lt 90;$i++){
  $ids=@(& docker compose --project-name $project -f $compose ps --quiet)
  $allHealthy=($ids.Count -eq 3)
  foreach($cid in $ids){$state=(& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $cid).Trim();if($state -ne 'healthy'){$allHealthy=$false}}
  if($allHealthy){break};Start-Sleep -Seconds 1
}
if(-not $allHealthy){throw 'ISOLATED_COMPOSE_SERVICES_NOT_HEALTHY'}
foreach($cid in $ids){$bindings=(& docker inspect --format '{{json .HostConfig.PortBindings}}' $cid).Trim();if($bindings -ne 'null' -and $bindings -ne '{}'){throw "HOST_PORT_MAPPING_PRESENT container=$cid bindings=$bindings"}}
$browser=Get-Content -Raw -LiteralPath (Join-Path $acq 'browser-linux.json')|ConvertFrom-Json
$stack.status='isolated_namespace_started_only';$stack.browser=$browser;$stack.wallet_zip_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $acq 'metamask-chrome-13.50.0.zip')).Hash.ToLowerInvariant();$stack.started_utc=[DateTime]::UtcNow.ToString('o')
$stack|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $stackPath -Encoding utf8
$inner='mkdir -p /tmp/repro-entry && tar -xzf /input/source.tar.gz -C /tmp/repro-entry tests/round6-repro/run-internal-linux.sh && bash /tmp/repro-entry/tests/round6-repro/run-internal-linux.sh'
Invoke-Docker @('compose','--project-name',$project,'-f',$compose,'exec','--no-TTY','hub','bash','-lc',$inner)
Invoke-Docker @('compose','--project-name',$project,'-f',$compose,'cp','hub:/proof/public/artifact-manifest.json',(Join-Path $runDir 'artifact-manifest.json'))
$art=Get-Content -Raw -LiteralPath (Join-Path $runDir 'artifact-manifest.json')|ConvertFrom-Json
$done=[ordered]@{schema_version='1';run_id=$RunId;compose_project=$project;source_archive_sha256=$sourceHash;runner_image_id=$imageId;public_artifact_manifest_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runDir 'artifact-manifest.json')).Hash.ToLowerInvariant();private_raw_proof_location="Compose project $project proof volume; not copied into public packet";status='driver exited successfully; acceptance reconciliation remains independent';artifact_count=$art.artifacts.Count;created_utc=[DateTime]::UtcNow.ToString('o')}
$done|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $runDir 'run-completion.json') -Encoding utf8
Write-Output "REPRO_RUN=$RunId"
Write-Output "SOURCE_SHA256=$sourceHash"
Write-Output "PUBLIC_ARTIFACT_MANIFEST=$(Join-Path $runDir 'artifact-manifest.json')"
Write-Output "PRIVATE_RAW_PROOF=Compose project $project proof volume (preserved)"
