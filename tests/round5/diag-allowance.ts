// @ts-nocheck -- read-only diagnostic: runs the same allowance freeze computation the API runs (no writes, no signing).
import {freezeAllowance} from '../../packages/allowance.ts';import fs from 'node:fs';
const d=JSON.parse(fs.readFileSync('evidence/app-deployment.json','utf8'));
try{const m=await freezeAllowance(d,4000750000n,['x']);console.log('OK',m.reset,String(m.cap),String(m.message?.nonce));}catch(e){console.log('ERR',e?.message,e?.stack?.split('\n').slice(0,4).join(' | '));}
