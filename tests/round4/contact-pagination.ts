import type {Locator,Page} from '@playwright/test';

type ContactPageObservation={index:number;card_count:number;card_visible:boolean;summary:string|null;show_more_count:number};
const DEFAULT_TOTAL_DEADLINE_MS=6000;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));

/** Reveal a contact with a fixed expansion bound derived from the initial rendered summary. */
export async function revealContactCard(page:Page,card:Locator,name:string,deadline=Date.now()+DEFAULT_TOTAL_DEADLINE_MS){
 const summaryLocator=page.getByText(/Showing \d+ of \d+ contacts/);
 const summary=async()=>((await summaryLocator.allTextContents())[0]??null);
 const sample=async(index:number):Promise<ContactPageObservation>=>({index,card_count:await card.count(),card_visible:await card.isVisible().catch(()=>false),summary:await summary(),show_more_count:await page.getByRole('button',{name:'Show more contacts',exact:true}).count()});
 const initial=await sample(0);
 const match=/Showing (\d+) of (\d+) contacts/.exec(initial.summary||'');
 if(initial.card_visible)return {name,initial_summary:initial.summary,page_size:match?Number(match[1]):null,total:match?Number(match[2]):null,expanded_pages:0,observations:[initial]};
 if(!match){throw Error(`contact pagination has no usable summary and target is not mounted: ${JSON.stringify({name,...initial})}`);}
 const pageSize=Number(match[1]),total=Number(match[2]);
 const maxExpansions=Math.max(0,Math.ceil(total/pageSize)-1);
 const observations=[initial];let expanded=0;
 while(expanded<maxExpansions&&!observations.at(-1)!.card_visible&&Date.now()<deadline){
  const more=page.getByRole('button',{name:'Show more contacts',exact:true});
  if(!(await more.count()))break;
  await more.click();expanded++;
  let current=await sample(expanded);
  const expansionDeadline=Math.min(deadline,Date.now()+1500);
  while(!current.card_visible&&Date.now()<expansionDeadline){await pause(100);current=await sample(expanded);}
  observations.push(current);
 }
 if(!observations.at(-1)!.card_visible){throw Error(`contact was not mounted within bounded pagination: ${JSON.stringify({name,page_size:pageSize,total,max_expansions:maxExpansions,expanded_pages:expanded,observations})}`);}
 return {name,initial_summary:initial.summary,page_size:pageSize,total,expanded_pages:expanded,observations};
}

export async function revealVerifiedContact(page:Page,card:Locator,name:string,totalDeadlineMs=DEFAULT_TOTAL_DEADLINE_MS){
 const deadline=Date.now()+totalDeadlineMs;
 const status=card.getByText(/Verified independently/);
 const refreshObservations:any[]=[];
 const observe=async(index:number)=>({index,card_count:await card.count(),card_visible:await card.isVisible().catch(()=>false),verified_status_visible:await status.isVisible().catch(()=>false),summary:(await page.getByText(/Showing \d+ of \d+ contacts/).allTextContents())[0]??null,show_more_count:await page.getByRole('button',{name:'Show more contacts',exact:true}).count()});
 let state=await observe(0);refreshObservations.push(state);
 while(!state.verified_status_visible&&state.card_visible&&Date.now()<deadline){await pause(100);state=await observe(refreshObservations.length);refreshObservations.push(state);}
 let result:any;
 if(!state.verified_status_visible){
  result=await revealContactCard(page,card,name,deadline);
  state=await observe(refreshObservations.length);refreshObservations.push(state);
  while(!state.verified_status_visible&&Date.now()<deadline){await pause(100);state=await observe(refreshObservations.length);refreshObservations.push(state);}
 }
 if(!state.verified_status_visible)throw Error(`verified contact status did not render before bounded deadline: ${JSON.stringify({name,deadline_ms:totalDeadlineMs,refresh_observations:refreshObservations,result:result||null,final_state:state})}`);
 return {...(result||{name,expanded_pages:0}),refresh_observations:refreshObservations};
}
