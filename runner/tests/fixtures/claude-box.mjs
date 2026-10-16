import { spawn } from 'node:child_process';
const args=process.argv.slice(2),at=args.indexOf('--');
const child=spawn(args[at+1],args.slice(at+2),{env:process.env,stdio:'inherit'});
process.on('SIGTERM',()=>child.kill('SIGKILL'));
child.on('exit',(code)=>process.exit(code || 0));
