// Preserve terminal control sequences while withholding unfinished secrets across PTY chunks.
export class TerminalRedactor {
  private pending='';
  constructor(private secrets:()=>string[],private marker:()=>string=()=> '[gizlendi]'){}
  push(text:string,flush=false){
    this.pending+=text;
    const secrets=this.secrets().filter(Boolean).sort((a,b)=>b.length-a.length);
    // Mask completed values before withholding an unfinished suffix. Otherwise
    // a value ending in its own prefix (e.g. abcabcabc) can be split into two
    // unmasked pieces which reconstruct the full secret in the terminal.
    for(const secret of secrets)this.pending=this.pending.split(secret).join(this.marker());
    let hold=0;
    for(const secret of secrets)for(let n=1;n<secret.length && n<=this.pending.length;n++)if(this.pending.endsWith(secret.slice(0,n)))hold=Math.max(hold,n);
    const unfinished=/(?:sk-[\w-]*|Bearer\s+[\w./-]*|eyJ[\w.-]*|(?:password|secret|api[_-]?key|(?:access|refresh|id)?[_-]?token)["']?\s*[=:]\s*[^\s,;}]*|(?:sk|Bear|eyJ|password|secret|api[_-]?key|token))$/i.exec(this.pending);
    if(unfinished)hold=Math.max(hold,unfinished[0].length);
    // Flush never reveals a value that could still become a known secret.
    if(hold>16000){this.pending='';return this.marker();}
    const ready=this.pending.slice(0,this.pending.length-hold);this.pending=this.pending.slice(this.pending.length-hold);
    let clean=ready;
    for(const secret of secrets)clean=clean.split(secret).join(this.marker());
    clean=clean.replace(/(?:sk-[\w-]{16,}|Bearer\s+[\w./-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/gi,this.marker()).replace(/(["']?(?:password|secret|api[_-]?key|(?:access|refresh|id)?[_-]?token)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1'+this.marker());
    if(flush && this.pending){this.pending='';clean+=this.marker();}
    return clean;
  }
}
