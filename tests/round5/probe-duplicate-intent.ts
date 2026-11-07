// @ts-nocheck  B5 probe (no side effect on 409): an identical allowance intent already frozen in the workspace -> 409, not 500.
import {Session} from '../round4/api-client.ts';import {q,db} from '../round4/flow-lib.ts';
const O=await Session.login('owner');const op=(await q("SELECT manifest->'ids' AS ids FROM treasury_operations WHERE kind='allowance' AND workspace_id='00000000-0000-4000-8000-000000000001' ORDER BY created_at DESC LIMIT 1"))[0];
const r=await O.post('/allowances',{ids:op.ids});console.log(JSON.stringify({status:r.status,code:r.body?.error?.code,details:r.body?.error?.details}));await db.end();
