import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync,realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

import { usageTotals } from '../dist/office/shared/runtime.js';

const repo = resolve(fileURLToPath(new URL('../../', import.meta.url))); // without the trailing slash
const envFile = (path) => existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const terminal = (r) => ['completed', 'failed', 'stopped', 'interrupted', 'waiting'].includes(r.state);
const withoutSecrets = (text, secrets = []) => {
  let value = String(text);
  for (const s of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(s).join('[gizlendi]');
  return value.replace(/(?:sk-[\w-]{16,}|Bearer\s+[\w.-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)/gi, '[gizlendi]')
    .replace(/(["']?(?:password|secret|api[_-]?key|(?:access|refresh|id)?[_-]?token)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[gizlendi]');
};

// The same scenario driver is exercised by a fake CLI + real stdio MCP without opening a port.
export async function runSmoke({ api, runner = 'codex', keep = false, roots = [], workDir,
  pause = sleep, timeoutMs = 240000, simulated = false, signal, report = console.log,
  archiveRoot = join(repo, 'runner/.smoke'), mask = withoutSecrets, cleanupTimeoutMs = 90000 }) {
  ensure(['codex', 'claude', 'all'].includes(runner), "--runner must be codex, claude or all.");
  const selected = runner === 'all' ? ['codex', 'claude'] : [runner];
  const ids = [], links = [], rows = [], runIds = new Set();
  const tag = 'Duman ' + randomUUID().slice(0, 8);
  const archive = join(archiveRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + tag.slice(6));
  const masked = (value) => typeof value === 'string' ? mask(value)
    : Array.isArray(value) ? value.map(masked)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, masked(item)])) : value;
  // Scrub strings before serialization so redaction cannot consume JSON quotes.
  const save = (name, value) => writeFileSync(join(archive, name), JSON.stringify(masked(value), null, 2) + '\n', { mode: 0o600 });
  const reporter = report;
  report = (text) => reporter(mask(text));
  let department, folders;
  const agents=[];
  const changeMode=async(agent,mode)=>{const current=(await snapshot()).agents.find(a=>a.id===agent.id);const fields=Object.fromEntries(['name','title','department_id','prompt','runner','model','effort','appearance','policy','active','username','watch_tasks','watch_due'].map(k=>[k,current[k]]));return api(`/agents/${agent.id}`,'PUT',{...fields,session_mode:mode});};
  const snapshot = () => api('/snapshot');
  const recordRuns = (s) => {
    for (const r of s.runtime.runs.filter((r) => ids.includes(r.agent_id) && r.started_at)) runIds.add(r.id);
    ensure(runIds.size <= 90, "The 90-run limit was exceeded; smoke stopped.");
  };
  const until = async (check, message) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      ensure(!signal?.aborted, "Smoke stopped; cleaning up temporary records.");
      const s = await snapshot(); recordRuns(s);
      const value = await check(s); if (value) return value;
      await pause(500);
    }
    throw new Error(message || "The expected result did not arrive before the timeout.");
  };
  const prompt = (scenario, data, instruction) => `${instruction}\nKısa çalış, eforu düşük tut. Yalnız istenen işlemleri yap. Sahibe teslim için ayrıca onay isteme.\nDUMAN ${JSON.stringify({ scenario, ...data })}`;
  const start = async (agent, scenario, data, instruction, maxRuns = 1, smokeTimeoutSeconds) => {
    const r = await api(`/agents/${agent.id}/run`, 'POST', {
      text: prompt(scenario, data, instruction), limits: { maxDepth: 1, maxRuns },
      ...(smokeTimeoutSeconds === undefined ? {} : { smokeTimeoutSeconds }),
    });
    ensure(r?.id, "Work was not queued. Check quotas and agent status.");
    return r;
  };
  const done = async (root, expected = 'completed') => {
    const r = await until((s) => { const r = s.runtime.runs.find((r) => r.id === root.id); return r && terminal(r) && r; });
    ensure(r.state === expected, `${r.state}: ${r.reason || "The expected run result was not received."}`);
    return r;
  };
  const scenario = async (name, fn, enabled = true) => {
    if(!enabled){rows.push({senaryo:name,sonuc:"UNTESTED",tani:"Claude uses chat-only access here; file and shell checks require Codex."});return;}
    ensure(!signal?.aborted, "Smoke stopped.");
    const at = Date.now(), before = new Set(runIds);
    try {
      for(const agent of agents){await changeMode(agent,'work');await api(`/agents/${agent.id}/session/reset`,'POST',{});}
      await fn(); rows.push({ senaryo: name, sonuc: "PASS", saniye: ((Date.now() - at) / 1000).toFixed(1) }); }
    catch (error) { rows.push({ senaryo: name, sonuc: "FAIL", saniye: ((Date.now() - at) / 1000).toFixed(1), tani: error.message }); }
    const s = await snapshot(); recordRuns(s);
    const runs = s.runtime.runs.filter((r) => runIds.has(r.id) && !before.has(r.id));
    rows.at(-1).token=runs.reduce((n,r)=>n+usageTotals(r.usage).total_tokens,0);
    rows.at(-1).cached_input_tokens=runs.reduce((n,r)=>n+usageTotals(r.usage).cached_input_tokens,0);
    rows.at(-1).uncached_input_tokens=runs.reduce((n,r)=>n+usageTotals(r.usage).uncached_input_tokens,0);
    for (const r of runs.filter((r) => ['failed', 'interrupted'].includes(r.state))) {
      const detail = await api(`/runs/${r.id}`);
      rows.at(-1).tani = (rows.at(-1).tani || '') + '\n' + detail.logs.filter((l) => l.kind === 'diagnostic').map((l) => l.text).join('\n').slice(-6000);
    }
    // A failed scenario must not leave jobs/onay cards that prevent later scenarios.
    if (rows.at(-1).sonuc === "FAIL") {
      for (const id of ids) await api(`/agents/${id}/stop`, 'POST');
      const pending = (await snapshot()).runtime.approvals.filter((a) => ids.includes(a.agent_id) && a.state === 'pending');
      for (const a of pending) await api(`/approvals/${a.id}/decision`, 'POST', { approved: false, note: 'Duman senaryosu tamamlanamadı.' });
      for (const id of ids) await api(`/agents/${id}/stop`, 'POST');
    }
    report(`${name}: ${rows.at(-1).sonuc}`);
  };
  const exited = async (root) => until(async () => {
    const d = await api(`/runs/${root.id}`);
    return d.logs.some((l) => l.kind === 'diagnostic' && l.text.includes('"olay":"process_exit"') && /"pid":\d+/.test(l.text));
  }, "No child-process exit record; panel state alone does not prove process termination.");
  try {
    const initial = await snapshot();
    ensure(initial.runtime.connected && !initial.runtime.paused, "The runner must be connected and Office must allow work.");
    for (const provider of selected) ensure(initial.runtime.availability?.[provider] === true,
      provider === 'claude' ? "Claude is not signed in." : "Codex is not signed in.");
    report(`At most 90 runs. ${simulated ? "FAKE CLI TEST — not evidence of real isolation or model behavior." : "Real model test."}`);
    department = await api('/departments', 'POST', { name: tag, description: 'Geçici duman denemesi', color: '#498f87' });
    const create = async (provider, suffix,mode='work') => {
      const a = await api('/agents', 'POST', { name: `${tag} ${suffix}`, title: 'Deneme çalışanı', department_id: department.id,
        session_mode:mode, runner: provider, model: initial.runtime.models[provider][0] || (provider === 'codex' ? 'gpt-6.1-sol' : 'sonnet'), effort: 'low',
        prompt: 'Türkçe ve kısa cevap ver. Devredilen işi bitirince gorev_durumu kullan; gönderen ajana cevap_bekleniyor=false ile haber ver. Onay kararı geldiğinde yalnız belirtilen devam işini yap.',
        appearance: { skin: '#e9ba87', hair: '#362f42', shirt: '#3c948d', style: 'kisa' },
        policy: { inputTokenBudget:400000,sessionTurnLimit:12,sessionTokenLimit:150000,permission: provider==='claude'?'chat':'folders', commands: false, network: false, timeoutMinutes: 1, maxCalls: 30, dailyRuns: 40, dailyMinutes: 20 },
      });
      ids.push(a.id); ensure(a.tududi_state === 'ready', "Could not create the test Tududi account."); return a;
    };

    for (const provider of selected) agents.push(await create(provider, provider));
    if (agents.length === 1) agents.push(await create(selected[0], 'B'));
    const [a, b] = agents;
    for (const provider of selected) {
      const agent = agents.find((a) => a.runner === provider), memory = randomUUID(), content = 'Merhaba\n';
      await scenario(`${provider}: reply, memory write, ${provider==='codex'?"file delivery, ":''}Tududi`, async () => {
        const r = await start(agent, 'temel', { memory, content, tag },
          `hafiza_yaz ile yalnız ${memory} yaz. ${provider==='codex'?'merhaba.txt içine tam olarak Merhaba ve satır sonu yaz, teslim_et ile sahibe ver. ':''}Kendi Tududi hesabına ${tag} adlı bir görev ve aynı başlıkta içeriği Deneme olan not ekle. Sonunda kendini bir cümleyle tanıt.`);
        const result = await done(r);
        ensure(result.output.trim().length > 5, "No introduction response.");
        ensure((await api(`/agents/${agent.id}/memory`)).text === memory, "Memory write could not be verified.");
        if(provider==='codex'){
          const s = await snapshot(), file = s.runtime.artifacts.find((f) => f.run_id === r.id && f.name === 'merhaba.txt');
          ensure(file, "No file was delivered to the output panel.");
          ensure((await api(`/artifacts/${file.id}/download`, 'GET', undefined, true)).replace(/(?:\r?\n)+$/, '') === content.trimEnd(), "Incorrect delivery contents.");
        }
        const t = await api(`/agents/${agent.id}/tududi`);
        ensure(t.tasks.some((t) => t.name === tag) && t.notes.some((n) => n.title === tag && n.content.replace(/(?:\r?\n)+$/, '') === 'Deneme'), "Could not verify Tududi task/note in the agent's own account.");
      });
      await scenario(`${provider}: memory in the second run`, async () => {
        const r = await start(agent, 'hatirla', {}, 'Hafızadaki notu hafiza_oku ile oku ve yalnız o notu cevap olarak yaz.');
        ensure((await done(r)).output.includes(memory), "The second run did not recall prior memory.");
        const detail = await api(`/runs/${r.id}`);
        ensure(detail.logs.some((l) => l.kind === 'tool' && l.text.startsWith('hafiza_oku:')), "No memory read in server logs.");
      });
    }
    for (const provider of selected) {
      const agent=agents.find(a=>a.runner===provider);
      await scenario(`${provider}: tool-free recall in a persistent session and a short second input`,async()=>{
        await changeMode(agent,'persistent');
        await api(`/agents/${agent.id}/session/reset`,'POST',{});
        const memory=randomUUID();
        const first=await done(await start(agent,'oturum-ilk',{memory},`Şu bilgiyi bu konuşmada hatırla: ${memory}. Bilgiyi kısa iş notuna ve Kararlar notuna yaz. hafiza_yaz ve hafiza_oku kullanma.`));
        const before=(await api(`/agents/${agent.id}/session`)).session;
        const second=await done(await start(agent,'oturum-sonraki',{},'Bu konuşmada önceki turda verdiğim deneme bilgisini yalnız cevap olarak yaz. Hiçbir hafıza/not/geçmiş aracı kullanma.'));
        const after=(await api(`/agents/${agent.id}/session`)).session;
        ensure(before.provider_id && before.provider_id===after.provider_id,"The second turn did not resume the same provider session.");
        ensure(second.output.includes(memory),"First-turn information was not recalled without tools.");
        const logs=(await api(`/runs/${second.id}`)).logs;
        ensure(!logs.some(l=>l.kind==='tool' && /^(hafiza_oku|tududi_not_oku|tududi_ara|sohbet_gecmisi):/.test(l.text)),"Recall used a reading tool; provider history was not verified.");
        const one=JSON.parse((await api(`/runs/${first.id}`)).logs.find(l=>l.kind==='context').text),two=JSON.parse(logs.find(l=>l.kind==='context').text);
        ensure(two.karakter<one.karakter,"The second turn's new input did not shrink.");
        report(`${provider}: first/second observed input tokens ${first.usage.input_tokens || 0}/${second.usage.input_tokens || 0}; submitted text ${one.karakter}/${two.karakter} characters. ${simulated?"Tokens are simulated counters.":"Real counters include provider history and tool schemas."}`);
      });
    }
    await scenario("Owner interruption closes the process and redirects the same session",async()=>{
      const first=await start(a,'uzun',{},'En az 30 saniye bekle; işi henüz bitirme.');
      await until(async()=> {const detail=await api(`/agents/${a.id}/session`);return detail.session.provider_id && detail.logs.some(l=>l.run_id===first.id && l.kind==='diagnostic' && l.text.includes('process_start'));});
      const previous=(await api(`/agents/${a.id}/session`)).session.provider_id, memory=randomUUID();
      const msg=await api(`/agents/${a.id}/session/input`,'POST',{text:prompt('sahip-girdi',{memory},`Önceki beklemeyi bırak; yalnız ${memory} yaz.`),mode:'interrupt'});
      const next=await until(s=>s.runtime.runs.find(r=>r.message_id===msg.id));
      ensure((await done(next)).output.includes(memory),"The owner's new input did not arrive.");await exited(first);
      ensure((await api(`/agents/${a.id}/session`)).session.provider_id===previous,"Interruption changed the session identity.");
    });
    await scenario("Session renewal: write two summaries before continuing with a new identity",async()=>{
      await done(await start(a,'yenileme-sonraki',{},'Kısa bir iş notu hazırla; devamını bekle.'));
      const old=(await api(`/agents/${a.id}/session`)).session;
      await api(`/agents/${a.id}/session/renew`,'POST',{});
      const preparation=await until(s=>s.runtime.runs.find(r=>r.agent_id===a.id && r.trigger==='Oturum yenileme hazırlığı' && terminal(r)));
      ensure(preparation.state==='completed',"Summary preparation did not complete.");
      const logs=(await api(`/runs/${preparation.id}`)).logs;
      ensure(['hafiza_yaz:','is_notu_yaz:'].every(name=>logs.some(l=>l.kind==='tool'&&l.text.startsWith(name))),"Could not verify both summary writes.");
      const msg=await api(`/agents/${a.id}/session/input`,'POST',{mode:'queue',session_key:old.session_key,text:prompt('yenileme-sonraki',{},'Kısa iş notu ve bilgi notu başlıklarını kullanarak bir cümleyle devam et.')});
      await done(await until(s=>s.runtime.runs.find(r=>r.message_id===msg.id)));
      const next=(await api(`/agents/${a.id}/session`)).session;
      ensure(next.generation===old.generation+1 && next.provider_id && next.provider_id!==old.provider_id,"No new provider session was created.");
    });
    const comparisons=[];
    for(const provider of selected)await scenario(`${provider}: three session modes and the same task in 2 and 6 steps`,async()=>{
      const cases=[];
      for(const steps of [2,6])for(const mode of ['single','work','persistent'])cases.push({steps,mode,agent:await create(provider,`${provider} ${mode} ${steps}`,mode)});
      const doneMessage=async(message)=>{const r=await until(s=>{const latest=s.runtime.runs.find(r=>r.message_id===message.id);return latest && terminal(latest) && latest;});ensure(r.state==='completed',`${r.state}: ${r.reason || "Comparison work did not complete."}`);return r;};
      for(const {steps,mode,agent} of cases) {
        const memory='A3-1-doğrulanan-bilgi',detail='Deneme kayıtları: '+('aynı kaynak bilgisi, doğrulanmış örnek. '.repeat(100));
        const message=await api('/messages','POST',{recipient_type:'agent',recipient_id:agent.id,text:prompt('karsilastirma-ilk',{memory},`${steps} adımlı deneme. ${detail} Kararlar notuna ve iş notuna yalnız ${memory} bilgisini yaz; kısa cevap ver. Görevi henüz bitirme.`)});
        const runs=[await doneMessage(message)];
        const firstSession=(await api(`/agents/${agent.id}/session`)).session;
        for(let step=2;step<=steps;step++) {
          const next=await api(`/agents/${agent.id}/session/input`,'POST',{mode:'queue',text:prompt('karsilastirma-sonraki',{step},`Adım ${step}: bu işin doğrulanan kısa bilgisini cevapla. Gerekiyorsa iş notunu veya Kararlar notunu oku. is_notu_yaz ile kısa durumu koru. Görevi henüz bitirme.`)});
          const result=await doneMessage(next);
          ensure(result.output.includes(memory),"Comparison did not recall prior task information.");runs.push(result);
        }
        const lastSession=(await api(`/agents/${agent.id}/session`)).session;
        if(mode!=='single')ensure(firstSession.provider_id && firstSession.session_key===lastSession.session_key && (firstSession.provider_id===lastSession.provider_id || lastSession.renewals>firstSession.renewals),"The task's session link was lost.");
        const allRuns=(await snapshot()).runtime.runs.filter(r=>r.agent_id===agent.id && r.started_at);
        const totals=allRuns.reduce((sum,r)=>{const u=usageTotals(r.usage);for(const k of ['input_tokens','cached_input_tokens','uncached_input_tokens'])sum[k]+=u[k];return sum;},{input_tokens:0,cached_input_tokens:0,uncached_input_tokens:0});
        comparisons.push({provider,mode,steps,renewals:lastSession.renewals-firstSession.renewals,...totals,step_run_ids:runs.map(r=>r.id),runs:allRuns.map(r=>({id:r.id,trigger:r.trigger,state:r.state,...usageTotals(r.usage)}))});
        mkdirSync(archive,{recursive:true,mode:0o700});save('token-karsilastirma.json',{simulated,comparisons});
      }
      report("Provider | Mode | Steps | Total input | Cached | Uncached\n--- | --- | --- | --- | --- | ---\n"+comparisons.filter(c=>c.provider===provider).map(c=>`${c.provider==='codex' ? 'Codex' : 'Claude'} | ${{single:"Single run",work:"Per task",persistent:"Persistent"}[c.mode]} | ${c.steps} | ${c.input_tokens} | ${c.cached_input_tokens} | ${c.uncached_input_tokens}`).join('\n'));
      report(simulated ? "Simulated counters do not prove real token savings or price differences." : "Real provider counters; savings are not proven without a decrease.");
    });
    await scenario("Handoff, completion and sender notification", async () => {
      const r = await start(a, 'devir', { to: b.id, tag }, `${b.id} ajanına gorev_devret ile ${tag} başlıklı kısa bir iş ver: bir cümlelik selam, gorev_durumu ile bitirme ve bana mesaj_gonder ile haber verme.`, 2);
      await done(r);
      const child = await until((s) => s.runtime.runs.find((x) => x.chain_id === r.chain_id && x.agent_id === b.id && terminal(x)));
      ensure(child.state === 'completed' && child.depth === 1, "Incorrect handoff run or chain depth.");
      const s = await snapshot();
      ensure(s.handoffs.some((h) => h.from_agent_id === a.id && h.to_agent_id === b.id && h.title === tag && h.status === 'completed'), "The handed-off task did not complete.");
      ensure(s.messages.some((m) => m.sender_agent_id === b.id && m.recipient_id === a.id), "The sending agent was not notified.");
    });
    await scenario("File handoff: recipient reads and delivers the incoming file", async () => {
      const content = `Dondurulmuş devir ${randomUUID()}`;
      const r = await start(a, 'dosyali-devir', { to: b.id, tag, content },
        `Kendi klasöründe inceleme.txt dosyasına tam olarak ${content} yaz. ${b.id} ajanına gorev_devret ile ${tag} dosyalı başlığını ve dosyalar=[inceleme.txt] ver. Alıcıya gelen dosyayı okuyup aynı baytları kendi okunan.txt dosyasına yazmasını, teslim_et ile vermesini ve gorev_durumu ile bitirmesini söyle. Devirden sonra kendi inceleme.txt dosyanı Sonradan değişti olarak değiştir.`, 2);
      await done(r);
      const child = await until((s) => s.runtime.runs.find((x) => x.chain_id === r.chain_id && x.agent_id === b.id && terminal(x)));
      ensure(child.state === 'completed', "The file-handoff recipient did not complete.");
      const s = await snapshot(), file = s.runtime.artifacts.find((f) => f.run_id === child.id && f.name === 'okunan.txt');
      ensure(file, "The recipient did not deliver the file it read.");
      ensure((await api(`/artifacts/${file.id}/download`, 'GET', undefined, true)) === content, "The recipient did not read the frozen bytes.");
      const detail = await api(`/runs/${r.id}`);
      ensure(detail.logs.some((l) => l.kind === 'tool' && l.text.startsWith('gorev_devret:') && l.text.includes('dosyalar')), "No file handoff in server tool logs.");
    },a.runner==='codex' && b.runner==='codex');
    await scenario("Unlinked file approval and continuation after approval/rejection", async () => {
      const r = await start(a, 'onay', { tag }, `ek.txt dosyasına Deneme yaz. Bağlantı vermeden onay_iste ile ${tag} başlığı ve dosyalar=[ek.txt] iste. Ayrıntıya şu devam planını yaz: onay gelince hafiza_yaz ile ONAY yaz ve ${tag} Ret başlıklı ikinci genel onay iste; ret gelince hafiza_yaz ile RET yaz ve cevap ver.`, 3);
      await done(r, 'waiting');
      const card = await until((s) => s.runtime.approvals.find((x) => x.run_id === r.id && x.state === 'pending'));
      ensure(!card.link_id && card.files.length === 1, "Missing unlinked file attachment.");
      ensure((await api(`/approvals/${card.id}/files/0`, 'GET', undefined, true)).replace(/(?:\r?\n)+$/, '') === 'Deneme', "Incorrect frozen approval attachment.");
      await api(`/approvals/${card.id}/decision`, 'POST', { approved: true, note: `hafiza_yaz ile ONAY yaz; ${tag} Ret başlıklı ikinci genel onay iste. Ret gelince hafiza_yaz ile RET yaz ve bitir.` });
      const rejection = await until((s) => s.runtime.approvals.find((x) => x.agent_id === a.id && x.id !== card.id && x.state === 'pending'));
      ensure((await api(`/agents/${a.id}/memory`)).text.trim() === 'ONAY', "Work did not resume after approval.");
      await api(`/approvals/${rejection.id}/decision`, 'POST', { approved: false, note: 'hafiza_yaz ile RET yaz ve bitir; yeniden onay isteme.' });
      await until((s) => s.runtime.runs.find((x) => x.chain_id === r.chain_id && x.trigger === 'Kullanıcının onay kararı' && x.state === 'completed'));
      ensure((await api(`/agents/${a.id}/memory`)).text.trim() === 'RET', "Work did not resume after rejection.");
    },a.runner==='codex');
    await scenario("Folder reading and approved copying", async () => {
      ensure(roots.length, "OFIS_ALLOWED_ROOTS has no allowed root for test folders.");
      mkdirSync(roots[0], { recursive: true }); folders = mkdtempSync(join(roots[0], 'ofis-duman-'));
      const read = join(folders, 'oku'), write = join(folders, 'yaz'); mkdirSync(read); mkdirSync(write);
      const marker = randomUUID(); writeFileSync(join(read, 'kaynak.txt'), marker); writeFileSync(join(write, 'sonuc.txt'), 'Eski');
      for (const [name, path, access] of [['Okuma', read, 'read'], ['Onaylı yazma', write, 'write']]) {
        const l = await api('/links', 'POST', { name: `${tag} ${name}`, path, access, approved_write: true, agent_ids: [a.id] }); links.push(l.id);
      }
      await until((s) => links.every((id) => s.runtime.links.find((l) => l.id === id)?.validation === 'valid'), "The runner did not validate temporary folders.");
      const r = await start(a, 'klasor', { read, write, link: links[1] },
        `${read}/kaynak.txt dosyasını oku, içeriğini kendi klasöründe sonuc.txt olarak yaz. Sonra onay_iste baglanti=${links[1]}, dosyalar=[sonuc.txt] ile iste. Karardan sonra kısa cevap ver.`, 2);
      await done(r, 'waiting');
      ensure(readFileSync(join(write, 'sonuc.txt'), 'utf8') === 'Eski', "The destination changed before approval.");
      ensure(readFileSync(join(read, 'kaynak.txt'), 'utf8') === marker, "The read-only source changed.");
      const s=await snapshot();
      const card = s.runtime.approvals.find((x) => x.run_id === r.id && x.link_id === links[1]); ensure(card, "Missing write approval.");
      const frozen = await api(`/approvals/${card.id}/files/0`, 'GET', undefined, true);
      ensure(frozen.trim() === marker, "Source contents are missing from the approval attachment.");
      await api(`/approvals/${card.id}/decision`, 'POST', { approved: true, note: 'Dondurulan içerik kopyalansın; sonra bitir.' });
      await until((s) => s.runtime.approvals.find((x) => x.id === card.id)?.state === 'applied');
      ensure(readFileSync(join(write, 'sonuc.txt'), 'utf8') === frozen, "Frozen approved bytes were not copied exactly.");
      await until((s) => s.runtime.runs.some((x) => x.chain_id === r.chain_id && x.state === 'completed'));
    },a.runner==='codex');
    await scenario("Unapproved folder writes: direct operating-system probe",async()=>{
      ensure(!simulated,"Fake CLIs cannot prove operating-system write denial.");
      const s=await snapshot(),folder=s.runtime.links.find(l=>l.id===links[1]);ensure(folder,"Approved-write link not found.");
      const {approvedWriteSmoke}=await import('../dist/runner/src/isolation-smoke.js');
      approvedWriteSmoke({agent:a,workDir,folder});
    },a.runner==='codex');
    // No provider call: run actual sandbox shells on the host using the very same command/mount builder.
    await scenario("Isolation probes: files, writes and network", async () => {
      ensure(!simulated, "Fake CLIs cannot prove file/network isolation; run a real check.");
      const { isolationSmoke } = await import('../dist/runner/src/isolation-smoke.js');
      await isolationSmoke({ agent: a, other: b, repo, home: homedir(), workDir });
    },a.runner==='codex');
    await scenario("Stop and child-process exit", async () => {
      const r = await start(a, 'uzun', {}, 'Kısa bir çalışma planı yaz.');
      await until(async (s) => {
        if (!s.runtime.runs.some((x) => x.id === r.id && x.state === 'running')) return false;
        const d = await api(`/runs/${r.id}`);
        return d.logs.some((l) => l.kind === 'diagnostic' && l.text.includes('"olay":"process_start"') && /"pid":\d+/.test(l.text));
      }, "No real child process started; stop could not be tested.");
      await api(`/agents/${a.id}/stop`, 'POST');
      await done(r, 'stopped'); await exited(r);
    });
    await scenario("Short timeout and process exit", async () => {
      ensure((await snapshot()).runtime.smoke === true, "Enable OFIS_SMOKE=1 in the runner; timeout was not verified.");
      const r = await start(a, 'sure', {}, 'Bir cümleyle kendini tanıt.', 1, 0.01);
      const result = await done(r, 'failed'); ensure(/süre.*aşıldı/.test(result.reason), "The failure was not a timeout."); await exited(r);
      const detail = await api(`/runs/${r.id}`);
      ensure(detail.logs.some((l) => l.kind === 'diagnostic' && l.text.includes('"olay":"smoke_timeout"')), "No evidence that the short timeout was enforced.");
      ensure(detail.logs.some((l) => l.kind === 'diagnostic' && l.text.includes('"olay":"process_exit"') && l.text.includes('"signal":"SIGKILL"')), "The process was not killed on timeout.");
    });
    await scenario("Chain brake between two agents", async () => {
      const r = await start(a, 'zincir', { to: b.id, back: a.id }, `${b.id} ajanına gorev_devret ile tek iş ver: ilk sonucu yazıp ${a.id} ajanına inceleme için bir kez devretsin. Döngü kurma; bu iki adımlı meşru devir sınır denemesidir.`, 2);
      await done(r);
      await until((s) => s.runtime.runs.find((x) => x.chain_id === r.chain_id && x.agent_id === b.id && terminal(x)));
      const s = await snapshot(), chain = s.runtime.runs.filter((x) => x.chain_id === r.chain_id);
      ensure(chain.length === 2 && Math.max(...chain.map((x) => x.depth)) === 1, "The chain brake did not stop after two runs.");
      const warning = s.runtime.stoppedChains?.find((c) => c.id === r.chain_id);
      ensure(warning && s.events.some((e) => e.id === warning.event_id && e.kind === 'runtime_notice')
        && s.messages.some((m) => m.id === warning.message_id && m.sender_type === 'system' && m.owner_only), "Could not verify the server chain brake, owner message and panel warning.");
    });
  } catch (error) {
    rows.push({ senaryo: "Smoke preparation or run limit", sonuc: "FAIL", tani: error.message });
  } finally {
    const errors = [];
    // Stop only the objects created during this invocation, including --keep runs.
    for (const id of ids) try { await api(`/agents/${id}/stop`, 'POST'); } catch { errors.push("Could not stop a test agent."); }
    let processesStopped = !errors.length;
    if (processesStopped && ids.length) {
      try {
        // Do not delete a run before its heartbeat stop instruction reaches the worker.
        const end = Date.now() + 15000;
        for (;;) {
          const s = await snapshot();
          const runs = s.runtime.runs.filter((r) => ids.includes(r.agent_id) && r.started_at);
          const details = await Promise.all(runs.map((r) => api(`/runs/${r.id}`)));
          if (details.every((d) => d.logs.some((l) => l.kind === 'diagnostic' && /"olay":"process_(?:exit|not_started)"/.test(l.text)))) break;
          ensure(Date.now() < end, "Could not verify child-process termination.");
          await pause(200);
        }
      } catch { processesStopped = false; errors.push("Process exits could not be verified; stop records retained."); }
    }
    let archived = false;
    try {
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      const s = await snapshot();
      for (const r of s.runtime.runs.filter((r) => ids.includes(r.agent_id))) {
        const detail = await api(`/runs/${r.id}`);
        save(r.id + '.json', detail);
      }
      save('sonuclar.json', { simulated, rows });
      archived = true;
    } catch { errors.push("Run transcripts could not be archived; nothing was deleted."); }
    const retry = async (path, method, body) => {
      const end = Date.now() + cleanupTimeoutMs;
      for (let attempt = 0; ; attempt++) {
        try { return await api(path, method, body); }
        catch (error) {
          if (method === 'DELETE' && error.status === 404) return;
          if (attempt >= 3 || Date.now() >= end) throw error;
          const delay = error.retryAfterMs || Math.min(5000, 500 * 2 ** attempt);
          if (Date.now() + delay > end) throw error;
          await pause(delay);
        }
      }
    };
    if (!keep && processesStopped && archived) {
      for (const id of links) try { await retry(`/links/${id}`, 'DELETE'); } catch { errors.push(`Could not delete test link: ${id}`); }
      for (const id of [...ids].reverse()) try { await retry(`/agents/${id}?account=delete&profile=delete`, 'DELETE'); } catch { errors.push(`Could not delete test agent: ${id}`); }
      if (department) try { await retry(`/departments/${department.id}`, 'DELETE'); } catch { errors.push(`Could not delete test department: ${department.id}`); }
      try {
        const end = Date.now() + cleanupTimeoutMs;
        while ((await snapshot()).runtime.pendingDeletions?.some((d) => ids.includes(d.id))) {
          await retry('/tududi-deletions/retry', 'POST');
          const pending = (await snapshot()).runtime.pendingDeletions.filter((d) => ids.includes(d.id));
          if (!pending.length) break;
          const delay = Math.max(200, Math.min(...pending.map((d) => d.next_at)) - Date.now());
          if (Date.now() + delay > end) throw new Error('Hesap silme sonraki denemeyi bekliyor.');
          // Short waits keep interruption and progress reporting responsive.
          await pause(Math.min(1000, delay));
        }
      } catch { errors.push('Tududi hesap silmeleri bekliyor.'); }
      try {
      const remaining = await snapshot();
      if (remaining.agents.some((a) => ids.includes(a.id))) errors.push("Test agents remain.");
      // Remove only this invocation's directories and preserve failed-work evidence above.
      if (!remaining.agents.some((a) => ids.includes(a.id)) && !remaining.runtime.links.some((l) => links.includes(l.id))) {
        if (folders) rmSync(folders, { recursive: true, force: true });
        if (workDir) for (const id of ids) { rmSync(join(workDir, 'ofis', id), { recursive: true, force: true }); rmSync(join(workDir,'.oturum',id),{recursive:true,force:true}); }
      }
      } catch { errors.push("Could not verify remaining records or test-folder cleanup."); }
    }
    let leftovers;
    try {
      const s = await snapshot();
      leftovers = { ajanlar: s.agents.filter((a) => ids.includes(a.id)).map((a) => ({ id: a.id, ad: a.name })),
        hesaplar: (s.runtime.pendingDeletions || []).filter((d) => ids.includes(d.id)),
        baglantilar: s.runtime.links.filter((l) => links.includes(l.id)).map((l) => ({ id: l.id, ad: l.name })),
        bolumler: s.departments.filter((d) => d.id === department?.id).map((d) => ({ id: d.id, ad: d.name })),
        klasorler: [folders, ...ids.map((id) => workDir && join(workDir, 'ofis', id))].filter((p) => p && existsSync(p)) };
      if (!keep && Object.values(leftovers).some((items) => items.length)) errors.push("Remaining test records and folders are listed below.");
    } catch { errors.push("Could not verify remaining records."); leftovers = { dogrulanamadi: true }; }
    if (errors.length) rows.push({ senaryo: 'Temizlik', sonuc: "FAIL", tani: errors.join(' ') });
    if (archived) try { save('sonuclar.json', { simulated, rows, leftovers }); } catch { rows.push({ senaryo: "Archive result", sonuc: "FAIL", tani: "Could not write the final cleanup list." }); }
    report(`Run transcripts: ${archive}`);
    report('Kalanlar: ' + mask(JSON.stringify(leftovers)));
    report(`Total runs: ${runIds.size}. ${keep ? "Temporary department/agents/accounts/links retained with --keep." : "Temporary-record deletion requested."}`);
    report("Scenario | Result | Duration (s) | Tokens\n--- | --- | --- | ---\n" + rows.map((r) => `${r.senaryo} | ${r.sonuc} | ${r.saniye || '-'} | ${r.token || 0}`).join('\n'));
    for (const r of rows.filter((r) => r.tani)) report(`${r.senaryo} diagnostics: ${r.tani}`);
  }
  return rows;
}

