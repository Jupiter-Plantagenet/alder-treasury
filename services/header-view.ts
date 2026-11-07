// Round 6 (TR-T-CAPACITY, review F-L6; TR-T-VERIFY S3): incremental, checkpoint-anchored canonical header view.
//
// Before round 6 every pass re-read every header from genesis (O(head) RPC + O(head) DB rows) inside an open
// transaction. Now a pass reads only [checkpoint-OVERLAP .. head] from the provider and checks it against the stored
// canonical headers:
//  - every fetched header is integrity-checked: its hash is RECOMPUTED (keccak(rlp(header))) and must equal the hash the
//    provider reported, numbers are contiguous and each parentHash equals the previous hash;
//  - the window must link to the stored chain (stored[start-1].hash === fetched[start].parentHash);
//  - if the stored checkpoint hash is still canonical, every stored header inside the window must be unchanged. A
//    provider that changes a recorded historical header while keeping the checkpoint (S3) is an IMPOSSIBLE history
//    (the checkpoint hash commits to all its ancestors) => `disagreement` => settlement pause (fail closed);
//  - otherwise it is a reorg: the common ancestor is searched downward (bounded, ANCESTOR_SEARCH blocks); depth>12 or no
//    ancestor within the bound => deep-reorg pause (operator rebuild required, blueprint §indexing).
// The full genesis-to-head walk remains as the operator rebuild tool (`full:true`).
import {keccak256,toRlp,type Hex} from 'viem';

// Every pass re-reads and re-checks the last REORG_OVERLAP recorded headers (reorg ancestor search + S3 audit window),
// and a rolling AUDIT_CHUNK of older recorded headers, so every stored header is re-compared periodically
// (10k blocks: about every 8 minutes at the 3 s worker interval).
export const REORG_OVERLAP=Number(process.env.ALDER_REORG_OVERLAP||256);
export const AUDIT_CHUNK=Number(process.env.ALDER_HEADER_AUDIT_CHUNK||64);
const auditCursor=new Map<string,bigint>();
export const ANCESTOR_SEARCH=Number(process.env.ALDER_ANCESTOR_SEARCH||256);
export const PAUSE_DEPTH=12n;
const CHUNK=64;

const q=(n:bigint):Hex=>{if(n===0n)return '0x';let h=n.toString(16);if(h.length%2)h='0'+h;return ('0x'+h) as Hex;};
// Execution-layer header hash (London..Cancun field sets; Anvil shanghai verified against live blocks).
export function headerHash(b:any):Hex{
 const f:any[]=[b.parentHash,b.sha3Uncles,b.miner,b.stateRoot,b.transactionsRoot,b.receiptsRoot,b.logsBloom,q(BigInt(b.difficulty)),q(BigInt(b.number)),q(BigInt(b.gasLimit)),q(BigInt(b.gasUsed)),q(BigInt(b.timestamp)),b.extraData,b.mixHash,b.nonce];
 if(b.baseFeePerGas!=null)f.push(q(BigInt(b.baseFeePerGas)));if(b.withdrawalsRoot)f.push(b.withdrawalsRoot);
 if(b.blobGasUsed!=null)f.push(q(BigInt(b.blobGasUsed)),q(BigInt(b.excessBlobGas)));if(b.parentBeaconBlockRoot)f.push(b.parentBeaconBlockRoot);
 return keccak256(toRlp(f));
}
export class Disagreement extends Error{constructor(public reason:string,public detail:any={}){super('PROVIDER_DISAGREEMENT:'+reason);}}
export type Hdr={number:bigint,hash:string,parentHash:string,timestamp?:bigint};
const slim=(b:any):Hdr=>({number:BigInt(b.number),hash:b.hash,parentHash:b.parentHash,timestamp:b.timestamp!=null?BigInt(b.timestamp):undefined});

// Fetch [from..to] (inclusive) with integrity checks. Throws Disagreement on an inconsistent provider answer.
export async function fetchRange(c:any,from:bigint,to:bigint,stats:{rpc:number}):Promise<Hdr[]>{
 const out:Hdr[]=[];
 for(let s=from;s<=to;s+=BigInt(CHUNK)){const e=s+BigInt(CHUNK)-1n<to?s+BigInt(CHUNK)-1n:to;
  const chunk=await Promise.all(Array.from({length:Number(e-s+1n)},(_,i)=>c.getBlock({blockNumber:s+BigInt(i)})));stats.rpc+=chunk.length;
  for(const b of chunk){const n=BigInt(b.number),want=from+BigInt(out.length);
   if(n!==want)throw new Disagreement('HEADER_NUMBER',{want:String(want),got:String(n)});
   if(headerHash(b)!==b.hash)throw new Disagreement('HEADER_HASH_RECOMPUTE',{number:String(n),reported:b.hash});
   const prev=out[out.length-1];if(prev&&b.parentHash!==prev.hash)throw new Disagreement('HEADER_PARENT_LINK',{number:String(n)});
   out.push(slim(b));}}
 return out;
}

