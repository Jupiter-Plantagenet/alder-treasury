// O5: TR-T-EXPORT smoke on the LIVE stack (UI origin 5103 -> API 8103 -> PG alder), accountant role. Creates ONE private export
// (writes .local/exports/<ws>/<id>/ and append-only audit events) and verifies integrity via the API. No business record changed.
import {Session} from '../round4/api-client.ts';import fs from 'node:fs';
const A=await Session.login('accountant');const list0=await A.get('/evidence/exports');const e=await A.post('/evidence/exports',{});const g=e.status===200?await A.get(`/evidence/exports/${e.body.id}`):null;const o=await (await Session.login('owner')).get('/evidence/exports');
const res={at:new Date().toISOString(),listBefore:list0.status,create:{status:e.status,id:e.body?.id,scope:e.body?.export_scope,manifest_digest:e.body?.manifest_digest,artifacts:e.body?.artifacts?.length,code:e.body?.error?.code},readBack:g?{status:g.status,integrity:g.body.integrity?.ok,auditMatch:g.body.integrity?.manifest_digest_matches_audit_event}:null,ownerList:o.status};
fs.mkdirSync('evidence/round5-ops/export',{recursive:true});fs.writeFileSync('evidence/round5-ops/export/live-smoke.json',JSON.stringify(res,null,1));console.log(JSON.stringify(res));process.exit(0);
