import React,{useEffect,useState} from 'react';
import {parseUnitsExact,formatUnitsExact} from '../../packages/units.ts';
import {ContactPageControls} from './Contacts.tsx';

type Api=(path:string,body?:any,key?:string)=>Promise<any>;
export type IntakeDraft={contact:string,reference:string,amount:string,pending?:{key:string,body:any,uncertain?:boolean},saved?:any,busy?:boolean,error?:string,message?:string,generation?:number};
export function PayablesInbox({contacts,roles,api,draft,onDraftChange,onInspect,onRefresh,contactDirectory}: {contacts:any[],roles:string[],api?:Api,draft:IntakeDraft,onDraftChange:()=>void,onInspect:(id:string)=>void,onRefresh:()=>Promise<any>,contactDirectory?:any}){
 const [query,setQuery]=useState(''),[review,setReview]=useState('all'),[scope,setScope]=useState({q:'',review:'all'});
 const [page,setPage]=useState<any>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 // Parent-owned observable command state, not component-local pending flags.
 const busy=!!draft.busy,message=draft.message||'',generation=draft.generation??0,renderedCommand=draft.pending;
 const update=(field:'contact'|'reference'|'amount',value:string)=>{if(draft.busy||draft.pending||draft.saved)return;draft[field]=value;onDraftChange();};
 async function load(filters=scope,cursor?:string){
  if(!api){setLoading(false);setError('Inbox API unavailable.');return;}
  setLoading(true);setError('');
  try{const params=new URLSearchParams({...filters,limit:'25',...(cursor?{cursor}:{})});const result=await api('/views/payables?'+params);setPage(result);setScope(filters);}
  catch(e){setError((e as Error).message);}finally{setLoading(false);}
 }
 useEffect(()=>{let live=true;if(!api){setLoading(false);setError('Inbox API unavailable.');return;}
  setLoading(true);api('/views/payables?q=&review=all&limit=25').then(result=>{if(live)setPage(result);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};
 },[api]);
 async function create(){
  // Recheck mutable command truth even for a callback captured before remount.
  if(!api||draft.busy||draft.saved||(draft.generation??0)!==generation||(renderedCommand&&draft.pending!==renderedCommand))return;
  draft.busy=true;draft.error='';draft.message='';setError('');onDraftChange();
  try{
   if(!draft.pending){
    if(!contacts.some(c=>c.id===draft.contact))throw Error('Choose a current contact.');
    if(!draft.reference||draft.reference!==draft.reference.trim()||draft.reference.length>200||/[\u0000-\u001f\u007f]/.test(draft.reference))throw Error('Use an exact external reference, without surrounding whitespace or control characters.');
    draft.pending={key:crypto.randomUUID(),body:{contact_id:draft.contact,external_reference:draft.reference,amount_units:parseUnitsExact(draft.amount).toString(),attachment_ids:[]}};
   }
   const result=await api('/payables',draft.pending.body,draft.pending.key);draft.saved=result;draft.pending=undefined;
   draft.message='Payable saved. Destination verification is separate from business approval.';onDraftChange();
   try{await onRefresh();await load();}catch{draft.message='Payable saved. Workspace refresh unavailable; do not recreate it.';onDraftChange();}
  }catch(e:any){
   // A transport/server failure may follow commit. Never change its key/body.
   const definite=e.statusCode>=400&&e.statusCode<500&&![408,429].includes(e.statusCode);
   if(draft.pending){if(definite&&!draft.pending.uncertain)draft.pending=undefined;else draft.pending.uncertain=true;}
   draft.error=e.message;
  }finally{draft.busy=false;onDraftChange();}
 }
 return <>
  <section className="panel" aria-label="Payable inbox"><header className="panel-head"><div><h2>Private payable inbox</h2><p>Server-scoped snapshot. Business records remain usable when the original chain is unavailable.</p></div></header><div className="panel-body">
   <form onSubmit={e=>{e.preventDefault();setPage(null);void load({q:query,review});}}><div className="toolbar"><label>Search payables<input value={query} maxLength={200} onChange={e=>setQuery(e.target.value)}/></label><label>Payable status<select value={review} onChange={e=>setReview(e.target.value)}><option value="all">All obligations</option><option value="pending">Needs review</option><option value="reviewed">Business reviewed</option><option value="destination_hold">Destination held</option></select></label><button disabled={loading}>Apply filters</button></div></form>
   {loading&&<p role="status">Loading inbox snapshot…</p>}{(error||draft.error)&&<p role="alert">{error||draft.error}</p>}
   {page&&<><p>{page.total_count} records in snapshot · {page.snapshot_version}</p><p className="footnote">Snapshot reads are not authorization. Current revisions, destination checks and independent review still apply.</p>
    {!page.items.length?<div className="empty"><strong>No matching payables</strong><button onClick={()=>{setQuery('');setReview('all');setPage(null);void load({q:'',review:'all'});}}>Clear filters</button></div>:<div className="table-wrap" role="region" aria-label="Payable search results" tabIndex={0}><table><thead><tr><th scope="col">Payable / contact</th><th scope="col">Full destination</th><th scope="col">Exact quantity</th><th scope="col">Review state</th></tr></thead><tbody>{page.items.map((p:any)=><tr key={p.id}><td><button className="row-link" disabled={loading} onClick={async()=>{try{await onRefresh();onInspect(p.id);}catch{setError('Workspace refresh unavailable. Retain this snapshot and retry before opening a current record.');}}}>{p.display_reference}</button><span className="secondary">{p.contact}</span></td><td className="mono">{p.recipient}</td><td>{p.amount_units} base units</td><td>{p.review_state}</td></tr>)}</tbody></table></div>}
    <dl className="kv">{page.totals_by_asset.map((t:any,i:number)=><React.Fragment key={i}><dt>{t.token_identity?`${t.token_identity.chain_id} · ${t.token_identity.address}`:'Legacy asset identity unknown'}</dt><dd>{t.total_units} base units · {t.count} records</dd></React.Fragment>)}</dl>
    <button disabled={loading||!page.next_cursor} onClick={()=>void load(scope,page.next_cursor)}>Next snapshot page</button>
   </>}
   <button disabled={loading} onClick={()=>{setPage(null);void load(scope);}}>Start fresh snapshot</button>
  </div></section>
  {roles.includes('preparer')?<section className="panel" aria-label="Manual payable intake"><header className="panel-head"><h2>Create manual payable</h2></header><div className="panel-body">
   <p>Use a contact’s current server-validated destination. An unverified destination remains held; no review or payment authority is granted. Add private attachments in payable detail after creation.</p>
   {draft.saved?<div role="status"><strong>Saved {draft.saved.display_reference}</strong><p>{draft.saved.amount_units} base units · payment ID {draft.saved.payment_id}</p><button disabled={busy} onClick={()=>{if(draft.busy||!draft.saved)return;draft.generation=(draft.generation??0)+1;draft.saved=undefined;draft.reference='';draft.amount='';draft.message='';draft.error='';setError('');onDraftChange();}}>Create another payable</button></div>:<form className="destination-form" onSubmit={e=>{e.preventDefault();void create();}}>
    <fieldset disabled={busy||!!draft.pending}><label>Contact<select aria-label="Contact" required value={draft.contact} onChange={e=>update('contact',e.target.value)}><option value="">Choose contact</option>{contacts.map(c=><option key={c.id} value={c.id}>{c.display_name} · r{c.revision} · {c.verification_state}</option>)}</select></label>{contactDirectory&&<ContactPageControls directory={contactDirectory} label="contacts available to the selector"/>}<label>External reference<input required maxLength={200} value={draft.reference} onChange={e=>update('reference',e.target.value)}/></label><label>Amount · ALDR<input required inputMode="decimal" value={draft.amount} onChange={e=>update('amount',e.target.value)}/></label></fieldset>
    <p className="footnote">Six decimal places maximum. Exact base units only; no floating-point accounting.</p>
    {draft.pending&&<p role="status">Outcome unresolved. Inputs and request key are retained across navigation. Retry this exact request; never submit a replacement payable.</p>}
    <button className="primary" disabled={busy||!api||!page||!contacts.length}>{busy?'Saving…':draft.pending?'Retry exact intake request':'Save manual payable'}</button>
   </form>}
   {message&&<p role="status">{message}</p>}<p className="footnote">Draft and unresolved command survive workspace navigation, not page reload, tab closure or sign-out. Do not reload an unresolved intake.</p>
  </div></section>:<p>Read only: manual payable creation requires a preparer.</p>}
  {roles.includes('preparer')&&<ImportPanel api={api} onImported={async()=>{try{await onRefresh();await load();}catch{}}}/>}
 </>;
}

// Round 5 TR-T-INBOX bulk import: preview (per-row validation) → explicit all-or-nothing commit. The commit uses an
// idempotency key derived from the file digest, so re-submitting the same file (even after an unknown outcome)
// replays the original import instead of creating duplicates.
export function ImportPanel({api,onImported}:{api?:Api,onImported:()=>Promise<any>}){
 const [file,setFile]=useState<{name:string,text:string}|null>(null),[preview,setPreview]=useState<any>(null),[result,setResult]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[rowErrors,setRowErrors]=useState<any[]>([]);
 async function validate(f=file){if(!api||!f)return;setBusy(true);setError('');setResult(null);setRowErrors([]);try{setPreview(await api('/payables/imports/preview',{filename:f.name,csv:f.text}));}catch(e:any){setPreview(null);setError(e.message);}finally{setBusy(false);}}
 async function commit(){if(!api||!file||!preview)return;setBusy(true);setError('');try{// Unknown-outcome retries reuse the digest key (exact replay); an already-imported file asks the server for its
  // digest replay explicitly (fresh key) so the result says `replay`.
  const r=await api('/payables/imports',{filename:file.name,csv:file.text},preview.already_imported?crypto.randomUUID():'import-'+preview.digest);setResult(r);await onImported();}catch(e:any){setError(e.message);setRowErrors(e.details?.rows||[]);}finally{setBusy(false);}}
 const bad=preview?.rows?.filter((r:any)=>r.errors.length)||[];
 return <section className="panel" aria-label="Bulk payable import"><header className="panel-head"><div><h2>Import payables from CSV</h2><p>Columns: external_reference, contact_id, amount_units (integer base units; 1 ALDR = 1000000), optional service.</p></div></header><div className="panel-body">
  <label>CSV file<input type="file" accept=".csv,text/csv" disabled={busy} onChange={async e=>{const f=e.target.files?.[0];setPreview(null);setResult(null);setError('');if(!f)return;if(f.size>1048576){setError('File exceeds 1 MiB.');return;}const next={name:f.name,text:await f.text()};setFile(next);await validate(next);}}/></label>
  {busy&&<p role="status">Working…</p>}{error&&<div className="notice bad" role="alert"><strong>Import not committed</strong>{error}{rowErrors.length?` · ${rowErrors.length} row(s) with errors`:''}</div>}
  {preview&&<div aria-label="Import validation">
   <p>{preview.row_count} rows · {preview.valid_count} valid · {preview.error_count} with errors · total {preview.total_units} base units (valid rows) · digest <span className="mono">{preview.digest.slice(0,16)}…</span></p>
   {preview.already_imported&&<div className="notice neutral" role="status"><strong>This exact file was already imported</strong>Import {preview.already_imported.id} on {new Date(preview.already_imported.created_at).toLocaleString()}. Committing again replays that result; no duplicates are created.</div>}
   {preview.file_errors?.length?<p role="alert">File errors: {preview.file_errors.join(', ')}</p>:null}
   {bad.length?<div className="table-wrap" role="region" aria-label="Import validation errors" tabIndex={0}><table><caption>Rows that must be fixed before anything is imported</caption><thead><tr><th scope="col">Line</th><th scope="col">External reference</th><th scope="col">Errors</th></tr></thead><tbody>{bad.slice(0,200).map((r:any)=><tr key={r.row}><td>{r.row}</td><td>{r.external_reference||'—'}</td><td>{r.errors.join(', ')}</td></tr>)}</tbody></table></div>:<p>No row errors.</p>}
   <button className="primary" disabled={busy||!api||(!preview.committable&&!preview.already_imported)} onClick={()=>void commit()}>{preview.already_imported?'Replay original import result':`Import ${preview.valid_count} payables`}</button>
   <button disabled={busy} onClick={()=>void validate()}>Re-validate file</button>
  </div>}
  {result&&<div role="status" className="notice neutral"><strong>{result.replay?'Already imported · replayed':'Imported'} {result.replay?result.row_count:result.created} payables</strong>Import {result.import_id} · {result.total_units} base units. Destination verification and independent review are still required for each payable.</div>}
  <p className="footnote">All-or-nothing: any invalid row (malformed contact, non-integer or out-of-range amount, duplicate external reference in the file or workspace) rejects the whole file with per-line errors.</p>
 </div></section>;
}
