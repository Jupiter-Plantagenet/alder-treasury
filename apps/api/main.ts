// Round 6: the API listens on loopback over HTTPS only (local CA under .local/tls, see ops/local-tls.sh); it refuses to
// start without TLS material rather than silently falling back to plain HTTP. Browsers reach it through a front proxy
// (Vite dev https://127.0.0.1:5103 or the release server https://127.0.0.1:5113) that verifies this certificate.
import {buildApp} from './app.ts';import {tlsAvailable,serverTls} from './tls.ts';
if(!tlsAvailable())throw Error('TLS_MATERIAL_REQUIRED: run ops/local-tls.sh');
const app=await buildApp(undefined,{https:serverTls()});await app.listen({host:'127.0.0.1',port:8103});console.log('Alder API listening on https://127.0.0.1:8103');
