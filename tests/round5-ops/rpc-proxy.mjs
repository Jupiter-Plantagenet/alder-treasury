// O5 (round-5 ops) LYING/STALE RPC PROXY — isolated test instrumentation only, never used by the live stack.
// Listens 127.0.0.1:18547 (the only non-live RPC the app allowlists) and forwards to the isolated Anvil 127.0.0.1:18548.
// Default mode is a transparent pass-through. POST /__o5 {rules:[...]} installs tamper rules; every tampered
// response is appended to evidence/round5-ops/verify/proxy-tamper.jsonl. Per-method request counts at GET /__o5.
import http from 'node:http';import fs from 'node:fs';
const UP=process.env.O5_UPSTREAM||'http://127.0.0.1:18548',PORT=Number(process.env.O5_PROXY_PORT||18547);
const LOG=process.env.O5_TAMPER_LOG||'evidence/round5-ops/verify/proxy-tamper.jsonl';fs.mkdirSync(LOG.replace(/[\\/][^\\/]+$/,''),{recursive:true});
let rules=[];const counts={};let total=0;
const SUCCESS_TOPIC='0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e';
const lower=x=>typeof x==='string'?x.toLowerCase():x;
const flipHash=h=>h.slice(0,-4)+(h.slice(-4)==='beef'?'dead':'beef');
const log=(rule,method,detail)=>fs.appendFileSync(LOG,JSON.stringify({at:new Date().toISOString(),rule:rule.kind,method,detail})+'\n');
let upstreamUrl=UP;async function upstream(body){const r=await fetch(upstreamUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return r.json();}
// 'rewrite-from' = a CONSISTENT alternative history from block K: every block >=K gets a different hash, every child
// links to it, and every log/receipt/tx in those blocks carries the alternative blockHash (requests are mapped back).
const fakeToReal=new Map();const fl=h=>{const f=flipHash(h.toLowerCase());fakeToReal.set(f,h.toLowerCase());return f;};
const unfake=x=>typeof x==='string'?(fakeToReal.get(x.toLowerCase())||x):Array.isArray(x)?x.map(unfake):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,unfake(v)])):x;
function rewrite(o,K,st){if(Array.isArray(o)){o.forEach(v=>rewrite(v,K,st));return;}if(!o||typeof o!=='object')return;
 if(typeof o.number==='string'&&typeof o.hash==='string'&&typeof o.parentHash==='string'){const n=BigInt(o.number);if(n>=K){o.hash=fl(o.hash);st.n++;}if(n>K)o.parentHash=fl(o.parentHash);}
 if(typeof o.blockHash==='string'&&o.blockNumber!=null&&BigInt(o.blockNumber)>=K){o.blockHash=fl(o.blockHash);st.n++;}
 for(const v of Object.values(o))if(v&&typeof v==='object')rewrite(v,K,st);}
async function handle(req0){
 const rw=rules.find(r=>r.kind==='rewrite-from');const req=rw?{...req0,params:unfake(req0.params)}:req0;
 const r=await handle1(req);if(rw&&r&&r.result){const st={n:0};rewrite(r.result,BigInt(rw.from),st);if(st.n)log(rw,req.method,{rewritten:st.n});}return r;}