export async function main(argv = process.argv.slice(2)) {
  let runner = 'codex', keep = false, ofisUrl='http://127.0.0.1:9401', workDir='',live=false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runner') runner = argv[++i];
    else if (argv[i] === '--keep') keep = true;
    else if(argv[i]==='--ofis-url')ofisUrl=argv[++i];
    else if(argv[i]==='--work-dir')workDir=argv[++i];
    else if(argv[i]==='--canli')live=true;
    else throw new Error("Usage: npm run smoke:real -- --runner codex|claude|all --work-dir /separate/work-root [--ofis-url http://127.0.0.1:9401] [--canli] [--keep]");
  }
  ensure(['codex', 'claude', 'all'].includes(runner), "--runner must be codex, claude or all.");
  const parsedUrl=new URL(ofisUrl);
  ensure(parsedUrl.origin===ofisUrl && parsedUrl.hostname==='127.0.0.1' && parsedUrl.protocol==='http:' && ['9400','9401'].includes(parsedUrl.port),"Only Office at 127.0.0.1:9400/9401 is allowed.");
  ensure(parsedUrl.port==='9401' || live,"Live Office access explicitly requires --canli.");
  ensure(workDir.startsWith('/') && resolve(workDir).startsWith(repo+'/'),"--work-dir must be a separate absolute work root inside this repository.");
  const usingLiveOffice=parsedUrl.port==='9400';
  const office = envFile(join(repo, usingLiveOffice?'office/.env':'office/.env.test')), config = envFile(join(repo, usingLiveOffice?'runner/.env':'runner/.env.test'));
  const roots=(config.OFIS_ALLOWED_ROOTS || '').split(':').filter(Boolean);
  if(!usingLiveOffice)ensure(roots.every(p=>resolve(p)===resolve(repo,'runner/test-code')),"Test Office allowed folders must be limited to runner/test-code.");
  ensure(resolve(workDir)===resolve(config.OFIS_WORK_DIR || ''),"Test work root must match the runner setting.");
  ensure(existsSync(workDir) && realpathSync(workDir)===resolve(workDir),"Create the work root first; symlinks are not allowed.");
  ensure(roots.every(p=>existsSync(p) && realpathSync(p)===resolve(p)),"Create allowed test roots first; symlinks are not allowed.");
  if(!usingLiveOffice){const current=envFile(join(repo,'runner/.env'));ensure(!current.OFIS_WORK_DIR || resolve(workDir)!==resolve(current.OFIS_WORK_DIR),"The test work root cannot be shared with the live runner.");}
  // Only this dedicated runner configuration is inherited by the offline sandbox probes.
  for (const [key, value] of Object.entries(config)) if (key.startsWith('OFIS_')) process.env[key] = value;
  ensure(office.OFIS_OWNER_PASSWORD, "Owner password not found in office/.env.");
  ensure((office.TUDUDI_BASE_URL || 'http://127.0.0.1:9393') === 'http://127.0.0.1:9393', "Smoke tests require the separate agent Tududi instance on 9393.");
  const secrets = Object.entries({ ...office, ...config }).filter(([k]) => /key|password|secret|token/i.test(k)).map(([, v]) => v);
  let cookie = '';
  const api = async (path, method = 'GET', body, asText = false) => {
    ensure(path.startsWith('/') && !path.startsWith('//'), "Invalid Office path.");
    if (method === 'POST' && body === undefined) body = {};
    const response = await fetch(ofisUrl+'/api' + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Ofis-Islem': '1', 'X-Ofis-Duman': '1', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (path === '/login') { cookie = (response.headers.get('set-cookie') || '').split(';')[0]; secrets.push(cookie.split('=').slice(1).join('=')); }
    const text = await response.text();
    if (!response.ok) { let message = "Office request failed."; try { message = JSON.parse(text).error || message; } catch {} const error = new Error(withoutSecrets(message, secrets)); error.status = response.status; const wait = response.headers.get('retry-after'); error.retryAfterMs = wait && /^\d+$/.test(wait) ? Number(wait) * 1000 : wait ? Math.max(0, Date.parse(wait) - Date.now()) : 0; throw error; }
    return asText ? text : JSON.parse(text);
  };
  await api('/login', 'POST', { password: office.OFIS_OWNER_PASSWORD });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const rows = await runSmoke({ api, runner, keep, signal: controller.signal, roots,
      workDir:resolve(workDir), mask: (text) => withoutSecrets(text, secrets), report: (text) => console.log(withoutSecrets(text, secrets)) });
    process.exitCode = rows.some((r) => r.sonuc === "FAIL") ? 1 : 0;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); await api('/logout', 'POST').catch(() => {}); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error("Smoke failed: " + String(error?.message || '').slice(0, 300).replace(/[A-Za-z0-9_-]{24,}/g, '***')); process.exitCode = 1; });
