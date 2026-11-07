import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AttachmentItems,AttachmentPanel} from '../apps/web/Attachments.tsx';

test('attachment UI keeps pending files quarantined and uses only authenticated private content routes',()=>{
 const html=renderToStaticMarkup(<AttachmentItems workspaceId="tenant" items={[
  {attachment_id:'pending-id',mime:'application/pdf',byte_length:12,scan_state:'pending'},
  {attachment_id:'clean-id',mime:'image/png',byte_length:8,scan_state:'clean'}
 ]}/>);
 assert(html.includes('Quarantined · pending trusted scan'));
 assert(!html.includes('/pending-id/content'));
 assert(html.includes('/api/v1/workspaces/tenant/attachments/clean-id/content'));
 assert(!html.includes('data:'));assert(!html.includes('inline'));
 const reader=renderToStaticMarkup(<AttachmentPanel workspaceId="tenant" payable={{id:'p',revision:1}} roles={['accountant']}/>);
 assert(!reader.includes('type="file"'));assert(reader.includes('Private attachments'));
 const preparer=renderToStaticMarkup(<AttachmentPanel workspaceId="tenant" payable={{id:'p',revision:1}} roles={['preparer']}/>);
 assert(preparer.includes('type="file"'));assert(preparer.includes('10 MiB'));assert(preparer.includes('independent'));
});
