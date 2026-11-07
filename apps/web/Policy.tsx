import React,{useEffect,useRef,useState} from 'react';
import {formatUnitsExact} from '../../packages/units.ts';
import {ContactPageControls} from './Contacts.tsx';

export type Api=(path:string,body?:any,key?:string,method?:string)=>Promise<any>;
export const IMPACT_LABEL:Record<string,string>={
 reserved_unchanged:'Reserved · frozen intent unchanged',
 policy_missing_hold:'Held · no review policy',
 unmatched_hold:'Held · no matching rule',
 destination_hold:'Held · destination not independently verified',
 approved_current:'Approved under current revision',
 rereview_required:'Re-review required under current revision',
 review_pending:'Awaiting independent review',
};
const IMPACT_TONE:Record<string,string>={reserved_unchanged:'bronze',approved_current:'good',review_pending:'warn',rereview_required:'warn'};
// Typed server codes -> human explanations. Unknown codes fall back to the server code itself.
export function explain(e:any){
 const code=e?.code||e?.message;
 return ({
  MANDATORY_REVIEW:'Rejected by the server: mandatory independent review cannot be disabled or reduced by any role, including admin or owner.',
  STALE_REVISION:'Revision conflict: this record changed since you loaded it. Your draft is kept; reload the current revision before saving again.',
  IF_MATCH_REQUIRED:'Revision precondition missing. Reload and try again.',
  CUSTODY_CHANGE_OUTSIDE_APP:'Denied: Safe owners and threshold are not managed by this application. They change only through a Safe transaction authorized by the current owner quorum, on-chain, outside this app.',
  ROLE_DENIED:'Permission denied: your server-resolved role cannot make this change.',
  POLICY_SCHEMA_REQUIRED:'Review policy storage is not installed (migration 008 is unapplied). Every review and freeze stays held until it is.',
  INVALID_POLICY:'Validation error: rule IDs use A–Z, 0–9 and hyphens; labels are required; bounds are whole base units with maximum ≥ minimum.',
  POLICY_EXISTS:'A policy already exists for this workspace. Reload and edit the current revision.',
  POLICY_UNCHANGED:'No change: the proposed rules equal the current revision.',
  REASON_REQUIRED:'A change reason is required.',
  SESSION_EXPIRED:'Session expired or revoked. Sign in again; unsaved changes are not submitted.',
  AUTH_REQUIRED:'Session expired or revoked. Sign in again; unsaved changes are not submitted.',
  CSRF:'Request refused by CSRF/origin protection. Refresh the workspace and retry.',
 } as Record<string,string>)[code]||String(code||'Request failed');
}
type RuleDraft={id:string,label:string,min_units:string,max_units:string,contact_ids:string[]};
const toDraft=(rules:any[]|undefined):RuleDraft[]=>(rules?.length?rules:[{id:'STANDARD',label:'Standard contractor payouts',min_units:'1',max_units:null,contact_ids:null}]).map((r:any)=>({id:r.id,label:r.label,min_units:r.min_units,max_units:r.max_units??'',contact_ids:r.contact_ids??[]}));
const display=(units:string)=>/^(0|[1-9][0-9]{0,77})$/.test(units)?formatUnitsExact(BigInt(units))+' ALDR':'—';
export function buildConditions(rules:RuleDraft[],asset:any){return {mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,rules:rules.map(r=>({id:r.id,label:r.label,asset,min_units:r.min_units,max_units:r.max_units===''?null:r.max_units,...(r.contact_ids.length?{contact_ids:r.contact_ids}:{})}))};}

