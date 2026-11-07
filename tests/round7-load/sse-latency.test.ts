import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SseLatencyMatcher,type RedactedEvent} from './sse-latency.ts';
const event=(id:string,kind='payable-create',eventId='900'):RedactedEvent=>({id:eventId,kind,at:'2026-11-03T10:00:00.100Z',data:{id}});

test('matches an SSE event that arrives before its HTTP response and keeps both clocks distinct',()=>{const m=new SseLatencyMatcher(),eventAt=Date.parse('2026-11-03T10:00:00.100Z');m.capture(event('p1'),2,eventAt+900,50);assert.equal(m.samples.length,0);m.noteResponse('p1','payable-create',{wallMs:eventAt+950,monoMs:80});assert.equal(m.samples.length,1);assert.equal(m.samples[0].responseToSseMs,-30);assert.equal(m.samples[0].eventAtToArrivalUpperBoundMs,900);assert.equal(m.unmatchedBufferedEvents,0);});
test('deduplicates subscriber/entity/event while keeping separate subscribers and event kinds',()=>{const m=new SseLatencyMatcher();m.noteResponse('p1','review',{wallMs:2000,monoMs:200});m.capture(event('p1','review','901'),0,2100,300);m.capture(event('p1','review','901'),0,2200,400);m.capture(event('p1','review','901'),1,2150,350);assert.equal(m.samples.length,2);assert.deepEqual(m.samples.map(x=>x.subscriber),[0,1]);});
