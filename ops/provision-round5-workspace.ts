// Round 5 test isolation (review L6 / parent note): a dedicated verification workspace "B5" with its own users, so
// round-5 runners never bump the primary workspace's policy revision or create batches there. Out-of-band provisioning
// as the local migration principal (same method as ops/seed.ts). Idempotent; the random password is written only to
// .local/round5-accounts.json and never printed.
import pg from 'pg';import fs from 'node:fs';import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
export const B5_WS='00000000-0000-4000-8000-0000000000b5';
const file='.local/round5-accounts.json';const existing=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const password=existing?.password||randomBytes(18).toString('base64url');
const people=[['b5-preparer','B5 Preparer',['preparer']],['b5-reviewer','B5 Reviewer',['reviewer']],['b5-owner','B5 Owner',['owner']],['b5-accountant','B5 Accountant',['accountant']],['b5-admin','B5 Admin',['admin']],['b5-invitee','B5 Invitee',null],['b5-invitee2','B5 Invitee Two',null]] as const;
const db=new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:5543/alder'});await db.connect();
try{await db.query('BEGIN');const users:any={};
 for(const [handle,name,roles] of people){const email=`${handle}@alder.local`;let u=(await db.query('SELECT id FROM users WHERE email=$1',[email])).rows[0];
  if(!u){const salt=randomBytes(16).toString('hex');u=(await db.query('INSERT INTO users(id,email,password_hash,salt,name) VALUES($1,$2,$3,$4,$5) RETURNING id',[randomUUID(),email,scryptSync(password,salt,64).toString('hex'),salt,name])).rows[0];}
  users[handle]=u.id;if(roles)await db.query('INSERT INTO memberships(workspace_id,user_id,roles) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[B5_WS,u.id,roles]);}
 await db.query("INSERT INTO workspace_profiles(workspace_id,display_name) VALUES($1,'B5 round-5 verification workspace') ON CONFLICT DO NOTHING",[B5_WS]);
 await db.query('COMMIT');fs.writeFileSync(file,JSON.stringify({workspace:B5_WS,password,users},null,1));console.log('PROVISIONED',B5_WS,Object.keys(users).length,'users (password in',file+')');
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
