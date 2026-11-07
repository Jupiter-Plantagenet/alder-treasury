// Creates a labeled, bounded PostgreSQL restore clone on reserved host port 15545,
// executes the production policy guard integration, captures a post-proof dump, and
// leaves the owned container/volume running for the coordinator's cache-agent handoff.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import net from 'node:net';

const ROOT=process.cwd();
const BACKUP=path.join(ROOT,'.local','backups','round6-consistent-20261102T125627Z-root-proof');
const MANIFEST=path.join(BACKUP,'manifest.json');
const DUMP=path.join(BACKUP,'alder.dump');
const ROLES=path.join(BACKUP,'roles.sql');
const EXPECTED_MANIFEST='357915be6e3f13347eab9531d9ffd85345f913f9e628406df98ff7994c76d2a3';
const EXPECTED_DUMP='7d385e45a4e6dac63b5de3c0c367288738bd49f169895e20ee80166e397aa437';
const IMAGE='sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const RESUME_OWNER=process.env.ALDER_R7_FINISH_RESUME_OWNER;
if(RESUME_OWNER&&!/^r7finish-20261103-policy-[0-9a-f]{12}$/.test(RESUME_OWNER))throw new Error('RESUME_OWNER_LABEL_INVALID');
const OWNER=RESUME_OWNER||'r7finish-20261103-policy-'+randomBytes(6).toString('hex');
const SUFFIX=OWNER.replaceAll(':','-');
const CONTAINER='alder-'+SUFFIX;
const VOLUME='alder-'+SUFFIX+'-pgdata';
const RUN=path.join(ROOT,'.local','round7-finish-'+SUFFIX+(RESUME_OWNER?'-resume':''));
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function cmd(file:string,args:string[],input?:Buffer,env:NodeJS.ProcessEnv=process.env){
 const r=spawnSync(file,args,{cwd:ROOT,input,env,windowsHide:true,maxBuffer:64*1024*1024,encoding:null});
 if(r.error||r.status!==0)throw new Error('SAFE_COMMAND_FAILED_'+path.basename(file)+'_'+sha(Buffer.concat([r.stdout||Buffer.alloc(0),r.stderr||Buffer.alloc(0)])));
 return r.stdout||Buffer.alloc(0);
}
function docker(args:string[],input?:Buffer){return cmd('docker',args,input);}
function assertFreePort(port:number){return new Promise<void>((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(new Error('RESERVED_PORT_NOT_FREE_'+port)));s.listen(port,'127.0.0.1',()=>s.close(e=>e?reject(e):resolve()));});}
async function main(){
 if(!fs.existsSync(MANIFEST)||!fs.existsSync(DUMP)||!fs.existsSync(ROLES))throw new Error('AUTHORIZED_BACKUP_FILES_MISSING');
 const manifestBytes=fs.readFileSync(MANIFEST),dumpBytes=fs.readFileSync(DUMP),manifest=JSON.parse(manifestBytes.toString());
 if(sha(manifestBytes)!==EXPECTED_MANIFEST||sha(dumpBytes)!==EXPECTED_DUMP||manifest.schema!=='alder.round6-consistent-backup/v1')throw new Error('AUTHORIZED_BACKUP_PIN_MISMATCH');
 if(manifest.sourceIdentity?.database!=='alder'||manifest.expectedTableCount!==54)throw new Error('AUTHORIZED_BACKUP_IDENTITY_MISMATCH');
 if(!RESUME_OWNER)await assertFreePort(15545);
 if(!RESUME_OWNER&&spawnSync('docker',['inspect',CONTAINER],{windowsHide:true,stdio:'ignore'}).status===0)throw new Error('TASK_CONTAINER_NAME_ALREADY_EXISTS');
 if(!RESUME_OWNER&&spawnSync('docker',['volume','inspect',VOLUME],{windowsHide:true,stdio:'ignore'}).status===0)throw new Error('TASK_VOLUME_NAME_ALREADY_EXISTS');
 if(!fs.existsSync(RUN)){
  fs.mkdirSync(RUN,{recursive:false});
  const account=process.env.USERNAME||os.userInfo().username;
  cmd('icacls.exe',[RUN,'/inheritance:r','/grant:r',`${account}:(OI)(CI)F`]);
 }else if(fs.existsSync(path.join(RUN,'receipt.json')))throw new Error('RUN_ALREADY_HAS_RECEIPT');
 let dbpass=randomBytes(32).toString('hex');
 const appCred=JSON.parse(fs.readFileSync(path.join(BACKUP,'private','.local','database-app.json'),'utf8'));
 const userCred=JSON.parse(fs.readFileSync(path.join(BACKUP,'private','.local','accounts.json'),'utf8'));
 if(appCred.user!=='alder_app'||typeof appCred.password!=='string'||typeof userCred.password!=='string')throw new Error('PRIVATE_RESTORE_CREDENTIAL_SHAPE_INVALID');
 const started=new Date().toISOString();
 let volumeCreated=false,containerCreated=false;
 const report:any={schema:'alder.round7-finish-pg/v1',startedAtUtc:started,ownerLabel:OWNER,container:CONTAINER,volume:VOLUME,host:'127.0.0.1',hostPort:15545,database:'alder_r7finish',image:IMAGE,backup:{manifestSha256:sha(manifestBytes),dumpSha256:sha(dumpBytes),sourceSystemIdentifier:manifest.sourceIdentity.systemIdentifier,sourceTableCount:manifest.expectedTableCount},preexistingResourcesTouched:false,canonicalDatabaseOrChainTouched:false,cleanup:'owned scratch container and volume intentionally retained for cache-agent handoff',checks:{}};
 try{
  if(RESUME_OWNER){
   const info=JSON.parse(docker(['inspect',CONTAINER]).toString())[0];
   const labels=info.Config?.Labels||{};
   const vol=JSON.parse(docker(['volume','inspect',VOLUME]).toString())[0];
   if(labels['alder.round7.owner']!==OWNER||(vol.Labels||{})['alder.round7.owner']!==OWNER||info.State?.Status!=='running')throw new Error('RESUME_RESOURCE_OWNER_OR_STATE_MISMATCH');
   const pgEnv=(info.Config?.Env||[]).find((x:string)=>x.startsWith('POSTGRES_PASSWORD='));
   if(!pgEnv)throw new Error('RESUME_PRIVATE_DB_CREDENTIAL_MISSING');
   dbpass=pgEnv.slice('POSTGRES_PASSWORD='.length);containerCreated=true;volumeCreated=true;
  }else{
   if(spawnSync('docker',['inspect',CONTAINER],{windowsHide:true,stdio:'ignore'}).status===0)throw new Error('TASK_CONTAINER_NAME_ALREADY_EXISTS');
   if(spawnSync('docker',['volume','inspect',VOLUME],{windowsHide:true,stdio:'ignore'}).status===0)throw new Error('TASK_VOLUME_NAME_ALREADY_EXISTS');
   docker(['volume','create','--label',`alder.round7.owner=${OWNER}`,VOLUME]);volumeCreated=true;
   docker(['run','--detach','--name',CONTAINER,'--label',`alder.round7.owner=${OWNER}`,'--publish','127.0.0.1:15545:5432','--memory','2g','--cpus','2','--env',`POSTGRES_PASSWORD=${dbpass}`,'--env','POSTGRES_DB=alder_r7finish','--mount',`type=volume,source=${VOLUME},target=/var/lib/postgresql/data`,IMAGE]);containerCreated=true;
  }
  const containerOwner=docker(['inspect','--format','{{ index .Config.Labels "alder.round7.owner" }}',CONTAINER]).toString().trim();
  const volumeOwner=docker(['volume','inspect','--format','{{ index .Labels "alder.round7.owner" }}',VOLUME]).toString().trim();
  if(containerOwner!==OWNER||volumeOwner!==OWNER)throw new Error('TASK_OWNER_LABEL_MISMATCH');
  const mappings=JSON.parse(docker(['inspect',CONTAINER]).toString())[0].NetworkSettings?.Ports?.['5432/tcp']||[];
  if(!mappings.some((m:any)=>m.HostIp==='127.0.0.1'&&m.HostPort==='15545'))throw new Error('TASK_PORT_BINDING_MISMATCH');
  let ready=false;for(let i=0;i<90;i++){const r=spawnSync('docker',['exec',CONTAINER,'pg_isready','-U','postgres','-d','alder_r7finish'],{windowsHide:true,stdio:'ignore'});if(r.status===0){ready=true;break;}await new Promise(r=>setTimeout(r,1000));}if(!ready)throw new Error('SCRATCH_POSTGRES_NOT_READY');
  if(!RESUME_OWNER){
   const rolesText=fs.readFileSync(ROLES,'utf8').replace(/^CREATE ROLE postgres;\r?\nALTER ROLE postgres[^;]*;\r?\n/gm,'');
   docker(['exec','-i',CONTAINER,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],Buffer.from(rolesText));
   docker(['exec','-i',CONTAINER,'pg_restore','--no-owner','--exit-on-error','-U','postgres','-d','alder_r7finish'],dumpBytes);
  }
  const appUrl=`postgresql://${appCred.user}:${encodeURIComponent(appCred.password)}@127.0.0.1:15545/alder_r7finish`;
  const adminUrl=`postgresql://postgres:${encodeURIComponent(dbpass)}@127.0.0.1:15545/alder_r7finish`;
  const env={...process.env,ALDER_R7_FINISH_APP_URL:appUrl,ALDER_R7_FINISH_ADMIN_URL:adminUrl,ALDER_R7_FINISH_LOGIN_PASSWORD:userCred.password,ALDER_R7_FINISH_OWNER:OWNER};
  const test=cmd(process.execPath,[path.join(ROOT,'node_modules','tsx','dist','cli.mjs'),'--test','tests/round7-finish/policy-pg.integration.test.ts'],undefined,env);
  const originalsUnchanged=sha(fs.readFileSync(MANIFEST))===EXPECTED_MANIFEST&&sha(fs.readFileSync(DUMP))===EXPECTED_DUMP;
  const integrationPassed=/pass 1\b/.test(test.toString());
  report.sourcePins={policyIntegrationTest:sha(fs.readFileSync(path.join(ROOT,'tests/round7-finish/policy-pg.integration.test.ts'))),
   policySource:sha(fs.readFileSync(path.join(ROOT,'apps/api/policy.ts'))),apiSource:sha(fs.readFileSync(path.join(ROOT,'apps/api/app.ts'))),
   databaseSource:sha(fs.readFileSync(path.join(ROOT,'apps/api/database.ts')))};
  report.checks={restoreCompleted:true,policyPostgresIntegration:{passed:integrationPassed,testCount:1,failedCount:0,
   assertion:'POLICY_UNMATCHED under alder_app session/workspace RLS; review/event counts unchanged; no payable row inserted',
   summarySha256:sha(test),privateStdoutSha256:sha(test)},hostPortBound:true,sourceBackupUnmodified:originalsUnchanged};
  if(!originalsUnchanged)throw new Error('SOURCE_BACKUP_CHANGED_DURING_CLONE');
  if(!report.checks.policyPostgresIntegration.passed)throw new Error('POLICY_POSTGRES_INTEGRATION_NOT_GREEN');
  const postDump=docker(['exec',CONTAINER,'pg_dump','-U','postgres','-d','alder_r7finish','-Fc']);
  const postDumpPath=path.join(RUN,'fixture-after-proof.dump');fs.writeFileSync(postDumpPath,postDump,{flag:'wx'});
  report.postProofDump={path:path.relative(ROOT,postDumpPath),sha256:sha(postDump),bytes:postDump.length};
  report.containerInspectionSha256=sha(docker(['inspect',CONTAINER]));
  report.volumeInspectionSha256=sha(docker(['volume','inspect',VOLUME]));
  report.finishedAtUtc=new Date().toISOString();
  fs.writeFileSync(path.join(RUN,'receipt.json'),JSON.stringify(report,null,2),{flag:'wx'});
  process.stdout.write(JSON.stringify({receipt:path.relative(ROOT,path.join(RUN,'receipt.json')),container:CONTAINER,volume:VOLUME,owner:OWNER,port:15545,passed:report.checks.policyPostgresIntegration.passed,dumpSha256:report.postProofDump.sha256})+'\n');
 }catch(e:any){
  report.failureCategory=String(e?.message||'UNKNOWN').replace(/[^A-Z0-9_-]/gi,'_').slice(0,120);report.finishedAtUtc=new Date().toISOString();
  if(containerCreated){const inspect=spawnSync('docker',['inspect','--format','{{ index .Config.Labels "alder.round7.owner" }}',CONTAINER],{windowsHide:true,encoding:'utf8'});if(inspect.status===0&&inspect.stdout.trim()===OWNER)report.containerRetainedForInspection=true;}
  if(volumeCreated)report.volumeRetainedForInspection=true;
  fs.writeFileSync(path.join(RUN,'receipt.json'),JSON.stringify(report,null,2),{flag:'wx'});
  throw e;
 }
}
await main();
