import { t as tx } from "../i18n";
export function bubbleText(text:string, width:number, measure:(text:string)=>number):string {
  const words=text.trim().replace(/\s+/g,' ').split(' ').filter(Boolean);
  if(!words.length)return tx("Çalışıyorum");
  if(measure(words[0]+'…')>width) {
    const complete=words.find(word=>measure(word+'…')<=width);
    return (complete || words.reduce((shortest,word)=>measure(word)<measure(shortest)?word:shortest,words[0]))+'…';
  }
  const lines:string[]=[];let used=0;
  for(let row=0;row<2 && used<words.length;row++) {
    let line='';
    while(used<words.length){const candidate=line ? line+' '+words[used] : words[used];const suffix=used<words.length-1 && row===1 ? '…' : '';if(measure(candidate+suffix)>width)break;line=candidate;used++;}
    if(!line)break;
    lines.push(line);
  }
  if(used<words.length)lines[lines.length-1]+='…';
  return lines.join('\n');
}
