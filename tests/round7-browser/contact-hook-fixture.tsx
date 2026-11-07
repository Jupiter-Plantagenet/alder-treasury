import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ContactPageControls,useContactPages} from '../../apps/web/Contacts.tsx';

declare global{interface Window{contactHarness:{calls:string[],allowRetry:boolean,releaseOld?:()=>void,unmount?:()=>void}}}
const scenario=new URLSearchParams(location.search).get('scenario')||'error';
window.contactHarness={calls:[],allowRetry:false};
async function api(path:string){const h=window.contactHarness,index=h.calls.push(path)-1;
 if(scenario==='error'&&index===0)throw Error('AUTHORED_FIRST_PAGE_FAILURE');
 if(scenario==='error'&&index>0&&!h.allowRetry)throw Error('AUTHORED_FIRST_PAGE_FAILURE');
 if(scenario==='error')return {items:[{id:'E1',display_name:'Error retry contact'}],next_cursor:null};
 if(index===0)return await new Promise(resolve=>{h.releaseOld=()=>resolve({items:[{id:'STALE',display_name:'Stale generation contact'}],next_cursor:'cursor-OLD'});});
 if(index===1)return {items:[{id:'B1',display_name:'Current generation contact'}],next_cursor:'cursor-B'};
 return {items:[{id:'B2',display_name:'Current next page contact'}],next_cursor:null};
}
function Directory({snapshot}:any){const directory=useContactPages(api,snapshot.contacts,snapshot.total,true);return <><ContactPageControls directory={directory}/><output data-contact-ids>{directory.contacts.map(c=>c.id).join(',')}</output></>;}
function Fixture(){const [snapshot,setSnapshot]=useState({contacts:[{id:'A0',display_name:'Original snapshot contact'}],total:'2'}),[mounted,setMounted]=useState(true);window.contactHarness.unmount=()=>setMounted(false);
 return <main><button type="button" onClick={()=>setSnapshot({contacts:[{id:'B0',display_name:'Replacement snapshot contact'}],total:'3'})}>Switch snapshot</button><button type="button" onClick={()=>setMounted(false)}>Unmount directory</button>{mounted?<Directory snapshot={snapshot}/>:<p>Directory unmounted</p>}</main>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
