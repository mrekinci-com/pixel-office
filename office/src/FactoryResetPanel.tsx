import { useEffect, useRef, useState } from 'react';
import { resetCountLabels, type ResetView } from '../shared/factory-reset';
import { api } from './api';
import { t as tx, useLanguage } from './i18n';
import type { Perform } from './chat/ChatPanel';
export function FactoryResetPanel({ value, onChange, onPreview, perform, disabled, onRunning }: {
    value: ResetView;
    onChange: (value: ResetView) => void;
    onPreview: () => void;
    perform: Perform;
    disabled: boolean;
    onRunning: (running: boolean) => void;
}) {
    const language = useLanguage();
    const [confirmation, setConfirmation] = useState('');
    const [running, setRunning] = useState(false);
    const runningNow = useRef(false);
    const settled = useRef(false);
    const word = language === 'en' ? 'RESET' : 'SIFIRLA';
    useEffect(() => setConfirmation(''), [language, value.id]);
    useEffect(() => { settled.current = false; }, [value.id]);
    useEffect(() => {
        // A new page can resume watching an execute request still running on the server.
        if (!running && (!['quiescing', 'deleting'].includes(value.state) || value.error))
            return;
        let alive = true, pending = false;
        const timer = setInterval(() => {
            if (pending)
                return;
            pending = true;
            void api<ResetView>(`/factory-reset/${value.id}`).then(next => {
                if (alive && !settled.current) {
                    if (next.state === 'completed' || next.state === 'partial' && !runningNow.current) settled.current = true;
                    onChange(next);
                }
            }).catch(() => { }).finally(() => { pending = false; });
        }, 400);
        return () => { alive = false; clearInterval(timer); };
    }, [running, value.id, value.state, value.error, onChange]);
    const execute = () => void perform(async () => {
        settled.current = false;
        runningNow.current = true;
        setRunning(true);
        onRunning(true);
        try {
            const next = await api<ResetView>(`/factory-reset/${value.id}/execute`, 'POST', { confirmation });
            settled.current = true;
            onChange(next);
            setConfirmation('');
        }
        catch (error) {
            settled.current = true;
            onChange(await api<ResetView>(`/factory-reset/${value.id}`));
            throw error;
        }
        finally {
            runningNow.current = false;
            setRunning(false);
            onRunning(false);
        }
    });
    const working = running || value.state === 'quiescing' || value.state === 'deleting';
    const stateLabels = { preview: 'Önizleme', quiescing: 'Çalışmaların durması bekleniyor', deleting: 'Kayıtlar temizleniyor', partial: 'Bazı kayıtlar kaldı', completed: 'Sıfırlama tamamlandı' };
  return <div className="factory-reset-panel">
    <p className="hint">{tx('Bu işlem geri alınamaz. Önce kapsamı ve yedeği inceleyin.')}</p>
    {value.backupReady && <a className="secondary reset-backup" href={`/api/factory-reset/${value.id}/backup`} download="sifirlama-yedegi.json">{tx('Yedeği indir')}</a>}
    <p className="reset-scope">{value.scope}</p>
    <p className="reset-status" role="status" aria-live="polite">{tx(stateLabels[value.state])}</p>
    {working && <>
      <progress max={value.agents.length || 1} value={value.state === 'deleting' ? value.results?.length || 0 : undefined} aria-label={tx('Sıfırlama ilerlemesi')}/>
      <p>{tx('{0} / {1} ajanın sonucu hazır.', [value.results?.length || 0, value.agents.length])}</p>
    </>}
    <div className="reset-agents">
      {value.agents.map(agent => {
            const result = value.results?.find(r => r.id === agent.id);
            return <section className="reset-agent" key={agent.id} aria-label={agent.name}>
          <h3>{agent.name}</h3>
          <details open={!value.results}>
            <summary>{tx('Önizlemedeki kayıt sayıları')}</summary>
            <dl className="reset-counts">{Object.entries(agent.counts).map(([kind, count]) => <div key={kind}><dt>{tx(resetCountLabels[kind])}</dt><dd>{count}</dd></div>)}</dl>
          </details>
          {result && <div className="reset-result">
            <p><strong>{result.ok ? tx('Temizlendi') : tx('Bazı kayıtlar kaldı')}</strong></p>
            {result.counts ? <dl className="reset-counts">{Object.entries(result.counts).map(([kind, count]) => <div key={kind}><dt>{tx('Kalan {0}', [tx(resetCountLabels[kind])])}</dt><dd>{count}</dd></div>)}</dl> : <p>{tx('Kalan kayıt sayısı doğrulanamadı. Bağlantıyı kontrol edin.')}</p>}
            {result.remaining.length > 0 && <ul>{result.remaining.map((text, i) => <li key={i}>{text}</li>)}</ul>}
          </div>}
        </section>;
        })}
    </div>
    {value.error && <p className="hint" role="alert">{value.error}</p>}
    {value.state !== 'completed' && <>
      <p>{tx('Silme başladıktan sonra ofis tamamlanana kadar duraklar. Pencereyi kapatmak işlemi iptal etmez.')}</p>
      <label>{tx('Onay için {0} yazın', [word])}<input className="reset-confirmation" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" spellCheck={false} disabled={running}/></label>
      <div className="modal-actions">
        {value.state === 'preview' && <button className="secondary" disabled={disabled || running} onClick={onPreview}>{tx('Yeni önizleme al')}</button>}
        <button className="danger-button" disabled={disabled || running || confirmation !== word} onClick={execute}>{running ? tx('Sıfırlama sürüyor…') : value.state === 'preview' ? tx('Onayla ve sıfırla') : tx('Yalnız kalanları tekrar dene')}</button>
      </div>
    </>}
  </div>;
}
