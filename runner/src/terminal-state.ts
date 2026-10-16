import {writeFileSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
// The supervisor and bridge share these private files. Rename prevents a crash
// or concurrent refresh from leaving a torn conversation id or launch spec.
export function writeTerminalJson(path:string,value:unknown){writeTerminalText(path,JSON.stringify(value));}
export function writeTerminalText(path:string,text:string){
  const tmp=`${path}.${randomUUID()}.tmp`;
  try{writeFileSync(tmp,text,{mode:0o600,flag:'wx'});renameSync(tmp,path);}finally{rmSync(tmp,{force:true});}
}
export function validTerminalId(value:unknown):value is string{return typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);}
