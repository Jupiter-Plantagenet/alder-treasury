// Round 6 (access agent): dedicated verification workspace "S6" with its own users, so round-6 runners never touch the
// primary workspace. Derived from ops/provision-round5-workspace.ts. Out-of-band provisioning
// as the local migration principal (same method as ops/seed.ts). Idempotent; the random password is written only to
// .local/s6-accounts.json and never printed.
import pg from 'pg';import fs from 'node:fs';import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
export const S6_WS='00000000-0000-4000-8000-0000000000c6';
const file='.local/s6-accounts.json';const existing=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const password=existing?.password||randomBytes(18).toString('base64url');
const people=[['s6-jordan','S6 Jordan (preparer)',['preparer']],['s6-priya','S6 Priya (reviewer)',['reviewer']],['s6-owner','S6 Owner',['owner']],['s6-accountant','S6 Accountant',['accountant']],['s6-admin','S6 Admin',['admin']],['s6-admin2','S6 Second Admin',['admin']],['s6-invitee','S6 Invitee',null],['s6-victim','S6 Limiter Victim',null]] as const;
const db=new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:5543/alder'});await db.connect();
try{await db.query('BEGIN');const users:any={};
 for(const [handle,name,roles] of people){const email=`${handle}@alder.local`;let u=(await db.query('SELECT id FROM users WHERE email=$1',[email])).rows[0];
  if(!u){const salt=randomBytes(16).toString('hex');u=(await db.query('INSERT INTO users(id,email,password_hash,salt,name) VALUES($1,$2,$3,$4,$5) RETURNING id',[randomUUID(),email,scryptSync(password,salt,64).toString('hex'),salt,name])).rows[0];}
  users[handle]=u.id;if(roles)await db.query('INSERT INTO memberships(workspace_id,user_id,roles) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[S6_WS,u.id,roles]);}
 await db.query("INSERT INTO workspace_profiles(workspace_id,display_name) VALUES($1,'S6 round-6 access verification workspace') ON CONFLICT DO NOTHING",[S6_WS]);
 await db.query('COMMIT');fs.writeFileSync(file,JSON.stringify({workspace:S6_WS,password,users},null,1));console.log('PROVISIONED',S6_WS,Object.keys(users).length,'users (password in',file+')');
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