// Canonical header lookup for this pass: fetched window + stored canonical rows loaded on demand.
export class HeaderBook{
 m=new Map<number,Hdr>();
 // Stored rows above `ceil` may be stale (above a reorg ancestor) and are never loaded; the fetched window covers them.
 ceil=Number.MAX_SAFE_INTEGER;
 constructor(private pool:any,private chainKey:string){}
 put(h:Hdr){this.m.set(Number(h.number),h);}
 get(n:any){return this.m.get(Number(n));}
 async load(ns:Iterable<any>){const need=[...new Set([...ns].map(Number))].filter(n=>Number.isSafeInteger(n)&&n>=0&&!this.m.has(n)&&n<=this.ceil);if(!need.length)return;
  const rows=(await this.pool.query('SELECT number::text,hash,parent_hash FROM treasury_headers WHERE chain_key=$1 AND canonical AND number=ANY($2::bigint[])',[this.chainKey,need.map(String)])).rows;
  for(const r of rows)this.m.set(Number(r.number),{number:BigInt(r.number),hash:r.hash,parentHash:r.parent_hash});}
 // normalizeLogs()/legacy callers index headers[n]; a Proxy keeps that contract without materialising 0..head.
 view():any{return new Proxy({},{get:(_t,p)=>typeof p==='string'&&/^\d+$/.test(p)?this.m.get(Number(p)):undefined});}
}

export type WindowResult={mode:'incremental'|'full',book:HeaderBook,write:Hdr[],ancestor:bigint,depth:bigint,deep:boolean,disagreement:null|{reason:string,detail:any},rpcHeaders:number,windowFrom:string};

async function storedRange(pool:any,chainKey:string,from:bigint,to:bigint){
 const rows=(await pool.query('SELECT number::text,hash,parent_hash FROM treasury_headers WHERE chain_key=$1 AND canonical AND number BETWEEN $2 AND $3',[chainKey,String(from),String(to)])).rows;
 return new Map<bigint,{hash:string,parentHash:string}>(rows.map((r:any)=>[BigInt(r.number),{hash:r.hash,parentHash:r.parent_hash}]));
}

