import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReleasePath} from '../ops/release-path.ts';

test('malformed request paths reject without escaping the HTTP callback',()=>{
 for(const value of ['/%','/%E0%A4%A','/%FF','/%00','http://[::1/']){
  assert.equal(parseReleasePath(value),null,value);
 }
});
test('valid release assets and API paths keep routing and decoded static path',()=>{
 assert.deepEqual(parseReleasePath('/assets/app.js?v=1'),{pathname:'/assets/app.js',decoded:'/assets/app.js'});
 assert.deepEqual(parseReleasePath('/api/v1/workspaces/uuid/snapshot'),{pathname:'/api/v1/workspaces/uuid/snapshot',decoded:'/api/v1/workspaces/uuid/snapshot'});
 assert.deepEqual(parseReleasePath('/hello%20world'),{pathname:'/hello%20world',decoded:'/hello world'});
 assert.deepEqual(parseReleasePath(undefined),{pathname:'/',decoded:'/'});
});