function ImpactTable({impact,caption,meta}:{impact:any[],caption:string,meta?:any}){
 if(!impact?.length)return <div className="empty"><strong>No payables in this workspace</strong><p>New payables are evaluated against the current revision at review time.</p></div>;
 return <div className="table-wrap impact-wrap" role="region" aria-label="Policy impact table" tabIndex={0}><table><caption className="secondary">{caption}</caption><thead><tr><th scope="col">Payable</th><th scope="col" className="num">Raw base units</th><th scope="col">Matched rules</th><th scope="col">Policy status</th></tr></thead><tbody>{impact.map((x:any)=><tr key={x.id}><td><strong>{x.display_reference}</strong><span className="secondary">{x.contact} · revision {x.revision}</span></td><td className="num mono">{x.amount_units}</td><td className="mono">{x.matched_rules.length?x.matched_rules.join(', '):'None'}</td><td><span className={'pill '+(IMPACT_TONE[x.status]||'bad')}>{IMPACT_LABEL[x.status]||x.status}</span></td></tr>)}</tbody></table>{meta?.impact_truncated&&<p className="footnote" role="status">Showing the first {impact.length} of {meta.impact_total} payables. Exact status counts over all payables: {Object.entries(meta.impact_counts||{}).map(([k,v])=>`${IMPACT_LABEL[k]||k} ${v}`).join(' · ')}.</p>}</div>;
}
export function CustodyBoundary({custody,onNavigate}:{custody:any,onNavigate?:(id:string)=>void}){
 return <section className="panel" aria-labelledby="custody-boundary-title"><header className="panel-head"><div><h2 id="custody-boundary-title">Custody authorization is separate</h2><p>Independent Safe owner quorum · not application policy</p></div></header><div className="panel-body"><p>{custody?.change_route||'Safe owners and threshold change only through a Safe transaction authorized by the current owner quorum, executed on-chain outside this application.'}</p><p>{custody?.external_ability||'Current Safe owners can authorize transfers and owner/threshold changes through other Safe routes outside this application. Business review is not a global Safe guard.'}</p><p className="footnote">No setting, role or policy revision here changes owners or threshold. Signing still checks current owners and threshold on-chain.</p>{onNavigate&&<button type="button" onClick={()=>onNavigate('settings')}>Workspace &amp; access settings</button>}</div></section>;
}
export function MandatoryGates(){
 const gates=[['Independent business review','Every payable needs a reviewer who is not its current preparer.'],['Reviewer role required','Only the reviewer role can approve; owner or admin status grants no bypass.'],['Verified destination','A current, independently verified full destination is required before review and freeze.']];
 return <section className="panel" aria-labelledby="mandatory-gates-title"><header className="panel-head"><div><h2 id="mandatory-gates-title">Mandatory gates</h2><p id="mandatory-gates-note">Not configurable. The server rejects any attempt to disable or reduce them (MANDATORY_REVIEW).</p></div></header><div className="panel-body">{gates.map(([t,d])=><label className="checkline" key={t}><input type="checkbox" checked disabled readOnly aria-describedby="mandatory-gates-note"/><span><strong>{t}</strong><br/><span className="muted">{d}</span></span></label>)}<p className="footnote">A payable that matches no rule, or any payable while no policy exists, is held and cannot be approved or frozen.</p></div></section>;
}

