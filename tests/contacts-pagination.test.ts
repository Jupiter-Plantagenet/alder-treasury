import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contactReadPath,CONTACT_READ_PAGE_SIZE,mergeContactPages} from '../apps/web/Contacts.tsx';

test('contact read pages request the API maximum and preserve opaque cursor bytes',()=>{
 assert.equal(CONTACT_READ_PAGE_SIZE,200);
 assert.equal(contactReadPath(),'/reads/contacts?limit=200');
 const cursor='opaque.cursor+/with=reserved';
 const u=new URL(contactReadPath(cursor),'http://local');
 assert.equal(u.pathname,'/reads/contacts');assert.equal(u.searchParams.get('limit'),'200');assert.equal(u.searchParams.get('cursor'),cursor);
});

test('merging a contact page retains every earlier contact and replaces duplicate IDs in place',()=>{
 const first=[{id:'a',display_name:'A'},{id:'b',display_name:'old B'}];
 const merged=mergeContactPages(first,[{id:'b',display_name:'new B'},{id:'c',display_name:'C'}]);
 assert.deepEqual(merged,[{id:'a',display_name:'A'},{id:'b',display_name:'new B'},{id:'c',display_name:'C'}]);
});
