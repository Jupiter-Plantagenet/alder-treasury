// Round 5 (review L4): before a hard stop of Anvil, take a consistent state snapshot via anvil_dumpState and write it
// ATOMICALLY (temp + rename) next to the live state file. If the hard stop tears Anvil's own interval dump, the
// sanitizer restores this snapshot instead of failing or silently losing blocks. Local loopback chain only.
import fs from 'node:fs';import zlib from 'node:zlib';
const [file,rpc='http://127.0.0.1:8547']=process.argv.slice(2);if(rpc!=='http://127.0.0.1:8547')throw Error('LOCAL_RPC_ONLY');
const r=await (await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'anvil_dumpState',params:[]})})).json();
if(!r.result)throw Error('DUMP_FAILED '+JSON.stringify(r.error||{}).slice(0,200));const buf=Buffer.from(r.result.slice(2),'hex');let text;try{text=zlib.gunzipSync(buf).toString('utf8');}catch{text=buf.toString('utf8');}
const s=JSON.parse(text);if(!Array.isArray(s.blocks)||!s.blocks.length)throw Error('DUMP_EMPTY');
const out=file+'.pre-stop';fs.writeFileSync(out+'.tmp',text);fs.renameSync(out+'.tmp',out);console.log(`pre-stop snapshot: ${s.blocks.length} blocks, best ${s.best_block_number} -> ${out}`);
