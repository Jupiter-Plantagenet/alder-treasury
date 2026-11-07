// @ts-nocheck -- live-stack check of the login throttle (fixed 60 s window, 20 attempts per client address)
import {ORIGIN,email,password} from './api-client.ts';
const login=async(pw:string,who='jordan')=>(await fetch(ORIGIN+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify({email:email(who),password:pw})})).status;
const phase=process.argv[2];const out:any={phase};
if(phase==='recovery'||phase==='all'){await new Promise(r=>setTimeout(r,61000));out.after_idle=[];for(let i=0;i<5;i++)out.after_idle.push(await login(password()));}
if(phase==='burst'||phase==='all'){out.burst=[];for(let i=0;i<21;i++)out.burst.push(await login('wrong-password-'+i));}
console.log(JSON.stringify(out));
