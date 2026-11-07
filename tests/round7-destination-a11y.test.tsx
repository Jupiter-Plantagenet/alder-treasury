import {build} from 'esbuild';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';

const entry = await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: 'destination-a11y-fixture.tsx',
    loader: 'tsx',
    contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ContactsDesk} from './apps/web/Destinations.tsx';
window.fixture={fail:true};
createRoot(document.getElementById('root')!).render(<ContactsDesk snapshot={{roles:['preparer'],contacts:[],activeDestinationHolds:[]}} contacts={[]} onCommand={async()=>{if((window as any).fixture.fail)throw Error('DESTINATION_SAVE_FAILED');return {};}}/>);`
  },
  bundle: true,
  outfile: "fixture.js",
  write: false,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  define: {'process.env.NODE_ENV':'"test"'}
});
const script=entry.outputFiles.find(f=>f.path.endsWith('.js'))!.text;
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">${script}</script>`);});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();if(!address||typeof address==='string')throw Error('listener unavailable');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${address.port}`);
 await page.getByLabel('Contact display name').fill('A11y fixture');
 await page.getByLabel('Full destination address').fill('0x0000000000000000000000000000000000000001');
 await page.getByRole('button',{name:'Create contact'}).click();
 const alert=page.getByRole('alert');await alert.getByText('DESTINATION_SAVE_FAILED').waitFor();
 assert.equal(await alert.getAttribute('aria-live'),'assertive');
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('role')),'alert','failed submit must focus the rendered error');
 assert.equal(await page.getByRole('status').getAttribute('aria-live'),'polite','success status remains a separate polite region');
 await page.evaluate(()=>{(window as any).fixture.fail=false;});
 await page.getByLabel('Contact display name').fill('A11y fixture');
 await page.getByLabel('Full destination address').fill('0x0000000000000000000000000000000000000001');
 await page.getByRole('button',{name:'Create contact'}).click();
 await page.getByRole('status').getByText('Saved. Refresh shows the exact committed revision.').waitFor();
 await assert.rejects(alert.waitFor({state:'visible',timeout:150}),/Timeout/);
 console.log('PASS destination ActionForm accessible error focus and separate success status');
} finally {await browser.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}



