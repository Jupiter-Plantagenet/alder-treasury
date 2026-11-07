from pathlib import Path

p=Path(__file__).resolve().parents[1]/'round6-perf/vitals-p6.ts'
s=p.read_text(encoding='utf-8')
s=s.replace("import {build} from 'esbuild';", "import path from 'node:path';import {createHash} from 'node:crypto';")
a=s.index('const b=await build(')
b=s.index('const app=',a)
s=s[:a]+'''const dist=path.resolve(process.env.P6_VITALS_DIST||'.local/release-candidate-20261103');
const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
const filePins=Object.fromEntries(fs.readdirSync(path.join(dist,'assets')).map(name=>['assets/'+name,createHash('sha256').update(fs.readFileSync(path.join(dist,'assets',name))).digest('hex')]));
'''+s[b:]
s=s.replace("if(u.pathname==='/app.js')return route.fulfill({contentType:'text/javascript',body:js});", "if(u.pathname.startsWith('/assets/')){const file=path.resolve(dist,'.'+u.pathname);if(!file.startsWith(dist+path.sep))return route.abort();return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});}")
s=s.replace('UI = esbuild production bundle of apps/web/main.tsx','UI = Vite production bundle pinned by filePins')
s=s.replace('JSON.stringify({summary,results},null,1)','JSON.stringify({summary,results,filePins},null,1)')
Path(__file__).with_name('vitals-release.ts').write_text(s,encoding='utf-8')
