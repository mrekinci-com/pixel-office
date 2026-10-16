import { translate, type Language } from './i18n/index.js';
import { officeDay, previousDay } from './time.js';
export type Timing =
  | { kind:'daily'; time:string }
  | { kind:'weekly'; time:string; days:number[] }
  | { kind:'interval'; hours:number; start:number; end:number }
  | { kind:'monthly'; time:string; day:number }
  | { kind:'once'; time:string; date:string };
export interface ScheduledTask {
  id:string; agent_id:string; name:string; instruction:string; timing:Timing;
  enabled:boolean; end_date:string|null; attention_only:boolean; token_budget:number; daily_limit:number;
  next_at:string|null; created_at:string; failures:number; notice_reason:string; last_note:string;
  last_result?: ScheduleHistory|null;
}
export interface ScheduleHistory {
  id:string; task_id:string; due_at:string; created_at:string; run_id:string|null; chain_id:string|null;
  result_run_id?:string;
  state:'queued'|'running'|'waiting'|'completed'|'silent'|'failed'|'skipped'|'missed'; reason:string;
  output:string; duration_ms:number; tokens:number; finished_at:string|null;
}
const clocks = new Map<string,Intl.DateTimeFormat>();
function localMinute(at:number, zone:string) {
  let f=clocks.get(zone);
  if(!f) { f=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});clocks.set(zone,f); }
  return f.format(at).replace(' ', 'T');
}
// Resolve wall time using the offsets on both sides of a transition. Missing wall
// times are skipped; a repeated wall time runs only once, at its first instant.
export function wallTime(day:string, time:string, zone:string):number|null {
  const target=`${day}T${time}`, naive=Date.parse(target+':00Z'), candidates=new Set<number>();
  for(const delta of [-36,-12,0,12,36]) {
    const sample=naive+delta*3600000;
    const offset=Date.parse(localMinute(sample,zone)+':00Z')-sample;
    const at=naive-offset;
    if(localMinute(at,zone)===target)candidates.add(at);
  }
  return candidates.size ? Math.min(...candidates) : null;
}
export function nextTimes(timing:Timing, after:number, zone:string, endDate:string|null=null, count=3):string[] {
  const result:string[]=[];
  if(timing.kind==='once') {
    if(endDate && timing.date>endDate)return [];
    const at=wallTime(timing.date,timing.time,zone);
    return at!==null && at>after ? [new Date(at).toISOString()] : [];
  }
  let day=officeDay(after,zone);
  for(let i=0;i<800 && result.length<count;i++,day=previousDay(day,-1)) {
    if(endDate && day>endDate)break;
    const weekday=new Date(day+'T12:00:00Z').getUTCDay();
    if(timing.kind==='weekly' && !timing.days.includes(weekday))continue;
    if(timing.kind==='monthly' && Number(day.slice(-2))!==timing.day)continue;
    const times=timing.kind==='interval' ? Array.from({length:Math.floor((timing.end-timing.start)/timing.hours)+1},(_,n)=>String(timing.start+n*timing.hours).padStart(2,'0')+':00') : [timing.time];
    for(const time of times) {
      const at=wallTime(day,time,zone);
      if(at!==null && at>after)result.push(new Date(at).toISOString());
      if(result.length===count)break;
    }
  }
  return result;
}
const days=['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
export function timingLabel(t:Timing, language: Language = "tr") {
  if (language === "en") {
    switch (t.kind) {
      case "daily": return `Every day ${t.time}`;
      case "weekly": return `${[1,2,3,4,5].every(d=>t.days.includes(d)) && t.days.length===5 ? "Every weekday" : [...t.days].sort().map(d=>translate(language,days[d])).join(", ")} ${t.time}`;
      case "interval": return `Every ${t.hours} hours from ${String(t.start).padStart(2,"0")}:00 to ${String(t.end).padStart(2,"0")}:00`;
      case "monthly": return `Day ${t.day} of each month ${t.time}`;
      case "once": return `${new Intl.DateTimeFormat("en-US", { timeZone:"UTC",year:"numeric",month:"short",day:"numeric" }).format(new Date(t.date+"T12:00:00Z"))} ${t.time} · once`;
    }
  }
  switch(t.kind) {
    case 'daily':return `Her gün ${t.time}`;
    case 'weekly':return `${[1,2,3,4,5].every(d=>t.days.includes(d)) && t.days.length===5 ? 'Hafta içi her gün' : [...t.days].sort().map(d=>days[d]).join(', ')} ${t.time}`;
    case 'interval':return `${String(t.start).padStart(2,'0')}:00–${String(t.end).padStart(2,'0')}:00 arasında her ${t.hours} saatte bir`;
    case 'monthly':return `Her ayın ${t.day}. günü ${t.time}`;
    case 'once':return `${t.date.split('-').reverse().join('.')} ${t.time} · tek sefer`;
  }
}
