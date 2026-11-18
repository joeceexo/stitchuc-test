import { useCallback, useEffect, useState } from 'react';
import type { Result, StaffDetail } from '../../server/src/types';
import { api, type SiteConfig, type StaffLink, type StaffRow } from './api';
import { Chip, Head, go, when } from './ui';

const verdictWord = { good: 'Ready', fair: 'Some trouble', poor: 'Problems' } as const;

export function Staff({ cfg }: { cfg: SiteConfig | null }) {
  const [me, setMe] = useState<{ staff: boolean; enabled: boolean } | null>(null);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'tests' | 'links'>('tests');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [keep, setKeep] = useState(90);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ result: Result; staff: StaffDetail } | null>(null);
  const [links, setLinks] = useState<StaffLink[]>([]);
  const [company, setCompany] = useState('');
  const [office, setOffice] = useState('');
  const [made, setMade] = useState<StaffLink | null>(null);
  const [tie, setTie] = useState({ company: '', office: '' });
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { document.title = 'Network tests · Stitch'; api<{ staff: boolean; enabled: boolean }>('/api/staff/me').then(setMe).catch(() => setMe({ staff: false, enabled: false })); }, []);
  const load = useCallback(() => {
    api<{ tests: StaffRow[]; keepDays: number }>(`/api/staff/tests?q=${encodeURIComponent(q)}`).then((r) => { setRows(r.tests); setKeep(r.keepDays); }).catch((e) => setErr(e.message));
    api<{ links: StaffLink[] }>('/api/staff/links').then((r) => setLinks(r.links)).catch(() => {});
  }, [q]);
  useEffect(() => { if (me?.staff) { const t = setTimeout(load, 200); return () => clearTimeout(t); } }, [me, load]);
  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    api<{ result: Result; staff: StaffDetail }>(`/api/staff/tests/${sel}`).then((d) => { setDetail(d); setTie({ company: d.result.company ?? '', office: d.result.office ?? '' }); }).catch((e) => setErr(e.message));
  }, [sel]);
  const copy = (text: string, key: string) => { void navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 2000); }); };

  if (!me) return <div className="page"><Head cfg={cfg} /></div>;
  if (!me.staff) {
    return (
      <div className="page">
        <Head cfg={cfg} />
        <main className="main">
          <form className="card raised login" onSubmit={async (e) => {
            e.preventDefault(); setErr(null);
            try { await api('/api/staff/login', { body: { password: pw } }); setMe({ staff: true, enabled: true }); } catch (x) { setErr((x as Error).message); }
          }}>
            <h1 style={{ fontSize: 26, fontWeight: 800 }}>Stitch staff</h1>
            {me.enabled ? (
              <>
                <label htmlFor="pw" style={{ fontSize: 15, fontWeight: 600 }}>Staff password</label>
                <input id="pw" className="field" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
                <button className="btn primary" type="submit">Sign in</button>
              </>
            ) : <p style={{ color: 'var(--ink2)' }}>The staff view isn't set up on this server yet (NETTEST_STAFF_PASSWORD).</p>}
            {err ? <p className="err" role="alert">{err}</p> : null}
          </form>
        </main>
      </div>
    );
  }

  const d = detail;
  const lossBars = d ? d.staff.samples.map((s) => (s.sentUp > 0 ? (s.lostUp / s.sentUp) * 100 : 0)) : [];
  const maxLoss = Math.max(5, ...lossBars);
  return (
    <div className="page">
      <div className="staff">
        <nav className="side" aria-label="Staff">
          <div className="b"><b>Stitch</b><span>Network Test</span></div>
          <button type="button" className={tab === 'tests' ? 'on' : ''} onClick={() => setTab('tests')}>Network tests</button>
          <button type="button" className={tab === 'links' ? 'on' : ''} onClick={() => setTab('links')}>Support links</button>
          <button type="button" onClick={() => go('/')}>Run a test</button>
          <button type="button" onClick={async () => { await api('/api/staff/logout', { method: 'POST' }); setMe({ staff: false, enabled: true }); }}>Sign out</button>
        </nav>
        <main className="smain">
          {tab === 'tests' ? (
            <>
              <div className="shead">
                <div><div className="crumb">Every finished test, newest first</div><h1>Network tests</h1></div>
                <div className="formrow">
                  <label htmlFor="q" style={{ position: 'absolute', left: -9999 }}>Find a test</label>
                  <input id="q" className="field" style={{ width: 280 }} placeholder="Company, office, provider or result code" value={q} onChange={(e) => setQ(e.target.value)} />
                  <button className="btn primary sm" type="button" onClick={() => setTab('links')}>Send a network test</button>
                </div>
              </div>
              {err ? <p className="err" role="alert">{err}</p> : null}
              <div className="scols">
                <section className="card tablecard">
                  <table className="t">
                    <thead><tr><th scope="col" style={{ paddingLeft: 8 }}>When</th><th scope="col">Company and office</th><th scope="col">Verdict</th><th scope="col">Worst check</th><th scope="col">Started from</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.code} className={sel === r.code ? 'sel' : ''} onClick={() => setSel(r.code)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setSel(r.code); }}>
                          <td>{when(r.created_at)}</td>
                          <td>{r.company ? `${r.company}${r.office ? ` · ${r.office}` : ''}` : <span style={{ color: 'var(--muted)' }}>Not tied to a company</span>}</td>
                          <td><Chip grade={r.verdict}>{verdictWord[r.verdict]}</Chip></td>
                          <td>{r.worst ?? <span style={{ color: 'var(--muted)' }}>Nothing to fix</span>}</td>
                          <td style={{ color: 'var(--ink2)' }}>{r.origin}</td>
                        </tr>
                      ))}
                      {!rows.length ? <tr><td colSpan={5} style={{ color: 'var(--muted)', fontWeight: 400 }}>No tests yet{q ? ' that match' : ''}.</td></tr> : null}
                    </tbody>
                  </table>
                  <div className="tfoot"><span>{rows.length} test{rows.length === 1 ? '' : 's'} · kept {keep} days</span></div>
                </section>
                {d ? (
                  <aside className="card raised panel" aria-label="Selected test">
                    <div className="ph"><span className="mono">{d.result.code}</span><Chip grade={d.result.verdict}>{verdictWord[d.result.verdict]}</Chip></div>
                    <p className="sum">{d.result.company ? `${d.result.company}${d.result.office ? `, ${d.result.office}` : ''}, ` : ''}{when(d.result.at)}. Calls at once: {d.result.calls ?? 'not measured'}. Score {d.result.score ?? 'not measured'}. {d.result.fixes.length ? `Flagged: ${d.result.fixes.map((f) => f.title.toLowerCase()).join('; ')}.` : 'Nothing flagged.'}</p>
                    <div className="only">
                      <div className="oh"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6A615C" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>Staff only</div>
                      <div className="or"><span>Public IP</span><span className="mono" style={{ fontSize: 13, fontWeight: 400 }}>{d.staff.ip ?? 'Not kept'}</span></div>
                      <div className="or"><span>Network</span><span>{d.result.provider ?? 'Not known'}{d.staff.asn ? <> · <span className="mono" style={{ fontSize: 13, fontWeight: 400 }}>AS{d.staff.asn}</span></> : null}</span></div>
                      <div className="or"><span>Place</span><span>{d.staff.place ?? 'Not known'}</span></div>
                      <div className="or"><span>Path the test call took</span><span>{d.staff.path}</span></div>
                      <div className="or"><span>Device</span><span>{d.result.device}</span></div>
                      <div className="or"><span>Browser string</span><span style={{ fontWeight: 400, fontSize: 12 }}>{d.staff.ua}</span></div>
                    </div>
                    {lossBars.length ? (
                      <div>
                        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>Sound lost, sending, second by second</div>
                        <div className="mini" role="img" aria-label={`Sound lost each second of the test call, worst ${maxLoss.toFixed(0)} percent`}>
                          {lossBars.map((v, i) => <div key={i} className={v > 2 ? 'poor' : ''} style={{ height: `${Math.max(4, (v / maxLoss) * 100)}%` }} />)}
                        </div>
                      </div>
                    ) : null}
                    <form className="formrow" onSubmit={async (e) => { e.preventDefault(); try { await api(`/api/staff/tests/${d.result.code}/company`, { body: tie }); setSel(null); setTimeout(() => setSel(d.result.code), 0); load(); } catch (x) { setErr((x as Error).message); } }}>
                      <label htmlFor="tc" style={{ position: 'absolute', left: -9999 }}>Company</label>
                      <input id="tc" className="field" placeholder="Company" value={tie.company} onChange={(e) => setTie({ ...tie, company: e.target.value })} />
                      <label htmlFor="to" style={{ position: 'absolute', left: -9999 }}>Office</label>
                      <input id="to" className="field" placeholder="Office (optional)" value={tie.office} onChange={(e) => setTie({ ...tie, office: e.target.value })} />
                      <button className="btn sm quiet" type="submit">{d.result.company ? 'Change company' : 'Tie to a company'}</button>
                    </form>
                    <div className="formrow">
                      <a className="btn sm" href={`/r/${d.result.code}`} target="_blank" rel="noreferrer">Open the full result</a>
                      <button className="btn sm" type="button" onClick={() => copy(`${location.origin}/r/${d.result.code}`, 'res')}>{copied === 'res' ? 'Copied' : 'Copy its link'}</button>
                    </div>
                  </aside>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="shead"><div><div className="crumb">A link ties every test run from it to a company and office</div><h1>Support links</h1></div></div>
              {err ? <p className="err" role="alert">{err}</p> : null}
              <form className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }} onSubmit={async (e) => {
                e.preventDefault(); setErr(null);
                try { const l = await api<StaffLink>('/api/staff/links', { body: { company, office } }); setMade(l); setCompany(''); setOffice(''); load(); } catch (x) { setErr((x as Error).message); }
              }}>
                <h2 style={{ fontSize: 18, fontWeight: 700 }}>Send a network test</h2>
                <div className="formrow">
                  <label htmlFor="lc" style={{ position: 'absolute', left: -9999 }}>Company</label>
                  <input id="lc" className="field" placeholder="Company" required value={company} onChange={(e) => setCompany(e.target.value)} />
                  <label htmlFor="lo" style={{ position: 'absolute', left: -9999 }}>Office</label>
                  <input id="lo" className="field" placeholder="Office or location (optional)" value={office} onChange={(e) => setOffice(e.target.value)} />
                  <button className="btn primary sm" type="submit">Make the link</button>
                </div>
                {made ? (
                  <div className="note" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                    <span className="mono" style={{ fontSize: 14, wordBreak: 'break-all' }}>{made.url}</span>
                    <button className="btn sm" type="button" onClick={() => copy(made.url, 'made')}>{copied === 'made' ? 'Copied' : 'Copy link'}</button>
                  </div>
                ) : null}
              </form>
              <section className="card tablecard" style={{ flex: 'none' }}>
                <table className="t">
                  <thead><tr><th scope="col" style={{ paddingLeft: 8 }}>Made</th><th scope="col">Company and office</th><th scope="col">Tests run</th><th scope="col">Link</th></tr></thead>
                  <tbody>
                    {links.map((l) => (
                      <tr key={l.slug} style={{ cursor: 'default' }}>
                        <td>{when(l.created_at)}</td><td>{l.company}{l.office ? ` · ${l.office}` : ''}</td><td>{l.tests}</td>
                        <td><button className="btn sm quiet" style={{ height: 36 }} type="button" onClick={() => copy(l.url, l.slug)}>{copied === l.slug ? 'Copied' : 'Copy link'}</button></td>
                      </tr>
                    ))}
                    {!links.length ? <tr style={{ cursor: 'default' }}><td colSpan={4} style={{ color: 'var(--muted)', fontWeight: 400 }}>No links yet.</td></tr> : null}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
