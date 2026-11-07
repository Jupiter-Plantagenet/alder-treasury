import {createPublicClient,http} from 'viem';const c=createPublicClient({transport:http('http://127.0.0.1:8547')});const head=await c.getBlockNumber();let prev:any=null;const bad=[];
for(let n=0n;n<=head;n++){const b=await c.getBlock({blockNumber:n});if(prev&&b.parentHash!==prev.hash)bad.push({n:String(n),parent:b.parentHash.slice(0,12),prevHash:prev.hash.slice(0,12),prevNum:String(prev.number)});prev=b;}
console.log('head',String(head),'mismatches',bad.length,JSON.stringify(bad.slice(0,10)));
