import React,{useEffect,useRef,useState} from 'react';
import {explain,CustodyBoundary,type Api} from './Policy.tsx';

export function PreferencesForm({preferences,api,onSaved,onReload}:{preferences:any,api?:Api,onSaved:(message:string)=>void,onReload:()=>void}){
 const [reminders,setReminders]=useState(!!preferences.pending_reminders),[redaction,setRedaction]=useState(!!preferences.default_redaction);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[conflict,setConflict]=useState(false);const status=useRef<HTMLDivElement>(null);
 async function save(){if(!api||busy)return;setBusy(true);setMessage('');setError('');setConflict(false);
  try{const r=await api('/preferences',{expected_revision:preferences.revision,pending_reminders:reminders,default_redaction:redaction},undefined,'PUT');onSaved(`Saved preference revision ${r.revision}. Custody owners and threshold are unchanged.`);return;}
  catch(e:any){setError(explain(e));setConflict(e?.statusCode===412);setTimeout(()=>status.current?.focus(),0);}finally{setBusy(false);}}
 return <form className="destination-form" onSubmit={e=>{e.preventDefault();save();}}><fieldset disabled={busy||!api}>
  <label className="checkline"><input type="checkbox" checked={reminders} onChange={e=>setReminders(e.target.checked)}/><span>Show pending custody and recovery reminders</span></label>
  <label className="checkline"><input type="checkbox" checked={redaction} onChange={e=>setRedaction(e.target.checked)}/><span>Redact full addresses in private exports by default</span></label>
  <p className="secondary">Preference revision {preferences.revision}. Preferences are yours only; they cannot change roles, review policy or custody.</p>
  <button className="primary" type="submit">{busy?'Saving…':'Save preferences'}</button>
 </fieldset><div ref={status} tabIndex={-1}>{error?<div className="notice bad" role="alert"><strong>Not saved</strong>{error}{conflict&&<button type="button" onClick={onReload}>Reload preferences</button>}</div>:<p role="status" aria-live="polite">{message}</p>}</div></form>;
}

export function CustodyChangeRequest({api}:{api?:Api}){
 const [result,setResult]=useState<{denied?:string,error?:string}|null>(null),[busy,setBusy]=useState(false);const status=useRef<HTMLDivElement>(null);
 async function request(){if(!api||busy)return;setBusy(true);setResult(null);
  try{await api('/custody/owner-changes',{});setResult({error:'Unexpected acceptance. Treat custody as unchanged and report this.'});}
  catch(e:any){setResult(e?.code==='CUSTODY_CHANGE_OUTSIDE_APP'?{denied:explain(e)}:{error:explain(e)});}
  finally{setBusy(false);setTimeout(()=>status.current?.focus(),0);}}
 return <div><button type="button" onClick={request} disabled={busy||!api} aria-describedby="custody-change-note">{busy?'Requesting…':'Request Safe owner or threshold change'}</button>
  <p id="custody-change-note" className="footnote">This application cannot add, remove or swap Safe owners or change the threshold for any role. The request is refused by the server.</p>
  <div ref={status} tabIndex={-1}>{result?.denied&&<div className="notice bad" role="alert"><strong>Custody change denied</strong>{result.denied}</div>}{result?.error&&<div className="notice bad" role="alert"><strong>Request failed</strong>{result.error}</div>}</div></div>;
}

