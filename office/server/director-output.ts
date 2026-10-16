import { translate, type Language } from "../shared/i18n/index.js";
// Keep valid JSON and useful identifiers while enforcing a serialized character cap.
export function boundedManagement(value:unknown,limit=3000,language:Language="tr"):any {
  let omitted=0,shortened=false;
  const copy=(v:any):any=>{
    if(typeof v==='string' && v.length>1000){shortened=true;return v.slice(0,997)+'…';}
    if(Array.isArray(v))return v.map(copy);
    if(v && typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,copy(x)]));
    return v;
  };
  let result=copy(value ?? null);
  if(!shortened && JSON.stringify(result).length<=limit)return result;
  if(Array.isArray(result))result={kayitlar:result};
  if(!result || typeof result!=='object')result={sonuc:result};
  const notice=()=>{result.kisaltma=translate(language,"… ({0} kayıt daha; metinler kısaltılmış olabilir; filtreyle iste)",[omitted]);};
  notice();
  while(JSON.stringify(result).length>limit){
    const arrays:any[][]=[],strings:{object:any;key:string;length:number}[]=[];
    const visit=(v:any)=>{
      if(Array.isArray(v)){if(v.length)arrays.push(v);v.forEach(visit);}
      else if(v && typeof v==='object')for(const [key,x] of Object.entries(v)){
        if(key==='kisaltma')continue;
        if(typeof x==='string' && x.length>80)strings.push({object:v,key,length:x.length});else visit(x);
      }
    };visit(result);
    arrays.sort((a,b)=>JSON.stringify(b).length-JSON.stringify(a).length);
    strings.sort((a,b)=>b.length-a.length);
    if(arrays.length && (!strings.length || JSON.stringify(arrays[0]).length>strings[0].length)){arrays[0].pop();omitted++;}
    else if(strings.length){const s=strings[0];s.object[s.key]=s.object[s.key].slice(0,Math.max(40,Math.floor(s.length/2)))+'…';}
    else {
      // Very wide objects: preserve the leading identity/result fields, drop tail data.
      const keys=Object.keys(result).filter(k=>k!=='kisaltma');
      if(!keys.length)break;delete result[keys.at(-1)!];omitted++;
    }
    notice();
  }
  return result;
}
