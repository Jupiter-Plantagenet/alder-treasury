import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Workspace} from '../apps/web/App.tsx';

const snapshot={payables:[],contacts:[],batches:[],signatures:[],events:[],roles:['preparer'],user:{id:'actor',name:'Preparer'},deployment:{},balance:null,allowance:null,chainError:'CHAIN_UNAVAILABLE'};
test('payables screen provides real manual intake and server snapshot loading independently of chain readiness',()=>{
 const html=renderToStaticMarkup(<Workspace workspaceId="tenant" screen="payables" snapshot={snapshot} businessApi={async()=>({})}/>);
 assert(html.includes('Create manual payable'));
 assert(html.includes('External reference'));
 assert(html.includes('Amount · ALDR'));
 assert(html.includes('Loading inbox snapshot'));
 assert(!html.includes('PAY-1044 remains on hold'));
});
test('manual intake detail does not invent a seed invoice, service period or bill-to facts',()=>{
 const p={id:'p',contact:'Authored contractor',display_reference:'MANUAL-EXACT',service:'Manual payable',amount_units:'9007199254740993',recipient:'0x0000000000000000000000000000000000000991',revision:1,verified:false,prepared_by:'actor',contact_id:'c'};
 const html=renderToStaticMarkup(<Workspace workspaceId="tenant" screen="payable" snapshot={{...snapshot,payables:[p]}}/>);
 assert(!html.includes('INVOICE'));
 assert(!html.includes('Release QA'));
 assert(!html.includes('01–31 October 2026'));
 assert(html.includes('Manually entered obligation'));
 assert(html.includes('9007199254740993'));
});