export function SettingsView({data,api,onReload,onLogout,onNavigate}:{data:any,api?:Api,onReload:()=>void,onLogout?:()=>void,onNavigate?:(id:string)=>void}){
 const w=data.workspace;const [saved,setSaved]=useState('');const savedRef=useRef<HTMLParagraphElement>(null);
 return <>
  <div className="cols">
   <section className="panel" aria-labelledby="settings-workspace-title"><header className="panel-head"><div><h2 id="settings-workspace-title">Workspace controls</h2><p>Server-resolved identity · no role switching</p></div></header><div className="panel-body">
    <dl className="kv"><dt>Authenticated user</dt><dd>{data.user?.name}</dd><dt>Server-resolved roles</dt><dd>{(data.roles||[]).join(', ')||'None'}</dd><dt>Supported asset</dt><dd className="mono">{w?`${w.asset.profile} · ${w.asset.address} · chain ${w.chain_id}`:'Deployment unavailable'}</dd><dt>Safe proxy</dt><dd className="mono">{w?.safe||'Not established'}</dd><dt>Business review policy</dt><dd>{data.policy?`Revision ${data.policy.revision} · mandatory independent review`:'No policy · every payable held'}</dd></dl>
    <p className="footnote">Roles are assigned to your membership by an administrator. This page has no view-role or impersonation control.</p>
    {onNavigate&&<button type="button" onClick={()=>onNavigate('policy')}>Inspect review policy</button>}
    <div className="divider"/>
    <h3>Your preferences</h3>
    <p ref={savedRef} tabIndex={-1} role="status" aria-live="polite">{saved}</p>
    <PreferencesForm key={data.preferences.revision} preferences={data.preferences} api={api} onSaved={m=>{setSaved(m);onReload();setTimeout(()=>savedRef.current?.focus(),0);}} onReload={()=>{setSaved('');onReload();}}/>
    {onLogout&&<><div className="divider"/><button type="button" onClick={onLogout}>Sign out &amp; revoke session</button><p className="footnote">HttpOnly SameSite=Strict development session. HTTPS Secure cookies and production identity hardening remain release work.</p></>}
   </div></section>
   <section className="panel" aria-labelledby="settings-matrix-title"><header className="panel-head"><div><h2 id="settings-matrix-title">Permission matrix</h2><p>Application permissions ≠ custody authority</p></div></header><div className="panel-body"><dl className="kv"><dt>Preparer</dt><dd>Draft payables and freeze reviewed batches; cannot approve own record</dd><dt>Reviewer</dt><dd>Approve another preparer’s exact record; edit business review policy</dd><dt>Owner</dt><dd>Submit actual current Safe EOA signatures; no business-review bypass</dd><dt>Accountant</dt><dd>Read and export; no mutations</dd><dt>Admin</dt><dd>Edit business review policy; invite, change roles of and revoke members; never a custody owner or review bypass</dd></dl></div></section>
  </div>
  <section className="panel" aria-labelledby="settings-custody-title"><header className="panel-head"><div><h2 id="settings-custody-title">Treasury owners &amp; threshold</h2><p>Custody is outside this application</p></div></header><div className="panel-body"><p>{data.custody?.change_route}</p><CustodyChangeRequest api={api}/></div></section>
  {(data.roles||[]).includes('admin')&&<MembersPanel api={api}/>}
  <CustodyBoundary custody={data.custody}/>
 </>;
}

export function SettingsScreen({api,onLogout,onNavigate}:{api?:Api,onLogout?:()=>void,onNavigate?:(id:string)=>void}){
 const [state,setState]=useState<{status:'loading'|'ready'|'error',data?:any,error?:any}>(()=>api?{status:'loading'}:{status:'error',error:{message:'Settings API unavailable.'}});
 const [generation,setGeneration]=useState(0);
 useEffect(()=>{if(!api)return;let live=true;setState(s=>({...s,status:'loading'}));api('/settings').then(data=>{if(live)setState({status:'ready',data});}).catch(error=>{if(live)setState({status:'error',error});});return()=>{live=false;};},[api,generation]);
 const reload=()=>setGeneration(n=>n+1);
 if(state.status==='loading'&&!state.data)return <div className="notice neutral" role="status">Loading workspace settings…</div>;
 if(state.status==='error'){const code=state.error?.code;const revoked=code==='SESSION_EXPIRED'||code==='AUTH_REQUIRED';return <div className={'notice '+(state.error?.statusCode===403?'neutral':'bad')} role="alert"><strong>{revoked?'Session revoked':state.error?.statusCode===403?'Permission denied':'Settings unavailable'}</strong>{explain(state.error)}{api&&!revoked&&<button type="button" onClick={reload}>Retry</button>}{revoked&&onLogout&&<button type="button" onClick={onLogout}>Return to sign in</button>}</div>;}
 return <>{state.status==='loading'&&<div className="notice neutral" role="status">Refreshing settings…</div>}<SettingsView data={state.data} api={api} onReload={reload} onLogout={onLogout} onNavigate={onNavigate}/></>;
}

