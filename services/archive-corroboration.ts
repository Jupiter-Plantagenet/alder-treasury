// Round 6 (review F-L2): the weaker receipt-log-proof mode may be chosen ONLY when state unavailability is corroborated
// by locally recorded evidence, never because the RPC returned an error string.
//
// Anvil restarted from a state file does not serve state below the block it was reloaded at. The chain start
// (ops/verify-chain-identity.mjs) appends every reload point {genesis, height, at, source} to a local JSONL file that
// the RPC cannot write. A fallback is allowed only if:
//   1. a recorded reload point exists for THIS chain instance (genesis hash), and
//   2. the inclusion block is at or below the highest recorded reload height (its parent state predates the reload), and
//   3. the node does serve state at the recorded reload height and at head (a node that refuses state everywhere is
//      not a pruning gap: fail closed).
// Otherwise the verifier fails closed (`unverified: archive unavailable not corroborated`).
import fs from 'node:fs';
export const RELOAD_POINTS_FILE=()=>process.env.ALDER_RELOAD_POINTS_FILE||'chain-state/reload-points.jsonl';
export type ReloadPoint={genesis:string,height:string,at:string,source:string};
export function reloadPoints(genesis:string,file=RELOAD_POINTS_FILE()):ReloadPoint[]{
 let text='';try{text=fs.readFileSync(file,'utf8');}catch{return [];}
 const out:ReloadPoint[]=[];
 for(const line of text.split(/\r?\n/)){if(!line.trim())continue;try{const p=JSON.parse(line);if(String(p.genesis).toLowerCase()===String(genesis).toLowerCase()&&/^[0-9]+$/.test(String(p.height)))out.push(p);}catch{}}
 return out;
}
export async function corroborateArchiveGap(c:any,genesis:string,inclusionBlock:bigint,probe:{to:string,data:string}){
 const pts=reloadPoints(genesis);
 if(!pts.length)return {ok:false as const,reason:'no recorded reload point for this chain instance'};
 const best=pts.reduce((a,b)=>BigInt(b.height)>BigInt(a.height)?b:a),R=BigInt(best.height);
 if(inclusionBlock>R)return {ok:false as const,reason:`inclusion block ${inclusionBlock} is above the recorded reload height ${R}; state must be available`};
 const call=async(tag:string)=>{try{await c.request({method:'eth_call',params:[probe,tag]});return true;}catch{return false;}};
 if(!await call('0x'+R.toString(16)))return {ok:false as const,reason:`state at the recorded reload height ${R} is unavailable: not a pruning gap`};
 if(!await call('latest'))return {ok:false as const,reason:'state at head is unavailable: not a pruning gap'};
 return {ok:true as const,reloadHeight:String(R),reloadRecordedAt:best.at,reloadSource:best.source};
}
export const ARCHIVE_NOT_CORROBORATED='archive unavailable not corroborated';
