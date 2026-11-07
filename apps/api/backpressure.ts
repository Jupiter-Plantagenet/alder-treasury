// Round 6 (TR-T-LOAD): bounded admission instead of unbounded queueing.
// Each request is assigned a cost class; a class admits at most `concurrency` requests at once and parks at most
// `queue` more for at most `waitMs`. Anything beyond that is refused immediately with 503 OVERLOADED + Retry-After
// (no work started, no effect committed), so memory and the PostgreSQL pool stay bounded under overload.
// Exempt: /health (readiness must answer under load) and the SSE stream (long-lived; it has its own caps).
export type ClassLimit={concurrency:number,queue:number,waitMs:number};
export type BackpressureOptions={classes?:Partial<Record<CostClass,Partial<ClassLimit>>>,retryAfterSeconds?:number};
export type CostClass='heavy'|'read'|'write';
const env=(k:string,d:number)=>{const v=Number(process.env[k]);return Number.isFinite(v)&&v>0?v:d;};
export const DEFAULT_LIMITS:Record<CostClass,ClassLimit>={
 // whole-workspace views: snapshot, inbox snapshot materialisation, policy impact, evidence/export reads
 heavy:{concurrency:env('ALDER_BP_HEAVY_CONCURRENCY',4),queue:env('ALDER_BP_HEAVY_QUEUE',64),waitMs:env('ALDER_BP_HEAVY_WAIT_MS',4000)},
 read:{concurrency:env('ALDER_BP_READ_CONCURRENCY',6),queue:env('ALDER_BP_READ_QUEUE',128),waitMs:env('ALDER_BP_READ_WAIT_MS',4000)},
 write:{concurrency:env('ALDER_BP_WRITE_CONCURRENCY',4),queue:env('ALDER_BP_WRITE_QUEUE',64),waitMs:env('ALDER_BP_WRITE_WAIT_MS',4000)}};
export function costClass(method:string,url:string):CostClass|null{
 const path=url.split('?')[0];
 if(path==='/health'||/\/events\/stream$/.test(path))return null;
 if(method!=='GET'&&method!=='HEAD')return 'write';
 if(/\/(snapshot|views\/payables|policy|evidence|evidence\/exports(\/[^/]+(\/artifacts\/[^/]+)?)?)$/.test(path))return 'heavy';
 return 'read';
}
export class Gate{
 active=0;waiting:{resolve:(ok:boolean)=>void,timer:any}[]=[];stats={admitted:0,queued:0,rejected_full:0,rejected_timeout:0,max_active:0,max_waiting:0};
 constructor(public limit:ClassLimit){}
 // Resolves true when admitted, false when refused (queue full or wait timeout).
 acquire():Promise<boolean>|boolean{
  if(this.active<this.limit.concurrency){this.active++;this.stats.admitted++;this.stats.max_active=Math.max(this.stats.max_active,this.active);return true;}
  if(this.waiting.length>=this.limit.queue){this.stats.rejected_full++;return false;}
  this.stats.queued++;
  return new Promise<boolean>(resolve=>{const w={resolve,timer:null as any};w.timer=setTimeout(()=>{const i=this.waiting.indexOf(w);if(i>=0){this.waiting.splice(i,1);this.stats.rejected_timeout++;resolve(false);}},this.limit.waitMs);
   this.waiting.push(w);this.stats.max_waiting=Math.max(this.stats.max_waiting,this.waiting.length);});
 }
 release(){const next=this.waiting.shift();if(next){clearTimeout(next.timer);this.stats.admitted++;next.resolve(true);return;}this.active=Math.max(0,this.active-1);}
}
export function registerBackpressure(app:any,options:BackpressureOptions={}){
 const gates:Record<CostClass,Gate>={} as any;
 for(const k of Object.keys(DEFAULT_LIMITS) as CostClass[])gates[k]=new Gate({...DEFAULT_LIMITS[k],...(options.classes?.[k]||{})});
 const retryAfter=String(options.retryAfterSeconds??1);
 // Admission follows the API's authentication and workspace-membership preHandler. Otherwise
 // an outsider probing a workspace can receive overload status before the membership 404.
 app.addHook('preHandler',async(req:any,reply:any)=>{
  const cls=costClass(req.method,req.url);if(!cls)return;const gate=gates[cls];
  const got=gate.acquire();const ok=got===true||got===false?got:await got;
  if(!ok){reply.header('Retry-After',retryAfter);return reply.code(503).send({error:{code:'OVERLOADED',message:'OVERLOADED',correlation_id:req.id,retryable:true,details:{class:cls}}});}
  // Release exactly once when the response finishes or the connection closes (client abort included).
  let done=false;const release=()=>{if(done)return;done=true;gate.release();};
  reply.raw.once('finish',release);reply.raw.once('close',release);
  if(reply.raw.destroyed||reply.raw.writableFinished)release();// client went away while queued: never leak the slot
 });
 app.decorate('backpressure',{gates,stats:()=>Object.fromEntries(Object.entries(gates).map(([k,g])=>[k,{...g.stats,active:g.active,waiting:g.waiting.length,limit:g.limit}]))});
 return gates;
}
