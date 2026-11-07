// One-way local TCP bridge for the already allow-listed test-worker endpoints. Both listeners are
// inside the private shared network namespace; Compose publishes no host ports.
import net from 'node:net';
const [listenRaw,targetRaw]=process.argv.slice(2);
const listen=Number(listenRaw),target=Number(targetRaw);
if(![15543,18547].includes(listen)||![5543,8547].includes(target))throw Error('REPRO_PROXY_PORT_PAIR_REFUSED');
const server=net.createServer(client=>{const upstream=net.connect(target,'127.0.0.1');client.pipe(upstream);upstream.pipe(client);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());});
server.listen(listen,'127.0.0.1');
