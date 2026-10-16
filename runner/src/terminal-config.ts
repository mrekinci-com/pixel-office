import { t as tx } from "./i18n.js";
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {writeTerminalText} from './terminal-state.js';

// The TUI onboarding checks the persisted user layer, not only CLI overrides.
// Parse TOML rather than editing strings: keep /model and other saved settings.
export function writeRestrictedProjectConfig(home:string,work:string){
  if(lstatSync(home).isSymbolicLink() || realpathSync(home)!==resolve(home))throw new Error(tx("Terminal ayar yolu kullanılamıyor."));
  const path=join(home,'config.toml');
  if(existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size>1_000_000))throw new Error(tx("Terminal ayar dosyası kullanılamıyor."));
  const source=existsSync(path)?readFileSync(path,'utf8'):'';
  // Python 3 is also required by the existing sandbox probes. No file or secret
  // content is logged; serialization preserves TOML values, not comments.
  const script=`import sys,json,tomllib,datetime,math
try:
 data=tomllib.loads(sys.stdin.read())
 for path in sys.argv[1:]:
  data.setdefault("projects",{}).setdefault(path,{})["trust_level"]="untrusted"
 def key(s): return json.dumps(s,ensure_ascii=False)
 def value(v):
  if isinstance(v,dict): return "{"+", ".join(key(k)+" = "+value(x) for k,x in v.items())+"}"
  if isinstance(v,list): return "["+", ".join(value(x) for x in v)+"]"
  if isinstance(v,(datetime.datetime,datetime.date,datetime.time)): return v.isoformat()
  if isinstance(v,float) and not math.isfinite(v): return str(v)
  return json.dumps(v,ensure_ascii=False)
 def table(d,path=[]):
  lines=[]
  if path: lines.append("["+".".join(key(k) for k in path)+"]")
  lines.extend(key(k)+" = "+value(v) for k,v in d.items() if not isinstance(v,dict))
  for k,v in d.items():
   if isinstance(v,dict): lines.extend(table(v,path+[k]))
  return lines
 result="\\n".join(table(data))+"\\n"
 assert tomllib.loads(result)==data
 sys.stdout.write(result)
except Exception:
 sys.exit(1)
`;
  const result=spawnSync('/usr/bin/python3',['-c',script,...new Set([resolve(work),realpathSync(work)])],{input:source,encoding:'utf8',timeout:5000,maxBuffer:2_000_000});
  if(result.status!==0 || result.error || result.signal)throw new Error(tx("Terminalin kısıtlı klasör kararı kaydedilemedi."));
  writeTerminalText(path,result.stdout);
}
