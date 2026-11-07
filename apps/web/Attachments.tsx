import React,{useEffect,useRef,useState} from 'react';

type Attachment={attachment_id:string,mime:string,byte_length:number,scan_state:'pending'|'clean'|'quarantine'};
type AttachmentApi=(path:string,body?:any,key?:string)=>Promise<any>;
export function AttachmentItems({workspaceId,items}:{workspaceId:string,items:Attachment[]}){
 return <ul>{items.map(file=><li key={file.attachment_id}>
  <span>{file.mime} · {file.byte_length} bytes · </span>
  <strong>{file.scan_state==='clean'?'Trusted scan complete':file.scan_state==='quarantine'?'Quarantined · scan rejected':'Quarantined · pending trusted scan'}</strong>{' '}
  {file.scan_state==='clean'&&<a href={`/api/v1/workspaces/${workspaceId}/attachments/${file.attachment_id}/content`} download>Download private attachment</a>}
 </li>)}</ul>;
}

/** Mounted under the authenticated workspace/account and keyed by payable ID.
 * Browser flags never assert scan authority. A failed link retains the pending
 * upload so retry never needs to upload the same private bytes a second time.
 */
export function AttachmentPanel({workspaceId,payable,roles,api}:{workspaceId:string,payable:any,roles:string[],api?:AttachmentApi}){
 const [items,setItems]=useState<Attachment[]>([]),[file,setFile]=useState<File|null>(null),[uploaded,setUploaded]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 const uploadKey=useRef(''),linkKey=useRef('');
 useEffect(()=>{let live=true;setLoaded(false);setItems([]);setError('');
  if(api&&payable?.id)api(`/payables/${payable.id}/attachments`).then(r=>{if(live){setItems(r.items);setLoaded(true);}}).catch(e=>{if(live)setError(e.message);});
  else setError('Attachment API unavailable.');
  return()=>{live=false;};
 },[payable?.id,payable?.revision,api]);
 async function reload(){if(!api)return;setError('');try{const r=await api(`/payables/${payable.id}/attachments`);setItems(r.items);setLoaded(true);}catch(e){setError((e as Error).message);}}
 async function upload(){if(!file||!api)return;setBusy(true);setError('');try{
  if(file.size<1||file.size>10*1024*1024)throw Error('Choose a PDF, PNG or JPEG up to 10 MiB.');
  uploadKey.current||=crypto.randomUUID();const form=new FormData();form.append('file',file);
  const result=await api('/attachments',form,uploadKey.current);setUploaded(result);
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function link(){if(!uploaded||!api)return;setBusy(true);setError('');try{
  linkKey.current||=crypto.randomUUID();await api(`/payables/${payable.id}/attachments`,{expected_revision:payable.revision,attachment_ids:[uploaded.attachment_id]},linkKey.current);
  setUploaded(null);setFile(null);uploadKey.current='';linkKey.current='';await reload();
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="panel" aria-label="Private attachments"><header className="panel-head"><div><h2>Private attachments</h2><p>Authenticated downloads only. No public file URLs.</p></div></header><div className="panel-body">
  <p>PDF, PNG or JPEG · maximum 10 MiB each. Every upload remains quarantined until an independent trusted scanner verdict. No inline document preview.</p>
  {error&&<p role="alert">{error}</p>}{busy&&<p role="status">Saving private attachment…</p>}
  {!loaded&&!error&&<p role="status">Loading attachments…</p>}
  {loaded&&!items.length&&<p>No linked attachments.</p>}
  <AttachmentItems workspaceId={workspaceId} items={items}/>
  <button disabled={busy||!api} onClick={reload}>Refresh attachment state</button>
  {roles.includes('preparer')&&payable&&<div>
   <label>Choose private attachment<input type="file" accept="application/pdf,image/png,image/jpeg" disabled={busy||!!uploaded} onChange={e=>{setFile(e.target.files?.[0]||null);setError('');uploadKey.current='';linkKey.current='';}}/></label>
   <button disabled={busy||!file||!!uploaded||!api} onClick={upload}>Upload to quarantine</button>
   {uploaded&&<div role="status"><p>Upload saved · quarantined. Not yet linked to this payable.</p><button disabled={busy} onClick={link}>Link pending file to revision {payable.revision}</button><p>Linking requires a current revision, clears business approval and is blocked for frozen payables. A failed link retains this upload for retry.</p></div>}
  </div>}
 </div></section>;
}
