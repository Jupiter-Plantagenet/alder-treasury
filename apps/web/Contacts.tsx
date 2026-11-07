import React,{useCallback,useEffect,useRef,useState} from 'react';

export type ContactPageState={contacts:any[],total:string,hasMore:boolean,loading:boolean,error:string|null,loadMore:()=>Promise<void>};
export const CONTACT_READ_PAGE_SIZE=200;
export function contactReadPath(cursor?:string){const q=new URLSearchParams({limit:String(CONTACT_READ_PAGE_SIZE)});if(cursor)q.set('cursor',cursor);return '/reads/contacts?'+q;}
export function mergeContactPages(current:any[],incoming:any[]){const byId=new Map(current.map(c=>[c.id,c]));for(const c of incoming)byId.set(c.id,c);return [...byId.values()];}

export function useContactPages(api:any,initial:any[],exactTotal:string|number,enabled=true):ContactPageState{
 const [contacts,setContacts]=useState<any[]>(initial),[total,setTotal]=useState(String(exactTotal)),[cursor,setCursor]=useState<string|undefined>(),[loaded,setLoaded]=useState(false),[loadingGeneration,setLoadingGeneration]=useState<number|null>(null),[error,setError]=useState<string|null>(null);
 const snapshotKey=String(exactTotal)+'|'+initial.map(c=>`${c.id}:${c.revision}:${c.verification_state}:${c.display_name}`).join(',');const previousSnapshot=useRef(snapshotKey),generation=useRef(0),mounted=useRef(true),loading=loadingGeneration===generation.current;
 if(previousSnapshot.current!==snapshotKey){previousSnapshot.current=snapshotKey;generation.current++;}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
 useEffect(()=>{setContacts(initial);setTotal(String(exactTotal));setCursor(undefined);setLoaded(false);setError(null);},[snapshotKey]);
 const loadMore=useCallback(async()=>{
  if(!api||loading||(!cursor&&loaded))return;
  const requestGeneration=generation.current;setLoadingGeneration(requestGeneration);setError(null);
  try{const result=await api(contactReadPath(cursor));if(requestGeneration!==generation.current)return;if(!Array.isArray(result.items)||!(result.next_cursor===null||typeof result.next_cursor==='string'))throw Error('CONTACT_PAGE_INVALID');
   if(!mounted.current)return;setContacts(current=>mergeContactPages(current,result.items));setCursor(result.next_cursor||undefined);setLoaded(true);
   if(result.total_count!==undefined)setTotal(String(result.total_count));
  }catch(e:any){if(requestGeneration===generation.current&&mounted.current)setError(e?.message||'CONTACT_PAGE_UNAVAILABLE');}
  finally{if(requestGeneration===generation.current&&mounted.current)setLoadingGeneration(null);}
 },[api,cursor,loaded,loading]);
 useEffect(()=>{if(enabled&&!loaded&&!loading&&!error)void loadMore();},[enabled,loaded,loading,error,loadMore]);
 return {contacts,total,hasMore:!!api&& (!!cursor||!loaded),loading,error,loadMore};
}

export function ContactPageControls({directory,label='contacts'}:{directory:ContactPageState,label?:string}){
 const {contacts,total,hasMore,loading,error,loadMore}=directory;
 return <div className="contact-page-controls"><p className="footnote" role="status">{loadedSummary(contacts.length,total,label)}{loading?' · Loading next page…':''}</p>{error&&<p role="alert">Could not load more contacts: {error}</p>}{(hasMore||error)&&<button type="button" disabled={loading} onClick={()=>void loadMore()}>{loading?'Loading contacts…':error?'Retry contact loading':'Load more contacts'}</button>}</div>;
}
function loadedSummary(loaded:number,total:string,label:string){return `Showing ${loaded} of ${total} ${label}.`;}
