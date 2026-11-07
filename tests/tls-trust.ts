// Round 6: Node-side test clients trust the LOCAL test CA (.local/tls/ca.pem) in addition to the default roots, so
// fetch() to https://127.0.0.1:5103 / :5113 / :8103 verifies the server certificate (no verification is disabled).
// The CA is not installed in the OS store. Imported for its side effect by the runner libraries.
import tls from 'node:tls';import fs from 'node:fs';
const ca='.local/tls/ca.pem';
if(fs.existsSync(ca)&&typeof (tls as any).setDefaultCACertificates==='function'){const pem=fs.readFileSync(ca,'utf8');const cur=tls.getCACertificates('default');if(!cur.includes(pem))(tls as any).setDefaultCACertificates([...cur,pem]);}
