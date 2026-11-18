import { useEffect, useState } from 'react';
import type { Result } from '../../server/src/types';
import { api, getResult, type SiteConfig } from './api';
import { Bang, Check, Chip, Foot, Head, go, when } from './ui';

export function ResultBody({ r }: { r: Result }) {
  const showIt = r.fixes.some((f) => f.link === 'it');
  const [itOpen, setItOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const itText = r.it.map((l) => `${l.state === 'blocked' ? '[BLOCKED] ' : l.state === 'open' ? '[OPEN]    ' : ''}${l.text}`).join('\n');
  return (
    <>
      <section className={`wrap card raised verdict ${r.verdict}`}>
        <div className="l">
          <span className={`mark ${r.verdict}`} aria-hidden="true">{r.verdict === 'good' ? <Check /> : <Bang />}</span>
          <div><h1>{r.headline}</h1><p>{r.sub}</p></div>
        </div>
        <div className="r">
          <small>Result code</small>
          <div className="code">{r.code}</div>
          <small>{when(r.at)} · {r.sent ? 'Sent to Stitch support' : 'Read this code to Stitch support'}</small>
        </div>
      </section>

      <section className="wrap tiles">
        <div className="card tile">
          <small>Calls at once</small>
          <b>{r.calls != null ? `${r.calls.toLocaleString()}${r.callsAtLeast ? '+' : ''}` : '–'}</b>
          <span className="t">{r.calls == null ? 'The speed test did not run' : r.video && r.video > 0 ? `or ${r.video}${r.callsAtLeast ? '+' : ''} ${r.video === 1 ? 'person' : 'people'} on video at the same time` : "Video isn't recommended on this line"}</span>
        </div>
        <div className="card tile">
          <small>Call quality score</small>
          <b>{r.score != null ? r.score.toFixed(1) : '–'}{r.score != null ? <span> of 5</span> : null}</b>
          <span className="t">{r.scoreText}</span>
        </div>
        <div className="card tile">
          <small>Nearest Stitch region</small>
          <b>{r.nearest ? r.nearest.ms : '–'}{r.nearest ? <span> ms</span> : null}</b>
          <span className="t">{r.nearest ? `${r.nearest.id}${r.provider ? `, on ${r.provider}` : ''}` : 'No region answered'}</span>
        </div>
      </section>

      {r.fixes.length ? (
        <section className="wrap fixes">
          <h2>{r.fixes.length === 1 ? 'What to fix' : 'What to fix, most important first'}</h2>
          {r.fixes.map((f, i) => (
            <div key={f.id} className="card fix">
              <span className="n" aria-hidden="true">{i + 1}</span>
              <div className="b">
                <div className="h"><h3>{f.title}</h3><Chip grade={f.grade} /></div>
                <p className="why">{f.why}</p>
                <p><strong>Do this:</strong> {f.action}</p>
              </div>
              {f.link === 'it' ? <a className="btn noprint" href="#it-list" style={{ flex: 'none' }} onClick={() => setItOpen(true)}>See the list</a> : null}
            </div>
          ))}
        </section>
      ) : null}

      {showIt || itOpen ? (
        <section id="it-list" className="wrap card it">
          <div className="top">
            <div><h2>For your IT person</h2><p>What Stitch needs through the firewall. {r.it.some((l) => l.state === 'blocked') ? 'What this test found blocked is marked.' : ''}</p></div>
            <button className="btn sm quiet" type="button" onClick={() => { void navigator.clipboard?.writeText(itText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <pre>{r.it.map((l, i) => (
            <div key={i}>{l.state === 'blocked' ? <><mark className="blocked">BLOCKED</mark>{'  '}</> : l.state === 'open' ? <><mark className="open">OPEN</mark>{'     '}</> : null}{l.text}</div>
          ))}</pre>
        </section>
      ) : null}

      <section className="wrap groups">
        {r.groups.map((g) => (
          <div key={g.id} className="card group">
            <div className="gh"><h2>{g.title}</h2>{g.grade ? <Chip grade={g.grade} /> : null}</div>
            {g.rows.map((row) => <div key={row.label} className="gr"><span>{row.label}</span><span className={row.grade ?? ''}>{row.value}</span></div>)}
          </div>
        ))}
      </section>
      {!showIt && !itOpen ? <div className="wrap noprint"><button className="btn sm quiet" type="button" onClick={() => setItOpen(true)}>Show the firewall list for your IT person</button></div> : null}
    </>
  );
}

export function ResultPage({ cfg, code, fresh, again }: { cfg: SiteConfig | null; code: string; fresh: Result | null; again: string }) {
  const [r, setR] = useState<Result | null>(fresh);
  const [err, setErr] = useState<string | null>(null);
  const [mailing, setMailing] = useState(false);
  const [email, setEmail] = useState('');
  const [mailState, setMailState] = useState<{ ok?: boolean; msg?: string; busy?: boolean }>({});
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (fresh && fresh.code === code) { setR(fresh); return; }
    setR(null); setErr(null);
    getResult(code).then(setR).catch((e) => setErr(e.message));
  }, [code, fresh]);
  useEffect(() => { document.title = r ? `${r.headline} · Stitch Network Test` : 'Stitch Network Test'; }, [r]);
  const who = r?.company ? `${r.company}${r.office ? ` · ${r.office}` : ''}` : null;
  const send = async (e: React.FormEvent) => {
    e.preventDefault(); setMailState({ busy: true });
    try { await api(`/api/results/${code}/email`, { body: { email } }); setMailState({ ok: true, msg: `Sent to ${email}.` }); }
    catch (x) { setMailState({ ok: false, msg: (x as Error).message }); }
  };
  return (
    <div className="page">
      <Head cfg={cfg} right={who ? <span className="who">{who}</span> : undefined} />
      <main className="main">
        {err ? (
          <section className="wrap card" style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
            <h1 style={{ fontSize: 28, fontWeight: 800 }}>We couldn't find that result</h1>
            <p style={{ color: 'var(--ink2)' }}>{err}</p>
            <button className="btn primary" type="button" onClick={() => go('/')}>Run a new test</button>
          </section>
        ) : !r ? <p className="who">Loading the result.</p> : (
          <>
            <ResultBody r={r} />
            <section className="wrap actions">
              {r.verdict === 'good' ? null : <button className="btn primary" type="button" onClick={() => go(again)}>Test again</button>}
              {cfg?.email ? <button className={`btn ${r.verdict === 'good' ? 'primary' : ''}`} type="button" onClick={() => setMailing((v) => !v)}>Email me a copy</button> : null}
              <button className="btn" type="button" onClick={() => window.print()}>Download PDF</button>
              <button className="btn" type="button" onClick={() => { void navigator.clipboard?.writeText(`${location.origin}/r/${r.code}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}>{copied ? 'Link copied' : 'Copy link to this result'}</button>
              <span className="grow" />
              {r.verdict === 'good' ? <button className="btn quiet" type="button" onClick={() => go(again)}>Test again</button> : null}
            </section>
            {mailing ? (
              <form className="wrap card mailbox" onSubmit={send}>
                <label htmlFor="mail" style={{ fontWeight: 600, fontSize: 15 }}>Where should we send it?</label>
                <input id="mail" className="field" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
                <button className="btn primary" type="submit" disabled={mailState.busy}>{mailState.busy ? 'Sending' : 'Send'}</button>
                {mailState.msg ? <span className={mailState.ok ? '' : 'err'} role="status" style={{ flexBasis: '100%', fontSize: 14 }}>{mailState.msg}</span> : null}
              </form>
            ) : null}
            <p className="wrap credit">Provider and place names come from <a href="https://db-ip.com">IP Geolocation by DB-IP</a>.</p>
          </>
        )}
      </main>
      <Foot cfg={cfg} />
    </div>
  );
}
