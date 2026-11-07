import './tls-trust.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';

const origin=process.env.ALDER_HTTP_SECURITY_ORIGIN||'https://127.0.0.1:5103';
assert.ok(['https://127.0.0.1:5103','https://127.0.0.1:5113'].includes(origin),'local HTTPS frontend required');

test('frontend must not serve private local credentials or database/evidence files',async()=>{
 const root=await fetch(origin+'/',{redirect:'manual'});
 assert.equal(root.status,200,'public root');
 assert.match(root.headers.get('content-type')||'',/^text\/html\b/,'public root is HTML');
 const publicHtml=await root.text();
 for(const path of ['/.local/accounts.json','/.local/database.json','/.local/backup-key.bin','/.local/pre-v2.pgdump','/tests/test-wallet.ts','/ops/provision-db.ts','/db/003-roles.sql','/evidence/deployment.json','/apps/api/app.ts']){
  const response=await fetch(origin+path,{redirect:'manual'});
  if(response.status===200){
   // The compiled release deliberately falls back to its public SPA document.
   // Require those exact public bytes; arbitrary successful responses fail.
   assert.equal(origin,'https://127.0.0.1:5113',path+' dev server must deny private paths');
   assert.match(response.headers.get('content-type')||'',/^text\/html\b/,path);
   assert.equal(await response.text(),publicHtml,path+' must return only public SPA HTML');
  }else{
   assert.ok([400,403,404].includes(response.status),path+' must be denied');
   await response.arrayBuffer();
  }
 }
});
