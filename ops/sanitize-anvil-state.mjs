// Anvil 1.5.1 regenerates a fresh genesis (timestamp = start time) on every start and appends it to the dumped
// state; on the next load the block-0 mapping can resolve to that regenerated genesis instead of the original,
// silently changing the chain identity (genesis hash) the app binds every intent to. Before each start, drop every
// block-0 header whose timestamp differs from the pinned lineage-2 genesis timestamp. Pre-sanitize copy is kept.
import fs from 'node:fs';import path from 'node:path';
const [file,pinned]=process.argv.slice(2);if(!file||!/^0x[0-9a-f]+$/.test(pinned||''))throw Error('usage: sanitize-anvil-state.mjs <state.json> <genesisTimestampHex>');
if(!fs.existsSync(file)){console.log('no state file; nothing to sanitize');process.exit(0);}
let raw=fs.readFileSync(file,'utf8');let s;
// Round 5 (review L4): a hard stop can tear Anvil's interval dump. Restore the atomic pre-stop snapshot (torn file kept).
try{s=JSON.parse(raw);}catch(e){const pre=file+'.pre-stop';if(!fs.existsSync(pre))throw Error('STATE_FILE_TORN_NO_PRESTOP_SNAPSHOT');const dir=path.join(path.dirname(file),'backups');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/torn-${Date.now()}.json`,raw);raw=fs.readFileSync(pre,'utf8');s=JSON.parse(raw);fs.writeFileSync(file+'.tmp',raw);fs.renameSync(file+'.tmp',file);console.log('state file was torn; restored the atomic pre-stop snapshot');}
// Prefer the newer of (live dump, pre-stop snapshot) when the live dump lost blocks mined before the stop.
{const pre=file+'.pre-stop';if(fs.existsSync(pre)){try{const p=JSON.parse(fs.readFileSync(pre,'utf8'));if(BigInt(p.best_block_number)>BigInt(s.best_block_number)){const dir=path.join(path.dirname(file),'backups');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/stale-dump-${Date.now()}.json`,raw);raw=JSON.stringify(p);s=p;fs.writeFileSync(file+'.tmp',raw);fs.renameSync(file+'.tmp',file);console.log('live dump older than pre-stop snapshot; using the snapshot');}}catch{}}}
const before=s.blocks.length;
const keep=s.blocks.filter(b=>!(BigInt(b.header.number)===0n&&BigInt(b.header.timestamp)!==BigInt(pinned)));
const originals=keep.filter(b=>BigInt(b.header.number)===0n).length;if(originals!==1)throw Error('PINNED_GENESIS_NOT_FOUND_EXACTLY_ONCE '+originals);
if(keep.length===before){console.log('state clean: 1 genesis, '+before+' blocks');process.exit(0);}
const dir=path.join(path.dirname(file),'backups');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/pre-sanitize-${Date.now()}.json`,raw);
s.blocks=keep;fs.writeFileSync(file+'.tmp',JSON.stringify(s));fs.renameSync(file+'.tmp',file);console.log(`sanitized: removed ${before-keep.length} regenerated genesis header(s); ${keep.length} blocks kept`);
