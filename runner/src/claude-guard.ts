import { readFileSync } from 'node:fs';
import { claudeFileAllowed, type ClaudeFiles } from './claude-policy.js';
// Managed PreToolUse hook, called only for Read/Edit/Write. Never echo inputs.
try {
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>200000)throw new Error();}
  const request=JSON.parse(raw),files=JSON.parse(readFileSync(process.argv[2],'utf8')) as ClaudeFiles;
  if(['bypassPermissions','auto'].includes(request.permission_mode))throw new Error();
  if(!claudeFileAllowed(files,request.tool_name,request.tool_input || {}))throw new Error();
} catch {process.stderr.write('Bu dosyaya erişim kapalı.\n');process.exitCode=2;}
