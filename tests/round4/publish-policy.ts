// Publishes the initial workspace review policy (revision 1) through the LIVE API as the reviewer.
import fs from 'node:fs';import {Session,expect} from './api-client.ts';
const d=JSON.parse(fs.readFileSync('evidence/app-deployment.json','utf8'));
const priya=await Session.login('priya');
const before=await priya.get('/policy');expect(before.status===200,'policy read',before);
if(before.body.policy){console.log(JSON.stringify({already:true,policy:before.body.policy},null,1));process.exit(0);}
const asset=before.body.workspace_asset;expect(asset&&asset.address.toLowerCase()===d.token.toLowerCase(),'workspace asset is lineage-2 token',asset);
const conditions={mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,rules:[
 {id:'STANDARD',label:'Standard contractor payable up to 10,000 ALDR',asset,min_units:'1',max_units:'10000000000'},
 {id:'LARGE',label:'Large contractor payable 10,000 to 50,000 ALDR',asset,min_units:'10000000001',max_units:'50000000000'}]};
const preview=await priya.post('/policies/preview',{conditions});expect(preview.status===200&&preview.body.not_saved===true,'preview',preview);
const r=await priya.post('/policies',{conditions,reason:'Initial review policy for chain lineage 2 (round 4): independent reviewer, verified destination, ALDR on 31337 up to 50,000.'});
expect(r.status===200,'policy create',r);const after=await priya.get('/policy');
console.log(JSON.stringify({create_status:r.status,policy:after.body.policy,impact:after.body.impact.map((x:any)=>({ref:x.display_reference,status:x.status}))},null,1));