export function PolicyEditor({data,api,contacts,onSaved,onReload,contactDirectory}:{data:any,api?:Api,contacts:any[],onSaved:(message:string)=>void,onReload:()=>void,contactDirectory?:any}){
 const p=data.policy;const [rules,setRules]=useState<RuleDraft[]>(()=>toDraft(p?.conditions?.rules));const [reason,setReason]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[message,setMessage]=useState(''),[preview,setPreview]=useState<any>(null);
 const status=useRef<HTMLDivElement>(null);const focusStatus=()=>setTimeout(()=>status.current?.focus(),0);
 const asset=data.workspace_asset;const next=(p?.revision??0)+1;
 const update=(i:number,field:keyof RuleDraft,value:any)=>setRules(rs=>rs.map((r,j)=>j===i?{...r,[field]:value}:r));
 async function run(kind:'preview'|'save'){
  if(!api||busy)return;setBusy(true);setError('');setMessage('');setConflict(false);
  try{const conditions=buildConditions(rules,asset);
   if(kind==='preview'){setPreview(await api('/policies/preview',{conditions}));setMessage('Impact preview only. Nothing was saved.');focusStatus();}
   else{const result=p?await api(`/policies/${p.id}/revisions`,{expected_revision:p.revision,conditions,reason}):await api('/policies',{conditions,reason});setReason('');setPreview(null);onSaved(`Saved policy revision ${result.policy_revision}. ${result.affected_draft_ids?.length||0} unreserved approved payable(s) now need re-review; ${result.outstanding_reserved_ids?.length||0} reserved payable(s) keep their frozen intent unchanged.`);return;}
  }catch(e:any){setError(explain(e));setConflict(e?.code==='STALE_REVISION'||e?.statusCode===412||e?.code==='POLICY_EXISTS');focusStatus();}
  finally{setBusy(false);}
 }
 if(!asset)return <div className="notice bad" role="status"><strong>Editing unavailable</strong>The workspace asset deployment could not be read, so rules cannot bind an exact asset identity. Existing policy remains in force.</div>;
 return <section className="panel" aria-labelledby="policy-editor-title"><header className="panel-head"><div><h2 id="policy-editor-title">{p?`Propose revision ${next}`:'Create the first review policy'}</h2><p>Rules select which payables may be reviewed. Each matched payable still needs one independent reviewer.</p></div></header>
  <form className="destination-form" onSubmit={e=>{e.preventDefault();run('save');}}><fieldset disabled={busy}>
   <p className="secondary">Asset for every rule: <span className="mono">{asset.profile} · {asset.address} · chain {asset.chain_id}</span></p>
   {rules.map((r,i)=><fieldset key={i} className="panel-body"><legend>Rule {i+1}</legend>
    <label>Rule ID<input value={r.id} onChange={e=>update(i,'id',e.target.value)} required pattern="[A-Z][A-Z0-9\-]{0,31}" spellCheck={false} aria-describedby={`rule-id-hint-${i}`}/></label><span id={`rule-id-hint-${i}`} className="secondary">Upper-case letters, digits and hyphens.</span>
    <label>Rule label<input value={r.label} onChange={e=>update(i,'label',e.target.value)} required maxLength={200}/></label>
    <label>Minimum · base units<input value={r.min_units} onChange={e=>update(i,'min_units',e.target.value.trim())} required inputMode="numeric" spellCheck={false}/></label><span className="secondary">= {display(r.min_units)} (inclusive)</span>
    <label>Maximum · base units (blank = no upper bound)<input value={r.max_units} onChange={e=>update(i,'max_units',e.target.value.trim())} inputMode="numeric" spellCheck={false}/></label><span className="secondary">{r.max_units===''?'No upper bound':'= '+display(r.max_units)+' (inclusive)'}</span>
    {contacts.length>0&&<><label>Restrict to contacts (optional)<select multiple value={r.contact_ids} onChange={e=>update(i,'contact_ids',[...e.target.selectedOptions].map(o=>o.value))}>{contacts.map((c:any)=><option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>{contactDirectory&&<ContactPageControls directory={contactDirectory} label="contacts available to policy rules"/>}</>}
    {rules.length>1&&<button type="button" className="small" onClick={()=>setRules(rs=>rs.filter((_,j)=>j!==i))}>Remove rule {i+1}</button>}
   </fieldset>)}
   <button type="button" onClick={()=>setRules(rs=>[...rs,{id:'RULE-'+(rs.length+1),label:'',min_units:'1',max_units:'',contact_ids:[]}])}>Add rule</button>
   <label>Change reason<textarea value={reason} onChange={e=>setReason(e.target.value)} required maxLength={2000}/></label>
   <div className="actions"><button type="button" onClick={()=>run('preview')}>Preview impact</button><button className="primary" type="submit">{busy?'Saving…':p?`Save policy revision ${next}`:'Create policy revision 1'}</button></div>
  </fieldset></form>
  <div ref={status} tabIndex={-1} className="panel-body">{error?<div className="notice bad" role="alert"><strong>Not saved</strong>{error}{conflict&&<button type="button" onClick={onReload}>Reload current policy</button>}</div>:<p role="status" aria-live="polite">{message}</p>}</div>
  {preview&&<div className="panel-body"><h3>Impact preview · revision {preview.proposed_revision}</h3><p className="mono secondary">Digest {preview.digest}</p><ImpactTable impact={preview.impact} meta={preview} caption="Proposed revision impact (not saved)"/></div>}
 </section>;
}

export function PolicyView({data,api,contacts=[],onReload,onNavigate,contactDirectory}:{data:any,api?:Api,contacts?:any[],onReload:()=>void,onNavigate?:(id:string)=>void,contactDirectory?:any}){
 const p=data.policy;const [saved,setSaved]=useState('');const savedRef=useRef<HTMLParagraphElement>(null);
 const onSaved=(message:string)=>{setSaved(message);onReload();setTimeout(()=>savedRef.current?.focus(),0);};
 return <>
  {!p&&<div className="notice bad" role="status"><strong>No review policy · every payable is held</strong>No payable can be approved or frozen until a reviewer or admin publishes a policy.</div>}
  <div className="cols">
   <section className="panel" aria-labelledby="policy-current-title"><header className="panel-head"><div><h2 id="policy-current-title">{p?`Business review policy · revision ${p.revision}`:'Business review policy'}</h2><p>Application policy for business records only</p></div></header><div className="panel-body">
    {p?<><dl className="kv"><dt>Revision</dt><dd className="mono">{p.revision}</dd><dt>Digest</dt><dd className="mono">{p.digest}</dd><dt>Changed by</dt><dd className="mono">{p.changed_by}</dd><dt>Reason</dt><dd>{p.reason}</dd><dt>Missing rule match</dt><dd>Hold · never auto-approve</dd></dl>
     <div className="table-wrap" role="region" aria-label="Policy rule table" tabIndex={0}><table><caption className="secondary">Rules in revision {p.revision}</caption><thead><tr><th scope="col">Rule</th><th scope="col">Asset</th><th scope="col" className="num">Range · base units</th><th scope="col">Contacts</th></tr></thead><tbody>{p.conditions.rules.map((r:any)=><tr key={r.id}><td><strong>{r.id}</strong><span className="secondary">{r.label}</span></td><td className="mono">{r.asset.profile}<span className="secondary">{r.asset.address}</span></td><td className="num mono">{r.min_units} – {r.max_units??'no upper bound'}<span className="secondary">{display(r.min_units)} – {r.max_units?display(r.max_units):'unbounded'}</span></td><td>{r.contact_ids?r.contact_ids.length+' contact(s)':'Any contact'}</td></tr>)}</tbody></table></div>
     {data.revisions?.length>1&&<details><summary>Revision history ({data.revisions.length})</summary><ul>{data.revisions.map((r:any)=><li key={r.revision}>Revision {r.revision} · <span className="mono">{r.digest.slice(0,16)}…</span> · {r.reason}</li>)}</ul><p className="footnote">Prior revisions and decisions are immutable; reviews keep the revision they were made under.</p></details>}</>
     :<div className="empty"><strong>No policy revision exists</strong><p>Every payable stays held.</p></div>}
    <button type="button" onClick={onReload}>Reload policy</button>
   </div></section>
   <MandatoryGates/>
  </div>
  <p ref={savedRef} tabIndex={-1} role="status" aria-live="polite">{saved}</p>
  {data.can_edit?<PolicyEditor key={(p?.id||'new')+':'+(p?.revision||0)} data={data} api={api} contacts={contacts} contactDirectory={contactDirectory} onSaved={onSaved} onReload={()=>{setSaved('');onReload();}}/>:<div className="notice neutral" role="status"><strong>Read only</strong>Reviewers and admins edit the business review policy. Your server-resolved role can inspect it.</div>}
  <section className="panel" aria-labelledby="policy-impact-title"><header className="panel-head"><div><h2 id="policy-impact-title">Current impact</h2><p>Snapshot for inspection only; review and freeze re-check under locks.</p></div></header><ImpactTable impact={data.impact} meta={data} caption={p?`Payables against revision ${p.revision}`:'Payables while no policy exists'}/></section>
  <CustodyBoundary custody={data.custody} onNavigate={onNavigate}/>
 </>;
}

export function PolicyScreen({api,contacts=[],onNavigate,contactDirectory}:{api?:Api,contacts?:any[],onNavigate?:(id:string)=>void,contactDirectory?:any}){
 const [state,setState]=useState<{status:'loading'|'ready'|'error',data?:any,error?:any}>(()=>api?{status:'loading'}:{status:'error',error:{message:'Review policy API unavailable.'}});
 const [generation,setGeneration]=useState(0);
 useEffect(()=>{if(!api)return;let live=true;setState(s=>({...s,status:'loading'}));api('/policy').then(data=>{if(live)setState({status:'ready',data});}).catch(error=>{if(live)setState({status:'error',error});});return()=>{live=false;};},[api,generation]);
 const reload=()=>setGeneration(n=>n+1);
 if(state.status==='loading'&&!state.data)return <div className="notice neutral" role="status">Loading review policy…</div>;
 if(state.status==='error'){const denied=state.error?.statusCode===403;return <div className={'notice '+(denied?'neutral':'bad')} role="alert"><strong>{denied?'Permission denied':'Review policy unavailable'}</strong>{explain(state.error)}{api&&<button type="button" onClick={reload}>Retry</button>}</div>;}
 return <>{state.status==='loading'&&<div className="notice neutral" role="status">Refreshing review policy…</div>}<PolicyView data={state.data} api={api} contacts={contacts} contactDirectory={contactDirectory} onReload={reload} onNavigate={onNavigate}/></>;
}
