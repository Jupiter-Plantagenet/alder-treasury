// @ts-nocheck -- exploration probe: launches the pinned extension, runs scripted steps (JSON file arg), dumps the UI
// after each step. Secret values are generated locally in-process and typed via fill(); they are never printed.
import {launchWallet,verifyPinnedWallet,dump,sleep} from './metamask.ts';import fs from 'node:fs';
import {generateMnemonic,english} from 'viem/accounts';
const out='evidence/round5-wallet/probe';fs.mkdirSync(out,{recursive:true});
const steps=process.argv[2]?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):[];
const secrets:any={seed:generateMnemonic(english),password:'W5-'+crypto.randomUUID(),k0:'0x'+(101).toString(16).padStart(64,'0'),k1:'0x'+(202).toString(16).padStart(64,'0')};
console.log(JSON.stringify(verifyPinnedWallet()));
const {ctx,id,home}=await launchWallet('.local/wallet-profiles/probe-'+Date.now().toString(36));
await sleep(2500);
const page=ctx.pages().find(p=>p.url().includes(id))||await ctx.newPage();
page.on("console",m=>{if(["error","warning"].includes(m.type()))console.log("CONSOLE",m.type(),m.text().slice(0,300));});page.on("requestfailed",r=>console.log("REQFAIL",r.url().slice(0,120),r.failure()?.errorText));
if(!page.url().includes(id))await page.goto(home);
await sleep(2000);
let n=0;
for(const s of steps){n++;try{
 if(s.click)await page.getByTestId(s.click).first().click({timeout:10000});
 if(s.clickText)await page.getByText(s.clickText,{exact:!!s.exact}).first().click({timeout:10000});
 if(s.clickRole)await page.getByRole(s.clickRole[0],{name:s.clickRole[1],exact:!!s.exact}).first().click({timeout:10000});
 if(s.uncheck){const st=await page.locator(s.uncheck).first().isChecked({timeout:5000});console.log("checked?",s.uncheck,st);if(st)await page.getByTestId(s.label).first().click({timeout:10000});await sleep(300);console.log("after",await page.locator(s.uncheck).first().isChecked({timeout:5000}));}
 if(s.css)await page.locator(s.css).first().click({timeout:10000,force:!!s.force});
 if(s.check)await page.getByTestId(s.check).first().check({timeout:10000});
 if(s.fill)await page.locator(s.fill).first().fill(s.secret?secrets[s.secret]:s.value,{timeout:10000});
 if(s.type){await page.locator(s.type).first().click();await page.keyboard.type(s.secret?secrets[s.secret]:s.value,{delay:5});}
 if(s.ph)await page.getByPlaceholder(s.ph).first().click({timeout:10000});
 if(s.kbd)await page.keyboard.type(s.secret?secrets[s.secret]:s.kbd,{delay:3});
 if(s.goto)await page.goto(home+s.goto);
 await sleep(s.wait??1500);
}catch(e){console.log('STEP FAILED',n,JSON.stringify(s),String(e).split('\n')[0]);break;}}
await page.screenshot({path:out+`/step-${n}.png`});
console.log(JSON.stringify(await dump(page),null,1));
await ctx.close();