// Round 5 TR-Access: real membership administration (admin only). Every change is server-authorized, audited and
// guarded (at least one admin; stale role views rejected 412). Roles never grant Safe custody.
const ALL_ROLES=['preparer','reviewer','owner','accountant','admin'];
function RoleChecks({value,onChange,name}:{value:string[],onChange:(v:string[])=>void,name:string}){return <fieldset className="role-checks"><legend>{name}</legend>{ALL_ROLES.map(r=><label className="checkline" key={r}><input type="checkbox" checked={value.includes(r)} onChange={e=>onChange(e.target.checked?[...value,r]:value.filter(x=>x!==r))}/><span>{r}</span></label>)}</fieldset>;}
function MemberRow({m,api,self,onDone}:any){const [roles,setRoles]=useState<string[]>(m.roles),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[msg,setMsg]=useState('');
 const act=async(path:string,body:any)=>{setBusy(true);setMsg('');try{await api(path,body);onDone();}catch(e:any){setMsg(explain(e));}finally{setBusy(false);}};
 return <details><summary>{m.name} · {m.email} · {m.roles.join(', ')}{m.user_id===self?' (you)':''}</summary><form className="destination-form" onSubmit={e=>{e.preventDefault();void act(`/members/${m.user_id}/roles`,{expected_roles:m.roles,roles,reason});}}><fieldset disabled={busy}>
  <RoleChecks name={`Roles for ${m.email}`} value={roles} onChange={setRoles}/><label>Reason (audited)<input required value={reason} onChange={e=>setReason(e.target.value)}/></label>
  <button type="submit" disabled={!roles.length}>Save role change</button> <button type="button" className="danger" disabled={!reason.trim()} onClick={()=>{if(confirm(`Revoke ${m.email} from this workspace? Access ends on the next request.`))void act(`/members/${m.user_id}/revoke`,{expected_roles:m.roles,reason});}}>Revoke membership</button></fieldset>{msg&&<p role="alert">{msg}</p>}</form></details>;}
export function MembersPanel({api}:{api?:Api}){
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[gen,setGen]=useState(0),[email,setEmail]=useState(''),[roles,setRoles]=useState<string[]>(['accountant']),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[msg,setMsg]=useState('');
 useEffect(()=>{if(!api)return;let live=true;api('/members').then(d=>{if(live){setData(d);setError('');}}).catch(e=>{if(live)setError(explain(e));});return()=>{live=false;};},[api,gen]);
 const reload=()=>setGen(n=>n+1);
 if(error)return <div className="notice bad" role="alert"><strong>Members unavailable</strong>{error}<button type="button" onClick={reload}>Retry</button></div>;
 if(!data)return <div className="notice neutral" role="status">Loading members…</div>;
 const open=data.invites.filter((i:any)=>!i.accepted_at&&!i.revoked_at);
 return <section className="panel" aria-labelledby="members-title"><header className="panel-head"><div><h2 id="members-title">Members &amp; access</h2><p>Admin only · invite, change roles, revoke · every change is audited</p></div></header><div className="panel-body">
  {data.members.map((m:any)=><MemberRow key={m.user_id+':'+m.roles.join()} m={m} api={api} self={data.self} onDone={reload}/>)}
  <div className="divider"/><h3>Invite an existing local account</h3>
  <form className="destination-form" onSubmit={async e=>{e.preventDefault();if(!api)return;setBusy(true);setMsg('');try{await api('/members/invitations',{email,roles,reason});setEmail('');setReason('');setMsg('Invitation recorded. The invitee accepts after signing in.');reload();}catch(err:any){setMsg(explain(err));}finally{setBusy(false);}}}><fieldset disabled={busy}>
   <label>Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><RoleChecks name="Invited roles" value={roles} onChange={setRoles}/><label>Reason (audited)<input required value={reason} onChange={e=>setReason(e.target.value)}/></label><button className="primary" type="submit" disabled={!roles.length}>Send invitation</button></fieldset><p role="status">{msg}</p></form>
  {open.length?<><h3>Open invitations</h3>{open.map((i:any)=><div className="list-row" key={i.id}><div className="grow"><strong>{i.email}</strong><p>{i.roles.join(', ')} · expires {new Date(i.expires_at).toLocaleString()}</p></div><button type="button" onClick={async()=>{const r=prompt('Reason for revoking this invitation');if(!r||!api)return;try{await api(`/members/invitations/${i.id}/revoke`,{reason:r});reload();}catch(err:any){setMsg(explain(err));}}}>Revoke invitation</button></div>)}</>:<p>No open invitations.</p>}
  <details><summary>Membership audit ({data.events.length})</summary>{data.events.length?<ul>{data.events.map((e:any)=><li key={e.id}><strong>{e.kind}</strong> · {e.subject_email||e.subject_user_id} · {(e.before_roles||[]).join(',')||'—'} → {(e.after_roles||[]).join(',')||'—'} · {e.reason} · {new Date(e.at).toLocaleString()}</li>)}</ul>:<p>No membership changes yet.</p>}</details>
 </div></section>;
}
