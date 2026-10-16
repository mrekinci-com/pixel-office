import { t as tx } from "./i18n";
import { useEffect,useRef,useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from './api';
import type { TerminalSnapshot,TerminalToBrowser } from '../shared/terminal';
import '@xterm/xterm/css/xterm.css';
export const terminalStatusLabels={get working() { return tx("Çalışıyor"); },get waiting() { return tx("Sizi bekliyor"); },get idle() { return tx("Boşta"); },get disconnected() { return tx("Bağlantı bekleniyor"); }};
export function CodexTerminal({active,visible,onStatus}:{active:boolean;visible:boolean;onStatus:(snapshot:TerminalSnapshot)=>void}){
  const host=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),socket=useRef<WebSocket|null>(null),fit=useRef<FitAddon|null>(null),callback=useRef(onStatus);callback.current=onStatus;
  const [error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!active || !host.current)return;
    let disposed=false,reconnect:ReturnType<typeof setTimeout>|undefined,resize:ReturnType<typeof setTimeout>|undefined;
    const term=new Terminal({cursorBlink:true,fontSize:13,fontFamily:'ui-monospace, SFMono-Regular, Consolas, monospace',scrollback:2000,theme:{background:'#101923',foreground:'#e4edf6'},allowProposedApi:false});
    const sizing=new FitAddon();fit.current=sizing;terminal.current=term;term.loadAddon(sizing);term.open(host.current);
    const send=(value:unknown)=>{if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify(value));};
    const size=()=>{if(!host.current?.clientWidth || !host.current.clientHeight)return;sizing.fit();send({type:'resize',cols:Math.max(20,Math.min(400,term.cols)),rows:Math.max(5,Math.min(200,term.rows))});};
    const observer=new ResizeObserver(()=>{if(resize)clearTimeout(resize);resize=setTimeout(size,100);});observer.observe(host.current);
    const input=term.onData(data=>{let chunk='',bytes=0;for(const character of data){const n=new TextEncoder().encode(character).length;if(bytes+n>8000){send({type:'input',data:chunk});chunk='';bytes=0;}chunk+=character;bytes+=n;}if(chunk)send({type:'input',data:chunk});});
    const connect=async()=>{
      try{const {ticket}=await api<{ticket:string}>('/director/terminal/ticket','POST',{});if(disposed)return;
        const url=new URL('/api/director/terminal/socket',window.location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',ticket);
        const ws=new WebSocket(url);socket.current=ws;ws.onopen=()=>{setError('');size();};
        ws.onmessage=event=>{if(disposed)return;const b=JSON.parse(String(event.data)) as TerminalToBrowser;if(b.type==='output')term.write(b.data);else if(b.type==='reset'){term.reset();term.write(b.data);}else if(b.type==='status')callback.current(b.terminal);else if(b.type==='error')setError(b.message);};
        ws.onclose=()=>{if(disposed)return;callback.current({enabled:true,status:'disconnected',generation:0,usageKnown:false});setError(tx("Bağlantı kesildi; yeniden bağlanılıyor."));reconnect=setTimeout(()=>void connect(),2000);};ws.onerror=()=>setError(tx("Terminal bağlantısı kurulamadı."));
      }catch(e){if(disposed)return;setError((e as Error).message);reconnect=setTimeout(()=>void connect(),5000);}
    };void connect();
    return()=>{disposed=true;if(reconnect)clearTimeout(reconnect);if(resize)clearTimeout(resize);observer.disconnect();input.dispose();socket.current?.close();socket.current=null;term.dispose();terminal.current=null;fit.current=null;};
  },[active,retry]);
  useEffect(()=>{if(visible){requestAnimationFrame(()=>{if(host.current?.clientWidth){fit.current?.fit();terminal.current?.focus();if(socket.current?.readyState===WebSocket.OPEN && terminal.current)socket.current.send(JSON.stringify({type:'resize',cols:Math.max(20,Math.min(400,terminal.current.cols)),rows:Math.max(5,Math.min(200,terminal.current.rows))}));}});}},[visible]);
  return <div className="gm-codex"><div className="gm-xterm" ref={host} aria-label={tx("Etkileşimli Genel Müdür terminali")} />{error && <div className="gm-connection" role="alert">{error}<button onClick={()=>setRetry(n=>n+1)}>{tx("Yeniden bağlan")}</button></div>}</div>;
}
