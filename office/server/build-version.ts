import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
export function sourceBuildId(root=process.cwd()) {
  const hash=createHash('sha256');
  const visit=(dir:string,all=false)=>{for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(dir,item.name);if(item.isDirectory())visit(path,all);else if(all || /\.(ts|tsx|css)$/.test(item.name)){hash.update(path.slice(root.length));hash.update(readFileSync(path));}}};
  for(const dir of ['src','shared','server'])visit(join(root,dir));
  if(existsSync(join(root,'public')))visit(join(root,'public'),true);
  for(const file of ['package-lock.json','package.json','index.html','vite.config.ts'])if(existsSync(join(root,file)))hash.update(readFileSync(join(root,file)));return hash.digest('hex').slice(0,20);
}
export function serverBuildId(staticDir:string) {
  const file=join(staticDir,'build-id.json');
  if(existsSync(file))return String(JSON.parse(readFileSync(file,'utf8')).id);
  // Development and tests may have no client build yet.
  return ['src','server','shared'].every(dir=>existsSync(resolve(dir))) ? sourceBuildId() : 'gelistirme';
}