async function handle1(req){
 const m=req.method,p=req.params||[];counts[m]=(counts[m]||0)+1;total++;
 for(const rule of rules){
  if(rule.kind==='chainid'&&m==='eth_chainId'){log(rule,m,{returned:rule.value});return {jsonrpc:'2.0',id:req.id,result:rule.value};}
  if(rule.kind==='chainid'&&m==='net_version'){return {jsonrpc:'2.0',id:req.id,result:String(parseInt(rule.value,16))};}
  if(rule.kind==='stale-head'&&m==='eth_blockNumber'){log(rule,m,{frozen:rule.number});return {jsonrpc:'2.0',id:req.id,result:'0x'+BigInt(rule.number).toString(16)};}
  if(rule.kind==='stale-head'&&m==='eth_getBlockByNumber'&&(p[0]==='latest'||p[0]==='pending'||p[0]==='safe'||p[0]==='finalized')){const r=await upstream({...req,params:['0x'+BigInt(rule.number).toString(16),p[1]]});log(rule,m,{tag:p[0],frozen:rule.number});return r;}
  if(rule.kind==='stale-head'&&m==='eth_getBlockByNumber'&&typeof p[0]==='string'&&p[0].startsWith('0x')&&BigInt(p[0])>BigInt(rule.number)){log(rule,m,{beyondStale:p[0]});return {jsonrpc:'2.0',id:req.id,result:null};}
 }
 const res=await upstream(req);
 for(const rule of rules){
  if(rule.kind==='genesis'&&m==='eth_getBlockByNumber'&&p[0]==='0x0'&&res.result){res.result.hash=rule.value;log(rule,m,{genesis:rule.value});}
  if(rule.kind==='block-hash'&&res.result&&(m==='eth_getBlockByNumber'||m==='eth_getBlockByHash')&&BigInt(res.result.number)===BigInt(rule.number)){const before=res.result.hash;res.result.hash=flipHash(before);log(rule,m,{number:rule.number,before,after:res.result.hash});}
  if(rule.kind==='block-hash'&&res.result&&m==='eth_getBlockByNumber'&&BigInt(res.result.number)===BigInt(rule.number)+1n){res.result.parentHash=flipHash(res.result.parentHash);}
  if(rule.kind==='forge-success-log'&&m==='eth_getLogs'&&Array.isArray(res.result)){const f=p[0]||{};const t=f.topics||[];if(lower(t[0])===SUCCESS_TOPIC&&lower(t[1])===lower(rule.safeTxHash)&&lower(f.address)===lower(rule.safe)){const fake={address:rule.safe,topics:[SUCCESS_TOPIC,rule.safeTxHash],data:'0x'+'0'.repeat(64),blockNumber:rule.blockNumber,blockHash:rule.blockHash,transactionHash:rule.transactionHash,transactionIndex:'0x0',logIndex:'0x0',removed:false};res.result.push(fake);log(rule,m,{injected:fake});}}
  if(rule.kind==='receipt-tamper'&&m==='eth_getTransactionReceipt'&&res.result&&lower(p[0])===lower(rule.tx)){const before=JSON.stringify(res.result.logs.map(l=>[l.address,l.topics[0],l.data]));
   if(rule.op==='amount'){for(const l of res.result.logs)if(lower(l.address)===lower(rule.executor)&&l.topics.length===4){const v=BigInt('0x'+l.data.slice(66,130))+1n;l.data=l.data.slice(0,66)+v.toString(16).padStart(64,'0')+l.data.slice(130);break;}}
   if(rule.op==='drop-transfer'){const i=res.result.logs.findIndex(l=>lower(l.address)===lower(rule.token));if(i>=0)res.result.logs.splice(i,1);}
   if(rule.op==='emitter'){for(const l of res.result.logs)if(lower(l.address)===lower(rule.executor))l.address=rule.forger;}
   if(rule.op==='status'){res.result.status='0x1';}
   log(rule,m,{tx:rule.tx,op:rule.op,before:before.slice(0,400)});}
  if(rule.kind==='token-logs-inject'&&m==='eth_getLogs'&&Array.isArray(res.result)&&lower((p[0]||{}).address)===lower(rule.token)&&(p[0]||{}).blockHash&&res.result.length){const src=res.result[0];const fake={...src,logIndex:'0x'+(Number(res.result.at(-1).logIndex)+1).toString(16),data:'0x'+(1n).toString(16).padStart(64,'0')};res.result.push(fake);log(rule,m,{injectedTokenLog:fake.logIndex});}
  if(rule.kind==='balance-lie'&&m==='eth_call'&&res.result&&lower(p[0]?.to)===lower(rule.token)&&String(p[0]?.data||p[0]?.input||'').startsWith('0x70a08231')&&(!rule.blockHash||lower(p[1]?.blockHash)===lower(rule.blockHash))){const v=BigInt(res.result)+BigInt(rule.delta);res.result='0x'+v.toString(16).padStart(64,'0');log(rule,m,{at:p[1],delta:rule.delta});}
  if(rule.kind==='call-override'&&m==='eth_call'&&res.result!==undefined&&lower(p[0]?.to)===lower(rule.to)&&String(p[0]?.data||p[0]?.input||'').startsWith(rule.selector)){const before=res.result;res.result=rule.result;log(rule,m,{to:rule.to,selector:rule.selector,before,after:rule.result});}
  if(rule.kind==='archive-unavailable'&&m==='eth_call'&&p[1]&&typeof p[1]==='object'&&p[1].blockHash){log(rule,m,{blockHash:p[1].blockHash});return {jsonrpc:'2.0',id:req.id,error:{code:-32000,message:'O5 proxy: historical state unavailable'}};}
 }
 return res;
}
http.createServer(async(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',async()=>{
 try{
  if(req.url==='/__o5'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({rules,counts,total,upstream:upstreamUrl}));}
  if(req.url==='/__o5'&&req.method==='POST'){const b=JSON.parse(body||'{}');if(b.rules)rules=b.rules;if(b.upstream){if(!/^http:\/\/127\.0\.0\.1:185[0-9][0-9]$/.test(b.upstream))throw Error('LOCAL_ISOLATED_UPSTREAM_ONLY');upstreamUrl=b.upstream;}if(b.resetCounts){for(const k in counts)delete counts[k];total=0;}fs.appendFileSync(LOG,JSON.stringify({at:new Date().toISOString(),control:{rules}})+'\n');res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,rules,upstream:upstreamUrl}));}
  const parsed=JSON.parse(body);const out=Array.isArray(parsed)?await Promise.all(parsed.map(handle)):await handle(parsed);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));
 }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32603,message:'O5 proxy error '+String(e?.message||e)}}));}
});}).listen(PORT,'127.0.0.1',()=>console.log('O5 rpc proxy 127.0.0.1:'+PORT+' -> '+UP));
