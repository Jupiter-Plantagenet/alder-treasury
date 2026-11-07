// O5 TR-T-UNITS full roundtrip property campaign over 1..2^256-1 (boundaries + seeded random over every bit length).
// Layer 1 (pure): packages/units.ts formatUnitsExact -> parseUnitsExact == n, canonical strings, rejection of malformed input.
// Layer 2 (API, O5_API_UNITS=1): base-unit strings through the REAL isolated API -> PostgreSQL numeric -> read-back are exact.
import fs from 'node:fs';import {createHash} from 'node:crypto';import {parseUnitsExact,formatUnitsExact} from '../../packages/units.ts';
const OUT='evidence/round5-ops/units';fs.mkdirSync(OUT,{recursive:true});
const SEED=process.env.O5_SEED||'O5-UNITS-20261031';const N=Number(process.env.O5_N||1000000);const MAX=2n**256n-1n;
let ctr=0n;const rnd=(bits:number)=>{let x=0n;const bytes=Math.ceil(bits/8);let buf=Buffer.alloc(0);while(buf.length<bytes){buf=Buffer.concat([buf,createHash('sha256').update(SEED+':'+(ctr++)).digest()]);}for(const b of buf.subarray(0,bytes))x=(x<<8n)|BigInt(b);return x&((1n<<BigInt(bits))-1n);};
const bounds=new Set<bigint>([1n,2n,9n,10n,11n,99n,100n,101n,999999n,1000000n,1000001n,1999999n,2000000n,MAX,MAX-1n,MAX-999999n,MAX-1000000n,2n**255n,2n**255n-1n,2n**255n+1n,MAX/1000000n,(MAX/1000000n)*1000000n,(MAX/1000000n)*1000000n-1n,2n**53n-1n,2n**53n,2n**53n+1n,2n**64n-1n,2n**64n,2n**128n-1n,2n**128n]);
for(let k=0n;k<=77n;k++){for(const d of [-1n,0n,1n]){const v=10n**k+d;if(v>=1n&&v<=MAX)bounds.add(v);}}for(let b=1n;b<=256n;b++){for(const d of [-1n,0n,1n]){const v=(1n<<b)+d;if(v>=1n&&v<=MAX)bounds.add(v);}}
const fails:any[]=[];let checked=0;const floatLoss:any[]=[];
const check=(n:bigint,src:string)=>{checked++;const s=formatUnitsExact(n);if(!/^(0|[1-9][0-9]*)(\.[0-9]{0,5}[1-9])?$/.test(s)){fails.push({src,n:String(n),s,why:'non-canonical'});return;}let back:bigint;try{back=parseUnitsExact(s);}catch(e:any){fails.push({src,n:String(n),s,why:'parse threw '+e.message});return;}if(back!==n)fails.push({src,n:String(n),s,back:String(back),why:'roundtrip'});
 if(BigInt(n.toString())!==n||n.toString()!==String(n))fails.push({src,n:String(n),why:'base-unit string'});};
for(const b of bounds)check(b,'boundary');
for(let i=0;i<N;i++){const bits=1+(i%256);let v=rnd(bits);if(v===0n)v=1n;check(v,'random');if(i<2000&&v>2n**53n){const f=Number(v);if(BigInt(Math.round(f))!==v)floatLoss.push(1);}}
const reject=['0','0.0','0.000000','-1','-0.000001','1e6','1E6','1,000','1.0000001','NaN','Infinity',' 1','1 ','01','00.1','1.','.1','+1','0x10','１',formatUnitsExact(MAX)+'1',(2n**256n).toString(),(MAX/1000000n+1n).toString()];
const rejected=reject.map(v=>{try{parseUnitsExact(v);return {v,rejected:false};}catch{return {v,rejected:true};}});
const pure={seed:SEED,random:N,boundaries:bounds.size,checked,failures:fails.length,firstFailures:fails.slice(0,5),malformedRejected:rejected.filter(r=>r.rejected).length,malformedTotal:rejected.length,notRejected:rejected.filter(r=>!r.rejected),floatWouldLoseOf2000Large:floatLoss.length,maxFormatted:formatUnitsExact(MAX)};
console.log('PURE',JSON.stringify(pure));let api:any=null;
if(process.env.O5_API_UNITS==='1'){const L=await import('./o5-lib.ts');const s=await L.sessions();const c=await L.contact(s,'O5-UNITS boundary contact');
 const vals=[...[...bounds].sort((a,b)=>a<b?-1:1).filter((_,i)=>i%2===0),...Array.from({length:120},(_,i)=>{let v=rnd(1+(i*2)%256);return v===0n?1n:v;})];const res:any[]=[];
 for(const v of vals){const r=await s.J.post('/payables',{contact_id:c.id,external_reference:`O5-UNITS-${createHash("sha256").update(v.toString()).digest("hex").slice(0,32)}-${L.RUN}`,amount_units:v.toString(),attachment_ids:[]});if(r.status!==201){res.push({v:String(v),status:r.status,code:r.body?.error?.code});continue;}
  const row=(await L.q('SELECT amount_units::text u FROM payables WHERE workspace_id=$1 AND id=$2',[L.WS,r.body.id]))[0];res.push({v:String(v),status:201,stored:row.u===v.toString(),response:String(r.body.amount_units??r.body.payable?.amount_units??'')===v.toString()});}
 const bad=[(2n**256n).toString(),'0','-1','1.5','0001','1e3',''];const neg=[];for(const v of bad){const r=await s.J.post('/payables',{contact_id:c.id,external_reference:`O5-UNITS-BAD-${Math.random().toString(36).slice(2,8)}`,amount_units:v,attachment_ids:[]});neg.push({v,status:r.status,code:r.body?.error?.code});}
 const num=await s.J.post('/payables',{contact_id:c.id,external_reference:'O5-UNITS-NUM',amount_units:1000000,attachment_ids:[]});
 api={posted:vals.length,created:res.filter(r=>r.status===201).length,storedExact:res.filter(r=>r.stored).length,responseExact:res.filter(r=>r.response).length,nonCreated:res.filter(r=>r.status!==201),negatives:neg,jsonNumberRejected:num.status};console.log('API',JSON.stringify(api));await L.db.end();}
fs.writeFileSync(`${OUT}/units-campaign${process.env.O5_API_UNITS==='1'?'-api':''}.json`,JSON.stringify({pure,api},null,1));process.exit(0);
