// @ts-nocheck -- read-only: Safe ALDR balance and allowance on the local chain.
import {createPublicClient,http,parseAbi} from 'viem';import fs from 'node:fs';
const d=JSON.parse(fs.readFileSync('evidence/app-deployment.json','utf8'));const c=createPublicClient({transport:http('http://127.0.0.1:8547')});const a=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)']);
console.log('safe ALDR units',String(await c.readContract({address:d.token,abi:a,functionName:'balanceOf',args:[d.safe]})),'allowance',String(await c.readContract({address:d.token,abi:a,functionName:'allowance',args:[d.safe,d.executor]})));
