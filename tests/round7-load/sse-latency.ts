export type EventStamp={wallMs:number,monoMs:number};
export type RedactedEvent={id:string|number,kind:string,at:string,data:{id:string,[key:string]:any}};
export type SseLatencySample={entityId:string,eventId:string,eventKind:string,subscriber:number,eventAt:string,arrivalAt:string,responseToSseMs:number,eventAtToArrivalUpperBoundMs:number};
const keyOf=(id:string,kind:string)=>`${id}:${kind}`;
export class SseLatencyMatcher{
 private responses=new Map<string,EventStamp>();private pending=new Map<string,Array<{event:RedactedEvent,subscriber:number,arrivalWallMs:number,arrivalMonoMs:number}>>();private seen=new Set<string>();
 readonly samples:SseLatencySample[]=[];
 noteResponse(entityId:string,eventKind:string,at:EventStamp){const key=keyOf(entityId,eventKind);this.responses.set(key,at);const waiting=this.pending.get(key);if(waiting){for(const x of waiting)this.match(x.event,x.subscriber,x.arrivalWallMs,x.arrivalMonoMs,at);this.pending.delete(key);}}
 capture(event:RedactedEvent,subscriber:number,arrivalWallMs:number,arrivalMonoMs:number){const entityId=String(event?.data?.id??''),eventId=String(event?.id??''),eventKind=String(event?.kind??'');if(!entityId||!eventId||!eventKind||!event?.at)return;const dedupe=`${subscriber}:${entityId}:${eventId}`;if(this.seen.has(dedupe))return;const response=this.responses.get(keyOf(entityId,eventKind));if(response){this.match(event,subscriber,arrivalWallMs,arrivalMonoMs,response);return;}const key=keyOf(entityId,eventKind),waiting=this.pending.get(key)||[];if(!waiting.some(x=>`${x.subscriber}:${String(x.event.data.id)}:${String(x.event.id)}`===dedupe))waiting.push({event,subscriber,arrivalWallMs,arrivalMonoMs});this.pending.set(key,waiting);}
 get unmatchedBufferedEvents(){return [...this.pending.values()].reduce((n,a)=>n+a.length,0);}
 private match(event:RedactedEvent,subscriber:number,arrivalWallMs:number,arrivalMonoMs:number,response:EventStamp){const entityId=String(event.data.id),eventId=String(event.id),dedupe=`${subscriber}:${entityId}:${eventId}`;if(this.seen.has(dedupe))return;this.seen.add(dedupe);this.samples.push({entityId,eventId,eventKind:String(event.kind),subscriber,eventAt:event.at,arrivalAt:new Date(arrivalWallMs).toISOString(),responseToSseMs:arrivalMonoMs-response.monoMs,eventAtToArrivalUpperBoundMs:arrivalWallMs-Date.parse(event.at)});}
}
