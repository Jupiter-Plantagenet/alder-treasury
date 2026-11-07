export type OpenLoopClock={now:()=>number;setTimeout:(fn:()=>void,delay:number)=>any;clearTimeout:(id:any)=>void};
export type OpenLoopResult={targetRps:number;durationMs:number;scheduled:number;issued:number;completed:number;startedAt:number;firstIssuedAt:number|null;lastIssuedAt:number|null;finishedAt:number;actualWallMs:number;completionWallMs:number;maxLatenessMs:number;catchUpTurns:number};
const realClock:OpenLoopClock={now:()=>performance.now(),setTimeout:(fn,d)=>setTimeout(fn,d),clearTimeout:id=>clearTimeout(id)};

/** Absolute-deadline open-loop driver. Late slots are carried forward in bounded turns, never discarded. */
export function runOpenLoop(options:{rps:number;durationMs:number;issue:(slot:number,dueAt:number)=>Promise<unknown>|unknown;clock?:OpenLoopClock;maxCatchUpPerTurn?:number}):Promise<OpenLoopResult>{
 const {rps,durationMs,issue}=options,clock=options.clock??realClock,limit=options.maxCatchUpPerTurn??4;
 if(!Number.isFinite(rps)||rps<=0||!Number.isFinite(durationMs)||durationMs<=0||!Number.isInteger(durationMs*rps/1000)||!Number.isInteger(limit)||limit<1)throw Error('OPEN_LOOP_CONFIG_INVALID');
 const scheduled=durationMs*rps/1000,startedAt=clock.now(),period=1000/rps;let issued=0,completed=0,maxLatenessMs=0,catchUpTurns=0,firstIssuedAt:number|null=null,lastIssuedAt:number|null=null,timer:any;
 return new Promise(resolve=>{const tick=()=>{let n=0;const now=clock.now();while(issued<scheduled&&startedAt+issued*period<=now&&n<limit){const slot=issued++,dueAt=startedAt+slot*period,issuedAt=clock.now();if(firstIssuedAt===null)firstIssuedAt=issuedAt;lastIssuedAt=issuedAt;maxLatenessMs=Math.max(maxLatenessMs,issuedAt-dueAt);n++;try{Promise.resolve(issue(slot,dueAt)).catch(()=>{}).finally(()=>{completed++;finishIfDone();});}catch{completed++;}}
   if(issued<scheduled){if(n===limit&&startedAt+issued*period<=clock.now())catchUpTurns++;const dueAt=startedAt+issued*period;timer=clock.setTimeout(tick,Math.max(0,dueAt-clock.now()));}else finishIfDone();};
  const finishIfDone=()=>{if(issued===scheduled&&completed===scheduled){clock.clearTimeout(timer);const finishedAt=clock.now();resolve({targetRps:rps,durationMs,scheduled,issued,completed,startedAt,firstIssuedAt,lastIssuedAt,finishedAt,actualWallMs:firstIssuedAt===null||lastIssuedAt===null?0:lastIssuedAt-firstIssuedAt,completionWallMs:finishedAt-startedAt,maxLatenessMs,catchUpTurns});}};
  timer=clock.setTimeout(tick,0);
 });
}
