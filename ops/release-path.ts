// Untrusted HTTP request targets must never throw out of the server callback.
export function parseReleasePath(raw:string|undefined):{pathname:string;decoded:string}|null{
 try{
  const pathname=new URL(raw||'/','https://127.0.0.1').pathname;
  const decoded=decodeURIComponent(pathname);
  return decoded.includes('\0')?null:{pathname,decoded};
 }catch{return null;}
}
