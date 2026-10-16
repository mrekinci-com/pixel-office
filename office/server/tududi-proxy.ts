import { translate, languageFrom } from "../shared/i18n/index.js";
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
// Accept only an explicitly configured numeric private-network bind address.
export function privateAddress(host: string) {
  if (isIP(host) !== 4) return false;
  const [a,b] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}
export function upstreamHeaders(input: IncomingHttpHeaders, upgrade = false) {
  const headers: IncomingHttpHeaders = {host:'127.0.0.1:9393',connection:upgrade ? 'Upgrade' : 'close'};
  for (const name of ['accept','accept-language','accept-encoding','content-type','content-length','authorization','origin','user-agent','x-csrf-token','x-requested-with', ...(upgrade ? ['sec-websocket-key','sec-websocket-version','sec-websocket-protocol'] : [])]) if (input[name] !== undefined) headers[name] = input[name];
  if (input.cookie) headers.cookie = input.cookie.split(';').filter(v => !/^ofis_(?:session|language)=/.test(v.trim())).join(';');
  if (upgrade) headers.upgrade = 'websocket';
  return headers;
}
export function proxyConfig(env = process.env) {
  const host = env.TUDUDI_PROXY_BIND || '127.0.0.1', port = Number(env.TUDUDI_PROXY_PORT || 9394);
  if (!privateAddress(host) || !Number.isInteger(port) || port < 1024 || port > 65535 || [9292,9393,9400,9401].includes(port)) throw new Error('Tududi vekili için ayrı port ve sayısal özel ağ adresi gerekiyor.');
  return {host,port};
}
export function createTududiProxy() {
  const server = createServer((req,res) => {
    const upstream = request({hostname:'127.0.0.1',port:9393,path:req.url,method:req.method,headers:upstreamHeaders(req.headers)},incoming => {
      res.writeHead(incoming.statusCode || 502,{...incoming.headers,'referrer-policy':'no-referrer'}); incoming.pipe(res); incoming.on('error',()=>res.destroy());
    });
    upstream.on('error',()=> { if (!res.headersSent) res.writeHead(502); res.end(translate(languageFrom(req.headers.cookie?.match(/(?:^|;\s*)ofis_language=(tr|en)(?:;|$)/)?.[1] || req.headers['accept-language']?.split(',')[0]),'Tududi bağlantısı hazır değil.')); });
    upstream.setTimeout(10000,()=>upstream.destroy()); req.on('aborted',()=>upstream.destroy()); res.on('close',()=>upstream.destroy()); req.pipe(upstream);
  });
  server.on('upgrade',(req,socket,head) => {
    socket.on('error',()=>socket.destroy());
    const upstream = request({hostname:'127.0.0.1',port:9393,path:req.url,method:'GET',headers:upstreamHeaders(req.headers,true)});
    upstream.on('upgrade',(incoming,target,upstreamHead) => {
      upstream.setTimeout(0);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(incoming.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) target.write(head); if (upstreamHead.length) socket.write(upstreamHead); target.pipe(socket); socket.pipe(target);
      socket.on('close',()=>target.destroy()); target.on('error',()=>socket.destroy()); target.on('close',()=>socket.destroy());
    });
    upstream.on('response',incoming=> { incoming.resume(); socket.end(`HTTP/1.1 ${incoming.statusCode || 502} Rejected\r\nConnection: close\r\n\r\n`); });
    upstream.on('error',()=>socket.destroy()); upstream.setTimeout(10000,()=>upstream.destroy()); upstream.end();
  });
  return server;
}
