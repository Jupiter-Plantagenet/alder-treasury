// One-time private provisioning. Never print credential material or overwrite a different profile.
import fs from 'node:fs';
const destination='.local/database-app.json';
const combined=JSON.parse(fs.readFileSync('.local/database.json','utf8'));
const app={user:combined.app?.user,password:combined.app?.password};
if(app.user!=='alder_app'||typeof app.password!=='string'||!app.password)throw Error('APP_PROFILE_INVALID');
if(fs.existsSync(destination)){
 const existing=JSON.parse(fs.readFileSync(destination,'utf8'));
 if(Object.keys(existing).sort().join(',')!=='password,user'||existing.user!==app.user||existing.password!==app.password)throw Error('APP_PROFILE_MISMATCH');
 console.log('App-only credential profile verified; combined operator profile preserved.');
}else{
 fs.writeFileSync(destination,JSON.stringify(app),{flag:'wx',mode:0o600});
 console.log('App-only credential profile created; combined operator profile preserved.');
}