export async function headerWindow(c:any,pool:any,chainKey:string,head:any,checkpoint:any,opts:{full?:boolean}={}):Promise<WindowResult>{
 const stats={rpc:0},book=new HeaderBook(pool,chainKey),H=BigInt(head.number);
 try{
 if(opts.full||!checkpoint){
  // Operator rebuild / bootstrap: full deployment-to-head walk, compared with every stored canonical header.
  const all=await fetchRange(c,0n,H,stats);if(all[all.length-1].hash!==head.hash)throw Error('CHAIN_VIEW_CHANGED');
  all.forEach(h=>book.put(h));book.ceil=-1;const stored=await storedRange(pool,chainKey,0n,H);let ancestor=-1n;
  for(let n=0n;n<=H;n++){const s=stored.get(n);if(!s||s.hash!==all[Number(n)].hash)break;ancestor=n;}
  const N=checkpoint?BigInt(checkpoint.number):-1n;const depth=checkpoint&&book.get(N)?.hash!==checkpoint.hash?N-ancestor:0n;
  return {mode:'full',book,write:all.slice(Number(ancestor)+1),ancestor,depth,deep:depth>PAUSE_DEPTH,disagreement:null,rpcHeaders:stats.rpc,windowFrom:'0'};
 }
 const N=BigInt(checkpoint.number),top=N<H?N:H;let start=top-BigInt(REORG_OVERLAP)>0n?top-BigInt(REORG_OVERLAP):0n;
 let fetched=await fetchRange(c,start,H,stats);if(fetched[fetched.length-1].hash!==head.hash)throw Error('CHAIN_VIEW_CHANGED');
 let stored=await storedRange(pool,chainKey,start>0n?start-1n:0n,N);
 const at=(n:bigint)=>fetched[Number(n-start)];
 if(H>=N&&at(N).hash===checkpoint.hash){
  // Checkpoint still canonical: every recorded ancestor inside the window MUST be unchanged (S3), and the window must link.
  for(let n=start;n<=N;n++){const s=stored.get(n);if(s&&s.hash!==at(n).hash)throw new Disagreement('HISTORICAL_HEADER_CHANGED_UNDER_UNCHANGED_CHECKPOINT',{number:String(n),stored:s.hash,provider:at(n).hash,checkpoint:String(N)});}
  if(start>0n){const s=stored.get(start-1n);if(s&&s.hash!==at(start).parentHash)throw new Disagreement('WINDOW_PARENT_LINK_TO_STORED',{number:String(start)});}
  // Rolling audit of older recorded headers (below the window): same rule, an unchanged checkpoint commits to them.
  if(start>0n&&AUDIT_CHUNK>0){let hi=auditCursor.get(chainKey)??start-1n;if(hi>start-1n||hi<0n)hi=start-1n;const lo=hi-BigInt(AUDIT_CHUNK)+1n>0n?hi-BigInt(AUDIT_CHUNK)+1n:0n;
   const audit=await fetchRange(c,lo,hi,stats);const st=await storedRange(pool,chainKey,lo,hi+1n);
   for(const h of audit){const s=st.get(h.number);if(s&&s.hash!==h.hash)throw new Disagreement('HISTORICAL_HEADER_AUDIT_MISMATCH',{number:String(h.number),stored:s.hash,provider:h.hash,checkpoint:String(N)});}
   const above=st.get(hi+1n);if(above&&above.parentHash!==audit[audit.length-1].hash)throw new Disagreement('HISTORICAL_HEADER_AUDIT_LINK',{number:String(hi)});
   auditCursor.set(chainKey,lo>0n?lo-1n:start-1n);}
  fetched.forEach(h=>book.put(h));book.ceil=Number(N);
  return {mode:'incremental',book,write:fetched.filter(h=>h.number>N),ancestor:N,depth:0n,deep:false,disagreement:null,rpcHeaders:stats.rpc,windowFrom:String(start)};
 }
 // Reorg (or head behind checkpoint): highest common ancestor, searched downward within ANCESTOR_SEARCH.
 let ancestor=-1n;
 for(;;){for(let n=top;n>=start;n--){const s=stored.get(n);if(s&&s.hash===at(n).hash){ancestor=n;break;}}
  if(ancestor>=0n||start===0n||N-start>=BigInt(ANCESTOR_SEARCH))break;
  const ns=start-BigInt(CHUNK)>0n?start-BigInt(CHUNK):0n;const more=await fetchRange(c,ns,start-1n,stats);
  if(more[more.length-1].hash!==fetched[0].parentHash)throw new Disagreement('HEADER_PARENT_LINK',{number:String(start)});
  fetched=[...more,...fetched];start=ns;stored=new Map([...(await storedRange(pool,chainKey,ns>0n?ns-1n:0n,start)),...stored]);}
 fetched.forEach(h=>book.put(h));book.ceil=Number(ancestor);
 if(ancestor<0n)return {mode:'incremental',book,write:[],ancestor,depth:N-start+1n,deep:true,disagreement:null,rpcHeaders:stats.rpc,windowFrom:String(start)};
 const depth=N-ancestor;
 return {mode:'incremental',book,write:fetched.filter(h=>h.number>ancestor),ancestor,depth,deep:depth>PAUSE_DEPTH,disagreement:null,rpcHeaders:stats.rpc,windowFrom:String(start)};
 }catch(e){if(e instanceof Disagreement)return {mode:opts.full||!checkpoint?'full':'incremental',book,write:[],ancestor:-1n,depth:0n,deep:false,disagreement:{reason:e.reason,detail:e.detail},rpcHeaders:stats.rpc,windowFrom:''};throw e;}
}

// Batched, idempotent header persistence (canonical flag maintained by the caller's ancestor rewind).
export async function writeHeaders(db:any,chainKey:string,hs:Hdr[]){
 for(let i=0;i<hs.length;i+=5000){const part=hs.slice(i,i+5000);
  await db.query('INSERT INTO treasury_headers SELECT $1,n,h,p,true FROM unnest($2::bigint[],$3::text[],$4::text[]) AS x(n,h,p) ON CONFLICT(chain_key,hash) DO UPDATE SET canonical=true',[chainKey,part.map(h=>String(h.number)),part.map(h=>h.hash),part.map(h=>h.parentHash)]);}
}
