import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {databaseUrl} from '../apps/api/database.ts';
import {deviceKey} from '../apps/api/tls.ts';

test('the API credential loader reads only the app profile and URL-encodes the password',()=>{
 const originalRead=fs.readFileSync,override=process.env.ALDER_DATABASE_URL;
 const opened:string[]=[];delete process.env.ALDER_DATABASE_URL;
 fs.readFileSync=((file:any,options:any)=>{
  if(file==='.local/database-app.json'){opened.push(file);return JSON.stringify({user:'alder_app',password:'fixture@:/?#'});}
  if(file==='.local/database.json')throw Error('MACHINE_PROFILE_OPENED_BY_API');
  return originalRead(file,options);
 }) as typeof fs.readFileSync;
 try{const url=new URL(databaseUrl('app'));assert.equal(url.username,'alder_app');assert.equal(decodeURIComponent(url.password),'fixture@:/?#');assert.deepEqual(opened,['.local/database-app.json']);}
 finally{fs.readFileSync=originalRead;if(override===undefined)delete process.env.ALDER_DATABASE_URL;else process.env.ALDER_DATABASE_URL=override;}
});

test('the login device key fails closed when missing or malformed',()=>{
 const directory=process.env.ALDER_TLS_DIR,key=process.env.ALDER_DEVICE_KEY_TEST;
 process.env.ALDER_TLS_DIR='.local/codex-round6/nonexistent-tls-'+process.pid;
 delete process.env.ALDER_DEVICE_KEY_TEST;
 try{assert.throws(()=>deviceKey(),/DEVICE_KEY_REQUIRED/);process.env.ALDER_DEVICE_KEY_TEST='invalid';assert.throws(()=>deviceKey(),/DEVICE_KEY_INVALID/);}
 finally{if(directory===undefined)delete process.env.ALDER_TLS_DIR;else process.env.ALDER_TLS_DIR=directory;if(key===undefined)delete process.env.ALDER_DEVICE_KEY_TEST;else process.env.ALDER_DEVICE_KEY_TEST=key;}
});
