import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';

test('the SAFE_TX_GAS_CAP initializer has a browser-safe default when process is absent',()=>{
 const source=readFileSync('packages/gas.ts','utf8');
 const start=source.indexOf('export const SAFE_TX_GAS_CAP=BigInt(');
 assert.notEqual(start,-1,'initializer exists');
 const bodyStart=start+'export const SAFE_TX_GAS_CAP=BigInt('.length;
 const end=source.indexOf(');',bodyStart);
 assert.notEqual(end,-1,'initializer is a single BigInt expression');
 const expression=source.slice(bodyStart,end);
 assert.equal(runInNewContext(`BigInt(${expression})`),15_000_000n);
});

test('SAFE_TX_GAS_CAP still follows the configured Node process environment',()=>{
 const code='import {SAFE_TX_GAS_CAP} from "./packages/gas.ts"; process.stdout.write(String(SAFE_TX_GAS_CAP));';
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{
  cwd:process.cwd(),encoding:'utf8',env:{...process.env,ALDER_SAFE_TX_GAS_CAP:'1234567'}
 });
 assert.equal(child.status,0,child.stderr);
 assert.equal(child.stdout,'1234567');
});
